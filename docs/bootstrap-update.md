# Bootstrap stack UPDATE (from 918f7b8)

Do **not** run `create-stack`. The account already has
`pi-durable-agentcore-bootstrap` in `CREATE_COMPLETE` in `ap-northeast-1`
(account `064212132988`). Fukuchi runs an **update** with `--profile fukuchi`.

This change must not replace the OIDC provider, existing IAM roles, or ECR
repository. New work is additive (DynamoDB table + execution-role policy) plus
an in-place trust-policy edit.

## Preserve these outputs

- GitHubDeployRoleArn=`arn:aws:iam::064212132988:role/pi-durable-agentcore-bootstrap-GitHubDeployRole-QaVaHsZDGJfJ`
- AgentRuntimeExecutionRoleArn=`arn:aws:iam::064212132988:role/pi-durable-agentcore-boot-AgentRuntimeExecutionRole-TeyUx6Cy7d9j`
- EcrRepositoryUri=`064212132988.dkr.ecr.ap-northeast-1.amazonaws.com/pi-durable-agentcore`

## Why `ExistingGitHubOidcProviderArn` must keep its previous value

The 918f7b8 template creates `GitHubOidcProvider` only when that parameter is
empty. Omitting it on an update that originally passed an ARN would flip
`CreateGitHubOidcProvider` to true and try to create (or replace) the provider.
Always pass `UsePreviousValue=true` for that parameter.

## Exact UPDATE command (immutable GitHub OIDC `sub`)

Repo `actions/oidc/customization/sub` is `use_immutable_subject: true` with
prefix `repo:har1101@174846912/pi-durable-agentcore@1422425297`. Jobs in
`environment: agentcore-poc` therefore present

`repo:har1101@174846912/pi-durable-agentcore@1422425297:environment:agentcore-poc`

not the legacy `repo:har1101/pi-durable-agentcore:environment:agentcore-poc`.
This update adds those immutable `sub` values and keeps the legacy entries.
Do **not** replace the OIDC provider, IAM roles, ECR repository, or DynamoDB
table. `GitHubOidcSubPrefix` is new; every other parameter must keep its
previous value.

From the repository root, after this template is on `main`:

```bash
aws cloudformation update-stack \
  --profile fukuchi \
  --region ap-northeast-1 \
  --stack-name pi-durable-agentcore-bootstrap \
  --template-body file://infra/github-oidc-bootstrap.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters \
    ParameterKey=GitHubOidcSubPrefix,ParameterValue=repo:har1101@174846912/pi-durable-agentcore@1422425297 \
    ParameterKey=GitHubOwner,UsePreviousValue=true \
    ParameterKey=GitHubRepository,UsePreviousValue=true \
    ParameterKey=GitHubBranch,UsePreviousValue=true \
    ParameterKey=GitHubEnvironment,UsePreviousValue=true \
    ParameterKey=SessionTableName,UsePreviousValue=true \
    ParameterKey=EcrRepositoryName,UsePreviousValue=true \
    ParameterKey=ExistingGitHubOidcProviderArn,UsePreviousValue=true
```

Required inputs: AWS CLI profile `fukuchi`, region `ap-northeast-1`, the
updated `infra/github-oidc-bootstrap.yaml`, and `CAPABILITY_NAMED_IAM`.
No AWS access keys. Do not run this from the agent environment.

Existing deploy-role and execution-role ARNs stay as above.

Fukuchi applied this update: stack `pi-durable-agentcore-bootstrap` is
**UPDATE_COMPLETE**. Trust now includes both immutable `sub` values. Re-run
GitHub Actions `agentcore-poc` (workflow_dispatch or push). Do not run AWS
from this agent environment.

## Exact UPDATE command (invoke + StopRuntimeSession on GitHubDeployRole)

Live crash-resume tests call `InvokeAgentRuntime` and `StopRuntimeSession`.
Those actions were not on `GitHubDeployRole`. This is an in-place policy add:
do **not** replace the OIDC provider, roles, ECR, or DynamoDB table. Every
parameter keeps its previous value.

