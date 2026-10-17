import { join } from "node:path";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Storage } from "@earendil-works/pi-durable";
import {
  DynamoDbEffectLedger,
  MemoryEffectLedger,
  type EffectLedger,
} from "../effects.js";
import { DynamoDbEventLog, FileEventLog, type EventLog } from "../event-log.js";
import { DynamoDbWakeStore, NoWakeStore, type WakeStore } from "../wake.js";
import {
  createDynamoDbDocumentClient,
  ensureSessionTable,
  openDynamoDbStorage,
} from "./dynamodb.js";

export type StorageBackend = "dynamodb" | "sqlite";

export interface OpenSessionStorageOptions {
  readonly sessionId: string;
  readonly sessionPath: string;
  readonly backend?: StorageBackend;
}

/** Everything one session persists, chosen together so they share a backend. */
export interface SessionBackend {
  readonly backend: StorageBackend;
  readonly location: string;
  readonly storage: Storage;
  readonly events: EventLog;
  readonly effects: EffectLedger;
  readonly wake: WakeStore;
}

export function configuredStorageBackend(): StorageBackend {
  const explicit = process.env.STORAGE_BACKEND;
  if (explicit === "sqlite" || explicit === "dynamodb") return explicit;
  return process.env.DYNAMODB_TABLE ? "dynamodb" : "sqlite";
}

export function sessionTableName(): string {
  return process.env.DYNAMODB_TABLE ?? "pi-durable-agentcore-sessions";
}

function dynamoDbEndpoint(): string | undefined {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  return endpoint !== undefined && endpoint !== "" ? endpoint : undefined;
}

function dynamoDbRegion(): string | undefined {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  return region !== undefined && region !== "" ? region : undefined;
}

let sharedClient: DynamoDBDocumentClient | undefined;
let tableReady: Promise<void> | undefined;

/** One client per process; DynamoDB Local gets its table created on first use. */
export async function sessionTableClient(): Promise<DynamoDBDocumentClient> {
  const endpoint = dynamoDbEndpoint();
  const region = dynamoDbRegion();
  const options = {
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(region !== undefined ? { region } : {}),
  };
  sharedClient ??= createDynamoDbDocumentClient(options);
  if (endpoint !== undefined) {
    tableReady ??= ensureSessionTable(sessionTableName(), options);
    await tableReady;
  }
  return sharedClient;
}

/** The event log alone: readable without taking the session lease. */
export async function openEventLog(
  options: OpenSessionStorageOptions,
): Promise<EventLog> {
  const backend = options.backend ?? configuredStorageBackend();
  if (backend === "dynamodb") {
    return new DynamoDbEventLog(
      await sessionTableClient(),
      sessionTableName(),
      options.sessionId,
    );
  }
  return new FileEventLog(
    join(options.sessionPath, "events.jsonl"),
    options.sessionId,
  );
}

export async function openSessionBackend(
  options: OpenSessionStorageOptions,
): Promise<SessionBackend> {
  const backend = options.backend ?? configuredStorageBackend();
  const events = await openEventLog({ ...options, backend });
  if (backend === "dynamodb") {
    const tableName = sessionTableName();
    const storage = await openDynamoDbStorage({
      tableName,
      sessionId: options.sessionId,
      client: await sessionTableClient(),
      leaseTtlMs: Number(process.env.PI_SESSION_LEASE_TTL_MS ?? 15_000),
      acquireTimeoutMs: Number(
        process.env.PI_SESSION_LEASE_ACQUIRE_TIMEOUT_MS ?? 12_000,
      ),
    });
    return {
      backend,
      storage,
      events,
      effects: new DynamoDbEffectLedger(await sessionTableClient(), tableName),
      wake: new DynamoDbWakeStore(
        await sessionTableClient(),
        tableName,
        options.sessionId,
        storage.fencingToken,
      ),
      location: `dynamodb:${tableName}#${options.sessionId}`,
    };
  }
  const { openNodeSqliteStorage } = await import(
    "@earendil-works/pi-durable/storage/sqlite/node"
  );
  const database = join(options.sessionPath, "session.sqlite");
  return {
    backend,
    storage: await openNodeSqliteStorage(database),
    events,
    effects: new MemoryEffectLedger(),
    wake: new NoWakeStore(),
    location: database,
  };
}
