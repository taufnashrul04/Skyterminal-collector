#!/usr/bin/env sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
mkdir -p "$ROOT/run" "$ROOT/data"
if [ -f "$ROOT/run/collector.pid" ] && kill -0 "$(cat "$ROOT/run/collector.pid")" 2>/dev/null; then
  echo "collector already running: $(cat "$ROOT/run/collector.pid")"
  exit 1
fi
cd "$ROOT"
nohup env DB_PATH="${DB_PATH:-$ROOT/data/skyterminal.db}" HOST="${HOST:-127.0.0.1}" PORT="${PORT:-4180}" node src/service.js >>"$ROOT/run/collector.log" 2>&1 &
echo $! >"$ROOT/run/collector.pid"
echo "started pid $(cat "$ROOT/run/collector.pid")"
