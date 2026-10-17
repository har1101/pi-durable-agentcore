// dist/wake-sweeper.cjs is also the Lambda's inline code (npm run sync:infra); keep it small and dependency-free.
export const WAKE_INDEX = "WakeIndex";
export const WAKE_SHARD = "w0";

export interface Due {
  readonly pk: string;
  readonly runtimeSessionId: string;
}

export interface SweepDeps {
  queryDue(now: number): Promise<Due[]>;
  leaseLive(pk: string): Promise<boolean>;
  resume(runtimeSessionId: string): Promise<string>;
}

/** Resumes each due session once; a session whose lease is live is skipped, its owner handles its own work. */
export async function sweep(deps: SweepDeps, now = Date.now()) {
  const due = await deps.queryDue(now);
  const queue = [...new Map(due.map((item) => [item.pk, item.runtimeSessionId]))];
  const outcomes: Record<string, string> = {};
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [pk, id] = next;
      try {
        outcomes[id] = (await deps.leaseLive(pk)) ? "live" : await deps.resume(id);
      } catch (error) {
        outcomes[id] = "failed";
        console.error("resume failed", id, error);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { due: due.length, outcomes };
}

type Client = { send(command: unknown): Promise<any> };

export function dynamoDeps(client: Client, table: string) {
  const { GetItemCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");
  return {
    async queryDue(now: number) {
      const due: Due[] = [];
      let start;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: table,
            IndexName: WAKE_INDEX,
            KeyConditionExpression: "wakeShard = :s AND wakeAt <= :n",
            ExpressionAttributeValues: { ":s": { S: WAKE_SHARD }, ":n": { N: String(now) } },
            ExclusiveStartKey: start,
          }),
        );
        for (const item of page.Items ?? []) {
          if (item.runtimeSessionId) due.push({ pk: item.pk.S, runtimeSessionId: item.runtimeSessionId.S });
        }
        start = page.LastEvaluatedKey;
      } while (start);
      return due;
    },
    async leaseLive(pk: string) {
      const { Item } = await client.send(
        new GetItemCommand({ TableName: table, Key: { pk: { S: pk }, sk: { S: "LEASE" } }, ConsistentRead: true }),
      );
      return Number(Item?.expiresAt?.N ?? 0) > Date.now();
    },
  };
}

/** Lambda entry. Env: TABLE_NAME, AGENT_RUNTIME_ARN, AGENT_RUNTIME_QUALIFIER. */
export async function handler() {
  const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
  const agentcore = require("@aws-sdk/client-bedrock-agentcore");
  const client = new agentcore.BedrockAgentCoreClient({});
  const result = await sweep({
    ...dynamoDeps(new DynamoDBClient({}), process.env.TABLE_NAME!),
    async resume(runtimeSessionId) {
      const reply = await client.send(
        new agentcore.InvokeAgentRuntimeCommand({
          agentRuntimeArn: process.env.AGENT_RUNTIME_ARN,
          qualifier: process.env.AGENT_RUNTIME_QUALIFIER || "DEFAULT",
          runtimeSessionId,
          contentType: "application/json",
          accept: "application/json",
          payload: Buffer.from('{"action":"resume"}'),
        }),
      );
      const body = JSON.parse((await reply.response?.transformToString()) || "{}");
      return body.status ?? `http_${reply.statusCode}`;
    },
  });
  console.log(JSON.stringify(result));
  return result;
}
