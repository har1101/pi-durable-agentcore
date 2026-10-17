import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { sessionHash } from "./storage/dynamodb.js";

export interface EffectRecord {
  readonly idempotencyKey: string;
  readonly action: string;
  readonly appliedAt: string;
  readonly pid: number;
}

/**
 * Stand-in for an external system that honors an `Idempotency-Key` header: the
 * first `apply()` with a key performs the effect, later ones return the
 * original record. A replay-safe tool that crashed after its effect but before
 * its result was committed therefore does not apply the effect twice.
 */
export interface EffectLedger {
  apply(
    idempotencyKey: string,
    action: string,
  ): Promise<{ readonly applied: boolean; readonly record: EffectRecord }>;
}

function isConditionalCheckFailed(error: unknown): boolean {
  return (
    error instanceof ConditionalCheckFailedException ||
    (error as { name?: string }).name === "ConditionalCheckFailedException"
  );
}

export class DynamoDbEffectLedger implements EffectLedger {
  readonly #docs: DynamoDBDocumentClient;
  readonly #tableName: string;
  readonly #pk: string;

  constructor(docs: DynamoDBDocumentClient, tableName: string, sessionId: string) {
    this.#docs = docs;
    this.#tableName = tableName;
    this.#pk = `fx#${sessionHash(sessionId)}`;
  }

  async apply(idempotencyKey: string, action: string) {
    const record: EffectRecord = {
      idempotencyKey,
      action,
      appliedAt: new Date().toISOString(),
      pid: process.pid,
    };
    const key = { pk: this.#pk, sk: `FX#${idempotencyKey}` };
    try {
      await this.#docs.send(
        new PutCommand({
          TableName: this.#tableName,
          Item: { ...key, ...record },
          ConditionExpression: "attribute_not_exists(sk)",
        }),
      );
      return { applied: true, record };
    } catch (error) {
      if (!isConditionalCheckFailed(error)) throw error;
    }
    const existing = await this.#docs.send(
      new GetCommand({ TableName: this.#tableName, Key: key, ConsistentRead: true }),
    );
    const item = existing.Item ?? {};
    return {
      applied: false,
      record: {
        idempotencyKey: String(item.idempotencyKey),
        action: String(item.action),
        appliedAt: String(item.appliedAt),
        pid: Number(item.pid),
      },
    };
  }
}

export class FileEffectLedger implements EffectLedger {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async apply(idempotencyKey: string, action: string) {
    await mkdir(this.#directory, { recursive: true });
    const path = join(this.#directory, `${idempotencyKey}.json`);
    const record: EffectRecord = {
      idempotencyKey,
      action,
      appliedAt: new Date().toISOString(),
      pid: process.pid,
    };
    try {
      await writeFile(path, JSON.stringify(record), { flag: "wx" });
      return { applied: true, record };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return {
        applied: false,
        record: JSON.parse(await readFile(path, "utf8")) as EffectRecord,
      };
    }
  }
}
