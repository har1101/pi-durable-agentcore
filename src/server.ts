import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";
import { SessionFailed } from "@earendil-works/pi-durable";
import {
  parseApprovalRequest,
  verifyApprovalSignature,
} from "./approvals.js";
import {
  ApprovalConflictError,
  ApprovalNotFoundError,
  PiRuntime,
  type InvokeResult,
  type ModelMode,
  type WorkState,
} from "./runtime.js";
import { LeaseContentionError } from "./storage/errors.js";
import { openEventRecorder, sessionDirectory } from "./storage/open.js";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 8080);
const stateDirectory =
  process.env.STATE_DIRECTORY ?? "/tmp/pi-durable-agentcore";
const configuredMode = process.env.MODEL_PROVIDER ?? "scripted";
if (configuredMode !== "scripted" && configuredMode !== "bedrock") {
  throw new Error("MODEL_PROVIDER must be scripted or bedrock");
}
const modelMode: ModelMode = configuredMode;

function isFailedSessionError(error: unknown): boolean {
  if (error instanceof SessionFailed) return true;
  const name = (error as { name?: string }).name;
  const message = error instanceof Error ? error.message : String(error);
  return (
    name === "SessionFailed" ||
    name === "FencedWriterError" ||
    name === "IdempotentParameterMismatchException" ||
    message.includes("Session failed after a storage error") ||
    message.includes("idempotent token")
  );
}

function isLeaseContention(error: unknown): boolean {
  return (
    error instanceof LeaseContentionError ||
    (error as { name?: string }).name === "LeaseContentionError"
  );
}

/**
 * One AgentCore session in this process. Operations on a session run one at a
 * time. The runtime (Harness + lease) stays open between operations while the
 * session is idle or working, and is closed as soon as the session parks on a
 * human or a clock, so the lease is free for whichever instance the next
 * request or the resumer reaches.
 */
class SessionHost {
  readonly id: string;
  #runtime: Promise<PiRuntime> | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #operations = 0;

  constructor(id: string) {
    this.id = id;
  }

  get busy(): boolean {
    return this.#operations > 0;
  }

  run<T>(operation: (runtime: PiRuntime) => Promise<T>): Promise<T> {
    this.#operations++;
    const task = this.#queue.then(() => this.#execute(operation));
    this.#queue = task.catch(() => undefined);
    return task.finally(() => {
      this.#operations--;
    });
  }