```bash
aws cloudformation update-stack \
  --profile fukuchi \
  --region ap-northeast-1 \
  --stack-name pi-durable-agentcore-bootstrap \
  --template-body file://infra/github-oidc-bootstrap.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters \
    ParameterKey=GitHubOidcSubPrefix,UsePreviousValue=true \
    ParameterKey=GitHubOwner,UsePreviousValue=true \
    ParameterKey=GitHubRepository,UsePreviousValue=true \
    ParameterKey=GitHubBranch,UsePreviousValue=true \
    ParameterKey=GitHubEnvironment,UsePreviousValue=true \
    ParameterKey=SessionTableName,UsePreviousValue=true \
    ParameterKey=EcrRepositoryName,UsePreviousValue=true \
    ParameterKey=ExistingGitHubOidcProviderArn,UsePreviousValue=true
```

## Exact UPDATE command (ECR BatchGetImage on GitHubDeployRole)

GHA run 39000278083 built the ARM64 image then failed pushing the
manifest/attestations: `ecr:BatchGetImage` is not on `GitHubDeployRole`.
`ecr:BatchCheckLayerAvailability` was already present. This update adds
`ecr:BatchGetImage` and `ecr:GetDownloadUrlForLayer`. In-place policy add
only; do **not** replace the OIDC provider, roles, ECR, or DynamoDB table.
Every parameter keeps its previous value. Do not run AWS from this agent.

Fukuchi applied this update: stack is **UPDATE_COMPLETE**. Re-run GitHub
Actions `agentcore-poc` (push to main; workflow_dispatch is 403 for this
token).

## Exact UPDATE command (CreateAgentRuntimeEndpoint + related)

GHA run 39000719319 pushed the ARM64 image, then CreateAgentRuntime failed:

`not authorized to perform bedrock-agentcore:CreateAgentRuntimeEndpoint`
on `arn:aws:bedrock-agentcore:ap-northeast-1:064212132988:runtime/*`.

One in-place policy add covers the rest of this deploy+invoke path so we
do not dribble: Create/Get/List/UpdateAgentRuntimeEndpoint,
Create/Get/ListAgentRuntimeVersion, TagResource, ListTagsForResource,
InvokeAgentRuntimeForUser. Existing List/Create/Get/Update/Invoke/Stop/PassRole
stay. Do **not** replace OIDC, roles, ECR, or DynamoDB. Every parameter
keeps its previous value.

Fukuchi applied **0695991** and **7d41dbc**: stack **UPDATE_COMPLETE**.

## Exact UPDATE command (workload-identity TagResource)

GHA run 39001137344 pushed the image, then CreateAgentRuntime failed:

`bedrock-agentcore:TagResource` on
`arn:aws:bedrock-agentcore:ap-northeast-1:064212132988:workload-identity-directory/default/workload-identity/pi_durable_agentcore-UcUt2555jm`

One in-place add: TagResource/ListTagsForResource on runtime, endpoint,
version, `workload-identity/*`, and
`workload-identity-directory/*/workload-identity/*`, plus
Create/Get/List/UpdateWorkloadIdentity. Do **not** replace OIDC, roles,
ECR, or DynamoDB. Every parameter keeps its previous value.

Fukuchi applied **359c28f**: stack **UPDATE_COMPLETE**. Retrigger GHA deploy.

## Exact UPDATE command (execution-role logs + GHA log read)

Replacement invoke 500 left no `/aws/bedrock-agentcore/runtimes/pi_durable_agentcore-*`
log group: `AgentRuntimeExecutionRole` could not `CreateLogGroup`/`PutLogEvents`.
One in-place add:

- execution role: logs CreateLogGroup/CreateLogStream/PutLogEvents/DescribeLogStreams
  on `/aws/bedrock-agentcore/runtimes/*` (group + stream ARNs)
- execution role: `xray:PutTraceSegments`, `PutTelemetryRecords`,
  `cloudwatch:PutMetricData`
- execution role: explicit
  `inference-profile/global.anthropic.claude-*` (foundation-model + wildcard
  inference-profile already present)
- DynamoDB Get/Put/Update/Query/Transact*/ConditionCheck/Describe on the
  session table ARN and `/index/*` (already present; unchanged)
- GitHubDeployRole: DescribeLogGroups + DescribeLogStreams/GetLogEvents/
  FilterLogEvents on the same log-group prefix so GHA can diagnose the 500

