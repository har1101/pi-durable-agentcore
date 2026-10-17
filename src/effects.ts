import { createHash } from "node:crypto";
import { PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/**
 * Stand-in for an external system that honors idempotency keys, the way a
 * payment or deployment API would. Applying the same key twice is a no-op.
 */
export interface EffectLedger {
  apply(key: string, effect: Record<string, unknown>): Promise<"applied" | "duplicate">;
}

export function effectPartition(key: string): string {
  return `fx#${createHash("sha256").update(key).digest("hex")}`;
}

export class DynamoDbEffectLedger implements EffectLedger {
  readonly #docs: DynamoDBDocumentClient;
  readonly #tableName: string;

  constructor(docs: DynamoDBDocumentClient, tableName: string) {
    this.#docs = docs;
    this.#tableName = tableName;
  }

  async apply(key: string, effect: Record<string, unknown>): Promise<"applied" | "duplicate"> {
    try {
      await this.#docs.send(
        new PutCommand({
          TableName: this.#tableName,
          Item: {
            pk: effectPartition(key),
            sk: "EFFECT",
            kind: "effect",
            effect: JSON.stringify(effect),
            appliedAt: Date.now(),
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return "applied";
    } catch (error) {
      if ((error as { name?: string }).name === "ConditionalCheckFailedException") {
        return "duplicate";
      }
      throw error;
    }
  }
}

/** SQLite mode is local-only, so its "external system" is this process. */
export class MemoryEffectLedger implements EffectLedger {
  readonly #applied = new Set<string>();

  async apply(key: string): Promise<"applied" | "duplicate"> {
    if (this.#applied.has(key)) return "duplicate";
    this.#applied.add(key);
    return "applied";
  }
}
