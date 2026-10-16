#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cache_dir="${DYNAMODB_LOCAL_DIR:-$repo_root/.dynamodb-local}"
port="${DYNAMODB_PORT:-8000}"
url="https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz"

mkdir -p "$cache_dir"
if [[ ! -f "$cache_dir/DynamoDBLocal.jar" ]]; then
  if [[ -f /tmp/dynamodb-local/DynamoDBLocal.jar ]]; then
    cp -a /tmp/dynamodb-local/. "$cache_dir/"
  else
    curl -fsSL "$url" | tar -xz -C "$cache_dir"
  fi
fi

if [[ ! -f "$cache_dir/DynamoDBLocal.jar" ]]; then
  echo "DynamoDB Local jar is missing in $cache_dir" >&2
  exit 1
fi

exec java \
  -Djava.library.path="$cache_dir/DynamoDBLocal_lib" \
  -jar "$cache_dir/DynamoDBLocal.jar" \
  -inMemory \
  -sharedDb \
  -port "$port" \
  -disableTelemetry
