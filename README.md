# Pi Durable on AgentCore Runtime PoC

A minimal TypeScript service that runs `@earendil-works/pi-durable` behind the
Amazon Bedrock AgentCore Runtime HTTP contract. Checkpoints go to a custom
DynamoDB `Storage` (Pi Durable has no official DynamoDB backend: only Memory,
SQLite, JSONL, and Cloudflare Durable Object SQLite). Local execution is
scripted and uses DynamoDB Local; the container can use Claude through Bedrock
with its AgentCore execution role.

SQLite remains optional (`STORAGE_BACKEND=sqlite`).

## Local setup

Requires Node.js 22.19 or newer and Java 21 (for DynamoDB Local).

```bash
npm ci
npm test
```

`npm test` starts DynamoDB Local, then runs process-level tests against the
real AWS DynamoDB client: crash→resume after `SIGKILL`, the AgentCore HTTP
contract, two-owner lease contention (the loser is fenced), and Pi's storage
conformance suite.

Run the AgentCore-shaped HTTP server with the free scripted provider:

```bash
npm run build
bash scripts/with-dynamodb-local.sh npm start

curl http://localhost:8080/ping
curl -X POST http://localhost:8080/invocations \
  -H 'content-type: application/json' \
  -H 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: local-demo' \
  -d '{"prompt":"Show durable progress.","requestId":"local-1"}'
curl 'http://localhost:8080/events?sessionId=local-demo'
```

`/events` lists model/tool events and monotonically numbered observed commit
positions. With `STORAGE_BACKEND=dynamodb` it reads the durable event log from
DynamoDB (no lease, any process); `/status` shows the session's wake-up item
and approvals. `/ping` returns `HealthyBusy` while work is running.

## Real crash → resume demo

