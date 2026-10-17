import {
  DeleteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { WakePlan } from "./suspensions.js";
import { sessionPk } from "./storage/dynamodb.js";

/**
 * Wake items share one partition so the resumer finds every session that
 * needs attention with a single Query, without a table schema change. Each
 * item carries the raw AgentCore session id, which InvokeAgentRuntime needs.
 */
export const WAKE_PARTITION = "WAKE";

/** Where the session tells the resumer when to invoke it next. */
export interface WakeStore {
  write(plan: WakePlan): Promise<void>;
}

export class DynamoDbWakeStore implements WakeStore {
  readonly #docs: DynamoDBDocumentClient;
  readonly #tableName: string;
  readonly #sessionId: string;
  readonly #fencingToken: number;

  constructor(
    docs: DynamoDBDocumentClient,
    tableName: string,
    sessionId: string,
    fencingToken: number,
  ) {
    this.#docs = docs;
    this.#tableName = tableName;
    this.#sessionId = sessionId;
    this.#fencingToken = fencingToken;
  }

  /** A stale owner (lower fencing token) cannot overwrite a newer owner's plan. */
  async write(plan: WakePlan): Promise<void> {
    const key = { pk: WAKE_PARTITION, sk: sessionPk(this.#sessionId) };
    const condition =
      "attribute_not_exists(fencingToken) OR fencingToken <= :token";
    try {
      if (plan.reason === "none") {
        await this.#docs.send(
          new DeleteCommand({
            TableName: this.#tableName,
            Key: key,
            ConditionExpression: condition,
            ExpressionAttributeValues: { ":token": this.#fencingToken },
          }),
        );
        return;
      }
      await this.#docs.send(
        new UpdateCommand({
          TableName: this.#tableName,
          Key: key,
          UpdateExpression:
            "SET runtimeSessionId = :session, dueAt = :due, reason = :reason, fencingToken = :token, updatedAt = :now REMOVE claimedUntil",
          ConditionExpression: condition,
          ExpressionAttributeValues: {
            ":session": this.#sessionId,
            ":due": plan.dueAt,
            ":reason": plan.reason,
            ":token": this.#fencingToken,
            ":now": Date.now(),
          },
        }),
      );
    } catch (error) {
      if (
        (error as { name?: string }).name !== "ConditionalCheckFailedException"
      ) {
        throw error;
      }
    }
  }
}

/** SQLite mode has no resumer. */
export class NoWakeStore implements WakeStore {
  async write(): Promise<void> {}
}
