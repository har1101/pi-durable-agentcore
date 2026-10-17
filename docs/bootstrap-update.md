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
