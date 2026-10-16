import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Type,
  type AssistantMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
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
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { EventRecorder } from "./event-recorder.js";

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
}

function sessionDirectory(stateDirectory: string, sessionId: string): string {
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
  #events: AgentEventStream;
  #busy = 0;

  private constructor(
    sessionId: string,
    sessionPath: string,
    recorder: EventRecorder,
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
    const recorder = await EventRecorder.open(
      join(path, "events.jsonl"),
      options.sessionId,
    );
    const models = createModels();

    if (modelMode === "bedrock") {
      models.setProvider(amazonBedrockProvider());
    } else {
      const faux = fauxProvider({ tokensPerSecond: 10_000 });
      faux.setResponses(Array.from({ length: 100 }, () => scriptedResponse));
      models.setProvider(faux.provider);
    }

    const delayMs =
      options.scriptedDelayMs ??
      Number(process.env.SCRIPTED_TOOL_DELAY_MS ?? 5_000);
    const attemptsPath = join(path, "tool-attempts.jsonl");
    const waitTool = defineTool({
      name: "durable_wait",
      description:
        "Wait briefly so process-crash recovery can be demonstrated.",
      parameters: Type.Object({ label: Type.String() }),
      replay: "safe",
      execute: async ({ label }) => {
        const attempt = {
          timestamp: new Date().toISOString(),
          pid: process.pid,
          label,
        };
        await appendFile(attemptsPath, `${JSON.stringify(attempt)}\n`, "utf8");
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
      await openNodeSqliteStorage(join(path, "session.sqlite")),
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
            modelId:
              process.env.BEDROCK_MODEL_ID ??
              "global.anthropic.claude-sonnet-4-6",
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
      database: join(path, "session.sqlite"),
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
      const settled = await submission.wait(context);
      if (settled.status !== "done" || settled.type !== "input") {
        throw new Error(`Submission did not complete: ${settled.status}`);
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
      return { response, requestId, sessionId: this.sessionId };
    } finally {
      this.#busy--;
    }
  }

  async readEvents(): Promise<string> {
    try {
      return await readFile(this.recorder.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#events.stop();
    await this.harness.close(context);
    await this.recorder.record("runtime_closed", {});
    await this.recorder.flush();
  }
}
