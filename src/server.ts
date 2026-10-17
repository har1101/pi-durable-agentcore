import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { SessionFailed } from "@earendil-works/pi-durable";
import { openEventLog } from "./event-recorder.js";
import {
  authorizedApprover,
  parseApprovers,
  parseInvocation,
  type Invocation,
} from "./invocation.js";
import { approvalIdOf, ParkStore } from "./parks.js";
import {
  CLOSED,
  PiRuntime,
  sessionDirectory,
  type Closed,
  type ModelMode,
} from "./runtime.js";
import { LeaseContentionError } from "./storage/errors.js";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 8080);
const stateDirectory =
  process.env.STATE_DIRECTORY ?? "/tmp/pi-durable-agentcore";
const configuredMode = process.env.MODEL_PROVIDER ?? "scripted";
if (configuredMode !== "scripted" && configuredMode !== "bedrock") {
  throw new Error("MODEL_PROVIDER must be scripted or bedrock");
}
const modelMode: ModelMode = configuredMode;
const runtimes = new Map<string, Promise<PiRuntime>>();
const approvers = parseApprovers(process.env.APPROVER_USER_IDS);

function sessionId(request: IncomingMessage, url?: URL): string {
  const header = request.headers["x-amzn-bedrock-agentcore-runtime-session-id"];
  const value = Array.isArray(header) ? header[0] : header;
  return value ?? url?.searchParams.get("sessionId") ?? "local-session";
}

function userId(request: IncomingMessage): string | undefined {
  const header = request.headers["x-amzn-bedrock-agentcore-runtime-user-id"];
  return (Array.isArray(header) ? header[0] : header) || undefined;
}

function runtimeFor(id: string): Promise<PiRuntime> {
  const existing = runtimes.get(id);
  if (existing) return existing;
  const forget = () => {
    if (runtimes.get(id) === pending) runtimes.delete(id);
  };
  const pending: Promise<PiRuntime> = PiRuntime.open({
    stateDirectory,
    sessionId: id,
    modelMode,
    resume: true,
    onClosing: forget,
  });
  runtimes.set(id, pending);
  pending.catch(forget);
  return pending;
}

/** Runs `operation` on an open runtime, opening a fresh one when the current one parked and closed under it. */
async function withRuntime<T>(
  id: string,
  operation: (runtime: PiRuntime) => Promise<T | Closed>,
): Promise<T> {
  for (;;) {
    const runtime = await runtimeFor(id);
    const result = await operation(runtime);
    if (result !== CLOSED) return result as T;
    await runtime.closed;
  }
}

function forgetRuntime(id: string): void {
  const pending = runtimes.get(id);
  if (!pending) return;
  runtimes.delete(id);
  void pending
    .then((runtime) => runtime.close())
    .catch(() => undefined);
}

function isFailedSessionError(error: unknown): boolean {
  if (error instanceof SessionFailed) return true;
  const name = (error as { name?: string }).name;
  const message = error instanceof Error ? error.message : String(error);
  return (
    name === "SessionFailed" ||
    name === "IdempotentParameterMismatchException" ||
    message.includes("Session failed after a storage error") ||
    message.includes("idempotent token")
  );
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 1_000_000) throw new Error("Request body exceeds 1 MB");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

async function invocation(
  request: IncomingMessage,
  response: ServerResponse,
  command: Invocation,
): Promise<void> {
  const id = sessionId(request);
  switch (command.action) {
    case "invoke": {
      const requestId = command.requestId ?? randomUUID();
      const caller = userId(request);
      const input = {
        prompt: command.prompt,
        requestId,
        ...(caller !== undefined ? { userId: caller } : {}),
      };
      json(response, 200, await withRuntime(id, (runtime) => runtime.invoke(input)));
      return;
    }
    case "decide": {
      const approver = authorizedApprover(userId(request), approvers);
      if (approver === undefined) {
        response.setHeader("x-amzn-ErrorType", "AccessDeniedException");
        json(response, 403, { message: "caller is not an approver" });
        return;
      }
      const outcome = await new ParkStore(id).decide(
        command.approval,
        command.decision,
        approver,
        Date.now(),
      );
      switch (outcome.kind) {
        case "unknown":
          json(response, 404, { status: "error", reason: "unknown_approval" });
          return;
        case "self_approval":
          response.setHeader("x-amzn-ErrorType", "AccessDeniedException");
          json(response, 403, { message: "the requester cannot decide" });
          return;
        case "already_decided":
        case "expired":
          json(response, 409, {
            status: "error",
            reason: outcome.kind,
            decision: outcome.park.decided!.decision,
            decidedBy: outcome.park.decided!.by,
          });
          return;
        case "recorded":
        case "duplicate": {
          if (outcome.kind === "recorded") {
            await openEventLog({
              sessionId: id,
              sessionPath: sessionDirectory(stateDirectory, id),
            }).record("approval_decided", {
              approvalId: approvalIdOf(outcome.park.id),
              decision: command.decision,
              decidedBy: approver,
            });
          }
          try {
            const park = outcome.park;
            json(response, 200, await withRuntime(id, (runtime) => runtime.deliver(park)));
          } catch (error) {
            if (!(error instanceof LeaseContentionError)) throw error;
            json(response, 202, { status: "accepted", decision: command.decision });
          }
          return;
        }
      }
      return;
    }
    case "resume": {
      try {
        const status = await (await runtimeFor(id)).resume();
        if (status === "idle") json(response, 200, { status });
        else json(response, 202, { status: "accepted" });
      } catch (error) {
        if (!(error instanceof LeaseContentionError)) throw error;
        json(response, 409, { status: "busy" });
      }
      return;
    }
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  try {
    if (request.method === "GET" && url.pathname === "/ping") {
      const values = await Promise.all([...runtimes.values()]);
      json(response, 200, {
        status: values.some((runtime) => runtime.busy)
          ? "HealthyBusy"
          : "Healthy",
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/invocations") {
      const parsed = parseInvocation(await body(request));
      if (!parsed.ok) {
        response.setHeader("x-amzn-ErrorType", "ValidationException");
        json(response, 400, { message: parsed.message });
        return;
      }
      await invocation(request, response, parsed.invocation);
      return;
    }

    if (request.method === "GET" && url.pathname === "/events") {
      const id = sessionId(request, url);
      const events = await openEventLog({
        sessionId: id,
        sessionPath: sessionDirectory(stateDirectory, id),
      }).list();
      if (request.headers.accept?.includes("text/html")) {
        const escaped = JSON.stringify(events, null, 2)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          `<!doctype html><title>Pi Durable checkpoints</title><h1>Committed steps</h1><pre>${escaped}</pre>`,
        );
      } else {
        json(response, 200, { sessionId: id, events });
      }
      return;
    }

    response.setHeader("x-amzn-ErrorType", "ResourceNotFoundException");
    json(response, 404, { message: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    if (isFailedSessionError(error)) {
      forgetRuntime(sessionId(request, url));
    }
    process.stderr.write(
      `RuntimeClientError ${request.method} ${url.pathname}: ${message}\n${stack ?? ""}\n`,
    );
    response.setHeader("x-amzn-ErrorType", "RuntimeClientError");
    json(response, 500, { message });
  }
});

server.listen(port, host, () => {
  process.stdout.write(
    `Pi Durable AgentCore HTTP server listening on http://${host}:${port} (${modelMode})\n`,
  );
});

async function shutdown(): Promise<void> {
  server.close();
  const opened = await Promise.allSettled([...runtimes.values()]);
  await Promise.all(
    opened
      .filter(
        (result): result is PromiseFulfilledResult<PiRuntime> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value.close()),
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
