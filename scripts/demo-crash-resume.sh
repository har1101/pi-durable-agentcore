#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
state_dir="${1:-$(mktemp -d "${TMPDIR:-/tmp}/pi-durable-demo.XXXXXX")}"
evidence_dir="${2:-}"
session_id="${3:-crash-resume-demo-$(date +%s)-$$}"
mkdir -p "$state_dir"
first_log="$state_dir/first-process.log"
resume_log="$state_dir/resumed-process.log"

node "$repo_root/dist/demo-worker.js" submit \
  --state-dir "$state_dir" \
  --session-id "$session_id" \
  --delay-ms 10000 >"$first_log" 2>&1 &
first_pid=$!

for _ in $(seq 1 200); do
  if grep -q "tool_call_started" "$first_log" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$first_pid" 2>/dev/null; then
    cat "$first_log"
    echo "first process exited before the crash window" >&2
    exit 1
  fi
  sleep 0.05
done

if ! grep -q "tool_call_started" "$first_log"; then
  kill "$first_pid" 2>/dev/null || true
  echo "timed out waiting for a live tool call" >&2
  exit 1
fi

set +m 2>/dev/null || true
kill -9 "$first_pid" 2>/dev/null || true
wait "$first_pid" 2>/dev/null || true
echo "CRASHED pid=$first_pid with SIGKILL during durable_wait"

node "$repo_root/dist/demo-worker.js" resume \
  --state-dir "$state_dir" \
  --session-id "$session_id" \
  --delay-ms 50 >"$resume_log" 2>&1

attempts="$(node "$repo_root/dist/demo-worker.js" events \
  --state-dir "$state_dir" \
  --session-id "$session_id" | grep -c '"kind":"tool_attempt"' || true)"
grep -q "resume_called" "$resume_log"
grep -q "DEMO_RESULT" "$resume_log"
grep -q '"storage":"dynamodb"' "$resume_log"
test "$attempts" -eq 2

cat "$first_log"
cat "$resume_log"
echo "PASS crash->resume: attempts=$attempts, state=$state_dir, session=$session_id"

if [[ -n "$evidence_dir" ]]; then
  mkdir -p "$evidence_dir"
  cp "$first_log" "$evidence_dir/first-process.log"
  cp "$resume_log" "$evidence_dir/resumed-process.log"
  {
    echo "CRASHED pid=$first_pid with SIGKILL during durable_wait"
    echo "PASS crash->resume: attempts=$attempts"
    echo "storage=dynamodb session=$session_id"
    grep "DEMO_RESULT" "$resume_log"
    grep "runtime_opened" "$resume_log" | tail -n 1
  } >"$evidence_dir/summary.log"
  echo "Evidence copied to $evidence_dir"
fi
