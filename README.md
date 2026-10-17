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

The account already has `pi-durable-agentcore-bootstrap` in `CREATE_COMPLETE`.
Do **not** run `create-stack`. Fukuchi updates that stack with
`--profile fukuchi`. Pass `ExistingGitHubOidcProviderArn` as
`UsePreviousValue=true` so CloudFormation does not recreate the OIDC provider.

The 918f7b8 template diff and the same command live in
`docs/bootstrap-update.md`.

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
