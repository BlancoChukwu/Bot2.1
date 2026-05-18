#!/bin/bash
set -e

echo "=== Base Liquidation Bot Launch ==="
echo "Dry-run first (required for safety)..."
npm run start:sim -- --dry-run --chain=base

echo "Dry-run passed. Starting live bot..."
echo "FTRL rollout at ${FTRL_ROLLOUT_PCT}% - private-first routing enabled."
node dist/index.js --chain=base
