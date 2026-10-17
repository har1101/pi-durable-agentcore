import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Type,
  type AssistantMessage,
  type Static,
  type TranscriptContext,
  type TSchema,
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
  Harness,
  hook,
  ToolTask,
  watchEvents,
  type AgentEventStream,
  type Conversation,
  type HarnessInspection,
  type HookApi,
  type SettledSubmissionRecord,
  type Submission,
  type SubmissionId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolHookCall,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  applyBedrockRuntimeEnv,
  createConfiguredAmazonBedrockProvider,
} from "./bedrock-provider.js";
import { openEventLog, type EventLog } from "./event-recorder.js";
import {
  approvalIdOf,
  parkIdOf,
  ParkStore,
  TIMEOUT,
  toolKey,
  verdictOf,
  type IdempotencyKey,
  type ParkRecord,
  type ParkSpec,
} from "./parks.js";
import { openSessionStorage } from "./storage/open.js";

const context = BACKGROUND_CONTEXT;

export type ModelMode = "scripted" | "bedrock";

export interface RuntimeOptions {
  stateDirectory: string;
  sessionId: string;
  modelMode?: ModelMode;
  resume?: boolean;
  scriptedDelayMs?: number;
  /** Called synchronously when the runtime starts closing itself after parking, so the owner stops handing it out. */
  onClosing?: () => void;
}

export interface InvokeInput {
  prompt: string;
  requestId?: string;
  /** AgentCore runtime user id of the caller; that user may not approve this run's gated calls. */
  userId?: string;
}

export interface PendingItem {
  readonly kind: ParkSpec["kind"];
  readonly tool: string;
  readonly summary: string;
  /** Approvals only. A reference, not a capability: deciding needs an approver identity. */
  readonly approvalId?: `apr_${string}`;
  readonly deadline: string;
}

export interface InvokeResult {
  response: string;
  requestId: string;
  sessionId: string;
  status: "success" | "error" | "pending";
  pending?: readonly PendingItem[];
  reason?: string;
  detail?: unknown;
}

/** Returned when the runtime parked and closed under the caller: retry on a freshly opened runtime. */
export const CLOSED = Symbol("runtime closed");
export type Closed = typeof CLOSED;

export function sessionDirectory(
  stateDirectory: string,
  sessionId: string,
): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return join(stateDirectory, "sessions", digest);
}

/** Tools that wait before they may start, and for what. Tool bodies know nothing about it. */
const GATES: Readonly<
  Record<string, (args: Readonly<Record<string, unknown>>, now: number) => ParkSpec>
> = {
  publish_report: () => ({
    kind: "approval",
    timeoutMs: Number(process.env.PI_APPROVAL_TIMEOUT_MS ?? 86_400_000),
  }),
  wait_until: (args, now) => ({
    kind: "timer",
    until: now + 1000 * Number(args.seconds),
  }),
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type?: string; text?: string }) =>
      part.type === "text" ? (part.text ?? "") : "",
    )
    .join("");
}

/** The scripted model's one tool call per prompt, so one server can run every scenario. */
function scriptedCall(prompt: string, callCount: number) {
  if (prompt.includes("[approval]")) {
    return { name: "publish_report", args: { title: "Q3" }, id: `publish-report-${callCount}` };
  }
  const wait = /\[wait (\d+(?:\.\d+)?)\]/.exec(prompt);
  if (wait) {
    return { name: "wait_until", args: { seconds: Number(wait[1]) }, id: `wait-until-${callCount}` };
  }
  return { name: "durable_wait", args: { label: "crash-window" }, id: `durable-wait-${callCount}` };
}

async function scriptedResponse(
  events: EventLog,
  transcript: TranscriptContext,
  state: FauxProviderState,
): Promise<AssistantMessage> {
  await events.record("model_call", { call: state.callCount });
  if (process.env.SCRIPTED_MODEL_ERROR === "1") {
    return fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage:
        process.env.SCRIPTED_MODEL_ERROR_MESSAGE ??
        "Provider is not configured: amazon-bedrock",
    });
  }
  const lastUser = transcript.messages.findLastIndex(
    (message) => message.role === "user",
  );
  const result = transcript.messages
    .slice(lastUser + 1)
    .find((message) => message.role === "toolResult");
  if (result?.role === "toolResult") {
    return fauxAssistantMessage([
      fauxText(
        result.toolName === "durable_wait"
          ? "Finished after the durable tool checkpoint was committed."
          : `Finished: ${textOf(result.content)}`,
      ),
    ]);
  }
  const call = scriptedCall(
    textOf(transcript.messages[lastUser]?.content),
    state.callCount,
  );
  return fauxAssistantMessage(
    [fauxToolCall(call.name, call.args, { id: call.id })],
    { stopReason: "toolUse" },
  );
}

