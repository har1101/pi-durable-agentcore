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
