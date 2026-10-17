import { PiRuntime } from "./runtime.js";
import { openEventRecorder, sessionDirectory } from "./storage/open.js";

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const command = process.argv[2];
if (command !== "submit" && command !== "resume" && command !== "count") {
  throw new Error(
    "Usage: demo-worker.js <submit|resume|count> [--state-dir DIR] [--session-id ID] [--kind KIND]",
  );
}

const stateDirectory = argument("--state-dir", ".demo-state");
const sessionId = argument("--session-id", "crash-resume-demo");

if (command === "count") {
  // Counts events of one kind in the durable event log (DynamoDB), e.g.
  // tool_attempt, which survives the SIGKILLed process and microVM swaps.
  const kind = argument("--kind", "tool_attempt");
  const recorder = await openEventRecorder(
    sessionId,
    sessionDirectory(stateDirectory, sessionId),
  );
  const events = await recorder.list();
  process.stdout.write(
    `${events.filter((event) => event.kind === kind).length}\n`,
  );
  process.exit(0);
}

const requestId = argument("--request-id", "crash-resume-request");
const prompt = argument("--prompt", "Demonstrate crash-safe progress.");
const scriptedDelayMs = Number(argument("--delay-ms", "5000"));

const runtime = await PiRuntime.open({
  stateDirectory,
  sessionId,
  modelMode: "scripted",
  resume: command === "resume",
  scriptedDelayMs,
});

try {
  await runtime.beginWork();
  try {
    const result = await runtime.invoke({ prompt, requestId });
    process.stdout.write(`DEMO_RESULT ${JSON.stringify(result)}\n`);
  } finally {
    await runtime.endWork();
  }
} finally {
  await runtime.close();
}
