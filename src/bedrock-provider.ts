import type { Provider } from "@earendil-works/pi-ai/models";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";

export const DEFAULT_BEDROCK_MODEL_ID = "global.anthropic.claude-sonnet-4-6";
export const DEFAULT_BEDROCK_REGION = "ap-northeast-1";

export function bedrockRegion(): string {
  return (
    process.env.AWS_REGION?.trim() ||
    process.env.AWS_DEFAULT_REGION?.trim() ||
    DEFAULT_BEDROCK_REGION
  );
}

export function bedrockModelId(): string {
  return process.env.BEDROCK_MODEL_ID?.trim() || DEFAULT_BEDROCK_MODEL_ID;
}

/**
 * Pi's stock amazon-bedrock `resolve()` only treats env keys, profiles, bearer
 * tokens, ECS URIs, and web-identity files as configured. AgentCore Runtime
 * authenticates the execution role through IMDS (the AWS SDK default chain),
 * which that check misses — hence `Provider is not configured: amazon-bedrock`
 * with durationMs:1 and no Bedrock call.
 */
export function createConfiguredAmazonBedrockProvider(): Provider<"bedrock-converse-stream"> {
  const stock = amazonBedrockProvider();
  const region = bedrockRegion();
  const modelId = bedrockModelId();
  const models = [...stock.getModels()];
  if (!models.some((model) => model.id === modelId)) {
    const template =
      models.find((model) => model.id === DEFAULT_BEDROCK_MODEL_ID) ??
      models.find((model) => model.id.includes("claude-sonnet-4-6")) ??
      models[0];
    if (!template) {
      throw new Error("amazon-bedrock catalog has no chat models");
    }
    models.push({
      ...template,
      id: modelId,
      name: `${template.name} (${modelId})`,
      baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
    });
  }

  const apiKey = stock.auth.apiKey;
  if (!apiKey) {
    throw new Error("amazon-bedrock provider is missing apiKey auth");
  }

  return {
    ...stock,
    getModels: () => models,
    getAllModels: () => models,
    auth: {
      apiKey: {
        ...apiKey,
        resolve: async (input) => {
          const resolved = await apiKey.resolve(input);
          if (resolved) return resolved;
          return {
            auth: {},
            env: { AWS_REGION: region, AWS_DEFAULT_REGION: region },
            source: "AWS default credential chain",
          };
        },
      },
    },
  };
}

export function applyBedrockRuntimeEnv(): { region: string; modelId: string } {
  const region = bedrockRegion();
  const modelId = bedrockModelId();
  process.env.AWS_REGION ??= region;
  process.env.AWS_DEFAULT_REGION ??= region;
  return { region, modelId };
}
