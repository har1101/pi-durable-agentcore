# Pi Durable on AgentCore Runtime PoC

A minimal TypeScript service that runs `@earendil-works/pi-durable` behind the
Amazon Bedrock AgentCore Runtime HTTP contract. It uses real Pi task checkpoints
and SQLite persistence. Local execution is scripted and makes no network model
calls; the container can use Claude through Bedrock with its AgentCore execution
role.

## Local setup

Requires Node.js 22.19 or newer.

```bash
npm ci
npm test
```

Run the AgentCore-shaped HTTP server with the free scripted provider:

```bash
npm run build
MODEL_PROVIDER=scripted SCRIPTED_TOOL_DELAY_MS=50 npm start

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

This launches the compiled worker, waits until its real Pi tool task is running,
sends that process `SIGKILL`, then launches a new process over the same SQLite
file. The second process calls `Harness.resume()` and uses the original
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
Pi Durable or its storage.

## AWS bootstrap (do not run from local demo)

The one-time CloudFormation stack creates:

- a GitHub OIDC provider (or accepts an existing provider ARN);
- an assume role restricted to this repository and `main`;
- one ECR repository;
- a deploy role scoped to that ECR repository, tagged AgentCore runtime, and
  one execution role;
- an AgentCore execution role that can pull this image and invoke Bedrock
  Claude. No access keys are created.

Required inputs:

1. AWS CLI profile `fukuchi` with permission to create IAM, ECR, and
   CloudFormation resources.
2. AWS Region (example below uses `ap-northeast-1`).
3. GitHub owner, repository (`har1101/pi-durable-agentcore` here), and allowed
   deploy branch.
4. If the AWS account already has GitHub's OIDC provider, its ARN.

Fukuchi can run exactly:

```bash
aws cloudformation deploy \
  --profile fukuchi \
  --region ap-northeast-1 \
  --stack-name pi-durable-agentcore-bootstrap \
  --template-file infra/github-oidc-bootstrap.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    GitHubOwner=har1101 \
    GitHubRepository=pi-durable-agentcore \
    GitHubBranch=main
```

If `token.actions.githubusercontent.com` already exists in that account, add:

```bash
ExistingGitHubOidcProviderArn=arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com
```

Read the output values:

```bash
aws cloudformation describe-stacks \
  --profile fukuchi \
  --region ap-northeast-1 \
  --stack-name pi-durable-agentcore-bootstrap \
  --query 'Stacks[0].Outputs'
```

Create a GitHub environment named `agentcore-poc`, then set repository or
environment variables:

| Variable                       | Value                                                      |
| ------------------------------ | ---------------------------------------------------------- |
| `AWS_DEPLOY_ROLE_ARN`          | `GitHubDeployRoleArn` output                               |
| `AGENTCORE_EXECUTION_ROLE_ARN` | `AgentRuntimeExecutionRoleArn` output                      |
| `ECR_REPOSITORY`               | `EcrRepositoryName` output                                 |
| `AWS_ACCOUNT_ID`               | 12-digit AWS account ID                                    |
| `AWS_REGION`                   | bootstrap Region                                           |
| `AGENT_RUNTIME_NAME`           | optional; defaults to `pi_durable_agentcore`               |
| `BEDROCK_MODEL_ID`             | optional; defaults to `global.anthropic.claude-sonnet-4-6` |

The workflow `.github/workflows/deploy-agentcore.yml` assumes the OIDC role,
tests, builds an ARM64 image, pushes it, and creates or updates the HTTP runtime.
It supplies `MODEL_PROVIDER=bedrock` to the deployed runtime. Local and image
defaults remain `scripted`, preventing accidental paid model calls.

## Persistence boundary

SQLite proves process-crash recovery while the AgentCore session filesystem
still exists. It does **not** survive termination/replacement of the microVM.
Before production use, replace it with a remote Pi storage implementation and
enforce Pi's single-writer rule with a conditional-write lease/fencing token.
