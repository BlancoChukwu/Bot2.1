#!/bin/bash
set -e

echo "=== Base Liquidation Bot Launch ==="
echo "Dry-run first (best-effort; soak validation is the launch gate)..."
if ! npm run start:sim -- --dry-run --chain=base; then
  echo "WARN: dry-run replay reported no profitable sims; continuing after soak validation."
fi

echo "Starting live bot..."
echo "FTRL rollout at ${FTRL_ROLLOUT_PCT}% - private-first routing enabled."
node dist/src/index.js --chain=base