Do **not** replace OIDC, roles, ECR, or DynamoDB. Every parameter keeps its
previous value. Do not run AWS from this agent.

Fukuchi applied **700ace3**: stack **UPDATE_COMPLETE**. Retrigger GHA deploy.

```bash
aws cloudformation update-stack \
  --profile fukuchi \
  --region ap-northeast-1 \
  --stack-name pi-durable-agentcore-bootstrap \
  --template-body file://infra/github-oidc-bootstrap.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters \
    ParameterKey=GitHubOidcSubPrefix,UsePreviousValue=true \
    ParameterKey=GitHubOwner,UsePreviousValue=true \
    ParameterKey=GitHubRepository,UsePreviousValue=true \
    ParameterKey=GitHubBranch,UsePreviousValue=true \
    ParameterKey=GitHubEnvironment,UsePreviousValue=true \
    ParameterKey=SessionTableName,UsePreviousValue=true \
    ParameterKey=EcrRepositoryName,UsePreviousValue=true \
    ParameterKey=ExistingGitHubOidcProviderArn,UsePreviousValue=true
```

```bash
aws cloudformation update-stack \
  --profile fukuchi \
  --region ap-northeast-1 \
  --stack-name pi-durable-agentcore-bootstrap \
  --template-body file://infra/github-oidc-bootstrap.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters \
    ParameterKey=GitHubOidcSubPrefix,UsePreviousValue=true \
    ParameterKey=GitHubOwner,UsePreviousValue=true \
    ParameterKey=GitHubRepository,UsePreviousValue=true \
    ParameterKey=GitHubBranch,UsePreviousValue=true \
    ParameterKey=GitHubEnvironment,UsePreviousValue=true \
    ParameterKey=SessionTableName,UsePreviousValue=true \
    ParameterKey=EcrRepositoryName,UsePreviousValue=true \
    ParameterKey=ExistingGitHubOidcProviderArn,UsePreviousValue=true
```

```bash
aws cloudformation update-stack \
  --profile fukuchi \
  --region ap-northeast-1 \
  --stack-name pi-durable-agentcore-bootstrap \
  --template-body file://infra/github-oidc-bootstrap.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters \
    ParameterKey=GitHubOidcSubPrefix,UsePreviousValue=true \
    ParameterKey=GitHubOwner,UsePreviousValue=true \
    ParameterKey=GitHubRepository,UsePreviousValue=true \
    ParameterKey=GitHubBranch,UsePreviousValue=true \
    ParameterKey=GitHubEnvironment,UsePreviousValue=true \
    ParameterKey=SessionTableName,UsePreviousValue=true \
    ParameterKey=EcrRepositoryName,UsePreviousValue=true \
    ParameterKey=ExistingGitHubOidcProviderArn,UsePreviousValue=true
```

```bash
aws cloudformation update-stack \
  --profile fukuchi \
  --region ap-northeast-1 \
  --stack-name pi-durable-agentcore-bootstrap \
  --template-body file://infra/github-oidc-bootstrap.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters \
    ParameterKey=GitHubOidcSubPrefix,UsePreviousValue=true \
    ParameterKey=GitHubOwner,UsePreviousValue=true \
    ParameterKey=GitHubRepository,UsePreviousValue=true \
    ParameterKey=GitHubBranch,UsePreviousValue=true \
    ParameterKey=GitHubEnvironment,UsePreviousValue=true \
    ParameterKey=SessionTableName,UsePreviousValue=true \
    ParameterKey=EcrRepositoryName,UsePreviousValue=true \
    ParameterKey=ExistingGitHubOidcProviderArn,UsePreviousValue=true
```

## Exact UPDATE command (wake sweeper + WakeIndex)

Approvals, approval timeouts, timed waits, and crash recovery must resume a
session when no caller is connected. AgentCore is invoked only from outside,
so the stack adds a clock. An EventBridge rule runs a sweeper Lambda every
minute. The Lambda queries the sparse `WakeIndex` on the session table and
sends `{"action":"resume"}` to each due session with `InvokeAgentRuntime`.

What changes:

