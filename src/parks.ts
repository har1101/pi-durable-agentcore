import { createHash } from "node:crypto";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { sessionPk } from "./storage/dynamodb.js";
import { sessionTable } from "./storage/open.js";
import { WAKE_SHARD } from "./wake-sweeper.cjs";

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** `tk1_` + 64 hex. One per tool task: stable across retries, replays and resume; never contains the session id. */
export type IdempotencyKey = Brand<string, "IdempotencyKey">;
/** 32 hex. The PARK item is `PARK#<id>`; the approval id on the wire is `apr_<id>`. */
export type ParkId = Brand<string, "ParkId">;

function digest(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * Keyed by the pi-durable task id, which Storage mints once per tool task, not by the provider call id, which a
 * provider may reuse (the scripted model restarts `durable-wait-1` in every process).
 */
export function toolKey(sessionId: string, taskId: number): IdempotencyKey {
  return `tk1_${digest(["pi-durable-agentcore/tool/v1", sessionId, taskId])}` as IdempotencyKey;
}

/** A separate derivation, so the public approval id reveals nothing of the key a tool hands to side effects. */
export function parkIdOf(key: IdempotencyKey): ParkId {
  return digest(["pi-durable-agentcore/park/v1", key]).slice(0, 32) as ParkId;
}

export function approvalIdOf(id: ParkId): `apr_${string}` {
  return `apr_${id}`;
}

export function parseApprovalId(value: unknown): ParkId | undefined {
  return typeof value === "string" && /^apr_[0-9a-f]{32}$/.test(value)
    ? (value.slice(4) as ParkId)
    : undefined;
}

export type Decision = "approve" | "reject";
/** `decidedBy` of the rejection a passed deadline writes. No approver may use this id. */
export const TIMEOUT = "timeout";

/** What a gated call waits for before its tool may start. */
export type ParkSpec =
  | { readonly kind: "approval"; readonly timeoutMs: number }
  | { readonly kind: "timer"; readonly until: number };

export interface ParkRecord {
  readonly id: ParkId;
  readonly kind: ParkSpec["kind"];
  readonly tool: string;
  /** Tool name and arguments, shown to the approver. */
  readonly summary: string;
  readonly requestedAt: number;
  readonly deadlineAt: number;
  /** The placed submission whose run made the call; decide reports its result. */
  readonly submissionId?: number;
  readonly requestId?: string;
  /** User id of the invoke that started the run, from its input entry; absent for an anonymous invoke. That user cannot approve. */
  readonly requestedBy?: string;
  readonly decided?: {
    readonly decision: Decision;
    readonly by: string;
    readonly at: number;
  };
  readonly consumedAt?: number;
}

export type ParkDraft = Omit<ParkRecord, "id" | "decided" | "consumedAt">;

/** How the gate settles a parked call. Only a stored "approve" approves, and only before the deadline. */
export type Verdict =
  | "pending"
  | "approved"
  | "rejected"
  | "timed_out"
  | "elapsed";

export function verdictOf(park: ParkRecord, now: number): Verdict {
  if (park.kind === "timer") return now >= park.deadlineAt ? "elapsed" : "pending";
  if (park.decided !== undefined) {
    return park.decided.decision === "approve" ? "approved" : "rejected";
  }
  return now >= park.deadlineAt ? "timed_out" : "pending";
}

/**
 * What a human decision does given the stored record: `write` applies it, `expire` records the deadline's rejection
 * first. The conditional update in `ParkStore.decide` encodes `write`; this classifies the record when it fails.
 */
export type DecideStep =
  | { readonly kind: "write" }
  | { readonly kind: "expire" }
  | { readonly kind: "unknown" }
  | { readonly kind: "self_approval" }
  | { readonly kind: "duplicate"; readonly park: ParkRecord }
  | { readonly kind: "already_decided"; readonly park: ParkRecord }
  | { readonly kind: "expired"; readonly park: ParkRecord };

export type DecideOutcome =
  | Exclude<DecideStep, { readonly kind: "write" | "expire" }>
  | { readonly kind: "recorded"; readonly park: ParkRecord };

export function decideStep(
  park: ParkRecord | undefined,
  decision: Decision,
  approver: string,
  now: number,
): DecideStep {
  if (park === undefined || park.kind !== "approval") return { kind: "unknown" };
  if (park.requestedBy === approver) return { kind: "self_approval" };
  if (park.decided !== undefined) {
    if (park.decided.by === TIMEOUT) return { kind: "expired", park };
    return park.decided.decision === decision
      ? { kind: "duplicate", park }
      : { kind: "already_decided", park };
  }
  return now < park.deadlineAt ? { kind: "write" } : { kind: "expire" };
}

const PARK_PREFIX = "PARK#";
const RUN_SK = "RUN";

function isConditionFailed(error: unknown): boolean {
  return (error as { name?: string }).name === "ConditionalCheckFailedException";
}

function parsePark(item: Record<string, unknown>): ParkRecord {
  const sk = String(item.sk);
  const kind = item.kind;
  if (!sk.startsWith(PARK_PREFIX) || (kind !== "approval" && kind !== "timer")) {
    throw new Error(`Not a PARK item: ${sk}`);
  }
  const decision = item.decision;
  const optional = <T>(name: string, value: T | undefined) =>
    value === undefined ? {} : { [name]: value };
  return {
    id: sk.slice(PARK_PREFIX.length) as ParkId,
    kind,
    tool: String(item.tool),
    summary: String(item.summary),
    requestedAt: Number(item.requestedAt),
    deadlineAt: Number(item.deadlineAt),
    ...optional("submissionId", item.submissionId as number | undefined),
    ...optional("requestId", item.requestId as string | undefined),
    ...optional("requestedBy", item.requestedBy as string | undefined),
    ...(decision === "approve" || decision === "reject"
      ? {
          decided: {
            decision,
            by: String(item.decidedBy),
            at: Number(item.decidedAt),
          },
        }
      : {}),
    ...optional("consumedAt", item.consumedAt as number | undefined),
  };
}

/**
 * Sole writer of the PARK#… and RUN items in a session's partition. Every write is conditional or idempotent, so the
 * gate, a human, the deadline and duplicate requests converge without the lease. While an item needs a wake it
 * carries `wakeShard`, `wakeAt` and `runtimeSessionId`, which put it in the sparse WakeIndex; they are removed together.
 */
export class ParkStore {
  readonly #sessionId: string;
  readonly #pk: string;

  constructor(sessionId: string) {
    this.#sessionId = sessionId;
    this.#pk = sessionPk(sessionId);
  }

  #wake(at: number) {
    return { wakeShard: WAKE_SHARD, wakeAt: at, runtimeSessionId: this.#sessionId };
  }

  /** First writer wins, so a re-run gate gets the original deadline back. */
  async ensure(
    id: ParkId,
    draft: ParkDraft,
  ): Promise<{ readonly park: ParkRecord; readonly created: boolean }> {
    const { docs, tableName } = await sessionTable();
    const item = {
      pk: this.#pk,
      sk: PARK_PREFIX + id,
      ...draft,
      ...this.#wake(draft.deadlineAt),
    };
    try {
      await docs.send(
        new PutCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(sk)",
        }),
      );
      return { park: parsePark(item), created: true };
    } catch (error) {
      if (!isConditionFailed(error)) throw error;
    }
    return { park: await this.mustGet(id), created: false };
  }

  async get(id: ParkId): Promise<ParkRecord | undefined> {
    const { docs, tableName } = await sessionTable();
    const { Item } = await docs.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: this.#pk, sk: PARK_PREFIX + id },
        ConsistentRead: true,
      }),
    );
    return Item === undefined ? undefined : parsePark(Item);
  }

  async mustGet(id: ParkId): Promise<ParkRecord> {
    const park = await this.get(id);
    if (park === undefined) throw new Error(`PARK ${id} is missing`);
    return park;
  }

  /**
   * A human decision. It sets `wakeAt = now` in the same write, so if this request cannot deliver it (lease held,
   * crash), the sweeper does.
   */
  async decide(
    id: ParkId,
    decision: Decision,
    approver: string,
    now: number,
  ): Promise<DecideOutcome> {
    const { docs, tableName } = await sessionTable();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { Attributes } = await docs.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { pk: this.#pk, sk: PARK_PREFIX + id },
            UpdateExpression:
              "SET decision = :decision, decidedBy = :by, decidedAt = :now, wakeShard = :shard, wakeAt = :now, runtimeSessionId = :sid",
            ConditionExpression:
              "attribute_exists(sk) AND #kind = :approval AND attribute_not_exists(decision) AND deadlineAt > :now AND (attribute_not_exists(requestedBy) OR requestedBy <> :by)",
            ExpressionAttributeNames: { "#kind": "kind" },
            ExpressionAttributeValues: {
              ":decision": decision,
              ":by": approver,
              ":now": now,
              ":shard": WAKE_SHARD,
              ":sid": this.#sessionId,
              ":approval": "approval",
            },
            ReturnValues: "ALL_NEW",
          }),
        );
        return { kind: "recorded", park: parsePark(Attributes ?? {}) };
      } catch (error) {
        if (!isConditionFailed(error)) throw error;
      }
      const step = decideStep(await this.get(id), decision, approver, now);
      if (step.kind === "expire") await this.expire(id, now);
      else if (step.kind !== "write") return step;
    }
    throw new Error(`Decision on PARK ${id} did not converge`);
  }

  /** The deadline's rejection. Loses to any decision already stored. */
  async expire(id: ParkId, now: number): Promise<void> {
    const { docs, tableName } = await sessionTable();
    try {
      await docs.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: this.#pk, sk: PARK_PREFIX + id },
          UpdateExpression:
            "SET decision = :reject, decidedBy = :timeout, decidedAt = :now",
          ConditionExpression:
            "attribute_exists(sk) AND #kind = :approval AND attribute_not_exists(decision) AND deadlineAt <= :now",
          ExpressionAttributeNames: { "#kind": "kind" },
          ExpressionAttributeValues: {
            ":reject": "reject",
            ":timeout": TIMEOUT,
            ":now": now,
            ":approval": "approval",
          },
        }),
      );
    } catch (error) {
      if (!isConditionFailed(error)) throw error;
    }
  }

  /** The gate has applied the stored outcome: the item needs no wake. Kept as the audit record. */
  async consume(id: ParkId, now: number): Promise<void> {
    const { docs, tableName } = await sessionTable();
    try {
      await docs.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: this.#pk, sk: PARK_PREFIX + id },
          UpdateExpression:
            "REMOVE wakeShard, wakeAt, runtimeSessionId SET consumedAt = if_not_exists(consumedAt, :now)",
          ConditionExpression: "attribute_exists(sk)",
          ExpressionAttributeValues: { ":now": now },
        }),
      );
    } catch (error) {
      if (!isConditionFailed(error)) throw error;
    }
  }

  /**
   * Due at once: the sweeper resumes the session as soon as its lease lapses, so a run whose process died
   * continues with no caller. Unconditional, so the latest arm wins.
   */
  async armRun(armId: string, now: number): Promise<void> {
    const { docs, tableName } = await sessionTable();
    await docs.send(
      new PutCommand({
        TableName: tableName,
        Item: { pk: this.#pk, sk: RUN_SK, armId, armedAt: now, ...this.#wake(now) },
      }),
    );
  }

  /** Only the arm that is still current is removed; a newer arm by another drive stays. */
  async disarmRun(armId: string): Promise<void> {
    const { docs, tableName } = await sessionTable();
    try {
      await docs.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: this.#pk, sk: RUN_SK },
          UpdateExpression: "REMOVE wakeShard, wakeAt, runtimeSessionId",
          ConditionExpression: "armId = :armId",
          ExpressionAttributeValues: { ":armId": armId },
        }),
      );
    } catch (error) {
      if (!isConditionFailed(error)) throw error;
    }
  }

  /** PARK items the gate has not consumed yet. */
  async open(): Promise<ParkRecord[]> {
    const { docs, tableName } = await sessionTable();
    const parks: ParkRecord[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await docs.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": this.#pk, ":prefix": PARK_PREFIX },
          ConsistentRead: true,
          ...(start !== undefined ? { ExclusiveStartKey: start } : {}),
        }),
      );
      for (const item of page.Items ?? []) {
        const park = parsePark(item);
        if (park.consumedAt === undefined) parks.push(park);
      }
      start = page.LastEvaluatedKey;
    } while (start !== undefined);
    return parks;
  }
}
