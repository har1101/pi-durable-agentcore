#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION}"
: "${AWS_ACCOUNT_ID:?Set AWS_ACCOUNT_ID}"
: "${ECR_REPOSITORY:?Set ECR_REPOSITORY}"
: "${IMAGE_TAG:?Set IMAGE_TAG}"
: "${AGENTCORE_EXECUTION_ROLE_ARN:?Set AGENTCORE_EXECUTION_ROLE_ARN}"

runtime_name="${AGENT_RUNTIME_NAME:-pi_durable_agentcore}"
model_id="${BEDROCK_MODEL_ID:-global.anthropic.claude-sonnet-4-6}"
image_uri="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}:${IMAGE_TAG}"
artifact="{\"containerConfiguration\":{\"containerUri\":\"${image_uri}\"}}"
environment="{\"MODEL_PROVIDER\":\"bedrock\",\"BEDROCK_MODEL_ID\":\"${model_id}\",\"STATE_DIRECTORY\":\"/tmp/pi-durable-agentcore\"}"

runtime_id="${AGENT_RUNTIME_ID:-}"
if [[ -z "$runtime_id" ]]; then
  runtime_id="$(aws bedrock-agentcore-control list-agent-runtimes \
    --region "$AWS_REGION" \
    --query "agentRuntimes[?agentRuntimeName=='${runtime_name}'].agentRuntimeId | [0]" \
    --output text)"
fi

if [[ -z "$runtime_id" || "$runtime_id" == "None" ]]; then
  aws bedrock-agentcore-control create-agent-runtime \
    --region "$AWS_REGION" \
    --agent-runtime-name "$runtime_name" \
    --agent-runtime-artifact "$artifact" \
    --role-arn "$AGENTCORE_EXECUTION_ROLE_ARN" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --protocol-configuration '{"serverProtocol":"HTTP"}' \
    --environment-variables "$environment" \
    --platform-version V2 \
    --tags Project=pi-durable-agentcore
else
  aws bedrock-agentcore-control update-agent-runtime \
    --region "$AWS_REGION" \
    --agent-runtime-id "$runtime_id" \
    --agent-runtime-artifact "$artifact" \
    --role-arn "$AGENTCORE_EXECUTION_ROLE_ARN" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --protocol-configuration '{"serverProtocol":"HTTP"}' \
    --environment-variables "$environment" \
    --metadata-configuration '{"requireMMDSV2":true}' \
    --platform-version V2
fi
