# Backlog (non-Track-A)

Items found during PR 1 evidence work. Neither blocks Track A (receiver v5 / on-chain oracle slippage + quote estimator). Do not silently drop.

## Test harness / env

### `merge-env-from-example.test.mjs` — Windows/Vitest ESM loader failure

- **Symptom:** Vitest reports `SyntaxError: Invalid or unexpected token` and runs 0 tests in the suite.
- **Not a logic bug:** `node --input-type=module -e "import('./scripts/merge-env-from-example.mjs')"` succeeds.
- **Provenance:** File introduced on `revised-live-bot` by `feaf54dd` (2026-06-12, event-purity / Flashblocks). Absent on `master`. **Not part of PR 1's uncommitted receiver-v3 diff** — prior branch commit, orthogonal to Solidity decode / flash-loan safety.
- **Fix direction:** Vitest config / ESM transform for `.test.mjs` on Windows (or convert the suite to `.test.ts`).

### `multicallBatchProbe.integration.test.ts` — placeholder RPC host

- **Symptom:** With `.env` `RPC_URL=https://base-mainnet.example`, test attempts a real `eth_blockNumber` and fails `ENOTFOUND base-mainnet.example`.
- **Provenance:** Same failure on `master` (pre-dates PR 1). Probe uses `RPC_URL ?? EXECUTION_RPC_URL_PRIMARY` and does not treat template hosts as skip conditions.
- **Fix direction:** Skip or warn when host matches known placeholders (e.g. `*.example`, empty, or non-resolving template URLs) instead of fetching.

## Track A status

PR 2 (this branch): Option B on-chain Aave oracle slippage floor + quote-based `estimateMinimumDebtOut` + validated fee field 8 + v5 schema. Human must still run testnet/mainnet deploy + verify with pasted eth_call evidence before any "cleared" / live-tx flip. Do not start HF skip storm until Track A is closed with evidence.
