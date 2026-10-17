import { createHash, randomUUID } from "node:crypto";
import {
  ConditionalCheckFailedException,
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  IdempotentParameterMismatchException,
  ResourceInUseException,
  ResourceNotFoundException,
  TransactionCanceledException,
  waitUntilTableExists,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type { Context } from "@earendil-works/chord";
import {
  MemoryStorage,
  type ConversationId,
  type ConversationQuery,
  type Cursor,
  type DocumentAddress,
  type DocumentId,
  type DocumentPoint,
  type DocumentQuery,
  type EntryId,
  type EntryQuery,
  type Id,
  type Page,
  type Seq,
  type Storage,
  type StorageWrite,
  type SubmissionId,
  type SubmissionQuery,
  type TaskId,
  type TaskQuery,
} from "@earendil-works/pi-durable";
import { FencedWriterError, LeaseContentionError } from "./errors.js";

const LEASE_SK = "LEASE";
const META_SK = "META";
const COMMIT_PREFIX = "COMMIT#";
const MAX_CHUNK_BYTES = 300_000;
const MAX_TRANSACT_ITEMS = 100;
const INITIAL_NEXT_ID = 2;
const INITIAL_NEXT_SEQ = 1;

export interface DynamoDbStorageOptions {
  readonly tableName: string;
  readonly sessionId: string;
  readonly client?: DynamoDBDocumentClient;
  readonly endpoint?: string;
  readonly region?: string;
  readonly ownerId?: string;
  readonly leaseTtlMs?: number;
  readonly acquireTimeoutMs?: number;
  readonly acquireRetryMs?: number;
  readonly ensureTable?: boolean;
  /** Set false to simulate a paused owner that cannot renew the lease. */
  readonly renewLease?: boolean;
}

export interface DynamoDbLease {
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly expiresAt: number;
}

function asSeq(value: number): Seq {
  return value as Seq;
}

function sessionPk(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return `s#${digest}`;
}

function commitSk(seq: number, chunk?: number): string {
  const base = `${COMMIT_PREFIX}${String(seq).padStart(16, "0")}`;
  return chunk === undefined ? base : `${base}#c${String(chunk).padStart(4, "0")}`;
}

function parseCommitSeq(sk: string): number | undefined {
  if (!sk.startsWith(COMMIT_PREFIX)) return undefined;
  const rest = sk.slice(COMMIT_PREFIX.length);
  const seqPart = rest.split("#")[0];
  if (seqPart === undefined) return undefined;
  const seq = Number(seqPart);
  return Number.isSafeInteger(seq) ? seq : undefined;
}

function isChunkSk(sk: string): boolean {
  return /#c\d+$/.test(sk);
}

function chunkUtf8(text: string, maxBytes: number): string[] {
  const buffer = Buffer.from(text, "utf8");
  const chunks: string[] = [];
  let start = 0;
  while (start < buffer.length) {
    let end = Math.min(start + maxBytes, buffer.length);
    while (end > start && (buffer[end]! & 0xc0) === 0x80) end -= 1;
    if (end === start) end = Math.min(start + maxBytes, buffer.length);
    chunks.push(buffer.subarray(start, end).toString("utf8"));
    start = end;
  }
  return chunks.length === 0 ? [""] : chunks;
}

function payloadHash(json: string): string {
  return createHash("sha256").update(json).digest("hex");
}

function throwIfAborted(context: Context): void {
  const signal = (context as { signal?: AbortSignal }).signal;
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Storage operation was cancelled");
  }
}

export function dynamoDbClientConfig(
  options: {
    readonly endpoint?: string;
    readonly region?: string;
  } = {},
): DynamoDBClientConfig {
  const endpoint = options.endpoint ?? process.env.DYNAMODB_ENDPOINT;
  const region =
    options.region ??
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION ??
    "ap-northeast-1";
  const config: DynamoDBClientConfig = { region };
  if (endpoint !== undefined && endpoint !== "") {
    config.endpoint = endpoint;
    config.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "local",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "local",
    };
  }
  return config;
}

export function createDynamoDbDocumentClient(
  options: {
    readonly endpoint?: string;
    readonly region?: string;
  } = {},
): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(
    new DynamoDBClient(dynamoDbClientConfig(options)),
    { marshallOptions: { removeUndefinedValues: true } },
  );
}

