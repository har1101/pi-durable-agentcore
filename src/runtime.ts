import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT,
  withCancel,
} from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
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
import type { EventLog } from "./event-log.js";
import { scriptedResponse } from "./scripted-model.js";
import {
  activeSuspensions,
  decide,
  Suspensions,
  type Approval,
  type DecisionOutcome,
  type Suspension,
} from "./suspensions.js";
import {
  approvedActionTool,
  durableWaitTool,
  watchSuspensions,
} from "./tools.js";
import { openSessionBackend } from "./storage/open.js";

const context = BACKGROUND_CONTEXT;

export type ModelMode = "scripted" | "bedrock";

export interface RuntimeOptions {
  stateDirectory: string;
  sessionId: string;
  modelMode?: ModelMode;
  resume?: boolean;
  scriptedDelayMs?: number;
}

export interface InvokeInput {
  prompt: string;
  requestId?: string;
}

interface ResultBase {
  response: string;
  sessionId: string;
}

/** What an invocation reports: the run's answer, its failure, or why it is parked. */
export type InvokeResult =
  | (ResultBase & { status: "success"; requestId: string })
  | (ResultBase & {
      status: "error";
      requestId: string;
      reason: string;
      detail?: unknown;
    })
  | (ResultBase & {
      status: "pending";
      requestId: string;
      reason: "approval_required";
      approvalId: string;
      expiresAt: string;
    })
  | (ResultBase & {
      status: "pending";
      requestId: string;
      reason: "timer";
      wakeAt: string;
    })
  | (ResultBase & { status: "idle" });

export interface DecisionResult {
  outcome: DecisionOutcome["kind"];
  approval?: Approval;
  result: InvokeResult;
}

function pendingResult(
  parked: Suspension,
  requestId: string,
  sessionId: string,
): InvokeResult {
  if (parked.kind === "approval") {
    return {
      status: "pending",
      reason: "approval_required",
      approvalId: parked.id,
      expiresAt: new Date(parked.deadline).toISOString(),
      requestId,
      sessionId,
      response: `Waiting for approval ${parked.id}.`,
    };
  }
  return {
    status: "pending",
    reason: "timer",
    wakeAt: new Date(parked.wakeAt).toISOString(),
    requestId,
    sessionId,
    response: `Waiting until ${new Date(parked.wakeAt).toISOString()}.`,
  };
}

