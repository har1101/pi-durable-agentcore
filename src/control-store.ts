import { createHash } from "node:crypto";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { sessionTableClient, sessionTableName } from "./event-log.js";
import { sessionPk } from "./storage/dynamodb.js";

/**
 * Session control items that live next to the Pi commit log but outside it:
 * human approvals, the session's single wake-up item (read by the auto-resume
 * sweeper through the sparse `WakeIndex` GSI), and idempotent tool effects.
 * Partition `s#<sha256(sessionId)>#ctl`, so Pi recovery never reads them and
 * they can be read without holding the session lease.
 */

export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ApprovalDecision = "approve" | "reject";

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly status: ApprovalStatus;
  readonly toolName: string;
  /** JSON of the arguments the approver is asked to approve. */
  readonly arguments: string;
  readonly idempotencyKey: string;
  readonly requestId?: string;
  readonly requestedAt: number;
  readonly deadline: number;
  readonly decidedAt?: number;
  readonly decidedBy?: "approver" | "timeout";
  readonly reason?: string;
}

export type DecideOutcome =
  | { readonly outcome: "recorded" | "already_recorded"; readonly record: ApprovalRecord }
  | { readonly outcome: "conflict" | "expired"; readonly record: ApprovalRecord }
  | { readonly outcome: "not_found" };

export type WakeReason = "running" | "approval" | "timer";

export interface WakeRecord {
  readonly armed: boolean;
  readonly reason?: WakeReason | "idle";
  readonly dueAt?: number;
  readonly requestId?: string;
  readonly approvalId?: string;
  readonly attempts?: number;
  readonly deadLetter?: boolean;
}

export interface EffectRecord {
  readonly idempotencyKey: string;
  readonly result: string;
  readonly performedAt: number;
}

const WAKE_SK = "WAKE";
const APPROVAL_PREFIX = "APPROVAL#";
const EFFECT_PREFIX = "EFFECT#";

export function controlPk(sessionId: string): string {
  return `${sessionPk(sessionId)}#ctl`;
}

export function wakeShardCount(): number {
  const value = Number(process.env.PI_WAKE_SHARDS ?? 4);
  return Number.isSafeInteger(value) && value > 0 ? value : 4;
}

/** Stable shard of a session; the sweeper queries every `wake#0..N-1`. */
export function wakeShard(sessionId: string, shards = wakeShardCount()): string {
  const prefix = createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
  return `wake#${Number.parseInt(prefix, 16) % shards}`;
}

function isConditionalCheckFailed(error: unknown): boolean {
  return (
    error instanceof ConditionalCheckFailedException ||
    (error as { name?: string }).name === "ConditionalCheckFailedException"
  );
}

function toApproval(item: Record<string, unknown>): ApprovalRecord {
  return {
    approvalId: String(item.approvalId),
    status: item.status as ApprovalStatus,
    toolName: String(item.toolName),
    arguments: String(item.arguments),
    idempotencyKey: String(item.idempotencyKey),
    ...(typeof item.requestId === "string" ? { requestId: item.requestId } : {}),
    requestedAt: Number(item.requestedAt),
    deadline: Number(item.deadline),
    ...(typeof item.decidedAt === "number" ? { decidedAt: item.decidedAt } : {}),
    ...(item.decidedBy === "approver" || item.decidedBy === "timeout"
      ? { decidedBy: item.decidedBy }
      : {}),
    ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
  };
}

export class ControlStore {
  readonly sessionId: string;
  readonly #docs: DynamoDBDocumentClient;
  readonly #tableName: string;
  readonly #pk: string;

  constructor(options: {
    sessionId: string;
    docs: DynamoDBDocumentClient;
    tableName: string;
  }) {
    this.sessionId = options.sessionId;
    this.#docs = options.docs;
    this.#tableName = options.tableName;
    this.#pk = controlPk(options.sessionId);
  }

  static async open(sessionId: string): Promise<ControlStore> {
    return new ControlStore({
      sessionId,
      docs: await sessionTableClient(),
      tableName: sessionTableName(),
    });
  }

  // ---- approvals -------------------------------------------------------

