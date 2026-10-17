import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";
import { PiRuntime, type ModelMode } from "./runtime.js";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 8080);
const stateDirectory =
  process.env.STATE_DIRECTORY ?? "/tmp/pi-durable-agentcore";
const configuredMode = process.env.MODEL_PROVIDER ?? "scripted";
if (configuredMode !== "scripted" && configuredMode !== "bedrock") {
  throw new Error("MODEL_PROVIDER must be scripted or bedrock");
}
const modelMode: ModelMode = configuredMode;
const runtimes = new Map<string, Promise<PiRuntime>>();

function sessionId(request: IncomingMessage, url?: URL): string {
  const header = request.headers["x-amzn-bedrock-agentcore-runtime-session-id"];
  const value = Array.isArray(header) ? header[0] : header;
  return value ?? url?.searchParams.get("sessionId") ?? "local-session";
}

async function runtimeFor(id: string): Promise<PiRuntime> {
  let pending = runtimes.get(id);
  if (!pending) {
    pending = PiRuntime.open({
      stateDirectory,
      sessionId: id,
      modelMode,
      resume: true,
    });
    runtimes.set(id, pending);
    pending.catch(() => runtimes.delete(id));
  }
  return pending;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 1_000_000) throw new Error("Request body exceeds 1 MB");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  try {
    if (request.method === "GET" && url.pathname === "/ping") {
      const values = await Promise.all([...runtimes.values()]);
      json(response, 200, {
        status: values.some((runtime) => runtime.busy)
          ? "HealthyBusy"
          : "Healthy",
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/invocations") {
      const input = await body(request);
      if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
        response.setHeader("x-amzn-ErrorType", "ValidationException");
        json(response, 400, { message: "prompt must be a non-empty string" });
        return;
      }
      if (
        input.requestId !== undefined &&
        typeof input.requestId !== "string"
      ) {
        response.setHeader("x-amzn-ErrorType", "ValidationException");
        json(response, 400, { message: "requestId must be a string" });
        return;
      }
      const runtime = await runtimeFor(sessionId(request));
      const result = await runtime.invoke({
        prompt: input.prompt,
        ...(typeof input.requestId === "string"
          ? { requestId: input.requestId }
          : {}),
      });
      json(response, 200, result);
      return;
    }

    if (request.method === "GET" && url.pathname === "/events") {
      const runtime = await runtimeFor(sessionId(request, url));
      const events = (await runtime.readEvents())
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
      if (request.headers.accept?.includes("text/html")) {
        const escaped = JSON.stringify(events, null, 2)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          `<!doctype html><title>Pi Durable checkpoints</title><h1>Committed steps</h1><pre>${escaped}</pre>`,
        );
      } else {
        json(response, 200, { sessionId: runtime.sessionId, events });
      }
      return;
    }

    response.setHeader("x-amzn-ErrorType", "ResourceNotFoundException");
    json(response, 404, { message: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    process.stderr.write(
      `RuntimeClientError ${request.method} ${url.pathname}: ${message}\n${stack ?? ""}\n`,
    );
    response.setHeader("x-amzn-ErrorType", "RuntimeClientError");
    json(response, 500, { message });
  }
});

server.listen(port, host, () => {
  process.stdout.write(
    `Pi Durable AgentCore HTTP server listening on http://${host}:${port} (${modelMode})\n`,
  );
});

async function shutdown(): Promise<void> {
  server.close();
  const opened = await Promise.allSettled([...runtimes.values()]);
  await Promise.all(
    opened
      .filter(
        (result): result is PromiseFulfilledResult<PiRuntime> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value.close()),
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