type KeyedTool<P extends TSchema> = Omit<ToolRegistration<P>, "execute"> & {
  run(
    args: Static<P>,
    key: IdempotencyKey,
    api: ToolExecutionApi,
    context: Context,
  ): Promise<ToolExecutionResult>;
};

/**
 * Every registered tool is built here, so none runs without its idempotency key and a durable
 * `tool_attempt` record written before its body starts.
 */
function keyed<P extends TSchema>(
  sessionId: string,
  events: EventLog,
  { run, ...tool }: KeyedTool<P>,
): ToolRegistration<P> {
  return defineTool<P>({
    ...tool,
    execute: async (args, api, context) => {
      const key = toolKey(sessionId, api.taskId);
      const attempt = {
        timestamp: new Date().toISOString(),
        pid: process.pid,
        tool: tool.name,
        sessionId,
        idempotencyKey: key,
      };
      process.stdout.write(`TOOL_ATTEMPT ${JSON.stringify(attempt)}\n`);
      await events.record("tool_attempt", {
        tool: tool.name,
        idempotencyKey: key,
        callId: api.callId,
      });
      return run(args, key, api, context);
    },
  });
}

/**
 * Retries a gate's storage call until it succeeds or the harness closes. A gate that threw for any other reason
 * would become a permanent block (pi-durable turns a non-abort hook throw into `block`), rejecting the call.
 */
