#!/usr/bin/env bash
# Starts a local validator with stake_council preloaded and serves the demo UI.
#   bash scripts/demo.sh            then open the printed URL
#   PORT=9000 bash scripts/demo.sh  to serve the UI on another port
# Stop with Ctrl-C; the validator and the web server are shut down together.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SO="target/deploy/stake_council.so"
IDL="target/idl/stake_council.json"
PORT="${PORT:-8080}"
RPC="http://127.0.0.1:8899"
LEDGER="$ROOT/.anchor/demo-ledger"

if [ ! -f "$SO" ] || [ ! -f "$IDL" ]; then
  echo "The program is not built yet. Run 'anchor build' first." >&2
  exit 1
fi
for tool in solana-test-validator python3 curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done

# Keep the UI's copy of the IDL (and therefore the program ID) in sync with the build.
cp "$IDL" app/idl.json
PROGRAM_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["address"])' "$IDL")"

VALIDATOR_PID=""
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$VALIDATOR_PID" ] && kill "$VALIDATOR_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

mkdir -p "$(dirname "$LEDGER")"
echo "Starting a local validator with stake_council ($PROGRAM_ID)..."
solana-test-validator --reset --quiet --ledger "$LEDGER" \
  --bpf-program "$PROGRAM_ID" "$SO" >/dev/null 2>&1 &
VALIDATOR_PID=$!

for _ in $(seq 1 60); do
  if curl -s -m 1 "$RPC" -X POST -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"ok"'; then
    break
  fi
  if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    echo "The validator exited. Is another validator already using port 8899?" >&2
    exit 1
  fi
  sleep 0.5
done

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory app >/dev/null 2>&1 &
SERVER_PID=$!

echo
echo "Demo UI:   http://127.0.0.1:$PORT"
echo "Validator: $RPC"
echo "Press Connect in the page. Add ?autodemo=1 to the URL to play the whole flow automatically."
echo "Ctrl-C to stop."
wait "$VALIDATOR_PID"
