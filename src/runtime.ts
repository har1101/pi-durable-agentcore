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
  Harness,
  watchEvents,
  type AgentEventStream,
  type Conversation,
  type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import {
  applyBedrockRuntimeEnv,
  createConfiguredAmazonBedrockProvider,
} from "./bedrock-provider.js";
import { openEventLog, type EventLog } from "./event-recorder.js";
import { openSessionStorage } from "./storage/open.js";

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

export interface InvokeResult {
  response: string;
  requestId: string;
  sessionId: string;
  status: "success" | "error";
  reason?: string;
  detail?: unknown;
}

export function sessionDirectory(
  stateDirectory: string,
  sessionId: string,
): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return join(stateDirectory, "sessions", digest);
}

function hasToolResultAfterLastUser(transcript: TranscriptContext): boolean {
  let lastUser = -1;
  for (let index = 0; index < transcript.messages.length; index++) {
    if (transcript.messages[index]?.role === "user") lastUser = index;
  }
  return transcript.messages
    .slice(lastUser + 1)
    .some(
      (message) =>
        message.role === "toolResult" && message.toolName === "durable_wait",
    );
}

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
  if (hasToolResultAfterLastUser(transcript)) {
    return fauxAssistantMessage([
      fauxText("Finished after the durable tool checkpoint was committed."),
    ]);
  }
  return fauxAssistantMessage(
    [
      fauxToolCall(
        "durable_wait",
        { label: "crash-window" },
        { id: `durable-wait-${state.callCount}` },
      ),
    ],
    { stopReason: "toolUse" },
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

export class PiRuntime {
  readonly sessionId: string;
  readonly sessionPath: string;
  readonly events: EventLog;
  readonly root: Conversation;
  readonly harness: Harness;
  #stream: AgentEventStream;
  #busy = 0;

  private constructor(
    sessionId: string,
    sessionPath: string,
    events: EventLog,
    harness: Harness,
    root: Conversation,
    stream: AgentEventStream,
  ) {
    this.sessionId = sessionId;
    this.sessionPath = sessionPath;
    this.events = events;
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
      faux.setResponses(Array.from({ length: 100 }, () => scriptedResponse));
      models.setProvider(faux.provider);
    }

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
        const attempt = {
          timestamp: new Date().toISOString(),
          pid: process.pid,
          label,
          sessionId: options.sessionId,
        };
        process.stdout.write(`TOOL_ATTEMPT ${JSON.stringify(attempt)}\n`);
        await recorder.record("tool_attempt", {
          tool: "durable_wait",
          callId: api.callId,
        });
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
    });

    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "poc-durable-wait",
        tools: [waitTool],
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
    await this.events.record("invocation_started", {
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
      const settled = await submission.wait(context);
      if (settled.status === "unanswered" || settled.type !== "input") {
        const payload = unansweredPayload(settled);
        await this.events.record("invocation_failed", {
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
      await this.events.record("invocation_completed", {
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
      this.#busy--;
    }
  }

  async close(): Promise<void> {
    await this.#stream.stop();
    await this.harness.close(context);
    await this.events.record("runtime_closed", {});
  }
}
