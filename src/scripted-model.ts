import type {
  AssistantMessage,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

/**
 * Every scripted tool call reuses this id, as some providers do across turns,
 * so tests can show idempotency keys do not depend on it.
 */
export const SCRIPTED_TOOL_CALL_ID = "scripted-call";

function lastUserIndex(transcript: TranscriptContext): number {
  let lastUser = -1;
  for (let index = 0; index < transcript.messages.length; index++) {
    if (transcript.messages[index]?.role === "user") lastUser = index;
  }
  return lastUser;
}

function toolResultText(transcript: TranscriptContext): string | undefined {
  const result = transcript.messages
    .slice(lastUserIndex(transcript) + 1)
    .find((message) => message.role === "toolResult");
  if (result?.role !== "toolResult") return undefined;
  return result.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
}

/** Free, deterministic stand-in for Bedrock: one tool call, then an answer. */
export function scriptedResponse(transcript: TranscriptContext): AssistantMessage {
  if (process.env.SCRIPTED_MODEL_ERROR === "1") {
    return fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage:
        process.env.SCRIPTED_MODEL_ERROR_MESSAGE ??
        "Provider is not configured: amazon-bedrock",
    });
  }
  const result = toolResultText(transcript);
  if (result !== undefined) {
    return fauxAssistantMessage([
      fauxText("Finished after the durable tool checkpoint was committed."),
    ]);
  }
  return fauxAssistantMessage(
    [
      fauxToolCall(
        "durable_wait",
        { label: "crash-window" },
        { id: SCRIPTED_TOOL_CALL_ID },
      ),
    ],
    { stopReason: "toolUse" },
  );
}
