#!/usr/bin/env bash
# Live AgentCore + DynamoDB crash→resume. Requires AWS CLI credentials that
# can InvokeAgentRuntime and StopRuntimeSession (no static keys in-repo).
set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION}"
runtime_name="${AGENT_RUNTIME_NAME:-pi_durable_agentcore}"
runtime_arn="${AGENT_RUNTIME_ARN:-}"
runtime_id="${AGENT_RUNTIME_ID:-}"
log_dir="${LIVE_LOG_DIR:-/tmp/agentcore-live}"
mkdir -p "$log_dir"

if [[ -z "$runtime_arn" ]]; then
  if [[ -z "$runtime_id" ]]; then
    runtime_id="$(aws bedrock-agentcore-control list-agent-runtimes \
      --region "$AWS_REGION" \
      --query "agentRuntimes[?agentRuntimeName=='${runtime_name}'].agentRuntimeId | [0]" \
      --output text)"
  fi
  if [[ -z "$runtime_id" || "$runtime_id" == "None" ]]; then
    echo "No AgentCore runtime named ${runtime_name}" >&2
    exit 1
  fi
  runtime_arn="$(aws bedrock-agentcore-control get-agent-runtime \
    --region "$AWS_REGION" \
    --agent-runtime-id "$runtime_id" \
    --query 'agentRuntimeArn' \
    --output text)"
fi

# AgentCore session IDs must be 33–256 characters.
session_id="${RUNTIME_SESSION_ID:-pi-durable-live-$(python3 -c 'import uuid; print(uuid.uuid4().hex + uuid.uuid4().hex[:8])')}"
request_id="${REQUEST_ID:-live-crash-resume-1}"
payload="$(python3 - <<PY
import json
print(json.dumps({
    "prompt": "You MUST call the durable_wait tool with label crash-window as your first action. Do not skip the tool. After it returns, reply with one short sentence.",
    "requestId": "${request_id}",
}))
PY
)"

echo "AGENT_RUNTIME_ID=${runtime_id}" | tee "$log_dir/runtime-ids.txt"
echo "AGENT_RUNTIME_ARN=${runtime_arn}" | tee -a "$log_dir/runtime-ids.txt"
echo "RUNTIME_SESSION_ID=${session_id}" | tee -a "$log_dir/runtime-ids.txt"
echo "REQUEST_ID=${request_id}" | tee -a "$log_dir/runtime-ids.txt"
printf '%s\n' "$payload" >"$log_dir/payload.json"

echo "Waiting for DEFAULT endpoint READY before invoke..." | tee -a "$log_dir/summary.log"
ready=""
for _ in $(seq 1 40); do
  endpoint_json="$(aws bedrock-agentcore-control get-agent-runtime-endpoint \
    --region "$AWS_REGION" \
    --agent-runtime-id "$runtime_id" \
    --endpoint-name DEFAULT \
    --output json 2>"$log_dir/endpoint-wait.err" || true)"
  if [[ -n "$endpoint_json" ]]; then
    printf '%s\n' "$endpoint_json" >"$log_dir/endpoint.json"
    status="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); e=d.get("agentRuntimeEndpoint") or d; print(e.get("status") or e.get("endpointStatus") or "")' "$endpoint_json")"
    echo "endpoint_status=${status}" | tee -a "$log_dir/summary.log"
    if [[ "$status" == "READY" ]]; then
      ready=1
      break
    fi
    if [[ "$status" == "CREATE_FAILED" || "$status" == "UPDATE_FAILED" ]]; then
      echo "endpoint failed: ${status}" | tee -a "$log_dir/summary.log"
      exit 1
    fi
  else
    cat "$log_dir/endpoint-wait.err" | tee -a "$log_dir/summary.log" || true
  fi
  sleep 15
done
if [[ -z "$ready" ]]; then
  echo "DEFAULT endpoint did not become READY" | tee -a "$log_dir/summary.log"
  exit 1
fi

invoke() {
  local out="$1"
  aws bedrock-agentcore invoke-agent-runtime \
    --region "$AWS_REGION" \
    --agent-runtime-arn "$runtime_arn" \
    --runtime-session-id "$session_id" \
    --qualifier DEFAULT \
    --content-type application/json \
    --accept application/json \
    --payload "fileb://$log_dir/payload.json" \
    "$out"
}

