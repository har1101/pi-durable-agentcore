import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry,
  createRegistry,
  Harness,
  watchEvents,
  type AgentEventStream,
  type Conversation,
  type HarnessInspection,
  type SettledSubmissionRecord,
  type Submission,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import {
  ApprovalDoc,
  pendingView,
  WaitsDoc,
  type ApprovalDecision,
  type ApprovalState,
  type PendingApprovalView,
} from "./approvals.js";
import {
  applyBedrockRuntimeEnv,
  createConfiguredAmazonBedrockProvider,
} from "./bedrock-provider.js";
import type { EventRecorder } from "./event-recorder.js";
import { Parking } from "./parking.js";
import { scriptedResponder } from "./scripted-model.js";
import {
  openEventRecorder,
  openSessionStorage,
  sessionDirectory,
} from "./storage/open.js";
import { createPocExtension } from "./tools.js";
import type { WakeState, WakeStore } from "./wake-store.js";

const context = BACKGROUND_CONTEXT;

export type ModelMode = "scripted" | "bedrock";

export interface RuntimeOptions {
  stateDirectory: string;
  sessionId: string;
  modelMode?: ModelMode;
  resume?: boolean;
  scriptedDelayMs?: number;
  /** Default `APPROVAL_TIMEOUT_MS` or 24 h: longer than one 8 h AgentCore lifetime. */
  approvalTimeoutMs?: number;
  /** Default `INLINE_WAIT_MAX_MS` or 30 s. */
  inlineWaitMaxMs?: number;
  /** Default `INFLIGHT_GRACE_MS` or 60 s. */
  inflightGraceMs?: number;
}

export interface InvokeInput {
  prompt: string;
  requestId?: string;
}

export type InvokeStatus =
  | "success"
  | "error"
  | "pending_approval"
  | "waiting";

export interface InvokeResult {
  response: string;
  requestId: string;
  sessionId: string;
  status: InvokeStatus;
  reason?: string;
  detail?: unknown;
  /** `pending_approval`: what a human must decide; ids only, never a credential. */
  approvals?: PendingApprovalView[];
  /** `waiting`: when the session resumes on its own. */
  resumeAt?: string;
}

/** Where the session's work stands after an operation. */
export type WorkState = "idle" | "parked" | "active" | "blocked";

export class ApprovalNotFoundError extends Error {
  constructor(approvalId: string) {
    super(`No approval ${approvalId} in this session`);
    this.name = "ApprovalNotFoundError";
  }
}