- `SessionStore`: in place. Adds attribute definitions `wakeShard` (S) and
  `wakeAt` (N) and exactly one GSI, `WakeIndex` (HASH `wakeShard`, RANGE
  `wakeAt`, projection INCLUDE `runtimeSessionId`). `TableName`, `KeySchema`,
  and the logical id are unchanged, so the table is not replaced. CloudFormation
  allows one GSI add per update. This update adds one.
- `WakeSweeperRole`: new, no `RoleName`. CloudWatch Logs through
  `AWSLambdaBasicExecutionRole`, `dynamodb:Query` on
  `<table>/index/WakeIndex`, `dynamodb:GetItem` on the table (the sweeper
  skips a session whose `LEASE` is still live), and
  `bedrock-agentcore:InvokeAgentRuntime` on `AgentRuntimeArn` and
  `AgentRuntimeArn/runtime-endpoint/*`. While the parameter is empty the
  statement names a runtime ARN that does not exist (`runtime/none`).
- `WakeSweeperFunction`: new. `nodejs22.x`, arm64, 60 s timeout, 256 MB, no
  reserved concurrency (overlapping sweeps are safe because a resume is
  idempotent and lease-gated). The inline code is generated from
  `dist/wake-sweeper.cjs` by `npm run sync:infra`. A test fails the build when
  the YAML block and the compiled file differ.
- `WakeSweeperSchedule` (`AWS::Events::Rule`, `rate(1 minute)`) and
  `WakeSweeperInvokePermission`: new. The rule is `ENABLED` only when
  `AgentRuntimeArn` is not empty.
- `AgentRuntimeExecutionRole`: unchanged. It already allows Get, Put, Update,
  Query, TransactWriteItems, and ConditionCheckItem on the table ARN and
  `index/*`. The runtime writes approval records (`PARK#...`), the run guard
  (`RUN`), and the event log (partition `e#...`) to the same table. It never
  deletes items and never queries `WakeIndex`, so no action is added.
- `GitHubDeployRole`: unchanged. A human applies this stack.

Do **not** replace the OIDC provider, IAM roles, ECR repository, or DynamoDB
table. `AgentRuntimeArn` is new. Every other parameter keeps its previous
value, and `ExistingGitHubOidcProviderArn` is always `UsePreviousValue=true`.

### Step 1: add the index and the disabled sweeper

Apply this before deploying an image that writes wake attributes. From the
repository root, after this template is on `main`:

```bash
aws cloudformation update-stack \
  --profile fukuchi \
  --region ap-northeast-1 \
  --stack-name pi-durable-agentcore-bootstrap \
  --template-body file://infra/github-oidc-bootstrap.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters \
    ParameterKey=AgentRuntimeArn,ParameterValue="" \
    ParameterKey=GitHubOidcSubPrefix,UsePreviousValue=true \
    ParameterKey=GitHubOwner,UsePreviousValue=true \
    ParameterKey=GitHubRepository,UsePreviousValue=true \
    ParameterKey=GitHubBranch,UsePreviousValue=true \
    ParameterKey=GitHubEnvironment,UsePreviousValue=true \
    ParameterKey=SessionTableName,UsePreviousValue=true \
    ParameterKey=EcrRepositoryName,UsePreviousValue=true \
    ParameterKey=ExistingGitHubOidcProviderArn,UsePreviousValue=true

aws cloudformation wait stack-update-complete \
  --profile fukuchi \
  --region ap-northeast-1 \
  --stack-name pi-durable-agentcore-bootstrap
```

The GSI backfill takes minutes. The table stays readable and writable during
it. Wait for `UPDATE_COMPLETE` before the GHA deploy of the runtime image that
writes wake attributes. A wake written earlier is not lost. It is swept once
the index is active.

### Step 2: deploy the runtime, then enable the sweeper

Push to `main` so GHA deploys the new image. `scripts/deploy-agentcore.sh`
prints the value at the end of the "Create or update AgentCore Runtime" step
and in the job summary:

```text
Bootstrap stack parameter for the wake sweeper:
  AgentRuntimeArn=arn:aws:bedrock-agentcore:ap-northeast-1:064212132988:runtime/pi_durable_agentcore-XXXXXXXXXX
```

The ARN is stable across `update-agent-runtime`. You can also read it with
your own profile:

```bash
aws bedrock-agentcore-control list-agent-runtimes \
  --profile fukuchi \
  --region ap-northeast-1 \
  --query "agentRuntimes[?agentRuntimeName=='pi_durable_agentcore'].agentRuntimeArn | [0]" \
  --output text
```

