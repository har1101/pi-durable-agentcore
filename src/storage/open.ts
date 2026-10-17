import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Storage } from "@earendil-works/pi-durable";
import {
  DynamoDbEffectLedger,
  FileEffectLedger,
  type EffectLedger,
} from "../effects.js";
import {
  DynamoDbEventRecorder,
  FileEventRecorder,
  type EventRecorder,
} from "../event-recorder.js";
import {
  DynamoDbWakeStore,
  NoopWakeStore,
  type WakeStore,
} from "../wake-store.js";
import {
  createDynamoDbDocumentClient,
  DynamoDbStorage,
  ensureSessionTable,
  openDynamoDbStorage,
} from "./dynamodb.js";

export type StorageBackend = "dynamodb" | "sqlite";

export interface OpenSessionStorageOptions {
  readonly sessionId: string;
  readonly sessionPath: string;
  readonly backend?: StorageBackend;
}

export function configuredStorageBackend(): StorageBackend {
  const explicit = process.env.STORAGE_BACKEND;
  if (explicit === "sqlite" || explicit === "dynamodb") return explicit;
  return process.env.DYNAMODB_TABLE ? "dynamodb" : "sqlite";
}

export interface DynamoDbSettings {
  readonly tableName: string;
  readonly endpoint?: string;
  readonly region?: string;
}

export function dynamoDbSettings(): DynamoDbSettings {
  const tableName = process.env.DYNAMODB_TABLE ?? "pi-durable-agentcore-sessions";
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  return {
    tableName,
    ...(endpoint !== undefined && endpoint !== "" ? { endpoint } : {}),
    ...(region !== undefined && region !== "" ? { region } : {}),
  };
}

let sharedDocs: DynamoDBDocumentClient | undefined;
let ensured: Promise<void> | undefined;

/** One DynamoDB document client per process; DynamoDB Local tables are created on first use. */
export async function sharedDynamoDb(): Promise<{
  docs: DynamoDBDocumentClient;
  settings: DynamoDbSettings;
}> {
  const settings = dynamoDbSettings();
  sharedDocs ??= createDynamoDbDocumentClient(settings);
  if (settings.endpoint !== undefined) {
    ensured ??= ensureSessionTable(settings.tableName, settings).catch((error) => {
      ensured = undefined;
      throw error;
    });
    await ensured;
  }
  return { docs: sharedDocs, settings };
}

export function sessionDirectory(stateDirectory: string, sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return join(stateDirectory, "sessions", digest);
}

/**
 * The session's event log. Readable without the session lease, so `/events`
 * works while another process or microVM owns the session.
 */
export async function openEventRecorder(
  sessionId: string,
  sessionPath: string,
  backend: StorageBackend = configuredStorageBackend(),
): Promise<EventRecorder> {
  if (backend === "dynamodb") {
    const { docs, settings } = await sharedDynamoDb();
    return new DynamoDbEventRecorder(docs, settings.tableName, sessionId);
  }
  return FileEventRecorder.open(join(sessionPath, "events.jsonl"), sessionId);
}

export interface OpenedSessionStorage {
  readonly storage: Storage;
  readonly backend: StorageBackend;
  readonly location: string;
  readonly wakes: WakeStore;
  readonly effects: EffectLedger;
}

export async function openSessionStorage(
  options: OpenSessionStorageOptions,
): Promise<OpenedSessionStorage> {
  const backend = options.backend ?? configuredStorageBackend();
  if (backend === "dynamodb") {
    const { docs, settings } = await sharedDynamoDb();
    const storage = await openDynamoDbStorage({
      ...settings,
      client: docs,
      sessionId: options.sessionId,
      leaseTtlMs: Number(process.env.PI_SESSION_LEASE_TTL_MS ?? 15_000),
      acquireTimeoutMs: Number(
        process.env.PI_SESSION_LEASE_ACQUIRE_TIMEOUT_MS ?? 12_000,
      ),
    });
    return {
      storage,
      backend,
      location: `dynamodb:${settings.tableName}#${options.sessionId}`,
      wakes: new DynamoDbWakeStore(
        docs,
        settings.tableName,
        options.sessionId,
        () => (storage as DynamoDbStorage).fencingToken,
      ),
      effects: new DynamoDbEffectLedger(docs, settings.tableName, options.sessionId),
    };
  }
  const { openNodeSqliteStorage } = await import(
    "@earendil-works/pi-durable/storage/sqlite/node"
  );
  const database = join(options.sessionPath, "session.sqlite");
  return {
    storage: await openNodeSqliteStorage(database),
    backend,
    location: database,
    wakes: new NoopWakeStore(),
    effects: new FileEffectLedger(join(options.sessionPath, "effects")),
  };
}
