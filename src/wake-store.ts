import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { sessionHash } from "./storage/dynamodb.js";

/**
 * Why a session needs an automatic resume:
 * - `inflight`: work is running; the owner keeps pushing `wakeAt` forward, so
 *   it only comes due when the owner died with nobody retrying.
 * - `interrupted`: the owner shut down (SIGTERM, maxLifetime) with work left.
 * - `approval_deadline`: parked on a human approval; resume auto-rejects.
 * - `timer`: parked on a timed wait.
 */
export type WakeReason =
  | "inflight"
  | "interrupted"
  | "approval_deadline"
  | "timer";

export interface WakeState {
  readonly wakeAt: number;
  readonly reason: WakeReason;
}

/** The single `WAKE` item of a session, indexed by `wake-index` while due-able. */
export interface WakeStore {
  set(state: WakeState): Promise<void>;
  clear(): Promise<void>;
  get(): Promise<(WakeState & { claimUntil?: number; claims?: number }) | undefined>;
}

export const WAKE_SHARD = "wake";
export const WAKE_SK = "WAKE";

export function wakePartitionKey(sessionId: string): string {
  return `w#${sessionHash(sessionId)}`;
}

function isConditionalCheckFailed(error: unknown): boolean {
  return (
    error instanceof ConditionalCheckFailedException ||
    (error as { name?: string }).name === "ConditionalCheckFailedException"
  );
}

/**
 * WAKE item in its own partition (`w#<sha256>`). It stores the raw session id
 * because the resumer must pass it to `InvokeAgentRuntime`. Every write is
 * conditioned on the writer's lease fencing token, so a fenced (stale) owner
 * cannot overwrite what the current owner scheduled. A write clears the
 * sweeper's claim, so a new wake time is picked up again.
 */
export class DynamoDbWakeStore implements WakeStore {
  readonly #docs: DynamoDBDocumentClient;
  readonly #tableName: string;
  readonly #sessionId: string;
  readonly #pk: string;
  readonly #fencingToken: () => number;

  constructor(
    docs: DynamoDBDocumentClient,
    tableName: string,
    sessionId: string,
    fencingToken: () => number,
  ) {
    this.#docs = docs;
    this.#tableName = tableName;
    this.#sessionId = sessionId;
    this.#pk = wakePartitionKey(sessionId);
    this.#fencingToken = fencingToken;
  }

  async set(state: WakeState): Promise<void> {
    await this.#update(
      "SET sessionId = :sid, wakeShard = :shard, wakeAt = :at, reason = :reason, fencingToken = :token, updatedAt = :now, claims = :zero REMOVE claimUntil",
      {
        ":sid": this.#sessionId,
        ":shard": WAKE_SHARD,
        ":at": Math.floor(state.wakeAt),
        ":reason": state.reason,
        ":now": Date.now(),
        ":zero": 0,
      },
    );
  }

  async clear(): Promise<void> {
    await this.#update(
      "SET sessionId = :sid, reason = :reason, fencingToken = :token, updatedAt = :now REMOVE wakeShard, wakeAt, claimUntil",
      { ":sid": this.#sessionId, ":reason": "idle", ":now": Date.now() },
    );
  }

  async get() {
    const result = await this.#docs.send(
      new GetCommand({
        TableName: this.#tableName,
        Key: { pk: this.#pk, sk: WAKE_SK },
        ConsistentRead: true,
      }),
    );
    const item = result.Item;
    if (item === undefined || typeof item.wakeAt !== "number") return undefined;
    return {
      wakeAt: item.wakeAt,
      reason: item.reason as WakeReason,
      ...(typeof item.claimUntil === "number" ? { claimUntil: item.claimUntil } : {}),
      ...(typeof item.claims === "number" ? { claims: item.claims } : {}),
    };
  }

  async #update(
    expression: string,
    values: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.#docs.send(
        new UpdateCommand({
          TableName: this.#tableName,
          Key: { pk: this.#pk, sk: WAKE_SK },
          UpdateExpression: expression,
          ConditionExpression:
            "attribute_not_exists(fencingToken) OR fencingToken <= :token",
          ExpressionAttributeValues: {
            ...values,
            ":token": this.#fencingToken(),
          },
        }),
      );
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        // A newer lease owner already scheduled this session; its state wins.
        process.stderr.write(
          `WAKE_WRITE_FENCED token=${this.#fencingToken()}\n`,
        );
        return;
      }
      throw error;
    }
  }
}

/** SQLite sessions are single-host; nothing outside the process can resume them. */
export class NoopWakeStore implements WakeStore {
  async set(): Promise<void> {}
  async clear(): Promise<void> {}
  async get() {
    return undefined;
  }
}