This launches the compiled worker against DynamoDB Local, waits until its real
Pi tool task is running, sends that process `SIGKILL`, then launches a **new**
process over the same DynamoDB session. The second process acquires the lease
(after the dead owner's TTL), calls `Harness.resume()`, and uses the original
`requestId`.

```bash
npm run build
npm run demo:crash-resume
```

Success ends with:

```text
CRASHED pid=... with SIGKILL during durable_wait
DEMO_RESULT {"response":"Finished after the durable tool checkpoint was committed.",...}
PASS crash->resume: attempts=2
```

The integration suite exercises this same process boundary; it does not mock
Pi Durable or DynamoDB.

## Human approval, timed waits, and automatic resume

All of this needs `STORAGE_BACKEND=dynamodb`. Everything a later process needs
lives in the session table, so a session can continue on a new microVM, after
the 8 h AgentCore lifetime, or after a crash.

| Item (same table)          | Partition key               | Purpose                                                    |
| -------------------------- | --------------------------- | ---------------------------------------------------------- |
| Pi commit log, lease, meta | `s#<sha256(session)>`       | unchanged                                                  |
| Event log (`/events`)      | `s#<sha256(session)>#events`| `EVT#<position>` + atomic counter `EVTSEQ`                 |
| Control                    | `s#<sha256(session)>#ctl`   | `APPROVAL#<id>`, one `WAKE` item, `EFFECT#<idempotency key>` |

Separate partitions keep Pi recovery from reading events or control items.

### Human in the loop (`guarded_action`)

The tool records a pending approval and the session's wake-up item, then the
runtime closes the Harness (the replay-safe tool task stays at its durable
`execute` checkpoint) and releases the lease. The invocation returns:

```json
{"status":"pending_approval","requestId":"r1","approval":{"approvalId":"…","toolName":"guarded_action","deadline":"…"}}
```

While it is pending, new prompts get the same pending result
(`reason: "session_suspended"`). An approver answers on the same AgentCore
session id:

```json
{"approval":{"approvalId":"…","decision":"approve","approverToken":"<hex>","reason":"optional"}}
```

- `decision` must be exactly `"approve"` or `"reject"`; anything else is a 400
  and nothing is recorded. Only `"approve"` approves.
- `approverToken` is `HMAC-SHA256(APPROVAL_HMAC_KEY, "pi-durable-agentcore/approval/v1\0" + sessionId + "\0" + approvalId)`
  in hex. Only the approver service holds the key; the requester gets the
  approval id only. Without `APPROVAL_HMAC_KEY` every decision is refused (403)
  and approvals can only time out.
- The decision is a conditional write (pending and before the deadline), then
  the session resumes from DynamoDB: Pi reruns only the parked tool, which
  finds the decision and performs the action once (`EFFECT#<key>`). Completed
  model calls and tools are not repeated.
- After `PI_APPROVAL_TIMEOUT_MS` (default 24 h) the approval is rejected
  automatically and the run continues with the rejection.

### Timed waits (`wait_until`)

`wait_until({seconds})` memoizes the resume time in Pi, arms the wake-up item
for it, and suspends like an approval (`status: "waiting"`, `resumeAt`).

### Tool idempotency keys

Every tool execution gets `tk_<sha256(domain, sessionId, conversationId, Pi tool task id)>`
(`src/idempotency.ts`). The task id is minted durably when the call is
admitted, so the key is stable across retries, replays, and resume on another
microVM, and differs per tool use even when a provider reuses a tool call id.
The raw session id never appears in it.

### Automatic resume (no client request)

One `WAKE` item per session, indexed by the sparse `WakeIndex` GSI
(`wakeShard`, `wakeDueAt`) while armed:

| Situation              | Armed by                                  | Due at                                 |
| ---------------------- | ----------------------------------------- | -------------------------------------- |
| Run in flight          | runtime heartbeat (`PI_WAKE_HEARTBEAT_MS`) | now + `PI_WAKE_CRASH_GRACE_MS` (60 s)  |
| Waiting for a human    | `guarded_action`                          | approval deadline (auto-reject)        |
| Timed wait             | `wait_until`                              | resume time                            |
| Idle                   | disarmed when the run settles             | –                                      |

A Lambda run every minute by EventBridge Scheduler (`infra/github-oidc-bootstrap.yaml`,
`AutoResume*`) queries due items, claims each with a conditional write on the
due time it read (racing sweeps claim once; the claim also schedules a retry
after `AutoResumeRetrySeconds`), and calls `InvokeAgentRuntime` with the same
`runtimeSessionId` and `{"action":"resume"}`. The runtime answers at once and
continues in the background (`/ping` reports `HealthyBusy`); a second resumer
on another process gets 409 from the DynamoDB lease. A wake claimed
`AutoResumeMaxAttempts` times without progress is dead-lettered
(`deadLetter=true`, out of the index). Clients may send
`{"action":"resume","wait":true}` themselves.

The local tests run the template's exact Lambda source against DynamoDB Local,
with local servers standing in for `InvokeAgentRuntime`.

## AWS bootstrap UPDATE (do not create a new stack)

The account already has `pi-durable-agentcore-bootstrap` in `CREATE_COMPLETE`.
Do **not** run `create-stack`. Fukuchi updates that stack with
`--profile fukuchi`. Pass `ExistingGitHubOidcProviderArn` as
`UsePreviousValue=true` so CloudFormation does not recreate the OIDC provider.

The 918f7b8 template diff and the same command live in
`docs/bootstrap-update.md`. The auto-resume update (WakeIndex GSI + sweeper,
new parameters) is the last section there.

```bash
aws cloudformation update-stack \
  --profile fukuchi \
  --region ap-northeast-1 \
  --stack-name pi-durable-agentcore-bootstrap \
  --template-body file://infra/github-oidc-bootstrap.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters \
    ParameterKey=GitHubOwner,ParameterValue=har1101 \
    ParameterKey=GitHubRepository,ParameterValue=pi-durable-agentcore \
    ParameterKey=GitHubBranch,ParameterValue=main \
    ParameterKey=GitHubEnvironment,ParameterValue=agentcore-poc \
    ParameterKey=SessionTableName,ParameterValue=pi-durable-agentcore-sessions \
    ParameterKey=EcrRepositoryName,UsePreviousValue=true \
    ParameterKey=ExistingGitHubOidcProviderArn,UsePreviousValue=true
```

The update adds the session table and least-privilege DynamoDB permissions on
the existing execution role, and allows the GitHub environment `agentcore-poc`
OIDC subject (the 918f7b8 trust policy only allowed `ref:refs/heads/main`).
OIDC provider, ECR, and existing role logical IDs are unchanged.

Create a GitHub environment named `agentcore-poc`, then set repository or
environment variables:

| Variable                       | Value                                                      |
| ------------------------------ | ---------------------------------------------------------- |
| `AWS_DEPLOY_ROLE_ARN`          | `GitHubDeployRoleArn` output                               |
| `AGENTCORE_EXECUTION_ROLE_ARN` | `AgentRuntimeExecutionRoleArn` output                      |
| `ECR_REPOSITORY`               | `EcrRepositoryName` output                                 |
| `DYNAMODB_TABLE`               | `SessionTableName` output                                  |
| `AWS_ACCOUNT_ID`               | 12-digit AWS account ID                                    |
| `AWS_REGION`                   | bootstrap Region                                           |
| `AGENT_RUNTIME_NAME`           | optional; defaults to `pi_durable_agentcore`               |
| `BEDROCK_MODEL_ID`             | optional; defaults to `global.anthropic.claude-sonnet-4-6` |
| `PI_WAKE_SHARDS`               | optional; must equal `WakeShardCount` (default 4)          |
| `PI_APPROVAL_TIMEOUT_MS`       | optional; approval auto-reject deadline (default 24 h)     |
| secret `APPROVAL_HMAC_KEY`     | optional; enables approver decisions (≥ 16 chars)          |

The workflow `.github/workflows/deploy-agentcore.yml` assumes the OIDC role,
tests against DynamoDB Local, builds an ARM64 image, pushes it, and creates or
updates the HTTP runtime. It supplies `MODEL_PROVIDER=bedrock` and
`STORAGE_BACKEND=dynamodb` to the deployed runtime. Local defaults remain
scripted + DynamoDB Local, preventing accidental paid model calls.

## Persistence

Each session's Pi state is one DynamoDB partition (its event log and control
items have their own, see above). A conditional-write lease plus a
monotonic fencing token enforces Pi's single-writer rule. Commits are
idempotent and chunked under DynamoDB's 400 KB item limit. A replaced AgentCore
microVM reopens the same table, steals an expired lease, and calls `resume()`.
