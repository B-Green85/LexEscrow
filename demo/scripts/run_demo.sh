#!/bin/bash
# LexEscrow Demo Runner — starts the mock adapters and launches the app in
# demo mode.
#
# Demo mode swaps the external seams (eSign provider, adapter URLs, on-chain tx
# format) for their mock counterparts. Everything between them runs the
# production code path.

set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "Starting LexEscrow Demo..."
echo ""

ADAPTERS_PID=""
APP_PID=""

# Kill the whole process group of each child: `npx tsx` and `cargo tauri dev`
# both spawn grandchildren that would otherwise survive the trap and keep
# ports 3002-3003 and 1420 bound.
cleanup() {
  trap - EXIT INT TERM
  for pid in "$ADAPTERS_PID" "$APP_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null; then
      kill -- "-$pid" 2> /dev/null || kill "$pid" 2> /dev/null || true
    fi
  done
  echo "Demo stopped."
}
trap cleanup EXIT INT TERM

echo "Starting mock adapters..."
cd "$REPO_ROOT/demo/mock-adapters"
set -m # own process group per child, so cleanup can signal the whole tree
npx tsx index.ts &
ADAPTERS_PID=$!
set +m
cd "$REPO_ROOT"

# Wait for the adapters to bind rather than sleeping a fixed interval — a cold
# `npx tsx` start is routinely slower than two seconds.
echo -n "Waiting for adapters"
for _ in $(seq 1 30); do
  if curl -s -f http://localhost:3002/v2/licenses/C10-0001234-LIC > /dev/null 2>&1; then
    break
  fi
  echo -n "."
  sleep 1
done
echo ""

if ! curl -s -f http://localhost:3002/v2/licenses/C10-0001234-LIC > /dev/null 2>&1; then
  echo "❌ Mock adapters did not come up on port 3002."
  echo "   Try running them directly to see the error: npm run demo"
  exit 1
fi

echo "✅ Mock adapters running:"
echo "   Metrc:     http://localhost:3002"
echo "   DocuSign:  http://localhost:3003"
echo ""

echo "Launching LexEscrow..."
set -m
VITE_DEMO_MODE=true npx tauri dev --config '{"build":{"beforeDevCommand":"npm run dev:demo"}}' &
APP_PID=$!
set +m

echo ""
echo "✅ LexEscrow running in demo mode"
echo ""
echo "Demo documents: demo/documents/  (Load Folder → select this directory)"
echo "Reset state:    bash demo/scripts/reset_demo.sh"
echo ""
echo "Press Ctrl-C to stop everything."

wait "$APP_PID"
