# LiquidationFlashReceiverV3 — design review

Status: **code + review only**. Authorized by CoS for writing and reviewing; **not** authorized to deploy, broadcast, push to `master`, merge a PR, use a private key/wallet, or touch a host. All fork measurements below ran against a **local** `anvil --fork-url https://mainnet.base.org` instance (no Alchemy; public Base RPC for forking only).

Live receiver today: `0x379ce85b431bd4cb3b2b11d682bac4556648ada6` = `contracts/LiquidationFlashReceiver.sol` (v1 layout from commit `042e442`, later bumped to `RECEIVER_VERSION = 2` with an HF precheck). This V3 contract is for a **future** redeploy.

## Threat model

| Threat | v1 LIVE | MultiProtocol (Grok-Work) | V3 |
| --- | --- | --- | --- |
| Anyone opens `flashLoanSimple` into the receiver with attacker-chosen params and drains leftover/profit balance | Open (no initiator check) | Fail-*open* when `authorizedInitiator == 0` | Fail-*closed*: `executor` never zero (ctor + setter); stranger initiator reverts; `initiator == address(this)` only accepted while `liquidate()` is on the stack |
| Sandwich / skim on the collateral→debt swap | Floor = 98% of *shortfall* only | Uses caller `minCollateralOut`, but still swaps whole balance | Floor = `max(minCollateralOut, amount+premium)`; swap amount = **delta only** |
| Preexisting receiver balance used to paper over a bad swap | Yes (absolute balance check) | Yes | No — repayment measured as debt-token **delta**; preexisting funds are neither spent nor swept |
| Partial liquidation leaves Pool allowance open | Approves `debtToCover`, may leave residue | Same | Resets leftover allowance to 0 after `liquidationCall`; router allowance reset after swap |
| Profit stranded in the contract (drainable later) | Yes | Yes (no sweep) | Swept to `profitRecipient` every fill; receiver ends with zero *delta* balances |
| Moonwell / Morpho / unexpected route | N/A (5-field) | Routes 1/2 present | `routeType != 0` reverts; no Moonwell |
| `receiveAToken = true` leaves aTokens that need redeem | Accepted | Accepted | Reverts (`ReceiveATokenUnsupported`) |
| Accidental native ETH | No `receive` | Has `receive()` + WETH wrap | No `receive`/`fallback` (Aave + SwapRouter02 never send ETH here); forced ETH still recoverable via `rescue(address(0), …)` |
| Owner rug / key compromise | Single-step private owner | Single-step | Two-step ownership; `rescue` onlyOwner; executor/profitRecipient/fee mapping are owner-settable but cannot be zeroed |

Assumptions out of scope for the contract itself: the bot EOA key security, RPC honesty, Uniswap V3 pool liquidity at the configured fee tier, and Aave oracle integrity.

## Diff vs v1 (`LiquidationFlashReceiver.sol` @ LIVE)

- Params: 5-field → 7-field (`routeType`, …, `minCollateralOut`, `receiveAToken`).
- Initiator gate + nonReentrant lock.
- Fee: immutable `swapFee` → owner mapping `poolFee[collateral][debt]` (unset reverts).
- Swap input: whole `balanceOf(collateral)` → exact seized delta.
- Repay check: absolute balance → delta vs `owe`; swap floor covers `owe`.
- `collateral == debt`: v1 skipped `liquidationCall`; V3 still calls it and requires `received >= owe`.
- Sweep to `profitRecipient`; events; `layoutId()`; two-step owner; optional `liquidate()` entry.

## Diff vs `MultiProtocolFlashReceiver` (origin/Grok-Work tip)

Kept: 7-field layout (so the future TS cutover can reuse the same ABI encoding), Aave route, SwapRouter02 exactInputSingle, Pool address.

Removed / fixed:

- Moonwell + WETH wrap + whole-balance / WETH-fallback swap.
- Fail-open initiator (`authorizedInitiator == 0` allowed anyone).
- Absolute-balance repay check; no sweep; no fee mapping; no reentrancy lock; no two-step owner; no `layoutId`.

## Initiation compatibility

Today's TS (`src/executors/liquidationExecutionAdapter.ts` → `toFlashWrappedEnvelope`) builds a tx **to the Aave Pool** with `flashLoanSimple(receiver, debt, amount, params, referral)`. Aave passes `initiator = msg.sender of flashLoanSimple = bot EOA`. Therefore:

- Deploy with `executor = bot EOA` (the same address that signs the Pool call).
- Optional: the bot may instead call `receiver.liquidate(...)` (executor-only), in which case Aave sets `initiator = address(this)` and the lock state `_IN_LIQUIDATE` authorizes it.

Do **not** set `executor` to the receiver address itself unless the bot switches to the `liquidate()` entry.

## Deploy parameters (Base)

