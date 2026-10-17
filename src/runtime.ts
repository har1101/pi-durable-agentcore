import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Type,
  type AssistantMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxProviderState,
} from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  watchEvents,
  type AgentEventStream,
  type Conversation,
  type SettledSubmissionRecord,
  type Submission,
} from "@earendil-works/pi-durable";
import {
  applyBedrockRuntimeEnv,
  createConfiguredAmazonBedrockProvider,
} from "./bedrock-provider.js";
import { ControlStore } from "./control-store.js";
import { openEventLog, type EventLog } from "./event-log.js";
import {
  guardedActionTool,
  keyFor,
  recordToolAttempt,
  waitUntilTool,
  type SuspensionRequest,
  type ToolServices,
} from "./hitl.js";
import { DynamoDbStorage } from "./storage/dynamodb.js";
import { openSessionStorage } from "./storage/open.js";

const context = BACKGROUND_CONTEXT;

export type ModelMode = "scripted" | "bedrock";

export interface RuntimeOptions {
  stateDirectory: string;
  sessionId: string;
  modelMode?: ModelMode;
  resume?: boolean;
  scriptedDelayMs?: number;
  /** Override the lease acquire timeout (fail fast for internal resumes). */
  acquireTimeoutMs?: number;
}

export interface InvokeInput {
  prompt: string;
  requestId?: string;
}

export interface PendingApproval {
  approvalId: string;
  toolName: string;
  deadline: string;
}

export type InvokeStatus =
  | "success"
  | "error"
  | "pending_approval"
  | "waiting"
  | "idle";

export interface InvokeResult {
  response: string;
  requestId: string;
  sessionId: string;
  status: InvokeStatus;
  reason?: string;
  detail?: unknown;
  approval?: PendingApproval;
  resumeAt?: string;
}

function sessionDirectory(stateDirectory: string, sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return join(stateDirectory, "sessions", digest);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item: { type?: string; text?: string }) =>
      item.type === "text" ? (item.text ?? "") : "",
    )
    .join("");
}

/** Text of the last user message and the tool results that follow it. */
function currentRun(transcript: TranscriptContext): {
  prompt: string;
  results: { toolName: string; text: string }[];
} {
  let lastUser = -1;
  for (let index = 0; index < transcript.messages.length; index++) {
    if (transcript.messages[index]?.role === "user") lastUser = index;
  }
  const prompt = messageText(transcript.messages[lastUser]?.content);
  const results = transcript.messages
    .slice(lastUser + 1)
    .flatMap((message) =>
      message.role === "toolResult"
        ? [{ toolName: message.toolName, text: messageText(message.content) }]
        : [],
    );
  return { prompt, results };
}

/**
 * Free, deterministic model. The prompt picks the scenario:
 * - `[approval]` calls guarded_action (human in the loop);
 * - `[wait:<seconds>]` calls wait_until;
 * - `[reuse-call-id]` calls durable_wait twice with the same provider call id;
 * - anything else calls durable_wait once (the crash→resume demo).
 */
function scriptedResponse(
  transcript: TranscriptContext,
  _options: unknown,
  state: FauxProviderState,
): AssistantMessage {
  if (process.env.SCRIPTED_MODEL_ERROR === "1") {
    return fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage:
        process.env.SCRIPTED_MODEL_ERROR_MESSAGE ??
        "Provider is not configured: amazon-bedrock",
    });
  }
  const { prompt, results } = currentRun(transcript);
  const toolUse = (
    name: string,
    args: Record<string, string | number>,
    id: string,
  ) =>
    fauxAssistantMessage([fauxToolCall(name, args, { id })], {
      stopReason: "toolUse",
    });
  const wait = /\[wait:(\d+(?:\.\d+)?)\]/.exec(prompt);
  if (prompt.includes("[approval]")) {
    if (results.length === 0) {
      return toolUse(
        "guarded_action",
        { action: "deploy-change", target: "production" },
        `guarded-${state.callCount}`,
      );
    }
    return fauxAssistantMessage([fauxText(`Finished: ${results.at(-1)?.text}`)]);
  }
  if (wait !== null) {
    if (results.length === 0) {
      return toolUse("wait_until", { seconds: Number(wait[1]) }, `wait-${state.callCount}`);
    }
    return fauxAssistantMessage([fauxText(`Finished: ${results.at(-1)?.text}`)]);
  }
  if (prompt.includes("[reuse-call-id]")) {
    if (results.length < 2) {
      return toolUse("durable_wait", { label: `reuse-${results.length}` }, "reused-call-id");
    }
    return fauxAssistantMessage([fauxText("Finished after two calls with one call id.")]);
  }
  if (results.some((result) => result.toolName === "durable_wait")) {
    return fauxAssistantMessage([
      fauxText("Finished after the durable tool checkpoint was committed."),
    ]);
  }
  return toolUse(
    "durable_wait",
    { label: "crash-window" },
    `durable-wait-${state.callCount}`,
  );
}