dump_cloudwatch() {
  echo "=== CloudWatch runtime logs ===" | tee -a "$log_dir/summary.log"
  set +e
  aws logs describe-log-groups \
    --region "$AWS_REGION" \
    --log-group-name-prefix "/aws/bedrock-agentcore/runtimes/" \
    --output json >"$log_dir/cw-log-groups.json" 2>"$log_dir/cw-describe.err"
  python3 - <<PY
import json, subprocess, os, sys
from pathlib import Path
region = os.environ["AWS_REGION"]
log_dir = Path("$log_dir")
rid = "$runtime_id"
groups = []
try:
    data = json.loads((log_dir / "cw-log-groups.json").read_text() or "{}")
    groups = [g.get("logGroupName","") for g in data.get("logGroups", [])]
except Exception as exc:
    (log_dir / "cw-parse.err").write_text(str(exc))
matched = [g for g in groups if rid in g or "pi_durable_agentcore" in g] or groups
(log_dir / "cw-matched-groups.txt").write_text("\n".join(matched) + ("\n" if matched else ""))
print("cw_groups=" + ",".join(matched) if matched else "cw_groups=(none)")
for i, name in enumerate(matched[:4]):
    out = log_dir / f"cw-events-{i}.json"
    subprocess.run(
        ["aws", "logs", "filter-log-events", "--region", region,
         "--log-group-name", name, "--limit", "100", "--output", "json"],
        stdout=out.open("w"), stderr=(log_dir / "cw-filter.err").open("a"),
        check=False,
    )
PY
  set -e
}

echo "=== invoke 1 (expect drop mid-run) ===" | tee -a "$log_dir/summary.log"
set +e
invoke "$log_dir/invoke-1-response.bin" >"$log_dir/invoke-1-cli.txt" 2>&1 &
invoke_pid=$!
set -e

# Cold start + model TTFT, then durable_wait (20s). Stop while the tool is running.
sleep 25
echo "=== StopRuntimeSession (drop microVM) ===" | tee -a "$log_dir/summary.log"
set +e
aws bedrock-agentcore stop-runtime-session \
  --region "$AWS_REGION" \
  --agent-runtime-arn "$runtime_arn" \
  --runtime-session-id "$session_id" \
  --qualifier DEFAULT \
  >"$log_dir/stop-session.txt" 2>&1
stop_status=$?
set -e
echo "stop_status=${stop_status}" | tee -a "$log_dir/summary.log"
cat "$log_dir/stop-session.txt" | tee -a "$log_dir/summary.log"

wait "$invoke_pid" || true
echo "invoke_1_done" | tee -a "$log_dir/summary.log"
cat "$log_dir/invoke-1-cli.txt" >>"$log_dir/summary.log" || true
python3 - <<PY
from pathlib import Path
p = Path("$log_dir/invoke-1-response.bin")
if p.exists():
    Path("$log_dir/invoke-1-response.txt").write_text(p.read_bytes().decode("utf-8", "replace"))
PY

# Lease TTL is 15s; wait for the dead owner and a replacement microVM.
sleep 35

echo "=== invoke 2 (replacement session, same session id) ===" | tee -a "$log_dir/summary.log"
invoke2_status=1
for attempt in 1 2 3 4 5 6; do
  echo "invoke_2_attempt=${attempt}" | tee -a "$log_dir/summary.log"
  set +e
  invoke "$log_dir/invoke-2-response.bin" >"$log_dir/invoke-2-cli.txt" 2>&1
  invoke2_status=$?
  set -e
  echo "invoke_2_status=${invoke2_status}" | tee -a "$log_dir/summary.log"
  cat "$log_dir/invoke-2-cli.txt" | tee -a "$log_dir/summary.log"
  python3 - <<PY
from pathlib import Path
p = Path("$log_dir/invoke-2-response.bin")
if p.exists():
    text = p.read_bytes().decode("utf-8", "replace")
    Path("$log_dir/invoke-2-response.txt").write_text(text)
    print(text)
PY
  if [[ "$invoke2_status" -eq 0 ]]; then
    break
  fi
  sleep 10
done

dump_cloudwatch

if [[ "$invoke2_status" -ne 0 ]]; then
  echo "FAIL replacement invoke" | tee -a "$log_dir/summary.log"
  exit 1
fi

echo "PASS live crash->resume session=${session_id}" | tee -a "$log_dir/summary.log"
echo "Logs in ${log_dir}"
