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

function lastUserText(transcript: TranscriptContext): string {
  const message = transcript.messages[lastUserIndex(transcript)];
  if (message?.role !== "user") return "";
  return typeof message.content === "string"
    ? message.content
    : message.content.map((item) => (item.type === "text" ? item.text : "")).join("");
}

function toolResult(
  transcript: TranscriptContext,
): { toolName: string; text: string } | undefined {
  const result = transcript.messages
    .slice(lastUserIndex(transcript) + 1)
    .find((message) => message.role === "toolResult");
  if (result?.role !== "toolResult") return undefined;
  return {
    toolName: result.toolName,
    text: result.content
      .map((item) => (item.type === "text" ? item.text : ""))
      .join(""),
  };
}

/** Prompt directives pick the scripted tool: `[approval]`, else `durable_wait`. */
function scriptedToolCall(prompt: string) {
  if (prompt.includes("[approval]")) {
    return fauxToolCall("approved_action", { action: "deploy" }, { id: SCRIPTED_TOOL_CALL_ID });
  }
  return fauxToolCall("durable_wait", { label: "crash-window" }, { id: SCRIPTED_TOOL_CALL_ID });
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
  const result = toolResult(transcript);
  if (result?.toolName === "durable_wait") {
    return fauxAssistantMessage([
      fauxText("Finished after the durable tool checkpoint was committed."),
    ]);
  }
  if (result !== undefined) {
    return fauxAssistantMessage([fauxText(`Finished: ${result.text}`)]);
  }
  return fauxAssistantMessage([scriptedToolCall(lastUserText(transcript))], {
    stopReason: "toolUse",
  });
}
