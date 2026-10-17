import { PiRuntime } from "./runtime.js";

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const command = process.argv[2];
if (command !== "submit" && command !== "resume") {
  throw new Error("Usage: demo-worker.js <submit|resume> [--state-dir DIR]");
}

const stateDirectory = argument("--state-dir", ".demo-state");
const sessionId = argument("--session-id", "crash-resume-demo");
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
  const result = await runtime.invoke({ prompt, requestId });
  process.stdout.write(`DEMO_RESULT ${JSON.stringify(result)}\n`);
} finally {
  await runtime.close();
}
