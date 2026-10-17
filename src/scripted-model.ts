import type {
  AssistantMessage,
  Message,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type FauxProviderState,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import type { EventRecorder } from "./event-recorder.js";

function messageText(message: Message | undefined): string {
  if (message === undefined) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item: { type?: string; text?: string }) =>
      item.type === "text" ? (item.text ?? "") : "",
    )
    .join("");
}

/**
 * Free, deterministic stand-in for Claude. The last user message selects the
 * scenario:
 * - `[approval]` or `[approval:<action>]`: call `perform_sensitive_action`
 *   (human-in-the-loop);
 * - `[wait:<seconds>]`: call `wait_until` (timed wait);
 * - anything else: call `durable_wait` (the crash window).
 * After a tool result it answers with text that names the result. Every call
 * is recorded as a `model_call` event so tests can prove completed model calls
 * are not repeated after a resume. `SCRIPTED_TOOL_CALL_ID` forces one tool call
 * id for every call, like a provider that reuses ids.
 */
export function scriptedResponder(recorder: EventRecorder): FauxResponseFactory {
  return async (
    transcript: TranscriptContext,
    _options: unknown,
    state: FauxProviderState,
  ): Promise<AssistantMessage> => {
    let lastUser = -1;
    for (let index = 0; index < transcript.messages.length; index++) {
      if (transcript.messages[index]?.role === "user") lastUser = index;
    }
    const prompt = messageText(transcript.messages[lastUser]);
    const results = transcript.messages
      .slice(lastUser + 1)
      .filter((message) => message.role === "toolResult");
    process.stdout.write(
      `MODEL_CALL ${JSON.stringify({ pid: process.pid, toolResults: results.length })}\n`,
    );
    await recorder.record("model_call", {
      provider: "faux",
      processCallCount: state.callCount,
      toolResults: results.length,
    });

    if (process.env.SCRIPTED_MODEL_ERROR === "1") {
      return fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage:
          process.env.SCRIPTED_MODEL_ERROR_MESSAGE ??
          "Provider is not configured: amazon-bedrock",
      });
    }

    const last = results.at(-1);
    if (last !== undefined) {
      const resultText = messageText(last);
      const toolName = (last as { toolName?: string }).toolName;
      if (toolName === "perform_sensitive_action") {
        return fauxAssistantMessage([
          fauxText(`Sensitive action finished. ${resultText}`),
        ]);
      }
      if (toolName === "wait_until") {
        return fauxAssistantMessage([
          fauxText(`Resumed after the timed wait. ${resultText}`),
        ]);
      }
      return fauxAssistantMessage([
        fauxText("Finished after the durable tool checkpoint was committed."),
      ]);
    }

    const forcedId = process.env.SCRIPTED_TOOL_CALL_ID;
    const approval = /\[approval(?::([a-z0-9-]{1,64}))?\]/.exec(prompt);
    const wait = /\[wait:(\d{1,7})\]/.exec(prompt);
    const [name, args]: [string, { [key: string]: string | number }] = approval
      ? ["perform_sensitive_action", { action: approval[1] ?? "rotate-demo-credentials" }]
      : wait
        ? ["wait_until", { seconds: Number(wait[1]) }]
        : ["durable_wait", { label: "crash-window" }];
    const id = forcedId ?? `${name.replaceAll("_", "-")}-${state.callCount}`;
    return fauxAssistantMessage([fauxToolCall(name, args, { id })], {
      stopReason: "toolUse",
    });
  };
}