  async close(): Promise<void> {
    const pending = this.#runtime;
    this.#runtime = undefined;
    if (pending === undefined) return;
    try {
      await (await pending).close();
    } catch (error) {
      process.stderr.write(
        `RuntimeCloseError ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  async #execute<T>(operation: (runtime: PiRuntime) => Promise<T>): Promise<T> {
    let runtime: PiRuntime;
    try {
      runtime = await this.#open();
      await runtime.beginWork();
    } catch (error) {
      if (isFailedSessionError(error)) await this.close();
      throw error;
    }
    let state: WorkState | undefined;
    try {
      return await operation(runtime);
    } catch (error) {
      if (isFailedSessionError(error)) {
        await this.close();
      }
      throw error;
    } finally {
      try {
        state = await runtime.endWork();
      } catch (error) {
        process.stderr.write(
          `WAKE_SYNC_FAILED ${error instanceof Error ? error.message : String(error)}\n`,
        );
        if (isFailedSessionError(error)) await this.close();
      }
      if (state === "parked") await this.close();
    }
  }

  #open(): Promise<PiRuntime> {
    if (this.#runtime === undefined) {
      const pending = PiRuntime.open({
        stateDirectory,
        sessionId: this.id,
        modelMode,
        resume: true,
      });
      this.#runtime = pending;
      pending.catch(() => {
        if (this.#runtime === pending) this.#runtime = undefined;
      });
    }
    return this.#runtime;
  }
}

const sessions = new Map<string, SessionHost>();

function sessionHost(id: string): SessionHost {
  let session = sessions.get(id);
  if (session === undefined) {
    session = new SessionHost(id);
    sessions.set(id, session);
  }
  return session;
}

function sessionId(request: IncomingMessage, url?: URL): string {
  const header = request.headers["x-amzn-bedrock-agentcore-runtime-session-id"];
  const value = Array.isArray(header) ? header[0] : header;
  return value ?? url?.searchParams.get("sessionId") ?? "local-session";
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function fail(
  response: ServerResponse,
  status: number,
  errorType: string,
  message: string,
): void {
  response.setHeader("x-amzn-ErrorType", errorType);
  json(response, status, { message });
}

async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 1_000_000) throw new Error("Request body exceeds 1 MB");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function approvalSigningKey(): string | undefined {
  const key = process.env.APPROVAL_SIGNING_KEY;
  return key !== undefined && key.length >= 32 ? key : undefined;
}

async function handlePrompt(
  id: string,
  input: Record<string, unknown>,
  response: ServerResponse,
): Promise<void> {
  if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
    fail(response, 400, "ValidationException", "prompt must be a non-empty string");
    return;
  }
  if (input.requestId !== undefined && typeof input.requestId !== "string") {
    fail(response, 400, "ValidationException", "requestId must be a string");
    return;
  }
  const prompt = input.prompt;
  const requestId = input.requestId;
  const result = await sessionHost(id).run((runtime) =>
    runtime.invoke({
      prompt,
      ...(typeof requestId === "string" ? { requestId } : {}),
    }),
  );
  json(response, 200, result);
}

async function handleApproval(
  id: string,
  input: Record<string, unknown>,
  response: ServerResponse,
): Promise<void> {
  const parsed = parseApprovalRequest(input);
  if (!parsed.ok) {
    fail(response, 400, "ValidationException", parsed.message);
    return;
  }
  const signingKey = approvalSigningKey();
  if (signingKey === undefined) {
    fail(
      response,
      403,
      "AccessDeniedException",
      "Approvals are not configured on this runtime (APPROVAL_SIGNING_KEY); pending approvals can only time out",
    );
    return;
  }
  const { approvalId, decision, signature, reason } = parsed.value;
  if (!verifyApprovalSignature(signingKey, approvalId, decision, signature)) {
    fail(response, 403, "AccessDeniedException", "Invalid approver signature");
    return;
  }
  try {
    const result = await sessionHost(id).run(async (runtime) => {
      const approval = await runtime.decide(approvalId, decision, reason);
      const state = await runtime.drive();
      let outcome: InvokeResult | undefined;
      if (approval.requestId !== null) {
        outcome =
          state === "parked"
            ? await runtime.pendingResult(approval.requestId)
            : await runtime.resultForRequest(approval.requestId);
      }
      return {
        ...(outcome ?? {
          response: `Approval ${approvalId} is ${approval.status}.`,
          sessionId: id,
          status: state === "parked" ? "pending_approval" : "success",
        }),
        approval: {
          approvalId,
          status: approval.status,
          decidedBy: approval.decidedBy,
        },
      };
    });
    json(response, 200, result);
  } catch (error) {
    if (error instanceof ApprovalNotFoundError) {
      fail(response, 404, "ResourceNotFoundException", error.message);
      return;
    }
    if (error instanceof ApprovalConflictError) {
      response.setHeader("x-amzn-ErrorType", "ConflictException");
      json(response, 409, {
        message: error.message,
        approval: {
          approvalId: error.current.approvalId,
          status: error.current.status,
          decidedBy: error.current.decidedBy,
        },
      });
      return;
    }
    throw error;
  }
}

const RESUME_FIELDS = new Set(["type", "wait", "reason"]);

/**
 * Internal resume, sent by the resume sweeper with the session's own id. It
 * needs no credential: it can only continue durable work, and deadlines are
 * checked against stored state, not against anything the caller claims.
 * Concurrent resumers are harmless: in one process they queue on the session,
 * across processes the lease admits one owner at a time.
 */
async function handleResume(
  id: string,
  input: Record<string, unknown>,
  response: ServerResponse,
): Promise<void> {
  for (const key of Object.keys(input)) {
    if (!RESUME_FIELDS.has(key)) {
      fail(response, 400, "ValidationException", `unexpected field ${JSON.stringify(key)}`);
      return;
    }
  }
  if (input.wait !== undefined && typeof input.wait !== "boolean") {
    fail(response, 400, "ValidationException", "wait must be a boolean");
    return;
  }
  const work = sessionHost(id).run(async (runtime) => {
    await runtime.recorder.record("resume_invoked", {
      reason: typeof input.reason === "string" ? input.reason.slice(0, 64) : null,
    });
    return runtime.drive();
  });
  if (input.wait !== true) {
    // Answer at once; /ping stays HealthyBusy until the work is done or parked.
    work.catch((error) => {
      process.stderr.write(
        `ResumeFailed ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
    json(response, 202, { status: "accepted", sessionId: id });
    return;
  }
  try {
    const state = await work;
    json(response, 200, { status: "resumed", state, sessionId: id });
  } catch (error) {
    if (isLeaseContention(error)) {
      json(response, 200, { status: "busy", sessionId: id });
      return;
    }
    throw error;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  try {
    if (request.method === "GET" && url.pathname === "/ping") {
      json(response, 200, {
        status: [...sessions.values()].some((session) => session.busy)
          ? "HealthyBusy"
          : "Healthy",
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/invocations") {
      const input = await body(request);
      const id = sessionId(request);
      const type = input.type ?? "prompt";
      if (type === "prompt") {
        const { type: _type, ...rest } = input;
        await handlePrompt(id, rest, response);
      } else if (type === "approval") {
        await handleApproval(id, input, response);
      } else if (type === "resume") {
        await handleResume(id, input, response);
      } else {
        fail(
          response,
          400,
          "ValidationException",
          'type must be "prompt", "approval", or "resume"',
        );
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/events") {
      const id = sessionId(request, url);
      // Straight from the durable log: no lease needed, works on any instance.
      const recorder = await openEventRecorder(id, sessionDirectory(stateDirectory, id));
      const events = await recorder.list();
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

    fail(response, 404, "ResourceNotFoundException", "Not found");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    process.stderr.write(
      `RuntimeClientError ${request.method} ${url.pathname}: ${message}\n${stack ?? ""}\n`,
    );
    if (!response.headersSent) {
      fail(response, 500, "RuntimeClientError", message);
    } else {
      response.end();
    }
  }
});

server.listen(port, host, () => {
  process.stdout.write(
    `Pi Durable AgentCore HTTP server listening on http://${host}:${port} (${modelMode})\n`,
  );
});

async function shutdown(): Promise<void> {
  server.close();
  // Each close schedules the next automatic resume for work left unfinished.
  await Promise.all([...sessions.values()].map((session) => session.close()));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
