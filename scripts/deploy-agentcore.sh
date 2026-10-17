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
table_name="${DYNAMODB_TABLE:-pi-durable-agentcore-sessions}"
delay_ms="${SCRIPTED_TOOL_DELAY_MS:-20000}"
approver_digest="${APPROVER_TOKEN_SHA256:-}"
if [[ -n "$approver_digest" && ! "$approver_digest" =~ ^[0-9a-f]{64}$ ]]; then
  echo "APPROVER_TOKEN_SHA256 must be 64 lowercase hex characters" >&2
  exit 1
fi
approver_env=""
if [[ -n "$approver_digest" ]]; then
  approver_env=",\"APPROVER_TOKEN_SHA256\":\"${approver_digest}\""
fi
environment="{\"MODEL_PROVIDER\":\"bedrock\",\"BEDROCK_MODEL_ID\":\"${model_id}\",\"STATE_DIRECTORY\":\"/tmp/pi-durable-agentcore\",\"STORAGE_BACKEND\":\"dynamodb\",\"DYNAMODB_TABLE\":\"${table_name}\",\"AWS_REGION\":\"${AWS_REGION}\",\"PI_SESSION_LEASE_TTL_MS\":\"${PI_SESSION_LEASE_TTL_MS:-15000}\",\"SCRIPTED_TOOL_DELAY_MS\":\"${delay_ms}\",\"PI_WAKE_GRACE_MS\":\"${PI_WAKE_GRACE_MS:-60000}\",\"APPROVAL_TIMEOUT_MS\":\"${APPROVAL_TIMEOUT_MS:-86400000}\"${approver_env}}"

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
    --tags Project=pi-durable-agentcore \
    --output json | tee /tmp/agentcore-runtime.json
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
    --platform-version V2 \
    --output json | tee /tmp/agentcore-runtime.json
fi

python3 - <<'PY'
import json
from pathlib import Path
data = json.loads(Path("/tmp/agentcore-runtime.json").read_text())
runtime = data.get("agentRuntime") or data
rid = runtime.get("agentRuntimeId") or data.get("agentRuntimeId") or ""
arn = runtime.get("agentRuntimeArn") or data.get("agentRuntimeArn") or ""
Path("/tmp/agentcore-runtime-id").write_text(rid)
print(f"AGENT_RUNTIME_ID={rid}")
print(f"AGENT_RUNTIME_ARN={arn}")
PY

runtime_id="$(cat /tmp/agentcore-runtime-id)"
if [[ -z "$runtime_id" ]]; then
  echo "create/update returned no agentRuntimeId" >&2
  exit 1
fi

echo "Waiting for DEFAULT endpoint to become READY..."
for _ in $(seq 1 40); do
  endpoint_json="$(aws bedrock-agentcore-control get-agent-runtime-endpoint \
    --region "$AWS_REGION" \
    --agent-runtime-id "$runtime_id" \
    --endpoint-name DEFAULT \
    --output json 2>/tmp/agentcore-endpoint.err || true)"
  if [[ -n "$endpoint_json" ]]; then
    status="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); e=d.get("agentRuntimeEndpoint") or d; print(e.get("status") or e.get("endpointStatus") or "")' "$endpoint_json")"
    echo "endpoint_status=${status}"
    if [[ "$status" == "READY" ]]; then
      break
    fi
    if [[ "$status" == "CREATE_FAILED" || "$status" == "UPDATE_FAILED" ]]; then
      echo "$endpoint_json"
      exit 1
    fi
  else
    cat /tmp/agentcore-endpoint.err || true
  fi
  sleep 15
done
status="${status:-}"
if [[ "$status" != "READY" ]]; then
  echo "DEFAULT endpoint did not become READY" >&2
  exit 1
fi
