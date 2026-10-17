import {
  readDynamoDbEvents,
  sessionTableClient,
  sessionTableName,
} from "./event-log.js";

/**
 * Read a session's durable event log from DynamoDB (no lease needed).
 *   node dist/events-cli.js count --session-id ID [--kind tool_attempt]
 *   node dist/events-cli.js dump --session-id ID
 */
function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const command = process.argv[2];
const sessionId = argument("--session-id");
if ((command !== "count" && command !== "dump") || sessionId === undefined) {
  throw new Error("Usage: events-cli.js <count|dump> --session-id ID [--kind KIND]");
}
const kind = argument("--kind");
const events = (
  await readDynamoDbEvents(await sessionTableClient(), sessionTableName(), sessionId)
).filter((event) => kind === undefined || event.kind === kind);
if (command === "count") {
  process.stdout.write(`${events.length}\n`);
} else {
  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
}
