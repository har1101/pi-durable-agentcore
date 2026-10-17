import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";
import { SessionFailed } from "@earendil-works/pi-durable";
import { ControlStore, type ApprovalDecision } from "./control-store.js";
import {
  readDynamoDbEvents,
  sessionTableClient,
  sessionTableName,
  type RecordedEvent,
} from "./event-log.js";
import { verifyApproverToken } from "./hitl.js";
import {
  pendingResult,
  PiRuntime,
  type InvokeResult,
  type ModelMode,
} from "./runtime.js";
import { LeaseContentionError } from "./storage/errors.js";
import { configuredStorageBackend } from "./storage/open.js";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 8080);
const stateDirectory =
  process.env.STATE_DIRECTORY ?? "/tmp/pi-durable-agentcore";
const configuredMode = process.env.MODEL_PROVIDER ?? "scripted";
if (configuredMode !== "scripted" && configuredMode !== "bedrock") {
  throw new Error("MODEL_PROVIDER must be scripted or bedrock");
}
const modelMode: ModelMode = configuredMode;
const durable = configuredStorageBackend() === "dynamodb";
const resumeAcquireTimeoutMs = Number(
  process.env.PI_RESUME_ACQUIRE_TIMEOUT_MS ?? 3_000,
);
const runtimes = new Map<string, Promise<PiRuntime>>();

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string,
    message: string,
  ) {
    super(message);
  }
}

function sessionId(request: IncomingMessage, url?: URL): string {
  const header = request.headers["x-amzn-bedrock-agentcore-runtime-session-id"];
  const value = Array.isArray(header) ? header[0] : header;
  return value ?? url?.searchParams.get("sessionId") ?? "local-session";
}

/**
 * The open runtime of a session. A runtime that suspended (or is closing) is
 * replaced by a fresh one that resumes from DynamoDB; requests for one session
 * in this process share one runtime.
 */
async function runtimeFor(
  id: string,
  options: { acquireTimeoutMs?: number } = {},
): Promise<PiRuntime> {
  for (;;) {
    let pending = runtimes.get(id);
    if (!pending) {
      const opening = PiRuntime.open({
        stateDirectory,
        sessionId: id,
        modelMode,
        resume: true,
        ...options,
      });
      pending = opening;
      runtimes.set(id, opening);
      opening.then(
        (runtime) =>
          void runtime.closed.then(() => {
            if (runtimes.get(id) === opening) runtimes.delete(id);
          }),
        () => {
          if (runtimes.get(id) === opening) runtimes.delete(id);
        },
      );
    }
    const runtime = await pending;
    if (!runtime.isClosing) return runtime;
    await runtime.closed;
    if (runtimes.get(id) === pending) runtimes.delete(id);
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
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "ValidationException", "Request body must be a JSON object");
  }
}

function invalid(message: string): never {
  throw new HttpError(400, "ValidationException", message);
}

/** A prompt while the run waits for a human or a timer would queue behind it. */
async function suspendedResult(
  id: string,
  requestId: string,
): Promise<InvokeResult | undefined> {
  if (!durable) return undefined;
  const control = await ControlStore.open(id);
  const wake = await control.getWake();
  if (!wake.armed || (wake.reason !== "approval" && wake.reason !== "timer")) {
    return undefined;
  }
  const approval =
    wake.approvalId !== undefined
      ? await control.getApproval(wake.approvalId)
      : undefined;
  // Decided, timed out, or due: opening the runtime resumes the parked tool
  // first, and the prompt follows it.
  if (approval !== undefined && approval.status !== "pending") return undefined;
  if ((wake.dueAt ?? 0) <= Date.now()) return undefined;
  const result = pendingResult(id, requestId, {
    kind: wake.reason,
    dueAt: wake.dueAt ?? Date.now(),
    toolName: approval?.toolName ?? "wait_until",
    idempotencyKey: approval?.idempotencyKey ?? "",
    ...(wake.approvalId !== undefined ? { approvalId: wake.approvalId } : {}),
  });
  return { ...result, reason: "session_suspended" };
}

async function handlePrompt(
  id: string,
  input: Record<string, unknown>,
): Promise<InvokeResult> {
  if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
    invalid("prompt must be a non-empty string");
  }
  if (input.requestId !== undefined && typeof input.requestId !== "string") {
    invalid("requestId must be a string");
  }
  const requestId = typeof input.requestId === "string" ? input.requestId : undefined;
  const blocked = await suspendedResult(id, requestId ?? "");
  if (blocked !== undefined) return blocked;
  const runtime = await runtimeFor(id);
  return runtime.invoke({
    prompt: input.prompt,
    ...(requestId !== undefined ? { requestId } : {}),
  });
}

const APPROVAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `{ approval: { approvalId, decision: "approve" | "reject", approverToken, reason? } }`.
 * Only the exact string "approve" approves; any other value is rejected as
 * invalid and nothing is recorded.
 */
