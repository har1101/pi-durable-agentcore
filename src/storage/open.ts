import { join } from "node:path";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Storage } from "@earendil-works/pi-durable";
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

export function configuredStorageBackend(): StorageBackend {
  const explicit = process.env.STORAGE_BACKEND;
  if (explicit === "sqlite" || explicit === "dynamodb") return explicit;
  return process.env.DYNAMODB_TABLE ? "dynamodb" : "sqlite";
}

export interface SessionTable {
  readonly docs: DynamoDBDocumentClient;
  readonly tableName: string;
}

let shared: { key: string; table: Promise<SessionTable> } | undefined;

/**
 * The session table every DynamoDB reader and writer in this process shares (storage, event log, parks).
 * Against DynamoDB Local the table and its indexes are created on first use.
 */
export function sessionTable(): Promise<SessionTable> {
  const tableName =
    process.env.DYNAMODB_TABLE ?? "pi-durable-agentcore-sessions";
  const endpoint = process.env.DYNAMODB_ENDPOINT || undefined;
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || undefined;
  const key = JSON.stringify([tableName, endpoint, region]);
  if (shared?.key !== key) {
    const options = {
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(region !== undefined ? { region } : {}),
    };
    const table = (async () => {
      if (endpoint !== undefined) await ensureSessionTable(tableName, options);
      return { docs: createDynamoDbDocumentClient(options), tableName };
    })();
    shared = { key, table };
    table.catch(() => {
      if (shared?.table === table) shared = undefined;
    });
  }
  return shared.table;
}

export async function openSessionStorage(
  options: OpenSessionStorageOptions,
): Promise<{ storage: Storage; backend: StorageBackend; location: string }> {
  const backend = options.backend ?? configuredStorageBackend();
  if (backend === "dynamodb") {
    const { docs, tableName } = await sessionTable();
    const storage = await openDynamoDbStorage({
      tableName,
      sessionId: options.sessionId,
      client: docs,
      leaseTtlMs: Number(process.env.PI_SESSION_LEASE_TTL_MS ?? 15_000),
      acquireTimeoutMs: Number(
        process.env.PI_SESSION_LEASE_ACQUIRE_TIMEOUT_MS ?? 12_000,
      ),
    });
    return {
      storage,
      backend,
      location: `dynamodb:${tableName}#${options.sessionId}`,
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
  };
}
