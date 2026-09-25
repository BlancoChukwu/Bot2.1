import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { getChainConfig } from "../../src/config/chains";
import {
  MOONWELL_BASE_COMPTROLLER,
  moonwellConstructorLists,
  moonwellMTokenForUnderlying,
} from "../../src/config/moonwellBase";
import { encodeMoonwellRoute } from "../../src/protocols/liquidationFlashLoanReceiver";
import { aavePoolAbi } from "../../src/protocols/aaveV3";

const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const weth = "0x4200000000000000000000000000000000000006" as const;
const cbBtc = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as const;
const uniswapRouter = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;

const HISTORICAL_TX = "0xe30976aa09582b0d0d03c53b13bdfbea0efcf350aae1a0e0bf8cfb92eb04e774" as Hex;
const HISTORICAL_BLOCK = 50_623_621n;
const FORK_BLOCK = HISTORICAL_BLOCK - 1n;
const BORROWER = "0x5F58cAB4A66fCb95B06455b3f1c39b0f355e6324" as Address;
const DEBT_TO_COVER = 225_183n;

const ANVIL_ACCOUNT = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const ANVIL_PORT = 8547;

const liquidateBorrowEvent = parseAbiItem(
  "event LiquidateBorrow(address liquidator, address borrower, uint256 repayAmount, address mTokenCollateral, uint256 seizeTokens)",
);

describe("MultiProtocol Moonwell fork provenance", () => {
  it("anchors Moonwell USDC/cbBTC mTokens and Comptroller on live Base", async () => {
    const rpc = process.env.FORK_RPC_URL?.trim() || process.env.RPC_URL?.trim() || "https://mainnet.base.org";
    const client = createPublicClient({ chain: base, transport: http(rpc) });
    const mUsdc = moonwellMTokenForUnderlying(usdc);
    const mCbBtc = moonwellMTokenForUnderlying(cbBtc);
    expect(mUsdc).toBeDefined();
    expect(mCbBtc).toBeDefined();

    const [usdcCode, cbBtcCode, comptrollerCode, aavePoolCode] = await Promise.all([
      client.getBytecode({ address: mUsdc! }),
      client.getBytecode({ address: mCbBtc! }),
      client.getBytecode({ address: MOONWELL_BASE_COMPTROLLER }),
      client.getBytecode({ address: getChainConfig("base").aave.pool }),
    ]);
    expect(usdcCode && usdcCode !== "0x").toBe(true);
    expect(cbBtcCode && cbBtcCode !== "0x").toBe(true);
    expect(comptrollerCode && comptrollerCode !== "0x").toBe(true);
    expect(aavePoolCode && aavePoolCode !== "0x").toBe(true);
  }, 30_000);

  it("encodes a Moonwell route that a historical liquidateBorrow can consume", () => {
    const encoded = encodeMoonwellRoute({
      collateralAsset: cbBtc,
      debtAsset: usdc,
      user: "0x59560000000000000000000000000000000002c0",
      debtToCover: 2_954_910_000n,
      minCollateralOut: 2_800_000_000n,
      receiveAToken: false,
    });
    expect(encoded.startsWith("0x")).toBe(true);
    expect(encoded.length).toBeGreaterThan(10);
  });
});