Then apply the same template with the ARN:

```bash
aws cloudformation update-stack \
  --profile fukuchi \
  --region ap-northeast-1 \
  --stack-name pi-durable-agentcore-bootstrap \
  --template-body file://infra/github-oidc-bootstrap.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters \
    ParameterKey=AgentRuntimeArn,ParameterValue=arn:aws:bedrock-agentcore:ap-northeast-1:064212132988:runtime/pi_durable_agentcore-XXXXXXXXXX \
    ParameterKey=GitHubOidcSubPrefix,UsePreviousValue=true \
    ParameterKey=GitHubOwner,UsePreviousValue=true \
    ParameterKey=GitHubRepository,UsePreviousValue=true \
    ParameterKey=GitHubBranch,UsePreviousValue=true \
    ParameterKey=GitHubEnvironment,UsePreviousValue=true \
    ParameterKey=SessionTableName,UsePreviousValue=true \
    ParameterKey=EcrRepositoryName,UsePreviousValue=true \
    ParameterKey=ExistingGitHubOidcProviderArn,UsePreviousValue=true
```

This only flips the rule to `ENABLED`, scopes the sweeper's invoke statement
to the runtime, and sets the Lambda's `AGENT_RUNTIME_ARN`. Later updates pass
`ParameterKey=AgentRuntimeArn,UsePreviousValue=true`.

### New parameter and outputs

| Name                     | Kind      | Value                                                        |
| ------------------------ | --------- | ------------------------------------------------------------ |
| `AgentRuntimeArn`        | parameter | `AgentRuntimeArn=` line from `deploy-agentcore.sh`. Default `""` keeps the rule disabled. |
| `WakeSweeperFunctionArn` | output    | sweeper Lambda ARN                                           |
| `WakeIndexName`          | output    | `WakeIndex`                                                  |

Existing outputs are unchanged.

### Who may approve

The approval id is a reference, not a permission. Approval authority is an
identity:

- An approver sends `{"action":"decide",...}` with
  `aws bedrock-agentcore invoke-agent-runtime --runtime-user-id <id> ...`
  (the API's `runtimeUserId`). AgentCore authorizes that call as
  `bedrock-agentcore:InvokeAgentRuntimeForUser` and forwards the id to the
  runtime in `x-amzn-bedrock-agentcore-runtime-user-id`.
- The runtime accepts a decision only when that id is in `APPROVER_USER_IDS`
  (comma separated, set by `deploy-agentcore.sh` from the environment
  variable of the same name). A missing header, an unknown id, or an empty
  list is 403. The user who started the run cannot approve it.
- The caller asserts `runtimeUserId`, and IAM is what makes it trustworthy.
  Grant `InvokeAgentRuntimeForUser` only to approver principals. Requesters
  get `InvokeAgentRuntime` only. `GitHubDeployRole` already has both, so GHA
  can act as an approver in live tests.

Approver policy, scoped to this runtime:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:InvokeAgentRuntimeForUser"],
    "Resource": [
      "arn:aws:bedrock-agentcore:ap-northeast-1:064212132988:runtime/pi_durable_agentcore-XXXXXXXXXX",
      "arn:aws:bedrock-agentcore:ap-northeast-1:064212132988:runtime/pi_durable_agentcore-XXXXXXXXXX/runtime-endpoint/*"
    ]
  }]
}
```

### Runtime lifecycle

`deploy-agentcore.sh` now passes
`--lifecycle-configuration '{"idleRuntimeSessionTimeout":28800,"maxLifetime":28800}'`
on create and update. The shape matches the `CreateAgentRuntime` and
`UpdateAgentRuntime` API models (`lifecycleConfiguration`, seconds). The GHA
runner's AWS CLI must be recent enough to know the flag. Pending approvals
do not depend on this: a parked session holds no process, and the sweeper
starts a new microVM when the session is due.

Required inputs: AWS CLI profile `fukuchi`, region `ap-northeast-1`, the
updated `infra/github-oidc-bootstrap.yaml`, and `CAPABILITY_NAMED_IAM`.
No AWS access keys. Do not run this from the agent environment.