export async function ensureSessionTable(
  tableName: string,
  options: {
    readonly endpoint?: string;
    readonly region?: string;
  } = {},
): Promise<void> {
  const lowLevel = new DynamoDBClient(dynamoDbClientConfig(options));
  try {
    await lowLevel.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      }),
    );
  } catch (error) {
    if (!(error instanceof ResourceInUseException)) throw error;
  }
  await waitUntilTableExists(
    { client: lowLevel, maxWaitTime: 30 },
    { TableName: tableName },
  );
  const described = await lowLevel.send(
    new DescribeTableCommand({ TableName: tableName }),
  );
  if (described.Table?.TableStatus !== "ACTIVE") {
    throw new Error(`DynamoDB table ${tableName} is not ACTIVE`);
  }
}

function maxIdFromWrites(writes: readonly StorageWrite[]): number {
  let maxId = 1;
  for (const write of writes) {
    if (write.type === "document.change" || write.type === "document.retire") {
      maxId = Math.max(maxId, write.id);
      continue;
    }
    const id =
      write.type === "document.create" || write.type === "document.copy"
        ? write.record.id
        : write.value.id;
    maxId = Math.max(maxId, id);
  }
  return maxId;
}

function isConditionalCheckFailed(error: unknown): boolean {
  return (
    error instanceof ConditionalCheckFailedException ||
    (error as { name?: string }).name === "ConditionalCheckFailedException"
  );
}

function isIdempotentParameterMismatch(error: unknown): boolean {
  return (
    error instanceof IdempotentParameterMismatchException ||
    (error as { name?: string }).name === "IdempotentParameterMismatchException"
  );
}

/**
 * DynamoDB TransactWriteItems ClientRequestToken is max 36 chars and is
 * remembered for ~10 minutes. AgentCore replacement microVMs can replay an
 * SDK auto-token (cloned RNG) with a different payload — unique tokens here.
 */
function transactClientRequestToken(parts: readonly unknown[]): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part)).join("\0"))
    .digest("hex")
    .slice(0, 36);
}

/**
 * Pi Durable `Storage` over DynamoDB. Commits are an append-only log replayed
 * into MemoryStorage. Ownership is a conditional-write lease plus a monotonic
 * fencing token on every mutation.
 */
export class DynamoDbStorage implements Storage {
  readonly sessionId: string;
  readonly tableName: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  private readonly pk: string;
  private readonly docs: DynamoDBDocumentClient;
  private readonly memory = new MemoryStorage();
  private readonly leaseTtlMs: number;
  private nextId = INITIAL_NEXT_ID;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private fenced = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  private constructor(
    options: DynamoDbStorageOptions,
    docs: DynamoDBDocumentClient,
    fencingToken: number,
  ) {
    this.sessionId = options.sessionId;
    this.tableName = options.tableName;
    this.ownerId = options.ownerId ?? randomUUID();
    this.fencingToken = fencingToken;
    this.pk = sessionPk(options.sessionId);
    this.docs = docs;
    this.leaseTtlMs = options.leaseTtlMs ?? 15_000;
  }

  static async open(options: DynamoDbStorageOptions): Promise<DynamoDbStorage> {
    const docs = options.client ?? createDynamoDbDocumentClient(options);
    if (options.ensureTable) {
      await ensureSessionTable(options.tableName, options);
    }
    const ownerId = options.ownerId ?? randomUUID();
    const fencingToken = await acquireLease(docs, { ...options, ownerId });
    const storage = new DynamoDbStorage(
      { ...options, ownerId },
      docs,
      fencingToken,
    );
    await storage.recover();
    if (options.renewLease !== false) storage.startHeartbeat();
    return storage;
  }

  get lease(): DynamoDbLease {
    return {
      ownerId: this.ownerId,
      fencingToken: this.fencingToken,
      expiresAt: Date.now() + this.leaseTtlMs,
    };
  }