export function sessionDirectory(
  stateDirectory: string,
  sessionId: string,
): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return join(stateDirectory, "sessions", digest);
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
  readonly recorder: EventLog;
  readonly root: Conversation;
  readonly harness: Harness;
  #events: AgentEventStream;
  #busy = 0;

  private constructor(
    sessionId: string,
    sessionPath: string,
    recorder: EventLog,
    harness: Harness,
    root: Conversation,
    events: AgentEventStream,
  ) {
    this.sessionId = sessionId;
    this.sessionPath = sessionPath;
    this.recorder = recorder;
    this.harness = harness;
    this.root = root;
    this.#events = events;
  }

  static async open(options: RuntimeOptions): Promise<PiRuntime> {
    const modelMode = options.modelMode ?? "scripted";
    const path = sessionDirectory(options.stateDirectory, options.sessionId);
    await mkdir(path, { recursive: true });
    const opened = await openSessionBackend({
      sessionId: options.sessionId,
      sessionPath: path,
    });
    const recorder = opened.events;
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

    const delayMs =
      options.scriptedDelayMs ??
      Number(process.env.SCRIPTED_TOOL_DELAY_MS ?? 5_000);
    const scope = {
      sessionId: options.sessionId,
      events: recorder,
      effects: opened.effects,
      now: () => Date.now(),
    };
    const approvalTimeoutMs = Number(
      process.env.APPROVAL_TIMEOUT_MS ?? 24 * 60 * 60 * 1000,
    );

    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "poc-durable-wait",
        tools: [
          durableWaitTool(scope, delayMs),
          approvedActionTool(scope, approvalTimeoutMs),
        ],
        hooks: [
          hook(GenerationTask, {
            afterResponse: (message) =>
              recorder.record("model_response", {
                stopReason: message.stopReason,
                toolCalls: message.content.filter(
                  (item) => item.type === "toolCall",
                ).length,
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
    if ((await harness.snapshot(Suspensions, context)) === undefined) {
      await harness.commit((tx) => tx.doc(Suspensions), context);
    }
    const events = await watchEvents(harness, root.id, context);
    const runtime = new PiRuntime(
      options.sessionId,
      path,
      recorder,
      harness,
      root,
      events,
    );

    await recorder.record("runtime_opened", {
      modelMode,
      storage: opened.backend,
      location: opened.location,
      ...(bedrockAuthSource !== undefined
        ? { bedrockAuthSource }
        : {}),
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

  async invoke(input: InvokeInput): Promise<InvokeResult> {
    const requestId = input.requestId ?? randomUUID();
    this.#busy++;
    await this.recorder.record("invocation_started", {
      requestId,
      prompt: input.prompt,
    });
    try {
      const submission = await this.root.submit(
        {
          type: "input",
          content: input.prompt,
          requestId,
        },
        context,
      );
      return await this.#outcome(submission, requestId);
    } finally {
      this.#busy--;
    }
  }

  /**
   * Record an approver's decision and continue the parked run. The first
   * decision wins, so a repeat or a late approval after a timeout changes
   * nothing.
   */
  async decide(
    approvalId: string,
    decision: "approve" | "reject",
  ): Promise<DecisionResult> {
    this.#busy++;
    try {
      const active = await this.#activeSubmission();
      const outcome = await this.harness.commit(
        async (tx) =>
          JSON.parse(
            JSON.stringify(
              decide(await tx.doc(Suspensions), approvalId, decision, Date.now()),
            ),
          ) as DecisionOutcome,
        context,
      );
      await this.recorder.record("approval_decision", {
        approvalId,
        decision,
        outcome: outcome.kind,
        ...(outcome.kind !== "not_found"
          ? { status: outcome.approval.status }
          : {}),
      });
      const result =
        outcome.kind !== "not_found" && active !== undefined
          ? await this.#outcome(active.submission, active.requestId)
          : this.#idle();
      return {
        outcome: outcome.kind,
        ...(outcome.kind !== "not_found" ? { approval: outcome.approval } : {}),
        result,
      };
    } finally {
      this.#busy--;
    }
  }

  #idle(): InvokeResult {
    return { status: "idle", sessionId: this.sessionId, response: "" };
  }

  /** The root input a run is working on or has queued, if any. */
  async #activeSubmission(): Promise<
    { submission: Submission; requestId: string } | undefined
  > {
    const inspection = await this.harness.inspect(context);
    const record = inspection.submissions.find(
      (item) => item.type === "input" && item.conversationId === this.root.id,
    );
    if (record === undefined) return undefined;
    const submission = await this.harness.submission(record.id, context);
    if (submission === undefined) return undefined;
    return { submission, requestId: record.requestId ?? String(record.id) };
  }

  /** Settled answer, or the suspension the run parked on, whichever comes first. */
  async #outcome(
    submission: Submission,
    requestId: string,
  ): Promise<InvokeResult> {
    const race = withCancel(context);
    try {
      const result = await Promise.race([
        submission
          .wait(race.context)
          .then((settled) => this.#settledResult(settled, requestId)),
        watchSuspensions(
          this.harness,
          (state) => activeSuspensions(state)[0],
          race.context,
        ).then((parked) =>
          pendingResult(parked, requestId, this.sessionId),
        ),
      ]);
      if (result.status === "pending") {
        await this.recorder.record("invocation_pending", result);
      }
      return result;
    } finally {
      race.cancel(new Error("outcome decided"));
    }
  }

  async #settledResult(
    settled: SettledSubmissionRecord,
    requestId: string,
  ): Promise<InvokeResult> {
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
  }

  async close(): Promise<void> {
    await this.#events.stop();
    await this.harness.close(context);
    await this.recorder.record("runtime_closed", {});
    await this.recorder.flush();
  }
}