export class ApprovalConflictError extends Error {
  readonly current: ApprovalState;
  constructor(current: ApprovalState) {
    super(`Approval ${current.approvalId} is already ${current.status}`);
    this.name = "ApprovalConflictError";
    this.current = current;
  }
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

function unansweredPayload(settled: SettledSubmissionRecord | SubmissionRecord): {
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
  readonly recorder: EventRecorder;
  readonly root: Conversation;
  readonly harness: Harness;
  readonly wakes: WakeStore;
  readonly parking: Parking;
  readonly inflightGraceMs: number;
  #events: AgentEventStream;
  #busy = 0;
  #active = false;
  #closed: Promise<void> | undefined;
  #wakeTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(init: {
    sessionId: string;
    sessionPath: string;
    recorder: EventRecorder;
    harness: Harness;
    root: Conversation;
    events: AgentEventStream;
    wakes: WakeStore;
    parking: Parking;
    inflightGraceMs: number;
  }) {
    this.sessionId = init.sessionId;
    this.sessionPath = init.sessionPath;
    this.recorder = init.recorder;
    this.harness = init.harness;
    this.root = init.root;
    this.#events = init.events;
    this.wakes = init.wakes;
    this.parking = init.parking;
    this.inflightGraceMs = init.inflightGraceMs;
  }

  static async open(options: RuntimeOptions): Promise<PiRuntime> {
    const modelMode = options.modelMode ?? "scripted";
    const path = sessionDirectory(options.stateDirectory, options.sessionId);
    await mkdir(path, { recursive: true });
    const opened = await openSessionStorage({
      sessionId: options.sessionId,
      sessionPath: path,
    });
    const recorder = await openEventRecorder(options.sessionId, path, opened.backend);
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
      const respond = scriptedResponder(recorder);
      faux.setResponses(Array.from({ length: 1_000 }, () => respond));
      models.setProvider(faux.provider);
    }

    const parking = new Parking();
    let harnessRef: Harness | undefined;
    const registry = createRegistry();
    registry.install(
      createPocExtension({
        sessionId: options.sessionId,
        recorder,
        effects: opened.effects,
        parking,
        delayMs:
          options.scriptedDelayMs ??
          Number(process.env.SCRIPTED_TOOL_DELAY_MS ?? 5_000),
        approvalTimeoutMs:
          options.approvalTimeoutMs ??
          envNumber("APPROVAL_TIMEOUT_MS", 24 * 60 * 60 * 1000),
        inlineWaitMaxMs:
          options.inlineWaitMaxMs ?? envNumber("INLINE_WAIT_MAX_MS", 30_000),
        requestIdFor: async (conversationId, toolContext) => {
          if (harnessRef === undefined) return null;
          const inspection = await harnessRef.inspect(toolContext);
          const placed = inspection.submissions.find(
            (submission) =>
              submission.conversationId === conversationId &&
              submission.type === "input" &&
              submission.status === "placed",
          );
          return placed?.requestId ?? null;
        },
      }),
    );

    let harness: Harness;
    try {
      harness = await Harness.open(
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
    } catch (error) {
      await opened.storage.close(context).catch(() => undefined);
      throw error;
    }
    harnessRef = harness;
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
      harness,
      root,
      events,
      wakes: opened.wakes,
      parking,
      inflightGraceMs:
        options.inflightGraceMs ?? envNumber("INFLIGHT_GRACE_MS", 60_000),
    });

    await recorder.record("runtime_opened", {
      modelMode,
      storage: opened.backend,
      location: opened.location,
      eventLog: recorder.location,
      ...(bedrockAuthSource !== undefined ? { bedrockAuthSource } : {}),
    });
    await recorder.record("conversation_snapshot", events.snapshot);
    events.start(async (batch) => {
      await recorder.record("checkpoint_committed", batch);
    });
    runtime.#startWakeRefresh();

    if (options.resume) {
      harness.resume();
      await recorder.record("resume_called", {});
    }
    return runtime;
  }

  get busy(): boolean {
    return this.#busy > 0;
  }

  /**
   * Mark the session in flight before starting work: if this process dies
   * with nobody retrying, the WAKE item comes due after the grace period and
   * the resumer continues the work on a new instance.
   */
  async beginWork(): Promise<void> {
    this.#busy++;
    try {
      await this.#markInflight();
    } catch (error) {
      this.#busy--;
      throw error;
    }
  }

  /** Record where the work stands and schedule (or clear) the next automatic resume. */
  async endWork(): Promise<WorkState> {
    this.#busy--;
    return this.#syncWake("active");
  }

  async invoke(input: InvokeInput): Promise<InvokeResult> {
    const requestId = input.requestId ?? randomUUID();
    await this.recorder.record("invocation_started", {
      requestId,
      prompt: input.prompt,
    });
    const submission = await this.root.submit(
      {
        type: "input",
        content: input.prompt,
        requestId,
      },
      context,
    );
    const outcome = await this.#settleOrPark(submission);
    if (outcome === "parked") {
      const result = await this.pendingResult(requestId);
      await this.recorder.record("invocation_parked", {
        requestId,
        status: result.status,
        approvals: result.approvals?.map((approval) => approval.approvalId) ?? [],
        ...(result.resumeAt !== undefined ? { resumeAt: result.resumeAt } : {}),
      });
      return result;
    }
    const result = await this.#settledResult(requestId, outcome);
    await this.recorder.record(
      result.status === "success" ? "invocation_completed" : "invocation_failed",
      result.status === "success"
        ? { requestId, response: result.response }
        : { requestId, reason: result.reason, detail: result.detail ?? null },
    );
    return result;
  }

  /**
   * Record a human decision. Only `approve` approves; past the deadline the
   * approval expires instead, whatever the decision. Repeating the recorded
   * decision is idempotent; contradicting it is a conflict.
   */
  async decide(
    approvalId: string,
    decision: ApprovalDecision,
    reason: string | undefined,
  ): Promise<ApprovalState> {
    const current = await this.harness.snapshot(ApprovalDoc, approvalId, context);
    if (current === undefined) throw new ApprovalNotFoundError(approvalId);
    const wanted = decision === "approve" ? "approved" : "rejected";
    if (current.status !== "pending") {
      if (current.status === wanted) return current;
      throw new ApprovalConflictError(current);
    }
    const decided = await this.harness.commit(async (tx) => {
      const approval = await tx.doc(ApprovalDoc, approvalId, current);
      if (approval.status === "pending") {
        const now = Date.now();
        if (now >= approval.deadline) {
          approval.status = "expired";
          approval.decidedBy = "timeout";
          approval.reason = "Decision arrived after the approval deadline; auto-rejected.";
        } else {
          approval.status = wanted;
          approval.decidedBy = "approver";
          approval.reason = reason ?? null;
        }
        approval.decidedAt = now;
        const waits = await tx.doc(WaitsDoc);
        delete waits.waits[approvalId];
      }
      return { ...approval } as ApprovalState;
    }, context);
    await this.recorder.record("approval_decided", {
      approvalId,
      status: decided.status,
      decidedBy: decided.decidedBy,
    });
    if (decided.status !== wanted) throw new ApprovalConflictError(decided);
    return decided;
  }

  /**
   * Run the session's durable work until nothing is left (`idle`), everything
   * waits on a human or a clock (`parked`), or a task cannot be scheduled
   * (`blocked`). This is what an internal resume invocation does.
   */
  async drive(): Promise<WorkState> {
    this.harness.resume();
    for (;;) {
      const inspection = await this.harness.inspect(context);
      if (inspection.tasks.length === 0) return "idle";
      if (this.#fullyParked(inspection)) return "parked";
      if (inspection.tasks.some((task) => task.state.kind === "blocked")) {
        return "blocked";
      }
      await Promise.race([this.parking.changed(), delay(200)]);
    }
  }

  /** Result of an earlier input by requestId, or undefined when unknown. */
  async resultForRequest(requestId: string): Promise<InvokeResult | undefined> {
    const record = await this.root.commit(
      (tx) => tx.submissionByRequest(this.root.id, requestId),
      context,
    );
    if (record === undefined || record.type !== "input") return undefined;
    if (record.status === "done" || record.status === "unanswered") {
      return this.#settledResult(requestId, record);
    }
    return this.pendingResult(requestId);
  }

  /** What the session is waiting on, as an invocation result. */
  async pendingResult(requestId: string): Promise<InvokeResult> {
    const waits = (await this.harness.snapshot(WaitsDoc, context))?.waits ?? {};
    const approvals: PendingApprovalView[] = [];
    let resumeAt: number | undefined;
    for (const [id, wait] of Object.entries(waits)) {
      if (wait.kind === "approval") {
        const approval = await this.harness.snapshot(ApprovalDoc, id, context);
        if (approval?.status === "pending") approvals.push(pendingView(approval));
      } else {
        resumeAt = resumeAt === undefined ? wait.at : Math.min(resumeAt, wait.at);
      }
    }
    if (approvals.length > 0) {
      return {
        response: `Waiting for human approval: ${approvals.map((approval) => `${approval.action} (${approval.approvalId})`).join(", ")}.`,
        requestId,
        sessionId: this.sessionId,
        status: "pending_approval",
        approvals,
      };
    }
    const at = new Date(resumeAt ?? Date.now()).toISOString();
    return {
      response: `Waiting until ${at}; the session resumes automatically.`,
      requestId,
      sessionId: this.sessionId,
      status: "waiting",
      resumeAt: at,
    };
  }

  async readEvents() {
    return this.recorder.list();
  }

  /**
   * Close the Harness and release the lease. Before that, schedule the next
   * automatic resume from what is left: none when idle, the earliest approval
   * deadline or timer when parked, and "now" when work was cut short (SIGTERM,
   * maxLifetime), so a new instance picks it up.
   */
  close(): Promise<void> {
    this.#closed ??= (async () => {
      this.#stopWakeRefresh();
      try {
        await this.#syncWake("interrupted");
      } catch (error) {
        process.stderr.write(
          `WAKE_SYNC_FAILED on close: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      await this.#events.stop();
      await this.harness.close(context);
      await this.recorder.record("runtime_closed", {});
      await this.recorder.flush();
    })();
    return this.#closed;
  }

  async #markInflight(): Promise<void> {
    await this.wakes.set({
      wakeAt: Date.now() + this.inflightGraceMs,
      reason: "inflight",
    });
  }

  #startWakeRefresh(): void {
    const interval = Math.max(250, Math.floor(this.inflightGraceMs / 3));
    this.#wakeTimer = setInterval(() => {
      if (this.#busy === 0 && !this.#active) return;
      this.#markInflight().catch((error) => {
        process.stderr.write(
          `WAKE_REFRESH_FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    }, interval);
    this.#wakeTimer.unref();
  }

  #stopWakeRefresh(): void {
    if (this.#wakeTimer !== undefined) clearInterval(this.#wakeTimer);
    this.#wakeTimer = undefined;
  }

  /**
   * Derive the WAKE item from durable state. `unfinished` says what to do with
   * live work that is neither idle nor parked: keep the in-flight marker
   * (`active`, still running here) or ask for an immediate resume
   * (`interrupted`, closing).
   */
  async #syncWake(unfinished: "active" | "interrupted"): Promise<WorkState> {
    const inspection = await this.harness.inspect(context);
    let state: WorkState;
    let wake: WakeState | undefined;
    if (inspection.tasks.length === 0) {
      state = "idle";
    } else if (this.#fullyParked(inspection)) {
      state = "parked";
      wake = await this.#nextWake();
    } else if (inspection.tasks.some((task) => task.state.kind === "blocked")) {
      // Needs a deploy that installs the missing definition; retry later.
      state = "blocked";
      wake = { wakeAt: Date.now() + this.inflightGraceMs, reason: "inflight" };
    } else {
      state = "active";
      wake =
        unfinished === "active"
          ? { wakeAt: Date.now() + this.inflightGraceMs, reason: "inflight" }
          : { wakeAt: Date.now(), reason: "interrupted" };
    }
    this.#active = state === "active" && unfinished === "active";
    if (wake === undefined) await this.wakes.clear();
    else await this.wakes.set(wake);
    await this.recorder.record("wake_synced", {
      state,
      ...(wake !== undefined
        ? { wakeAt: new Date(wake.wakeAt).toISOString(), reason: wake.reason }
        : { wakeAt: null }),
    });
    return state;
  }

  async #nextWake(): Promise<WakeState> {
    const waits = (await this.harness.snapshot(WaitsDoc, context))?.waits ?? {};
    let next: WakeState | undefined;
    for (const wait of Object.values(waits)) {
      if (next === undefined || wait.at < next.wakeAt) {
        next = {
          wakeAt: wait.at,
          reason: wait.kind === "approval" ? "approval_deadline" : "timer",
        };
      }
    }
    return next ?? { wakeAt: Date.now() + this.inflightGraceMs, reason: "inflight" };
  }

  /**
   * Every live task is a parked tool (waiting on a human or a clock) or waits
   * on other tasks; nothing runnable is left.
   */
  #fullyParked(inspection: HarnessInspection): boolean {
    if (this.parking.size === 0 || inspection.tasks.length === 0) return false;
    return inspection.tasks.every(
      (task) =>
        task.state.kind === "waiting" ||
        task.state.kind === "completing" ||
        (task.state.kind === "running" && this.parking.has(task.record.id)),
    );
  }

  async #settleOrPark(
    submission: Submission,
  ): Promise<SettledSubmissionRecord | "parked"> {
    const settled = submission.wait(context);
    // Once parked nobody awaits it; the Harness closing rejects it.
    settled.catch(() => undefined);
    const tagged = settled.then((record) => ({ record }));
    for (;;) {
      const next = await Promise.race([
        tagged,
        this.parking.changed().then(() => undefined),
        delay(200).then(() => undefined),
      ]);
      if (next !== undefined) return next.record;
      if (this.parking.size === 0) continue;
      if (this.#fullyParked(await this.harness.inspect(context))) return "parked";
    }
  }

  async #settledResult(
    requestId: string,
    settled: SettledSubmissionRecord | SubmissionRecord,
  ): Promise<InvokeResult> {
    if (
      settled.status !== "done" ||
      settled.type !== "input"
    ) {
      const payload = unansweredPayload(settled);
      return {
        response: payload.message,
        requestId,
        sessionId: this.sessionId,
        status: "error",
        reason: payload.reason,
        ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
      };
    }
    const answerId = settled.answer;
    const answer = await this.root.commit(
      (transaction) => transaction.entry(AssistantEntry, answerId),
      context,
    );
    return {
      response: assistantText(answer?.model?.[0] as AssistantMessage | undefined),
      requestId,
      sessionId: this.sessionId,
      status: "success",
    };
  }
}
