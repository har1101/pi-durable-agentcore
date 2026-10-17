import { join } from "node:path";
import type { Storage } from "@earendil-works/pi-durable";
import { openDynamoDbStorage } from "./dynamodb.js";

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

export async function openSessionStorage(
  options: OpenSessionStorageOptions,
): Promise<{ storage: Storage; backend: StorageBackend; location: string }> {
  const backend = options.backend ?? configuredStorageBackend();
  if (backend === "dynamodb") {
    const tableName =
      process.env.DYNAMODB_TABLE ?? "pi-durable-agentcore-sessions";
    const endpoint = process.env.DYNAMODB_ENDPOINT;
    const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    const storage = await openDynamoDbStorage({
      tableName,
      sessionId: options.sessionId,
      ...(endpoint !== undefined && endpoint !== "" ? { endpoint } : {}),
      ...(region !== undefined && region !== "" ? { region } : {}),
      leaseTtlMs: Number(process.env.PI_SESSION_LEASE_TTL_MS ?? 15_000),
      acquireTimeoutMs: Number(
        process.env.PI_SESSION_LEASE_ACQUIRE_TIMEOUT_MS ?? 12_000,
      ),
      ensureTable: Boolean(process.env.DYNAMODB_ENDPOINT),
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