function unansweredPayload(settled: SettledSubmissionRecord): {
  message: string;
  reason: string;
  detail?: unknown;
} {
  const reason =
    settled.status === "unanswered" ? settled.reason : settled.status;
  const detail = settled.status === "unanswered" ? settled.detail : undefined;
  const detailText =
    typeof detail === "string"
      ? detail
      : detail !== undefined
        ? JSON.stringify(detail)
        : "";
  return {
    reason,
    message: detailText
      ? `Submission unanswered (${reason}): ${detailText}`
      : `Submission unanswered (${reason})`,
    ...(detail !== undefined ? { detail } : {}),
  };
}

function assistantText(message: AssistantMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter(
      (
        item,
      ): item is Extract<(typeof message.content)[number], { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join("");
}

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function pendingResult(
  sessionId: string,
  requestId: string,
  request: SuspensionRequest,
): InvokeResult {
  const at = new Date(request.dueAt).toISOString();
  if (request.kind === "approval" && request.approvalId !== undefined) {
    return {
      response: `Waiting for human approval of ${request.toolName} (approval ${request.approvalId}, auto-reject at ${at}).`,
      requestId,
      sessionId,
      status: "pending_approval",
      approval: {
        approvalId: request.approvalId,
        toolName: request.toolName,
        deadline: at,
      },
    };
  }
  return {
    response: `Waiting until ${at}; the session resumes automatically.`,
    requestId,
    sessionId,
    status: "waiting",
    resumeAt: at,
  };
}

/**
 * One open Pi Durable session. A run either settles, or a tool suspends it:
 * then the runtime arms the session's wake-up item, closes the Harness and
 * releases the lease (`closed` resolves), and every waiting caller gets a
 * pending result. Reopening (any process, any microVM) resumes from DynamoDB.
 */
export class PiRuntime {
  readonly sessionId: string;
  readonly sessionPath: string;
  readonly recorder: EventLog;
  readonly control: ControlStore | undefined;
  readonly root: Conversation;
  readonly harness: Harness;
  readonly fencingToken: number;
  readonly closed: Promise<void>;
  #events: AgentEventStream;
  #busy = 0;
  #running = 0;
  #suspension: SuspensionRequest | undefined;
  #suspended: Promise<SuspensionRequest>;
  #signalSuspended!: (request: SuspensionRequest) => void;
  #closing: Promise<void> | undefined;
  #markClosed!: () => void;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #wakeQueue: Promise<unknown> = Promise.resolve();
  #activeRequestId: string | undefined;

  private constructor(fields: {
    sessionId: string;
    sessionPath: string;
    recorder: EventLog;
    control: ControlStore | undefined;
    harness: Harness;
    root: Conversation;
    events: AgentEventStream;
    fencingToken: number;
  }) {
    this.sessionId = fields.sessionId;
    this.sessionPath = fields.sessionPath;
    this.recorder = fields.recorder;
    this.control = fields.control;
    this.harness = fields.harness;
    this.root = fields.root;
    this.#events = fields.events;
    this.fencingToken = fields.fencingToken;
    this.#suspended = new Promise((resolve) => {
      this.#signalSuspended = resolve;
    });
    this.closed = new Promise((resolve) => {
      this.#markClosed = resolve;
    });
  }

  static async open(options: RuntimeOptions): Promise<PiRuntime> {
    const modelMode = options.modelMode ?? "scripted";
    const path = sessionDirectory(options.stateDirectory, options.sessionId);
    await mkdir(path, { recursive: true });
    const recorder = await openEventLog({
      sessionId: options.sessionId,
      sessionPath: path,
    });
    const models = createModels();
    let bedrockAuthSource: string | undefined;

    if (modelMode === "bedrock") {
      const { region, modelId } = applyBedrockRuntimeEnv();
      const provider = createConfiguredAmazonBedrockProvider();
      models.setProvider(provider);
      const configured = models.getModel("amazon-bedrock", modelId);
      if (!configured) {
        throw new Error(
          `Bedrock model ${modelId} is not registered on amazon-bedrock`,
        );
      }
      const auth = await models.getAuth(configured);
      bedrockAuthSource = auth?.source;
      if (!auth) {
        throw new Error(
          `amazon-bedrock provider is not configured (region=${region} model=${modelId})`,
        );
      }
      process.stdout.write(
        `BEDROCK_PROVIDER configured source=${auth.source} model=${modelId} region=${region}\n`,
      );
    } else {
      const faux = fauxProvider({ tokensPerSecond: 10_000 });
      faux.setResponses(Array.from({ length: 100 }, () => scriptedResponse));
      models.setProvider(faux.provider);
    }

    const opened = await openSessionStorage({
      sessionId: options.sessionId,
      sessionPath: path,
      ...(options.acquireTimeoutMs !== undefined
        ? { acquireTimeoutMs: options.acquireTimeoutMs }
        : {}),
    });
    const fencingToken =
      opened.storage instanceof DynamoDbStorage ? opened.storage.fencingToken : 0;
    const control =
      opened.backend === "dynamodb"
        ? await ControlStore.open(options.sessionId)
        : undefined;

    // Tools reach the runtime through this late-bound holder.
    let runtimeRef: PiRuntime | undefined;
    const services: ToolServices = {
      sessionId: options.sessionId,
      events: recorder,
      control,
      requestSuspension: async (request) => {
        if (runtimeRef === undefined) {
          throw new Error("Runtime is not ready to suspend");
        }
        await runtimeRef.requestSuspension(request);
      },
    };

    const delayMs =
      options.scriptedDelayMs ??
      Number(process.env.SCRIPTED_TOOL_DELAY_MS ?? 5_000);
    const waitTool = defineTool({
      name: "durable_wait",
      description:
        "Wait briefly so process-crash recovery can be demonstrated.",
      parameters: Type.Object({ label: Type.String() }),
      replay: "safe",
      execute: async ({ label }, api) => {
        const idempotencyKey = keyFor(services, api);
        await recordToolAttempt(services, api, "durable_wait", idempotencyKey, {
          label,
        });
        await recorder.record("tool_call_started", {
          name: "durable_wait",
          label,
          delayMs,
          idempotencyKey,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        await recorder.record("tool_call_completed", {
          name: "durable_wait",
          label,
        });
        return {
          output: [
            { type: "text" as const, text: `waited ${delayMs}ms for ${label}` },
          ],
        };
      },
    });

    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "poc-durable-wait",
        tools: [waitTool, guardedActionTool(services), waitUntilTool(services)],
        hooks: [
          hook(GenerationTask, {
            // One event per provider response, so tests can prove that resume
            // never repeats a completed model call.
            afterResponse: (message: AssistantMessage) =>
              recorder.record("model_response", {
                stopReason: message.stopReason,
                toolCalls: message.content
                  .filter((item) => item.type === "toolCall")
                  .map((item) => (item as { name: string }).name),
              }),
          }),
        ],
      }),
    );

    const harness = await Harness.open(
      opened.storage,
      {
        models,
        registry,
        onReport: (error) => {
          void recorder.record("harness_error", {
            message: error instanceof Error ? error.message : String(error),
          });
        },
      },
      context,
    );
    const model =
      modelMode === "bedrock"
        ? {
            provider: "amazon-bedrock",
            modelId: applyBedrockRuntimeEnv().modelId,
          }
        : { provider: "faux", modelId: "faux-1" };
    const root = await harness.root(context, { agent: { model } });
    const events = await watchEvents(harness, root.id, context);
    const runtime = new PiRuntime({
      sessionId: options.sessionId,
      sessionPath: path,
      recorder,
      control,
      harness,
      root,
      events,
      fencingToken,
    });
    runtimeRef = runtime;

    await recorder.record("runtime_opened", {
      modelMode,
      storage: opened.backend,
      location: opened.location,
      events: recorder.location,
      fencingToken,
      ...(bedrockAuthSource !== undefined ? { bedrockAuthSource } : {}),
    });
    await recorder.record("conversation_snapshot", events.snapshot);
    events.start(async (batch) => {
      await recorder.record("checkpoint_committed", batch);
    });

    if (options.resume) {
      harness.resume();
      await recorder.record("resume_called", {});
    }
    return runtime;
  }

  get busy(): boolean {
    return this.#busy > 0;
  }

  get isClosing(): boolean {
    return this.#closing !== undefined;
  }

  get suspension(): SuspensionRequest | undefined {
    return this.#suspension;
  }

  async invoke(input: InvokeInput): Promise<InvokeResult> {
    const requestId = input.requestId ?? randomUUID();
    this.#busy++;
    try {
      await this.recorder.record("invocation_started", {
        requestId,
        prompt: input.prompt,
      });
      if (this.#suspension !== undefined) {
        return pendingResult(this.sessionId, requestId, this.#suspension);
      }
      const submission = await this.root.submit(
        {
          type: "input",
          content: input.prompt,
          requestId,
        },
        context,
      );
      return await this.#drive(submission, requestId);
    } finally {
      this.#busy--;
    }
  }

  /**
   * Internal resume (auto-resume sweeper, approval decision, or a client
   * retry): continue the oldest unsettled input, if any, and report how it
   * ended. Opening the runtime already restarted Pi's scheduler.
   */
  async resumeWork(): Promise<InvokeResult> {
    this.#busy++;
    try {
      if (this.#suspension !== undefined) {
        return pendingResult(
          this.sessionId,
          this.#activeRequestId ?? "",
          this.#suspension,
        );
      }
      const inspection = await this.harness.inspect(context);
      const record = inspection.submissions.find(
        (submission) => submission.type === "input",
      );
      if (record === undefined) {
        await this.#updateWake(() => this.control?.disarmWake(this.fencingToken));
        await this.recorder.record("resume_idle", {});
        return {
          response: "Nothing to resume.",
          requestId: "",
          sessionId: this.sessionId,
          status: "idle",
        };
      }
      const submission = await this.harness.submission(record.id, context);
      if (submission === undefined) {
        throw new Error(`Submission ${record.id} disappeared during resume`);
      }
      const requestId = record.requestId ?? `submission-${record.id}`;
      await this.recorder.record("resume_started", { requestId });
      return await this.#drive(submission, requestId);
    } finally {
      this.#busy--;
    }
  }

  async #drive(submission: Submission, requestId: string): Promise<InvokeResult> {
    this.#activeRequestId = requestId;
    this.#runStarted(requestId);
    let finishedRun = true;
    try {
      const waiting = submission.wait(context);
      // A suspension closes the Harness, which rejects this wait; the race
      // has already been decided by then.
      waiting.catch(() => undefined);
      const outcome = await Promise.race([
        waiting.then((settled) => ({ kind: "settled" as const, settled })),
        this.#suspended.then((request) => ({ kind: "suspended" as const, request })),
      ]);
      if (outcome.kind === "suspended") {
        finishedRun = false;
        await this.#closing;
        return pendingResult(this.sessionId, requestId, outcome.request);
      }
      const { settled } = outcome;
      if (settled.status === "unanswered" || settled.type !== "input") {
        const payload = unansweredPayload(settled);
        await this.recorder.record("invocation_failed", {
          requestId,
          reason: payload.reason,
          detail: payload.detail ?? null,
        });
        return {
          response: payload.message,
          requestId,
          sessionId: this.sessionId,
          status: "error",
          reason: payload.reason,
          ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
        };
      }
      const answer = await this.root.commit(
        (transaction) => transaction.entry(AssistantEntry, settled.answer),
        context,
      );
      const response = assistantText(
        answer?.model?.[0] as AssistantMessage | undefined,
      );
      await this.recorder.record("invocation_completed", {
        requestId,
        response,
      });
      return {
        response,
        requestId,
        sessionId: this.sessionId,
        status: "success",
      };
    } finally {
      if (finishedRun) await this.#runFinished();
    }
  }

  /**
   * Crash detection: while a run is in flight the wake item is re-armed every
   * heartbeat with `now + grace`. If this process dies, the heartbeat stops,
   * the due time passes, and the sweeper resumes the session elsewhere.
   */
  #runStarted(requestId: string): void {
    this.#running++;
    if (this.control === undefined || this.#heartbeat !== undefined) return;
    const grace = positiveEnv("PI_WAKE_CRASH_GRACE_MS", 60_000);
    const every = positiveEnv("PI_WAKE_HEARTBEAT_MS", 20_000);
    const arm = () =>
      this.#updateWake(() =>
        this.#suspension !== undefined || this.#closing !== undefined
          ? undefined
          : this.control?.armWake({
              reason: "running",
              dueAt: Date.now() + grace,
              fencingToken: this.fencingToken,
              requestId,
            }),
      );
    void arm();
    this.#heartbeat = setInterval(() => void arm(), every);
    this.#heartbeat.unref();
  }

  async #runFinished(): Promise<void> {
    this.#running = Math.max(0, this.#running - 1);
    if (this.#running > 0) return;
    this.#stopHeartbeat();
    if (this.#suspension !== undefined || this.#closing !== undefined) return;
    // Disarm only when nothing is left: a queued follow-up keeps the wake.
    const inspection = await this.harness.inspect(context).catch(() => undefined);
    if (inspection !== undefined && inspection.submissions.length === 0) {
      await this.#updateWake(() =>
        this.#suspension !== undefined
          ? undefined
          : this.control?.disarmWake(this.fencingToken),
      );
    }
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== undefined) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
    }
  }

  /** Wake writes are serialized so a late heartbeat never lands after a suspension. */
  #updateWake(write: () => Promise<unknown> | undefined): Promise<void> {
    const next = this.#wakeQueue.then(write).then(
      () => undefined,
      (error: unknown) => {
        process.stderr.write(
          `WAKE_WRITE_FAILED ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    );
    this.#wakeQueue = next;
    return next;
  }

  /** Called by a tool that must wait for a human or a time. */
  async requestSuspension(request: SuspensionRequest): Promise<void> {
    if (this.control === undefined) {
      throw new Error("Durable suspension requires the DynamoDB backend");
    }
    const first = this.#suspension === undefined;
    // Several parked tools in one round: wake at the earliest due time.
    if (first || request.dueAt < (this.#suspension?.dueAt ?? Infinity)) {
      this.#suspension = request;
    }
    this.#stopHeartbeat();
    const winner = this.#suspension ?? request;
    await this.#updateWake(() =>
      this.control?.armWake({
        reason: winner.kind,
        dueAt: winner.dueAt,
        fencingToken: this.fencingToken,
        ...(this.#activeRequestId !== undefined
          ? { requestId: this.#activeRequestId }
          : {}),
        ...(winner.approvalId !== undefined ? { approvalId: winner.approvalId } : {}),
      }),
    );
    await this.recorder.record("run_suspended", {
      kind: request.kind,
      tool: request.toolName,
      dueAt: new Date(request.dueAt).toISOString(),
      idempotencyKey: request.idempotencyKey,
      ...(request.approvalId !== undefined ? { approvalId: request.approvalId } : {}),
    });
    if (first) {
      // Not awaited: closing waits for this tool, which waits for the abort.
      this.#closing = this.#shutdown("suspended");
      this.#signalSuspended(request);
    }
  }

  async readEvents(): Promise<string> {
    return (await this.recorder.readAll())
      .map((event) => `${JSON.stringify(event)}\n`)
      .join("");
  }

  close(): Promise<void> {
    this.#closing ??= this.#shutdown("closed");
    return this.#closing;
  }

  async #shutdown(reason: "closed" | "suspended"): Promise<void> {
    // Let the suspending tool reach its abort wait before the Harness closes.
    await new Promise((resolve) => setImmediate(resolve));
    this.#stopHeartbeat();
    try {
      await this.#events.stop();
      await this.harness.close(context);
      await this.#wakeQueue;
      await this.recorder.record("runtime_closed", { reason });
      await this.recorder.flush();
    } finally {
      this.#markClosed();
    }
  }
}
