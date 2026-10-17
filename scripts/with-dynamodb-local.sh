#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port="${DYNAMODB_PORT:-8000}"
log="${DYNAMODB_LOCAL_LOG:-$repo_root/.dynamodb-local/server.log}"
mkdir -p "$(dirname "$log")"

if [[ $# -lt 1 ]]; then
  echo "Usage: with-dynamodb-local.sh <command> [args...]" >&2
  exit 1
fi

already_up=0
if bash -c "echo >/dev/tcp/127.0.0.1/${port}" >/dev/null 2>&1; then
  already_up=1
else
  bash "$repo_root/scripts/dynamodb-local.sh" >"$log" 2>&1 &
  dynamodb_pid=$!
  cleanup() {
    kill "$dynamodb_pid" 2>/dev/null || true
    wait "$dynamodb_pid" 2>/dev/null || true
  }
  trap cleanup EXIT
  for _ in $(seq 1 100); do
    if bash -c "echo >/dev/tcp/127.0.0.1/${port}" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$dynamodb_pid" 2>/dev/null; then
      cat "$log" >&2
      echo "DynamoDB Local exited before becoming ready" >&2
      exit 1
    fi
    sleep 0.1
  done
  if ! bash -c "echo >/dev/tcp/127.0.0.1/${port}" >/dev/null 2>&1; then
    cat "$log" >&2
    echo "timed out waiting for DynamoDB Local on port ${port}" >&2
    exit 1
  fi
fi

export STORAGE_BACKEND="${STORAGE_BACKEND:-dynamodb}"
export DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT:-http://127.0.0.1:${port}}"
export DYNAMODB_TABLE="${DYNAMODB_TABLE:-pi-durable-agentcore-sessions}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-local}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-local}"
export AWS_REGION="${AWS_REGION:-ap-northeast-1}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$AWS_REGION}"
export PI_SESSION_LEASE_TTL_MS="${PI_SESSION_LEASE_TTL_MS:-2000}"
export PI_SESSION_LEASE_ACQUIRE_TIMEOUT_MS="${PI_SESSION_LEASE_ACQUIRE_TIMEOUT_MS:-12000}"

"$@"
status=$?
if [[ "$already_up" -eq 0 ]]; then
  trap - EXIT
  cleanup
fi
exit "$status"