  async commit(writes: readonly StorageWrite[], context: Context): Promise<Seq> {
    return this.enqueue(async () => {
      this.assertOpen();
      throwIfAborted(context);
      const prepared = this.memory.prepareCommit(writes);
      const json = JSON.stringify(prepared.writes);
      const hash = payloadHash(json);
      const chunks = chunkUtf8(json, MAX_CHUNK_BYTES);
      const durableNextId = Math.max(
        this.nextId,
        maxIdFromWrites(prepared.writes) + 1,
      );
      const persistedNextId = Number.isSafeInteger(durableNextId)
        ? durableNextId
        : Number.MAX_SAFE_INTEGER;
      if (chunks.length + 3 > MAX_TRANSACT_ITEMS) {
        throw new Error(
          `Commit ${prepared.seq} is too large for a DynamoDB transaction (${chunks.length} chunks)`,
        );
      }
      try {
        await this.transactWrite(
          [
            this.leaseCondition(),
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: this.pk,
                  sk: commitSk(prepared.seq),
                  kind: "commit",
                  seq: prepared.seq,
                  fencingToken: this.fencingToken,
                  chunkCount: chunks.length,
                  payloadHash: hash,
                  ...(chunks.length === 1 ? { payload: chunks[0] } : {}),
                },
                ConditionExpression: "attribute_not_exists(sk)",
              },
            },
            ...(chunks.length === 1
              ? []
              : chunks.map((payload, index) => ({
                  Put: {
                    TableName: this.tableName,
                    Item: {
                      pk: this.pk,
                      sk: commitSk(prepared.seq, index),
                      kind: "chunk",
                      seq: prepared.seq,
                      payload,
                    },
                    ConditionExpression: "attribute_not_exists(sk)",
                  },
                }))),
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: this.pk, sk: META_SK },
                UpdateExpression: "SET nextSeq = :nextSeq, nextId = :nextId",
                ExpressionAttributeValues: {
                  ":nextSeq": prepared.seq + 1,
                  ":nextId": persistedNextId,
                },
              },
            },
          ],
          "commit",
          `${prepared.seq}:${hash}`,
        );
      } catch (error) {
        if (error instanceof TransactionCanceledException) {
          const reasons = error.CancellationReasons ?? [];
          if (reasons[0]?.Code === "ConditionalCheckFailed") {
            throw new FencedWriterError(
              `Commit ${prepared.seq} rejected: fencing token ${this.fencingToken} is not current`,
            );
          }
          if (reasons[1]?.Code === "ConditionalCheckFailed") {
            return this.commitIfIdempotent(prepared.seq, hash, json, prepared.apply);
          }
        }
        throw error;
      }
      this.nextId = durableNextId;
      return prepared.apply();
    });
  }

  async mintId<I extends Id<string>>(): Promise<I> {
    return this.enqueue(async () => {
      this.assertOpen();
      if (!Number.isSafeInteger(this.nextId)) {
        throw new Error("ID space is exhausted");
      }
      const id = this.nextId;
      try {
        await this.transactWrite(
          [
            this.leaseCondition(),
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: this.pk, sk: META_SK },
                UpdateExpression: "SET nextId = :next",
                ExpressionAttributeValues: {
                  ":next": id + 1,
                },
              },
            },
          ],
          "mint",
          String(id),
        );
      } catch (error) {
        if (error instanceof TransactionCanceledException) {
          const reasons = error.CancellationReasons ?? [];
          if (reasons[0]?.Code === "ConditionalCheckFailed") {
            throw new FencedWriterError(
              `mintId rejected: fencing token ${this.fencingToken} is not current`,
            );
          }
        }
        throw error;
      }
      this.nextId = id + 1;
      return id as I;
    });
  }

  async conversation(id: ConversationId, context: Context) {
    this.assertOpen();
    return this.memory.conversation(id, context);
  }
  async scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ) {
    this.assertOpen();
    return this.memory.scanConversations(query, limit, cursor, context);
  }
  async entry(
    idOrConversationId: EntryId | ConversationId,
    idOrContext: Context | EntryId,
    context?: Context,
  ) {
    this.assertOpen();
    if (context === undefined) {
      return this.memory.entry(idOrConversationId as EntryId, idOrContext as Context);
    }
    return this.memory.entry(
      idOrConversationId as ConversationId,
      idOrContext as EntryId,
      context,
    );
  }
  async findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
    context: Context,
  ) {
    this.assertOpen();
    return this.memory.findLatestHeadMarker(
      conversationId,
      atOrBeforeEntryId,
      context,
    );
  }
  async scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ) {
    this.assertOpen();
    return this.memory.scanEntries(query, limit, cursor, context);
  }
  async task(id: TaskId, context: Context) {
    this.assertOpen();
    return this.memory.task(id, context);
  }
  async scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ) {
    this.assertOpen();
    return this.memory.scanTasks(query, limit, cursor, context);
  }
  async submission(id: SubmissionId, context: Context) {
    this.assertOpen();
    return this.memory.submission(id, context);
  }
  async scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ) {
    this.assertOpen();
    return this.memory.scanSubmissions(query, limit, cursor, context);
  }
  async submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
    context: Context,
  ) {
    this.assertOpen();
    return this.memory.submissionByRequest(conversationId, requestId, context);
  }
  async findDocument(address: DocumentAddress, at: DocumentPoint, context: Context) {
    this.assertOpen();
    return this.memory.findDocument(address, at, context);
  }
  async document(id: DocumentId, at: DocumentPoint, context: Context) {
    this.assertOpen();
    return this.memory.document(id, at, context);
  }
  async scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<import("@earendil-works/pi-durable").DocumentRecord, Cursor>> {
    this.assertOpen();
    return this.memory.scanDocuments(query, limit, cursor, context);
  }

  async close(context: Context): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    try {
      await this.docs.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: this.pk, sk: LEASE_SK },
          UpdateExpression: "SET expiresAt = :zero",
          ConditionExpression: "ownerId = :owner AND fencingToken = :token",
          ExpressionAttributeValues: {
            ":zero": 0,
            ":owner": this.ownerId,
            ":token": this.fencingToken,
          },
        }),
      );
    } catch (error) {
      if (
        !isConditionalCheckFailed(error) &&
        !(error instanceof ResourceNotFoundException) &&
        (error as { name?: string }).name !== "ResourceNotFoundException"
      ) {
        await this.memory.close(context);
        throw error;
      }
    }
    await this.memory.close(context);
  }

  private async transactWrite(
    items: NonNullable<TransactWriteCommandInput["TransactItems"]>,
    purpose: string,
    extra: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.docs.send(
          new TransactWriteCommand({
            TransactItems: items,
            ClientRequestToken: transactClientRequestToken([
              this.pk,
              this.ownerId,
              this.fencingToken,
              purpose,
              extra,
              attempt,
              Date.now(),
              process.hrtime.bigint(),
              randomUUID(),
            ]),
          }),
        );
        return;
      } catch (error) {
        lastError = error;
        if (!isIdempotentParameterMismatch(error)) throw error;
      }
    }
    throw lastError;
  }

  private leaseCondition() {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: { pk: this.pk, sk: LEASE_SK },
        ConditionExpression: "ownerId = :owner AND fencingToken = :token",
        ExpressionAttributeValues: {
          ":owner": this.ownerId,
          ":token": this.fencingToken,
        },
      },
    };
  }

  private async recover(): Promise<void> {
    const items = await this.queryAll();
    const bySeq = new Map<
      number,
      { head?: Record<string, unknown>; chunks: Map<number, string> }
    >();
    let metaNextId = INITIAL_NEXT_ID;
    for (const item of items) {
      const sk = String(item.sk);
      if (sk === META_SK) {
        if (typeof item.nextId === "number") metaNextId = item.nextId;
        continue;
      }
      const seq = parseCommitSeq(sk);
      if (seq === undefined) continue;
      let group = bySeq.get(seq);
      if (group === undefined) {
        group = { chunks: new Map() };
        bySeq.set(seq, group);
      }
      if (isChunkSk(sk)) {
        const chunk = Number(sk.slice(sk.lastIndexOf("c") + 1));
        if (typeof item.payload === "string") group.chunks.set(chunk, item.payload);
      } else {
        group.head = item;
        if (typeof item.payload === "string") group.chunks.set(0, item.payload);
      }
    }

    const seqs = [...bySeq.keys()].sort((a, b) => a - b);
    for (const seq of seqs) {
      const group = bySeq.get(seq);
      if (group?.head === undefined) continue;
      const chunkCount = Number(group.head.chunkCount ?? 1);
      const parts: string[] = [];
      let complete = true;
      for (let index = 0; index < chunkCount; index++) {
        const part = group.chunks.get(index);
        if (part === undefined) {
          complete = false;
          break;
        }
        parts.push(part);
      }
      if (!complete) continue;
      const json = parts.join("");
      const writes = JSON.parse(json) as StorageWrite[];
      this.memory.prepareCommit(writes, asSeq(seq)).apply();
      this.nextId = Math.max(this.nextId, maxIdFromWrites(writes) + 1);
    }

    this.nextId = Math.max(this.nextId, metaNextId);
    const current = await this.getMeta();
    const durableNextId = Math.max(this.nextId, current.nextId, INITIAL_NEXT_ID);
    this.nextId = durableNextId;
    if (current.nextId < durableNextId || current.nextSeq === INITIAL_NEXT_SEQ) {
      await this.docs.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: this.pk, sk: META_SK },
          UpdateExpression:
            "SET nextId = :id, nextSeq = if_not_exists(nextSeq, :seq)",
          ExpressionAttributeValues: {
            ":id": durableNextId,
            ":seq": INITIAL_NEXT_SEQ,
          },
        }),
      );
    }
  }

  private async queryAll(): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.docs.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": this.pk },
          ConsistentRead: true,
          ...(exclusiveStartKey !== undefined
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );
      for (const item of page.Items ?? []) {
        items.push(item);
      }
      exclusiveStartKey = page.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey !== undefined);
    return items;
  }

  private async getMeta(): Promise<{ nextId: number; nextSeq: number }> {
    const result = await this.docs.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: this.pk, sk: META_SK },
        ConsistentRead: true,
      }),
    );
    const nextId =
      typeof result.Item?.nextId === "number"
        ? result.Item.nextId
        : INITIAL_NEXT_ID;
    const nextSeq =
      typeof result.Item?.nextSeq === "number"
        ? result.Item.nextSeq
        : INITIAL_NEXT_SEQ;
    if (result.Item === undefined) {
      try {
        await this.transactWrite(
          [
            this.leaseCondition(),
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: this.pk,
                  sk: META_SK,
                  kind: "meta",
                  nextId: INITIAL_NEXT_ID,
                  nextSeq: INITIAL_NEXT_SEQ,
                },
                ConditionExpression: "attribute_not_exists(sk)",
              },
            },
          ],
          "meta",
          "init",
        );
      } catch (error) {
        if (
          error instanceof TransactionCanceledException &&
          error.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed"
        ) {
          throw new FencedWriterError();
        }
      }
      return { nextId: INITIAL_NEXT_ID, nextSeq: INITIAL_NEXT_SEQ };
    }
    return { nextId, nextSeq };
  }

  private async commitIfIdempotent(
    seq: number,
    hash: string,
    json: string,
    apply: () => Seq,
  ): Promise<Seq> {
    const existing = await this.docs.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: this.pk, sk: commitSk(seq) },
        ConsistentRead: true,
      }),
    );
    if (existing.Item?.payloadHash === hash) {
      return apply();
    }
    if (existing.Item !== undefined) {
      throw new Error(
        `Commit sequence ${seq} already exists with a different payload`,
      );
    }
    void json;
    throw new Error(`Commit sequence ${seq} was not stored`);
  }

  private startHeartbeat(): void {
    const interval = Math.max(250, Math.floor(this.leaseTtlMs / 3));
    this.heartbeat = setInterval(() => {
      void this.renewLease();
    }, interval);
    this.heartbeat.unref();
  }

  private async renewLease(): Promise<void> {
    if (this.closed) return;
    try {
      await this.docs.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: this.pk, sk: LEASE_SK },
          UpdateExpression: "SET expiresAt = :exp",
          ConditionExpression: "ownerId = :owner AND fencingToken = :token",
          ExpressionAttributeValues: {
            ":exp": Date.now() + this.leaseTtlMs,
            ":owner": this.ownerId,
            ":token": this.fencingToken,
          },
        }),
      );
    } catch (error) {
      if (isConditionalCheckFailed(error)) this.markFenced();
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private markFenced(): void {
    this.fenced = true;
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private assertOpen(): void {
    if (this.fenced) {
      throw new FencedWriterError(
        `DynamoDB session lease fencing token ${this.fencingToken} is no longer current`,
      );
    }
    if (this.closed) throw new Error("DynamoDbStorage is closed");
  }
}

async function acquireLease(
  docs: DynamoDBDocumentClient,
  options: DynamoDbStorageOptions & { readonly ownerId: string },
): Promise<number> {
  const pk = sessionPk(options.sessionId);
  const ownerId = options.ownerId;
  const ttl = options.leaseTtlMs ?? 15_000;
  const timeout = options.acquireTimeoutMs ?? Math.max(ttl * 4, 8_000);
  const retryMs = options.acquireRetryMs ?? 100;
  const deadline = Date.now() + timeout;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await docs.send(
        new UpdateCommand({
          TableName: options.tableName,
          Key: { pk, sk: LEASE_SK },
          UpdateExpression:
            "SET ownerId = :owner, expiresAt = :exp, fencingToken = if_not_exists(fencingToken, :zero) + :one",
          ConditionExpression: "attribute_not_exists(sk) OR expiresAt < :now",
          ExpressionAttributeValues: {
            ":owner": ownerId,
            ":exp": Date.now() + ttl,
            ":now": Date.now(),
            ":zero": 0,
            ":one": 1,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      const token = result.Attributes?.fencingToken;
      if (typeof token !== "number") {
        throw new Error("Lease acquire did not return a fencing token");
      }
      return token;
    } catch (error) {
      lastError = error;
      if (!isConditionalCheckFailed(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
  throw new LeaseContentionError(
    `Timed out acquiring DynamoDB session lease for ${options.sessionId}${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`,
  );
}

export async function openDynamoDbStorage(
  options: DynamoDbStorageOptions,
): Promise<DynamoDbStorage> {
  return DynamoDbStorage.open(options);
}
