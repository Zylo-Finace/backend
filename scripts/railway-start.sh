#!/bin/sh
set -eu

echo "[start] Running migrations…"
attempt=1
max_attempts=6
while [ "$attempt" -le "$max_attempts" ]; do
  if ./node_modules/.bin/prisma migrate deploy; then
    break
  fi
  if [ "$attempt" -eq "$max_attempts" ]; then
    echo "[start] prisma migrate deploy failed after ${max_attempts} attempts"
    exit 1
  fi
  delay=$((attempt * 5))
  echo "[start] migrate failed (attempt ${attempt}/${max_attempts}); retrying in ${delay}s…"
  sleep "$delay"
  attempt=$((attempt + 1))
done

echo "[start] Entrypoint check…"
ls -la dist/main.js

echo "[start] Launching node (PORT=${PORT:-3000})…"
exec node dist/main.js
