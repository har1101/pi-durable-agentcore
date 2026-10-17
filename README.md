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
positions. `/ping` returns `HealthyBusy` while work is running.

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

The account already has `pi-durable-agentcore-bootstrap`. Do **not** run
`create-stack`. Fukuchi updates that stack with `--profile fukuchi`. Agents
never run AWS commands.

Rules for every update:

- Never replace the OIDC provider, the IAM roles, the ECR repository, or the
  DynamoDB table. Changes are additive or in place.
- Pass `ExistingGitHubOidcProviderArn` as `UsePreviousValue=true`, so
  CloudFormation does not recreate the OIDC provider.
- Every other existing parameter is `UsePreviousValue=true`. A new parameter
  gets an explicit value.

The exact command for each change lives in `docs/bootstrap-update.md`, one
"Exact UPDATE command (...)" section per change. The latest is
"Exact UPDATE command (wake sweeper + WakeIndex)". It is applied in two steps:
first with `AgentRuntimeArn=""`, then with the runtime ARN that
`scripts/deploy-agentcore.sh` prints.

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
| `APPROVER_USER_IDS`            | comma list of AgentCore runtime user ids allowed to decide; empty denies every decide |
| `PI_APPROVAL_TIMEOUT_MS`       | optional; approval deadline, defaults to 86400000 (24 h) |

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

## Human approval and automatic resume

A gated tool call waits for a human decision without holding a process. The
session parks, the harness closes, and the lease is released. Any later
process resumes from the same DynamoDB checkpoint.

All requests are `POST /invocations` with the AgentCore session id header. The
`action` field selects the command. Values are exact strings.

```jsonc
// invoke: no action field (unchanged contract)
-> {"prompt": "Publish the Q3 report", "requestId": "r-42"}
<- 200 {"status":"pending","requestId":"r-42","sessionId":"...","response":"Waiting for approval",
        "pending":[{"kind":"approval","tool":"publish_report",
                    "summary":"publish_report {\"title\":\"Q3\"}",
                    "approvalId":"apr_3f9c0d4e5a6b7c8d9e0f1a2b3c4d5e6f",
                    "deadline":"2026-10-18T07:00:00.000Z"}]}
<- 200 {"status":"success", ...}   // no gate hit
<- 200 {"status":"error", ..., "reason":"..."}

// decide: only "approve" or "reject"
-> {"action":"decide","approvalId":"apr_3f9c...","decision":"approve"}
<- 200 InvokeResult of the parked request (success, pending at another gate, or error)
<- 202 {"status":"accepted","decision":"approve"}   // recorded; another process holds the lease
<- 400 {"message":"decision must be exactly \"approve\" or \"reject\""}
<- 403 x-amzn-ErrorType: AccessDeniedException    // not an approver, or the requester; nothing written
<- 404 {"status":"error","reason":"unknown_approval"}  // unknown id, or another session's id
<- 409 {"status":"error","reason":"already_decided","decision":"reject","decidedBy":"<user id or timeout>"}
<- 409 {"status":"error","reason":"expired","decision":"reject","decidedBy":"timeout"}

// resume: sent by the sweeper; harmless from anyone
-> {"action":"resume"}
<- 202 {"status":"accepted"}   // driving the session in the background
<- 200 {"status":"idle"}       // nothing unsettled
<- 409 {"status":"busy"}       // another process holds the lease

// timed wait: same pending shape, no approvalId, cannot be decided
<- 200 {"status":"pending", ..., "pending":[{"kind":"timer","tool":"wait_until",
        "summary":"wait_until {\"seconds\":3600}","deadline":"..."}]}
```

**Validation.** The body is parsed once into a strict union. `"yes"`, `true`,
`"APPROVE"`, a missing field, or a malformed `approvalId` is 400, and nothing
is written. Checks run in order: parse (400), approver (403), lookup and
condition (404, 409), then the run continues.

**Approvers.** Authority comes from the caller's identity, never from the
approval id. AgentCore sets `x-amzn-bedrock-agentcore-runtime-user-id` when
the caller invokes with `runtimeUserId` (IAM action
`InvokeAgentRuntimeForUser`). The decision is accepted only when that id is
in `APPROVER_USER_IDS` (comma separated). A missing header or an empty list
fails closed with 403. The user who started the run cannot approve it.
`scripts/deploy-agentcore.sh` passes `APPROVER_USER_IDS` and
`PI_APPROVAL_TIMEOUT_MS` (default 86400000, 24 h) to the runtime.

**Decisions.** A decision is one conditional DynamoDB write, so the first
writer wins. A duplicate of the same decision is treated as success. The
deadline wins too. A decision that arrives after it records the timeout
rejection and returns 409 `expired`. An approved call runs its tool body once.
A rejected call never runs it, and the model sees
`Tool call blocked: rejected by approver`.

**Idempotency keys.** Every tool call gets a key derived from the session id
and the pi-durable task id:
`"tk1_" + sha256(JSON.stringify(["pi-durable-agentcore/tool/v1", sessionId, taskId]))`.
The key is stable across retries, crashes, and resume, and differs for every
call, even when a provider reuses a call id. It does not contain the session
id. Tools pass it to their side effects. Each attempt records a `tool_attempt`
event and a `TOOL_ATTEMPT` stdout line with the key.

**Event log.** Events are stored in the session table under a sibling
partition (`e#<sha256(sessionId)>`), which checkpoint recovery never reads.
`GET /events` reads DynamoDB directly and never opens the runtime, so polling
does not take the lease. Events from a killed process remain visible.

**Automatic resume.** Every item that needs a wake carries `wakeShard`,
`wakeAt`, and `runtimeSessionId`. These attributes exist only while the item
is due and form the sparse GSI `WakeIndex`. A Lambda runs every minute,
queries `WakeIndex` for `wakeAt <= now`, skips sessions whose lease is still
live, and sends `{"action":"resume"}` through `InvokeAgentRuntime`. One
mechanism covers three cases:

- Crash recovery. A run arms its `RUN` item before work starts and disarms it
  when the run settles. If the process dies, the sweeper resumes the session
  on a new microVM with no caller involved.
- Approval timeout. The approval's `wakeAt` is its deadline. On resume the run
  records `reject` by `timeout` unless a human decided first.
- Timed waits. `wait_until` parks with `wakeAt` at the due time and continues
  on the first resume after it.

Wake latency is up to one minute plus the open. Infrastructure and the exact
update command are in `docs/bootstrap-update.md`.