  /** Create the approval once; a replay with the same id returns the stored one. */
  async ensureApproval(record: ApprovalRecord): Promise<ApprovalRecord> {
    try {
      await this.#docs.send(
        new PutCommand({
          TableName: this.#tableName,
          Item: {
            pk: this.#pk,
            sk: `${APPROVAL_PREFIX}${record.approvalId}`,
            kind: "approval",
            ...record,
          },
          ConditionExpression: "attribute_not_exists(sk)",
        }),
      );
      return record;
    } catch (error) {
      if (!isConditionalCheckFailed(error)) throw error;
      const existing = await this.getApproval(record.approvalId);
      if (existing === undefined) throw error;
      return existing;
    }
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
    const result = await this.#docs.send(
      new GetCommand({
        TableName: this.#tableName,
        Key: { pk: this.#pk, sk: `${APPROVAL_PREFIX}${approvalId}` },
        ConsistentRead: true,
      }),
    );
    return result.Item === undefined ? undefined : toApproval(result.Item);
  }

  async listApprovals(): Promise<ApprovalRecord[]> {
    const page = await this.#docs.send(
      new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": this.#pk, ":prefix": APPROVAL_PREFIX },
        ConsistentRead: true,
      }),
    );
    return (page.Items ?? []).map(toApproval);
  }

  /**
   * Record an approver's decision. Only a pending approval whose deadline has
   * not passed changes; the conditional write is the tie-breaker against the
   * timeout path and against a second approver.
   */
  async decide(
    approvalId: string,
    decision: ApprovalDecision,
    options: { now: number; reason?: string },
  ): Promise<DecideOutcome> {
    const status: ApprovalStatus = decision === "approve" ? "approved" : "rejected";
    try {
      const result = await this.#docs.send(
        new UpdateCommand({
          TableName: this.#tableName,
          Key: { pk: this.#pk, sk: `${APPROVAL_PREFIX}${approvalId}` },
          UpdateExpression:
            "SET #status = :status, decidedAt = :now, decidedBy = :by, reason = :reason",
          ConditionExpression:
            "attribute_exists(sk) AND #status = :pending AND deadline > :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": status,
            ":pending": "pending",
            ":now": options.now,
            ":by": "approver",
            ":reason": options.reason ?? "",
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return { outcome: "recorded", record: toApproval(result.Attributes ?? {}) };
    } catch (error) {
      if (!isConditionalCheckFailed(error)) throw error;
    }
    const existing = await this.getApproval(approvalId);
    if (existing === undefined) return { outcome: "not_found" };
    if (existing.status === "pending") return { outcome: "expired", record: existing };
    if (existing.status === status && existing.decidedBy === "approver") {
      return { outcome: "already_recorded", record: existing };
    }
    return { outcome: "conflict", record: existing };
  }

  /** Reject a pending approval whose deadline passed. Returns the settled record. */
  async expire(approvalId: string, now: number): Promise<ApprovalRecord | undefined> {
    try {
      const result = await this.#docs.send(
        new UpdateCommand({
          TableName: this.#tableName,
          Key: { pk: this.#pk, sk: `${APPROVAL_PREFIX}${approvalId}` },
          UpdateExpression:
            "SET #status = :rejected, decidedAt = :now, decidedBy = :by, reason = :reason",
          ConditionExpression: "#status = :pending AND deadline <= :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":rejected": "rejected",
            ":pending": "pending",
            ":now": now,
            ":by": "timeout",
            ":reason": "approval timed out",
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return toApproval(result.Attributes ?? {});
    } catch (error) {
      if (!isConditionalCheckFailed(error)) throw error;
      return this.getApproval(approvalId);
    }
  }

  // ---- wake-up item ------------------------------------------------------

  /**
   * Arm the session's wake-up: the sweeper resumes the session once `dueAt`
   * passes. A writer with an older fencing token (a fenced former owner)
   * cannot overwrite a newer owner's wake.
   */
  async armWake(options: {
    reason: WakeReason;
    dueAt: number;
    fencingToken: number;
    requestId?: string;
    approvalId?: string;
  }): Promise<boolean> {
    return this.#writeWake(
      "SET sessionId = :sid, wakeShard = :shard, wakeDueAt = :due, reason = :reason, " +
        "fencingToken = :token, updatedAt = :now, attempts = :zero, requestId = :rid, approvalId = :aid " +
        "REMOVE deadLetter",
      {
        ":sid": this.sessionId,
        ":shard": wakeShard(this.sessionId),
        ":due": options.dueAt,
        ":reason": options.reason,
        ":zero": 0,
        ":rid": options.requestId ?? "",
        ":aid": options.approvalId ?? "",
      },
      options.fencingToken,
    );
  }

  /** Nothing left to resume: drop out of the sparse GSI. */
  async disarmWake(fencingToken: number): Promise<boolean> {
    return this.#writeWake(
      "SET reason = :idle, fencingToken = :token, updatedAt = :now REMOVE wakeShard, wakeDueAt",
      { ":idle": "idle" },
      fencingToken,
    );
  }

  async getWake(): Promise<WakeRecord> {
    const result = await this.#docs.send(
      new GetCommand({
        TableName: this.#tableName,
        Key: { pk: this.#pk, sk: WAKE_SK },
        ConsistentRead: true,
      }),
    );
    const item = result.Item;
    if (item === undefined) return { armed: false };
    return {
      armed: typeof item.wakeDueAt === "number" && typeof item.wakeShard === "string",
      ...(typeof item.reason === "string" ? { reason: item.reason as WakeReason } : {}),
      ...(typeof item.wakeDueAt === "number" ? { dueAt: item.wakeDueAt } : {}),
      ...(item.requestId ? { requestId: String(item.requestId) } : {}),
      ...(item.approvalId ? { approvalId: String(item.approvalId) } : {}),
      ...(typeof item.attempts === "number" ? { attempts: item.attempts } : {}),
      ...(item.deadLetter === true ? { deadLetter: true } : {}),
    };
  }

  async #writeWake(
    update: string,
    values: Record<string, unknown>,
    fencingToken: number,
  ): Promise<boolean> {
    try {
      await this.#docs.send(
        new UpdateCommand({
          TableName: this.#tableName,
          Key: { pk: this.#pk, sk: WAKE_SK },
          UpdateExpression: update,
          ConditionExpression:
            "attribute_not_exists(fencingToken) OR fencingToken <= :token",
          ExpressionAttributeValues: {
            ...values,
            ":token": fencingToken,
            ":now": Date.now(),
          },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailed(error)) return false;
      throw error;
    }
  }

  // ---- idempotent effects ------------------------------------------------

  async getEffect(idempotencyKey: string): Promise<EffectRecord | undefined> {
    const result = await this.#docs.send(
      new GetCommand({
        TableName: this.#tableName,
        Key: { pk: this.#pk, sk: `${EFFECT_PREFIX}${idempotencyKey}` },
        ConsistentRead: true,
      }),
    );
    const item = result.Item;
    return item === undefined
      ? undefined
      : {
          idempotencyKey,
          result: String(item.result),
          performedAt: Number(item.performedAt),
        };
  }

  /**
   * Record an effect once per idempotency key (first writer wins) and return
   * the stored one, so a replayed or racing execution reports the same result.
   */
  async recordEffect(idempotencyKey: string, result: string): Promise<{
    readonly record: EffectRecord;
    readonly firstWrite: boolean;
  }> {
    const record = { idempotencyKey, result, performedAt: Date.now() };
    try {
      await this.#docs.send(
        new PutCommand({
          TableName: this.#tableName,
          Item: {
            pk: this.#pk,
            sk: `${EFFECT_PREFIX}${idempotencyKey}`,
            kind: "effect",
            ...record,
          },
          ConditionExpression: "attribute_not_exists(sk)",
        }),
      );
      return { record, firstWrite: true };
    } catch (error) {
      if (!isConditionalCheckFailed(error)) throw error;
      const existing = await this.getEffect(idempotencyKey);
      if (existing === undefined) throw error;
      return { record: existing, firstWrite: false };
    }
  }
}