async function handleDecision(
  id: string,
  approval: unknown,
): Promise<InvokeResult & { decision: { approvalId: string; status: string } }> {
  if (!durable) invalid("approvals need STORAGE_BACKEND=dynamodb");
  if (approval === null || typeof approval !== "object" || Array.isArray(approval)) {
    invalid("approval must be an object");
  }
  const fields = approval as Record<string, unknown>;
  const allowed = new Set(["approvalId", "decision", "approverToken", "reason"]);
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) invalid(`approval.${key} is not allowed`);
  }
  if (typeof fields.approvalId !== "string" || !APPROVAL_ID.test(fields.approvalId)) {
    invalid("approval.approvalId must be an approval id");
  }
  const decision = fields.decision;
  if (decision !== "approve" && decision !== "reject") {
    invalid('approval.decision must be exactly "approve" or "reject"');
  }
  if (
    fields.reason !== undefined &&
    (typeof fields.reason !== "string" || fields.reason.length > 1_000)
  ) {
    invalid("approval.reason must be a string of at most 1000 characters");
  }
  const verified = verifyApproverToken(id, fields.approvalId, fields.approverToken);
  if (verified !== "ok") {
    throw new HttpError(
      403,
      "AccessDeniedException",
      verified === "not_configured"
        ? "Approvals are disabled: APPROVAL_HMAC_KEY is not configured"
        : "approval.approverToken is not valid for this approval",
    );
  }
  const control = await ControlStore.open(id);
  const decided = await control.decide(fields.approvalId, decision as ApprovalDecision, {
    now: Date.now(),
    ...(typeof fields.reason === "string" ? { reason: fields.reason } : {}),
  });
  if (decided.outcome === "not_found") {
    throw new HttpError(404, "ResourceNotFoundException", "Unknown approval");
  }
  if (decided.outcome === "expired" || decided.outcome === "conflict") {
    throw new HttpError(
      409,
      "ConflictException",
      decided.outcome === "expired"
        ? "The approval deadline has passed; it is rejected automatically"
        : `The approval was already ${decided.record.status} by ${decided.record.decidedBy}`,
    );
  }
  if (decided.outcome === "recorded") await control.expediteWake(Date.now());
  const runtime = await runtimeFor(id);
  const result = await runtime.resumeWork();
  return {
    ...result,
    decision: { approvalId: fields.approvalId, status: decided.record.status },
  };
}

async function handleResume(
  id: string,
  input: Record<string, unknown>,
): Promise<InvokeResult | { status: "resuming"; sessionId: string }> {
  if (input.wait !== undefined && typeof input.wait !== "boolean") {
    invalid("wait must be a boolean");
  }
  let runtime: PiRuntime;
  try {
    runtime = await runtimeFor(id, { acquireTimeoutMs: resumeAcquireTimeoutMs });
  } catch (error) {
    if (error instanceof LeaseContentionError) {
      // Another process owns the session and is already working on it.
      throw new HttpError(409, "ConflictException", "Session is owned by another live process");
    }
    throw error;
  }
  if (input.wait === true) return runtime.resumeWork();
  // AgentCore keeps the session alive while /ping reports HealthyBusy.
  void runtime.resumeWork().catch((error: unknown) => {
    process.stderr.write(
      `BACKGROUND_RESUME_FAILED ${error instanceof Error ? error.message : String(error)}\n`,
    );
    if (isFailedSessionError(error)) forgetRuntime(id);
  });
  return { status: "resuming", sessionId: id };
}

async function readEvents(id: string): Promise<RecordedEvent[]> {
  if (durable) {
    // Straight from DynamoDB: no lease, works from any microVM.
    return readDynamoDbEvents(await sessionTableClient(), sessionTableName(), id);
  }
  const runtime = await runtimeFor(id);
  return (await runtime.readEvents())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedEvent);
}

const server = createServer(async (request, response) => {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  try {
    if (request.method === "GET" && url.pathname === "/ping") {
      const values = await Promise.allSettled([...runtimes.values()]);
      json(response, 200, {
        status: values.some(
          (result) => result.status === "fulfilled" && result.value.busy,
        )
          ? "HealthyBusy"
          : "Healthy",
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/invocations") {
      const input = await body(request);
      const id = sessionId(request);
      const modes = ["prompt", "approval", "action"].filter(
        (key) => input[key] !== undefined,
      );
      if (modes.length !== 1) {
        invalid("send exactly one of prompt, approval, or action");
      }
      if (input.approval !== undefined) {
        json(response, 200, await handleDecision(id, input.approval));
      } else if (input.action !== undefined) {
        if (input.action !== "resume") invalid('action must be "resume"');
        json(response, 200, await handleResume(id, input));
      } else {
        let result: InvokeResult;
        try {
          result = await handlePrompt(id, input);
        } catch (error) {
          // The runtime suspended between lookup and submit: retry once.
          if (!(error instanceof Error) || !error.message.includes("Harness is closed")) {
            throw error;
          }
          result = await handlePrompt(id, input);
        }
        json(response, 200, result);
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/events") {
      const id = sessionId(request, url);
      const events = await readEvents(id);
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

    if (request.method === "GET" && url.pathname === "/status") {
      const id = sessionId(request, url);
      if (!durable) invalid("status needs STORAGE_BACKEND=dynamodb");
      const control = await ControlStore.open(id);
      const [wake, approvals] = await Promise.all([
        control.getWake(),
        control.listApprovals(),
      ]);
      json(response, 200, {
        sessionId: id,
        wake,
        approvals: approvals.map((approval) => ({
          approvalId: approval.approvalId,
          status: approval.status,
          toolName: approval.toolName,
          arguments: approval.arguments,
          deadline: new Date(approval.deadline).toISOString(),
          ...(approval.decidedBy !== undefined ? { decidedBy: approval.decidedBy } : {}),
        })),
      });
      return;
    }

    response.setHeader("x-amzn-ErrorType", "ResourceNotFoundException");
    json(response, 404, { message: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof HttpError) {
      response.setHeader("x-amzn-ErrorType", error.errorType);
      json(response, error.status, { message });
      return;
    }
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
