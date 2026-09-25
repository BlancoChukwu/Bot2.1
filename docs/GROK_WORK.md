# Grok-Work branch

Date: 2026-09-25

## Why this branch exists

Keep Base as the only live chain, stop treating WETH/USDC as the only executable Aave pair, and add one real Moonwell liquidation route behind `ENABLE_NON_AAVE_LIQUIDATION=false` until the new receiver is deployed.

## Shipped

- Extra Base Aave pairs: cbBTC, cbETH, weETH, wstETH, EURC, GHO (WETH/USDC remains pair `[0]`).
- `MultiProtocolFlashReceiver` route 1: Aave `flashLoanSimple` → Moonwell `liquidateBorrow` → `redeem` → wrap native ETH from mWETH → Uniswap V3 swap → repay.
- `authorizedInitiator` gate and constructor mToken map from published Moonwell Core markets.
- Production encoder uses quote-based `estimateMinimumCollateralOut`.
- Deploy script passes initiator + mToken arrays.
- Unit tests for pair config and ABI parity.

## Fork evidence (do not treat as mainnet deploy)

- Historical Moonwell liq: `0xe30976aa09582b0d0d03c53b13bdfbea0efcf350aae1a0e0bf8cfb92eb04e774` block `50623621`
- Borrower: `0x5F58cAB4A66fCb95B06455b3f1c39b0f355e6324`
- Fork at `50623620` then `flashLoanSimple` succeeded:
  - tx `0x458b661b893be2b33af12b9002ce9cf87be43114e1036e0ddd394e160f2b3595`
  - gas `1119043`
  - debt covered `225183` USDC wei

## Still gated

`ENABLE_NON_AAVE_LIQUIDATION` stays `false` until `MULTI_PROTOCOL_RECEIVER_ADDRESS` points at this bytecode on Base.

Morpho route 2 still reverts.
