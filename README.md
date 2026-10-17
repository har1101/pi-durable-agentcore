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
contract, two-owner lease contention (the loser is fenced), Pi's storage
conformance suite, human approvals answered on a new instance, tool
idempotency keys, the durable event log, and automatic resume driven by the
resume sweeper's own Lambda code. If the environment injects AWS keys that
DynamoDB Local rejects, run `AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local npm test`.

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
positions. `/ping` returns `HealthyBusy` while work is running.

## Invocations

AgentCore only routes `POST /invocations` (and `/ping`), so every operation
is a payload on the same session id
(`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`):

| Payload | What it does |
| --- | --- |
| `{"prompt": "...", "requestId": "..."}` | Submit input (`type` defaults to `prompt`). A retried `requestId` returns the stored answer. |
| `{"type": "approval", "approvalId": "apr_…", "decision": "approve" \| "reject", "signature": "<hex>", "reason"?: "..."}` | Answer a pending approval; the response is the result of the run it unblocked. |
| `{"type": "resume", "reason"?: "...", "wait"?: true}` | Internal: continue whatever durable work the session has. Sent by the resume sweeper; answers `202 accepted` at once unless `wait` is true. |

A prompt answers `success`, `error`, `pending_approval` (with `approvals`:
id, tool, action, deadline), or `waiting` (with `resumeAt`).

## Human-in-the-loop approvals

The scripted model calls `perform_sensitive_action` when the prompt contains
`[approval]` (or `[approval:<action>]`); Claude calls it when asked to do
something sensitive. The tool records a pending approval (a Pi document,
committed to DynamoDB with the transcript) and waits. When every live task of
the session waits on a human or a clock, the invocation returns
`pending_approval` with the approval id, the runtime closes the Harness and
releases the lease, and `/ping` goes back to `Healthy`. Nothing is held in
memory: the answer may reach a new microVM hours later (the deadline,
`APPROVAL_TIMEOUT_MS`, defaults to 24 h, beyond one 8 h AgentCore lifetime).

The requester only ever receives the approval id. Approving needs a signature
from the approver side: HMAC-SHA256 with `APPROVAL_SIGNING_KEY` (at least 32
characters) over the approval id and the exact decision. The answer is parsed
strictly: only the string `"approve"` approves, `"reject"` rejects, and
anything else (`"yes"`, `"APPROVE"`, `true`, extra fields, a signature for the
other decision) is rejected without changing anything. Repeating the recorded
decision is idempotent; contradicting it is `409`. Without a key, approvals
can only time out.

```bash
curl -s -X POST localhost:8080/invocations -H 'content-type: application/json' \
  -H 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: local-hitl' \
  -d '{"prompt":"Rotate it [approval:rotate-demo-credentials]","requestId":"hitl-1"}'
# → {"status":"pending_approval","approvals":[{"approvalId":"apr_…",...}],...}

# On the approver's side only:
APPROVAL_SIGNING_KEY=... npm run -s approval:sign -- apr_… approve > answer.json
curl -s -X POST localhost:8080/invocations -H 'content-type: application/json' \
  -H 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: local-hitl' -d @answer.json
```

On resume the replay-safe tool reruns, finds the decision in its approval
document, and continues; the model call that requested the tool is not
repeated. A rejection or an expired deadline returns "Not executed: …" to the
model, which continues the run.

## Tool idempotency keys

Every tool use gets `idem_v1_<sha256>` over the SHA-256 of the session id, the
conversation id, and Pi's persisted tool task id (plus call id and tool name).
Task ids are minted once and never reused in a session, so the key is the same
across retries, replays, and resume, and different for every tool use, even
when a provider reuses a tool call id. The key is pinned in the task's memo
(first writer wins), so it also survives a change of derivation. Tools pass it
to external systems; the approved action goes through an idempotent ledger
keyed by it, so a crash between the effect and the result does not apply the
effect twice.

## Durable event log

Events (`runtime_opened`, `model_call`, `tool_attempt`, `checkpoint_committed`,
approvals, wakes, ...) go to the session table, not to `/tmp`: partition
`e#<sha256(session id)>`, sort key `EVENT#<position>`, positions from an atomic
counter so they stay monotonic across processes. The partition is separate
from the commit log (`s#…`) so reopening a session does not replay events.
`/events` reads it without the lease, on any instance. `TOOL_ATTEMPT` lines are
still printed for CloudWatch.

## Automatic resume

Each session has one `WAKE` item (partition `w#<sha256>`) saying when it must
be looked at without a client request. It holds the raw session id because
the resumer needs it for `InvokeAgentRuntime`. A sparse GSI, `wake-index`
(`wakeShard`, `wakeAt`), lists only items that are due-able.

| Situation | WAKE item |
| --- | --- |
| Work running | `inflight`, `now + INFLIGHT_GRACE_MS` (60 s), pushed forward every grace/3 while the owner lives |
| Instance shuts down mid-work (SIGTERM, maxLifetime) | `interrupted`, now |
| Parked on approval | `approval_deadline`, the deadline |
| Parked on `wait_until` longer than `INLINE_WAIT_MAX_MS` (30 s) | `timer`, the wake time |
| Idle | not due-able (removed from the index) |

Writes are conditioned on the lease fencing token, so a stale owner cannot
overwrite a newer schedule. The resume sweeper (Lambda, every minute from
EventBridge Scheduler) queries `wakeAt <= now`, claims each item with a
conditional write (one invocation per claim window, at most 20 claims without
progress), and sends `{"type":"resume"}` with that session id. The runtime
acquires the lease, resumes the Harness, and drives the work until it is idle
or parked again, which rewrites the WAKE item. Racing resumers are harmless:
in one process they queue on the session, across instances the lease admits
one owner, and tool effects are keyed.

Why a sweeper rather than one EventBridge schedule per wake: in-flight work
needs its wake pushed forward continuously (a schedule update every few
seconds per session) and a crashed process cannot cancel or create schedules,
whereas the table is already the source of truth and every write to it is
fenced. DynamoDB TTL is not precise enough for deadlines (deletion can lag by
days). The cost is up to one sweep interval of latency.

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
`docs/bootstrap-update.md`, together with the update that adds the wake index
and the resume sweeper (new parameters `AgentRuntimeArn`,
`ResumeSweepSchedule`, `ResumeQualifier`; new outputs `WakeIndexName`,
`ResumeSweeperFunctionName`, `ResumeSweeperScheduleName`).

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
| `APPROVAL_TIMEOUT_MS`          | optional; defaults to `86400000` (24 h)                    |
| `INFLIGHT_GRACE_MS`            | optional; defaults to `60000`                              |

Secret `APPROVAL_SIGNING_KEY` (optional, at least 32 characters): the
approver's HMAC key. Without it approvals can only time out. It is passed as a
runtime environment variable for this PoC; use Secrets Manager in production.

The workflow `.github/workflows/deploy-agentcore.yml` assumes the OIDC role,
tests against DynamoDB Local, builds an ARM64 image, pushes it, and creates or
updates the HTTP runtime. It supplies `MODEL_PROVIDER=bedrock` and
`STORAGE_BACKEND=dynamodb` to the deployed runtime. Local defaults remain
scripted + DynamoDB Local, preventing accidental paid model calls.

## Persistence

Each session's Pi commit log is one DynamoDB partition. A conditional-write lease plus a
monotonic fencing token enforces Pi's single-writer rule. Commits are
idempotent and chunked under DynamoDB's 400 KB item limit. A replaced AgentCore
microVM reopens the same table, steals an expired lease, and calls `resume()`.