| Param | Value |
| --- | --- |
| `pool_` | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` |
| `router_` | `0x2626664c2603336E57B271c5C0b26F421741e481` (SwapRouter02) |
| `owner_` | ops multisig / cold key (NOT the bot EOA) |
| `executor_` | bot EOA (the address that will call `Pool.flashLoanSimple`) |
| `profitRecipient_` | treasury / ops wallet (nonzero) |

Post-deploy `setPoolFee` (Uniswap V3 factory `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`, read at Base block ~51911851 via public RPC):

| Pair | Recommended fee | Pool | Why |
| --- | --- | --- | --- |
| WETH → USDC | **500** | `0xd0b53D9277642d899DF5C87A3966A349A798F224` | Deep liquidity (~1.36e18 L); QuoterV2 1/10/100 WETH → 2,689.16 / 26,882.32 / 267,913.03 USDC. Fee 3000 → 2,681.38 / 26,813.55 / 268,106.55: 3000 has ~30x more in-range L and wins above ~50–100 WETH; consider 3000 (or per-size routing in a later version) for very large WETH fills. Fee 100/10000 are thin. |
| cbBTC → USDC | **500** | `0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef` | Best of the set (~2.23e12 L; QuoterV2 0.1 cbBTC → 8,388 USDC, 1 cbBTC → 83,782 USDC). Fee 3000: 8,361 / 83,198 (worse). |
| cbBTC → WETH | **500** | `0x7AeA2E8A3843516afa07293a10Ac8E49906dabD1` | Best L (~1.98e17); QuoterV2 0.1 / 1 cbBTC → 3.1173 / 31.165 WETH vs fee 3000 3.1025 / 31.009. |

`fee = 0` unsets a pair (next fill reverts `FeeNotSet`). Owner should set every pair the bot may liquidate before cutover.

Oracle used in fork E2E (verified via `Pool.ADDRESSES_PROVIDER().getPriceOracle()`): `0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156`.

## Gas (local anvil fork of Base @ block 51911800)

| Measurement | Gas |
| --- | --- |
| Contract create (`forge create` on local anvil; receipt `gasUsed`) | **1,223,926** (`0x12acf6`) |
| `cast estimate --create` (same bytecode+args) | **1,223,926** |
| Runtime code size | **4,941** bytes |
| E2E `Pool.flashLoanSimple` (WETH/USDC, debtToCover 10,676.77 USDC, fee 500) | **~673,371** (in-EVM `gasleft` delta; includes liquidationCall + swap + sweep) |
| E2E `receiver.liquidate()` entry (debtToCover 5,338.38 USDC) | **~673,043** |

> The `gasleft()` delta printed inside Foundry `setUp` for `new LiquidationFlashReceiverV3(...)` (~15k) is **not** a reliable deploy estimate (Foundry accounting); use the `forge create` / `cast estimate` numbers above.

Fork E2E also asserted: profit swept (e.g. **2,432,651,727 USDC units ≈ $2,432.65** on the half-position fill), receiver USDC/WETH balances and allowances = 0, stranger initiator reverts, unset fee reverts, `minCollateralOut` too high reverts (`Too little received`).

## Unit coverage (Foundry, no fork)

26/26 pass: constructor zero-checks, identity (`receiverVersion=3`, `layoutId=keccak256("BOT21_RECEIVER_V3_7FIELD")`), OnlyPool, initiator fail-closed (stranger / zero / self-outside-liquidate), OnlyExecutor, reentrancy, `routeType!=0`, `receiveAToken`, debt mismatch, debtToCover>amount, fee unset, approvals reset, sweep+zero balances, same-asset path, preexisting balance cannot cover shortfall and is not swept, minOut floor/sandwich, rescue onlyOwner (ERC20+ETH), plain ETH transfer reverts, two-step ownership.

TS encoder round-trip: `test/unit/liquidationReceiverV3.test.ts` (3/3).

## TS cutover (future; **not** done here)

New file only: `src/executors/liquidationReceiverV3.ts` (encode/decode, ABI, identity assert). Live path still uses `src/protocols/liquidationFlashLoanReceiver.ts`.

At cutover:

1. Deploy V3; set `executor`, `profitRecipient`, `poolFee` for every traded pair.
2. Point `FLASH_LOAN_RECEIVER_ADDRESS` (or equivalent) at the new address.
3. In `liquidationExecutionAdapter.ts`, replace `encodeLiquidationRoute` with `encodeLiquidationReceiverV3Params`. Keep calling **Pool** directly (executor = bot EOA).
4. Readiness: `receiverVersion()==3` and `layoutId()==RECEIVER_V3_LAYOUT_ID`.
5. Treat `minCollateralOut` as **minDebtOut** when sizing. Today `estimateMinimumCollateralOut` returns `debtCovered * (1 + bonus) * (1 - slippage)` in debt-token units, which V3 will read as the minimum swap output; that is compatible in units but should be re-derived from a live Quoter quote of the expected seized collateral (the contract separately floors at `owe`).
6. Do **not** send Moonwell/Morpho routeTypes; they revert.

## Compile settings

Solidity **0.8.26**, `viaIR: true`, optimizer **200** runs (matches `scripts/compile-liquidation-receiver.mjs` + `foundry.toml`). Artifact `contracts/build/LiquidationFlashReceiverV3.json` is generated by `npm run compile:contracts` (not committed on this branch, to keep the reviewable diff source-only).

## Hard rules respected

- No transaction broadcast to Base mainnet or any public testnet.
- No real private key / wallet / host access. **Disclosure:** the deploy-gas measurement used `forge create` with Foundry/anvil's publicly known dev key #0 against the in-memory local anvil fork at `127.0.0.1:8547` only (nothing left the box; no public chain). `cast estimate --create` (keyless) gives the same figure and is the recommended method going forward.
- No push to `master`, no PR merge.
- Public RPC `https://mainnet.base.org` used only for forking / read-only `eth_call`.
- Sibling worktree `/workspace/sizingfix` (`fix/sizing-followups`) untouched.
