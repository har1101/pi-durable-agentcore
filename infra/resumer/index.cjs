// Resumer Lambda. Embedded verbatim in infra/github-oidc-bootstrap.yaml by
// scripts/embed-resumer.mjs; keep it under CloudFormation's 4096-char ZipFile limit.
"use strict";
const { QueryCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");

const due = "dueAt <= :now AND (attribute_not_exists(claimedUntil) OR claimedUntil < :now)";

// Claims each due wake item, then sends {"action":"resume"} on its session id.
// A claim blocks other sweeps until claimedUntil; the runtime's next plan clears it.
async function sweep({ dynamodb, tableName, invoke, now = Date.now(), claimMs = 300000 }) {
  const at = { ":now": { N: String(now) } };
  const items = [];
  let start;
  do {
    const page = await dynamodb.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk",
      FilterExpression: due,
      ExpressionAttributeValues: { ...at, ":pk": { S: "WAKE" } },
      ConsistentRead: true,
      ExclusiveStartKey: start,
    }));
    items.push(...(page.Items || []));
    start = page.LastEvaluatedKey;
  } while (start);
  return Promise.all(items.map(async (item) => {
    const session = item.runtimeSessionId.S;
    try {
      await dynamodb.send(new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: item.pk, sk: item.sk },
        UpdateExpression: "SET claimedUntil = :until ADD claims :one",
        ConditionExpression: due,
        ExpressionAttributeValues: { ...at, ":until": { N: String(now + claimMs) }, ":one": { N: "1" } },
      }));
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException") return { sk: item.sk.S, status: "claimed_elsewhere" };
      throw error;
    }
    try {
      return { sk: item.sk.S, reason: item.reason && item.reason.S, status: "invoked", response: await invoke(session, { action: "resume" }) };
    } catch (error) {
      return { sk: item.sk.S, status: "failed", error: String(error && error.message || error) };
    }
  }));
}

async function handler() {
  const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
  const { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } = require("@aws-sdk/client-bedrock-agentcore");
  const agentcore = new BedrockAgentCoreClient({});
  const results = await sweep({
    dynamodb: new DynamoDBClient({}),
    tableName: process.env.TABLE_NAME,
    claimMs: Number(process.env.CLAIM_SECONDS || 300) * 1000,
    invoke: async (runtimeSessionId, payload) => {
      const out = await agentcore.send(new InvokeAgentRuntimeCommand({
        agentRuntimeArn: process.env.AGENT_RUNTIME_ARN,
        qualifier: process.env.QUALIFIER || "DEFAULT",
        runtimeSessionId,
        contentType: "application/json",
        accept: "application/json",
        payload: new TextEncoder().encode(JSON.stringify(payload)),
      }));
      return out.response ? (await out.response.transformToString()).slice(0, 2000) : "";
    },
  });
  console.log(JSON.stringify({ swept: results.length, results }));
  return results;
}

module.exports = { sweep, handler };
