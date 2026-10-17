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

## Exact UPDATE command

From the repository root, after this PR's template is on disk:

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

Required inputs: AWS CLI profile `fukuchi`, region `ap-northeast-1`, the
updated `infra/github-oidc-bootstrap.yaml`, and `CAPABILITY_NAMED_IAM`.
No AWS access keys.

After update, set GitHub environment `agentcore-poc` variable `DYNAMODB_TABLE`
to the `SessionTableName` output (`pi-durable-agentcore-sessions`). Existing
deploy-role and execution-role ARNs stay as above.

The OIDC `sub` mismatch is fixed because the deploy workflow uses
`environment: agentcore-poc` (token sub
`repo:har1101/pi-durable-agentcore:environment:agentcore-poc`), which 918f7b8
did not allow.
