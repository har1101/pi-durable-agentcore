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
# PI_WAKE_SHARDS must equal the bootstrap stack's WakeShardCount (auto-resume).
# APPROVAL_HMAC_KEY (optional GitHub secret) enables approver decisions; without
# it every approval decision is refused and pending approvals auto-reject at
# their deadline.
environment="$(python3 - "$model_id" "$table_name" "$delay_ms" <<'PY'
import json, os, sys
model_id, table_name, delay_ms = sys.argv[1:4]
env = {
    "MODEL_PROVIDER": "bedrock",
    "BEDROCK_MODEL_ID": model_id,
    "STATE_DIRECTORY": "/tmp/pi-durable-agentcore",
    "STORAGE_BACKEND": "dynamodb",
    "DYNAMODB_TABLE": table_name,
    "AWS_REGION": os.environ["AWS_REGION"],
    "PI_SESSION_LEASE_TTL_MS": os.environ.get("PI_SESSION_LEASE_TTL_MS") or "15000",
    "SCRIPTED_TOOL_DELAY_MS": delay_ms,
    "PI_WAKE_SHARDS": os.environ.get("PI_WAKE_SHARDS") or "4",
    "PI_APPROVAL_TIMEOUT_MS": os.environ.get("PI_APPROVAL_TIMEOUT_MS") or "86400000",
}
if os.environ.get("APPROVAL_HMAC_KEY"):
    env["APPROVAL_HMAC_KEY"] = os.environ["APPROVAL_HMAC_KEY"]
print(json.dumps(env, separators=(",", ":")))
PY
)"

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
