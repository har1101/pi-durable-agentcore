import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { dynamoDbClientConfig } from "./storage/dynamodb.js";
import { sessionTable } from "./storage/open.js";
import { dynamoDeps, sweep } from "./wake-sweeper.cjs";

// One sweep against a local server, through the same HTTP contract AgentCore forwards to the runtime.
const index = process.argv.indexOf("--target");
const target = index === -1 ? undefined : process.argv[index + 1];
if (target === undefined) {
  throw new Error("Usage: wake-sweep-cli.js --target http://HOST:PORT");
}

const { tableName } = await sessionTable();
const result = await sweep({
  ...dynamoDeps(new DynamoDBClient(dynamoDbClientConfig()), tableName),
  async resume(runtimeSessionId) {
    const response = await fetch(`${target}/invocations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-amzn-bedrock-agentcore-runtime-session-id": runtimeSessionId,
      },
      body: JSON.stringify({ action: "resume" }),
    });
    const body = (await response.json()) as { status?: string };
    return body.status ?? `http_${response.status}`;
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
