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
contract, two-owner lease contention (the loser is fenced), human approval
across a process replacement, automatic resume (crash, approval deadline,
timer) driven by the resumer Lambda's code, and Pi's storage conformance
suite.

If port 8000 is taken, or the environment injects AWS keys that DynamoDB
Local rejects, run:

```bash
AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local DYNAMODB_PORT=8001 npm test
```

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
positions. They are DynamoDB items, so a replacement microVM serves the events
of the one it replaced; reading them takes no session lease. `/ping` returns
`HealthyBusy` while an invocation is open or a run is working, and `Healthy`
while the run waits for an approval or a timer.

## Invocation actions

`POST /invocations` takes one of three bodies. The session is always the
`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header.

| Body | Who sends it | Result |
| --- | --- | --- |
| `{"prompt", "requestId"?}` | requester | `success`, `error`, or `pending` |
| `{"action":"decide", "approvalId", "decision", "approverToken"}` | approver | the decision and the run's next result |
| `{"action":"resume"}` | resumer Lambda | the run's next result, or `idle` |

A tool that needs approval makes the invocation return at once:

```json
{"status":"pending","reason":"approval_required","approvalId":"apr_…","expiresAt":"…","requestId":"…","sessionId":"…","response":"Waiting for approval apr_…."}
```

The approval id names the approval. It does not let anyone decide it. A
decision needs `approverToken`, whose SHA-256 the runtime holds in
`APPROVER_TOKEN_SHA256`; without that variable every decision is refused
(403). `decision` must be exactly `"approve"` or `"reject"`; anything else is
a 400 and changes nothing. The first decision wins: repeating it returns 200
`already_decided`, and a different later decision returns 409. A timed wait
returns `{"status":"pending","reason":"timer","wakeAt":"…"}` the same way.

Scripted mode picks its tool from the prompt: `[approval]` calls
`approved_action`, `[timer]` calls `wait_until` (`SCRIPTED_WAIT_SECONDS`,
default 2), and anything else calls `durable_wait`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `APPROVER_TOKEN_SHA256` | unset (refuse all) | hex SHA-256 of the approver token |
| `APPROVAL_TIMEOUT_MS` | `86400000` (24 h) | approval deadline; then it is rejected as `timeout` |
| `PI_WAKE_GRACE_MS` | `60000` | how long after the last heartbeat a crashed run is resumed |
| `PI_RESUME_WAIT_MS` | `240000` | how long a `resume` invocation waits before returning `running` |

## Automatic resume

Each session keeps one item in the `WAKE` partition of the session table
saying when it next needs a `resume` invocation: a live run's heartbeat plus
`PI_WAKE_GRACE_MS`, the earliest approval deadline, or a timer's wake time. A
scheduled Lambda (`infra/resumer/index.cjs`, created by the bootstrap stack
when `AgentRuntimeArn` is set) claims due items and calls
`InvokeAgentRuntime` with the stored session id. The runtime then rejects
expired approvals, lets Pi rerun interrupted replay-safe tools, and reports
the outcome. `docs/auto-resume.md` explains the design and its limits.

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

## AWS bootstrap UPDATE (do not create a new stack)

The account already has `pi-durable-agentcore-bootstrap` in `CREATE_COMPLETE`.
Do **not** run `create-stack`. Fukuchi updates that stack with
`--profile fukuchi`. Pass `ExistingGitHubOidcProviderArn` as
`UsePreviousValue=true` so CloudFormation does not recreate the OIDC provider.

The 918f7b8 template diff and the same command live in
`docs/bootstrap-update.md`. The resumer (automatic resume) is a later update
of the same stack with the new `AgentRuntimeArn` parameter; its command is in
`docs/bootstrap-update.md` under "Exact UPDATE command (resumer)".

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
| `APPROVER_TOKEN_SHA256`        | optional; hex SHA-256 of the approver token (unset: no decisions) |

The workflow `.github/workflows/deploy-agentcore.yml` assumes the OIDC role,
tests against DynamoDB Local, builds an ARM64 image, pushes it, and creates or
updates the HTTP runtime. It supplies `MODEL_PROVIDER=bedrock` and
`STORAGE_BACKEND=dynamodb` to the deployed runtime. Local defaults remain
scripted + DynamoDB Local, preventing accidental paid model calls.

## Persistence

Each session is one DynamoDB partition. A conditional-write lease plus a
monotonic fencing token enforces Pi's single-writer rule. Commits are
idempotent and chunked under DynamoDB's 400 KB item limit. A replaced AgentCore
microVM reopens the same table, steals an expired lease, and calls `resume()`.

The same table holds, under other partition keys:

| Partition key | Items |
| --- | --- |
| `s#<sha256(sessionId)>` | Pi commits, lease, meta (unchanged) |
| `e#<sha256(sessionId)>` | event log, including `tool_attempt` |
| `WAKE` | one wake item per session that needs a resume |
| `fx#<sha256(idempotencyKey)>` | the demo side-effect ledger |

Approvals and timers live inside Pi's commit log, as the session document
`app.suspensions`.

Every tool execution gets an idempotency key:
`sha256("pi-durable-agentcore/tool/v1\0" + sha256(sessionId) + "\0" + taskId)`.
The Pi tool task id is minted once per tool use and survives retries, replays,
and resume, while provider tool call ids can repeat. `tool_attempt` events
carry the key.
