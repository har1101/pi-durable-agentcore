import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import {
  createConfiguredAmazonBedrockProvider,
  DEFAULT_BEDROCK_MODEL_ID,
} from "../dist/bedrock-provider.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("configured amazon-bedrock provider", () => {
  it("registers the default model and treats the AWS default chain as configured", async () => {
    const models = createModels();
    models.setProvider(createConfiguredAmazonBedrockProvider());
    const model = models.getModel("amazon-bedrock", DEFAULT_BEDROCK_MODEL_ID);
    expect(model?.id).toBe(DEFAULT_BEDROCK_MODEL_ID);
    expect(model?.provider).toBe("amazon-bedrock");
    const auth = await models.getAuth(model!);
    expect(auth).toBeDefined();
    expect(auth?.source).toMatch(/AWS|credential/i);
  });

  it("stock amazon-bedrock resolve stays unconfigured without AWS env credentials", async () => {
    const models = createModels();
    models.setProvider(amazonBedrockProvider());
    const model = models.getModel("amazon-bedrock", DEFAULT_BEDROCK_MODEL_ID);
    expect(model).toBeDefined();
    const previous = {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
      AWS_PROFILE: process.env.AWS_PROFILE,
      AWS_BEARER_TOKEN_BEDROCK: process.env.AWS_BEARER_TOKEN_BEDROCK,
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:
        process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
      AWS_CONTAINER_CREDENTIALS_FULL_URI:
        process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
      AWS_WEB_IDENTITY_TOKEN_FILE: process.env.AWS_WEB_IDENTITY_TOKEN_FILE,
    };
    for (const key of Object.keys(previous)) delete process.env[key];
    try {
      const auth = await models.getAuth(model!);
      expect(auth).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("unanswered requestId replay", () => {
  it("returns an explicit error payload instead of HTTP 500", async () => {
    expect(process.env.DYNAMODB_ENDPOINT).toMatch(/^http:\/\//);
    const state = await mkdtemp(join(tmpdir(), "pi-model-error-"));
    temporaryDirectories.push(state);
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    const sessionId = `model-error-${randomUUID()}`;
    const child = spawn(process.execPath, ["dist/server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        STATE_DIRECTORY: state,
        MODEL_PROVIDER: "scripted",
        SCRIPTED_MODEL_ERROR: "1",
        SCRIPTED_TOOL_DELAY_MS: "10",
        STORAGE_BACKEND: "dynamodb",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });

    const invoke = () =>
      fetch(`http://127.0.0.1:${port}/invocations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId,
        },
        body: JSON.stringify({
          prompt: "This should fail the model.",
          requestId: "live-crash-resume-1",
        }),
      });

    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (output.includes("listening on")) break;
        if (child.exitCode !== null)
          throw new Error(`server exited:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const first = await invoke();
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as {
        status: string;
        reason?: string;
        response: string;
        requestId: string;
      };
      expect(firstBody).toMatchObject({
        status: "error",
        reason: "model_error",
        requestId: "live-crash-resume-1",
        sessionId,
      });
      expect(firstBody.response).toContain("unanswered");

      const retry = await invoke();
      expect(retry.status).toBe(200);
      const retryBody = await retry.json();
      expect(retryBody).toMatchObject({
        status: "error",
        reason: "model_error",
        requestId: "live-crash-resume-1",
        sessionId,
      });
      expect(output).not.toContain("RuntimeClientError");
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  });
});