async function persist<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  for (let delay = 100; ; delay = Math.min(delay * 2, 5_000)) {
    try {
      return await operation();
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      process.stderr.write(
        `gate storage call failed, retrying in ${delay}ms: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    }
  }
}

/**
 * `parked`: every task that could make progress is a gate waiting on its PARK, so nothing is lost by closing.
 * A submit in flight (`holds`) keeps the runtime open until the submission is durable.
 */
function liveness(
  inspection: HarnessInspection,
  parked: ReadonlySet<number>,
  holds: number,
): "idle" | "running" | "parked" {
  if (holds > 0) return "running";
  if (inspection.tasks.length === 0 && inspection.submissions.length === 0) {
    return "idle";
  }
  const active = inspection.tasks.filter(
    (task) => task.state.kind === "running" || task.state.kind === "ready",
  );
  return parked.size > 0 && active.every((task) => parked.has(task.record.id))
    ? "parked"
    : "running";
}

function pendingItem(park: ParkRecord): PendingItem {
  return {
    kind: park.kind,
    tool: park.tool,
    summary: park.summary,
    ...(park.kind === "approval" ? { approvalId: approvalIdOf(park.id) } : {}),
    deadline: new Date(park.deadlineAt).toISOString(),
  };
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

export class PiRuntime {
  readonly sessionId: string;
  readonly sessionPath: string;
  readonly events: EventLog;
  readonly root: Conversation;
  readonly harness: Harness;
  readonly #stream: AgentEventStream;
  /** Undefined for STORAGE_BACKEND=sqlite: gated calls are blocked there. */
  readonly #parks: ParkStore | undefined;
  readonly #onClosing: (() => void) | undefined;
  /** Gates waiting in memory on their PARK, by tool task id; each entry wakes its gate to re-read the PARK. */
  readonly #parked = new Map<number, () => void>();
  /** requestId → user id of the invoke that submitted it, for this process only. */
  readonly #requesters = new Map<string, string>();
  #holds = 0;
  /** The current drive; `armed` resolves once its RUN item is armed. */
  #drive: { readonly armed: Promise<void> } | undefined;
  #closing: "parked" | "closed" | undefined;
  #closed: Promise<void> | undefined;
  #change = Promise.withResolvers<void>();

  private constructor(
    options: RuntimeOptions,
    sessionPath: string,
    events: EventLog,
    parks: ParkStore | undefined,
    harness: Harness,
    root: Conversation,
    stream: AgentEventStream,
  ) {
    this.sessionId = options.sessionId;
    this.sessionPath = sessionPath;
    this.events = events;
    this.#parks = parks;
    this.#onClosing = options.onClosing;
    this.harness = harness;
    this.root = root;
    this.#stream = stream;
  }

  static async open(options: RuntimeOptions): Promise<PiRuntime> {
    const modelMode = options.modelMode ?? "scripted";
    const path = sessionDirectory(options.stateDirectory, options.sessionId);
    await mkdir(path, { recursive: true });
    const opened = await openSessionStorage({
      sessionId: options.sessionId,
      sessionPath: path,
    });
    const recorder = openEventLog({
      sessionId: options.sessionId,
      sessionPath: path,
      backend: opened.backend,
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
      faux.setResponses(
        Array.from(
          { length: 100 },
          () => (transcript: TranscriptContext, _: unknown, state: FauxProviderState) =>
            scriptedResponse(recorder, transcript, state),
        ),
      );
      models.setProvider(faux.provider);
    }

    const delayMs =
      options.scriptedDelayMs ??
      Number(process.env.SCRIPTED_TOOL_DELAY_MS ?? 5_000);
    const tools = [
      keyed(options.sessionId, recorder, {
        name: "durable_wait",
        description:
          "Wait briefly so process-crash recovery can be demonstrated.",
        parameters: Type.Object({ label: Type.String() }),
        replay: "safe",
        run: async ({ label }) => {
          await recorder.record("tool_call_started", {
            name: "durable_wait",
            label,
            delayMs,
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
      }),
      keyed(options.sessionId, recorder, {
        name: "publish_report",
        description: "Publish a report. Requires a human approval.",
        parameters: Type.Object({ title: Type.String() }),
        replay: "unsafe",
        run: async ({ title }, key) => {
          await recorder.record("gated_action", {
            tool: "publish_report",
            title,
            idempotencyKey: key,
          });
          return { output: [{ type: "text" as const, text: `published ${title}` }] };
        },
      }),
      keyed(options.sessionId, recorder, {
        name: "wait_until",
        description: "Continue after the given number of seconds.",
        parameters: Type.Object({ seconds: Type.Number() }),
        replay: "safe",
        run: async ({ seconds }) => ({
          output: [{ type: "text" as const, text: `waited ${seconds}s` }],
        }),
      }),
    ];

    let runtime: PiRuntime | undefined;
    const gate = hook(ToolTask, {
      beforeTool: (call, api, hookContext) =>
        runtime!.#gate(call, api, hookContext),
    });
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "poc-durable-wait",
        tools,
        hooks: [gate],
      }),
    );

    const harness = await Harness.open(
      opened.storage,
      {
        models,
        registry,
        onReport: (error) => {
          recorder
            .record("harness_error", {
              message: error instanceof Error ? error.message : String(error),
            })
            .catch(() => undefined);
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
    const stream = await watchEvents(harness, root.id, context);
    runtime = new PiRuntime(
      options,
      path,
      recorder,
      opened.backend === "dynamodb" ? new ParkStore(options.sessionId) : undefined,
      harness,
      root,
      stream,
    );

    await recorder.record("runtime_opened", {
      modelMode,
      storage: opened.backend,
      location: opened.location,
      ...(bedrockAuthSource !== undefined ? { bedrockAuthSource } : {}),
    });
    await recorder.record("conversation_snapshot", stream.snapshot);
    const opening = runtime;
    stream.start(async (batch) => {
      await recorder.record("checkpoint_committed", batch);
      opening.#changed();
    });

    if (options.resume) {
      harness.resume();
      await recorder.record("resume_called", {});
      void runtime.#ensureDriving().catch(() => undefined);
    }
    return runtime;
  }

  get busy(): boolean {
    return this.#drive !== undefined || this.#holds > 0;
  }

  /** Resolves once the runtime has closed; only meaningful after a method returned CLOSED. */
  get closed(): Promise<void> {
    return this.#closed ?? Promise.resolve();
  }

  async invoke(
    input: InvokeInput & { requestId: string },
  ): Promise<InvokeResult | Closed> {
    if (this.#closing) return CLOSED;
    const { requestId } = input;
    let submission: Submission;
    this.#holds++;
    try {
      if (input.userId !== undefined) this.#requesters.set(requestId, input.userId);
      await this.events.record("invocation_started", {
        requestId,
        prompt: input.prompt,
      });
      await this.#ensureDriving();
      submission = await this.root.submit(
        { type: "input", content: input.prompt, requestId },
        context,
      );
    } finally {
      this.#release();
    }
    return this.#resultOf(submission, requestId);
  }

  /** The result of a parked call's submission once a decision is stored; wakes a gate waiting in this process. */
  async deliver(park: ParkRecord): Promise<InvokeResult | Closed> {
    if (this.#closing) return CLOSED;
    if (park.submissionId === undefined) {
      throw new Error(`PARK ${park.id} names no submission`);
    }
    let submission: Submission | undefined;
    this.#holds++;
    try {
      for (const wake of [...this.#parked.values()]) wake();
      await this.#ensureDriving();
      submission = await this.harness.submission(
        park.submissionId as SubmissionId,
        context,
      );
    } finally {
      this.#release();
    }
    if (submission === undefined) {
      throw new Error(`Submission ${park.submissionId} is unknown`);
    }
    return this.#resultOf(submission, park.requestId ?? "");
  }

  /** Drives whatever the open left unsettled. CLOSED means it ran and parked again. */
  async resume(): Promise<"accepted" | "idle" | Closed> {
    if (this.#closing) return CLOSED;
    try {
      const inspection = await this.harness.inspect(context);
      if (inspection.tasks.length === 0 && inspection.submissions.length === 0) {
        return "idle";
      }
    } catch (error) {
      if (this.#closing) return CLOSED;
      throw error;
    }
    await this.#ensureDriving();
    return "accepted";
  }

  async close(): Promise<void> {
    this.#closing ??= "closed";
    await this.#shutdown();
  }

  #release(): void {
    this.#holds--;
    this.#changed();
  }

  #changed(): void {
    this.#change.resolve();
    this.#change = Promise.withResolvers<void>();
  }

  #ensureDriving(): Promise<void> {
    if (this.#closing) return Promise.resolve();
    if (this.#drive === undefined) {
      const armId = randomUUID();
      const armed = this.#parks?.armRun(armId, Date.now()) ?? Promise.resolve();
      const drive = { armed };
      this.#drive = drive;
      armed
        .then(() => this.#driveLoop(drive, armId))
        .catch((error: unknown) => {
          if (this.#drive === drive) this.#drive = undefined;
          if (this.#closing) return;
          this.events
            .record("harness_error", {
              message: error instanceof Error ? error.message : String(error),
            })
            .catch(() => undefined);
        });
    }
    return this.#drive.armed;
  }

  /**
   * Watches live work until it settles or every runnable task is a parked gate; then closes to hold nothing.
   * RUN stays armed until then, so a process that dies mid-run is resumed by the sweeper.
   */
  async #driveLoop(drive: object, armId: string): Promise<void> {
    let worked = false;
    for (;;) {
      const next = this.#change.promise;
      const inspection = await this.harness.inspect(context);
      const state = liveness(inspection, new Set(this.#parked.keys()), this.#holds);
      if (state === "idle") {
        this.#drive = undefined;
        await this.#parks?.disarmRun(armId);
        await this.#reapOrphanedParks();
        if (worked) await this.events.record("run_settled", {});
        return;
      }
      if (state === "parked") {
        this.#drive = undefined;
        this.#closing = "parked";
        this.#onClosing?.();
        await this.#parks?.disarmRun(armId);
        await this.events.record("runtime_parked", {
          gates: this.#parked.size,
        });
        await this.#shutdown();
        return;
      }
      if (this.#drive !== drive) return;
      worked = true;
      await Promise.race([
        next,
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
  }

  /**
   * With no live task, no gate can consume a PARK any more (its task was aborted), and its wake attributes would
   * make the sweeper resume the session every minute. Pending ones are left: a new run may have just written them.
   */
  async #reapOrphanedParks(): Promise<void> {
    if (this.#parks === undefined) return;
    const now = Date.now();
    for (const park of await this.#parks.open()) {
      if (verdictOf(park, now) === "pending") continue;
      await this.#parks.consume(park.id, now);
      await this.events.record("park_orphaned", { tool: park.tool });
    }
  }

  #shutdown(): Promise<void> {
    this.#closed ??= (async () => {
      await this.#stream.stop();
      await this.harness.close(context);
      await this.events.record("runtime_closed", { reason: this.#closing });
    })();
    return this.#closed;
  }

  async #resultOf(
    submission: Submission,
    requestId: string,
  ): Promise<InvokeResult | Closed> {
    let settled: SettledSubmissionRecord;
    try {
      settled = await submission.wait(context);
    } catch (error) {
      if (this.#closing !== "parked") throw error;
      await this.closed;
      return this.#pendingResult(requestId);
    }
    if (settled.status === "unanswered" || settled.type !== "input") {
      const payload = unansweredPayload(settled);
      await this.events.record("invocation_failed", {
        requestId,
        reason: payload.reason,
        detail: (payload.detail ?? null) as JsonValue,
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
    if (this.#closing) return CLOSED;
    this.#holds++;
    let response: string;
    try {
      const answer = await this.root.commit(
        (transaction) => transaction.entry(AssistantEntry, settled.answer),
        context,
      );
      response = assistantText(answer?.model?.[0] as AssistantMessage | undefined);
    } finally {
      this.#release();
    }
    await this.events.record("invocation_completed", { requestId, response });
    return {
      response,
      requestId: settled.requestId ?? requestId,
      sessionId: this.sessionId,
      status: "success",
    };
  }

  async #pendingResult(requestId: string): Promise<InvokeResult> {
    const now = Date.now();
    const pending = (await this.#parks!.open())
      .filter((park) => verdictOf(park, now) === "pending")
      .map(pendingItem);
    await this.events.record("invocation_pending", {
      requestId,
      pending: pending as unknown as JsonValue,
    });
    return {
      response: pending.some((item) => item.kind === "approval")
        ? "Waiting for approval"
        : "Waiting for timer",
      requestId,
      sessionId: this.sessionId,
      status: "pending",
      pending,
    };
  }

  /**
   * beforeTool: a gated call waits for its PARK's verdict. Until the hook returns nothing is committed for the call,
   * so the tool task stays at its `call` checkpoint and this re-runs on any later open; the stored PARK alone decides.
   */
  async #gate(call: ToolHookCall, api: HookApi, hookContext: Context) {
    const spec = GATES[call.name]?.(call.arguments, Date.now());
    if (spec === undefined) return undefined;
    const parks = this.#parks;
    if (parks === undefined) {
      return { block: "approvals require STORAGE_BACKEND=dynamodb" };
    }
    const signal = hookContext.abortSignal;
    const id = parkIdOf(toolKey(this.sessionId, api.taskId));
    const { park: stored, created } = await persist(signal, async () => {
      const placed = (await this.harness.inspect(hookContext)).submissions.find(
        (submission) => submission.type === "input" && submission.status === "placed",
      );
      const requestedBy =
        placed?.requestId !== undefined
          ? this.#requesters.get(placed.requestId)
          : undefined;
      const now = Date.now();
      return parks.ensure(id, {
        kind: spec.kind,
        tool: call.name,
        summary: `${call.name} ${JSON.stringify(call.arguments)}`.slice(0, 512),
        requestedAt: now,
        deadlineAt: spec.kind === "approval" ? now + spec.timeoutMs : spec.until,
        ...(placed !== undefined ? { submissionId: placed.id } : {}),
        ...(placed?.requestId !== undefined ? { requestId: placed.requestId } : {}),
        ...(requestedBy !== undefined ? { requestedBy } : {}),
      });
    });
    const label = {
      tool: stored.tool,
      ...(stored.kind === "approval" ? { approvalId: approvalIdOf(stored.id) } : {}),
    };
    if (created) {
      await persist(signal, () =>
        this.events.record(
          stored.kind === "approval" ? "approval_requested" : "timer_started",
          { ...label, deadline: new Date(stored.deadlineAt).toISOString() },
        ),
      );
    }
    let park = stored;
    for (;;) {
      const verdict = verdictOf(park, Date.now());
      if (verdict === "pending") {
        await this.#waitParked(api.taskId, park.deadlineAt, signal);
        park = await persist(signal, () => parks.mustGet(id));
        continue;
      }
      if (verdict === "timed_out") {
        await persist(signal, () => parks.expire(id, Date.now()));
        park = await persist(signal, () => parks.mustGet(id));
        if (park.decided?.by === TIMEOUT) {
          await persist(signal, () =>
            this.events.record("approval_timed_out", label),
          );
        }
        continue;
      }
      await persist(signal, () => parks.consume(id, Date.now()));
      await persist(signal, () =>
        this.events.record("park_resolved", {
          ...label,
          verdict,
          ...(park.decided ? { decidedBy: park.decided.by } : {}),
        }),
      );
      if (verdict === "approved" || verdict === "elapsed") return undefined;
      return {
        block:
          park.decided?.by === TIMEOUT
            ? "approval timed out (rejected)"
            : "rejected by approver",
      };
    }
  }

  /** Resolves when woken (a decision reached this process) or at the deadline; rejects when the harness closes. */
  #waitParked(
    taskId: number,
    deadlineAt: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const done = (error?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#parked.delete(taskId);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onAbort = () => done(signal?.reason ?? new Error("aborted"));
      if (signal?.aborted) return onAbort();
      const timer = setTimeout(
        () => done(),
        Math.min(Math.max(0, deadlineAt - Date.now()), 2 ** 31 - 1),
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#parked.set(taskId, () => done());
      this.#changed();
    });
  }
}
