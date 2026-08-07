/**
 * Diff local LT decode / PDP getReserveConfigurationData / config bits 16–31
 * for USDC, cbBTC, WETH, and one eMode-eligible collateral on Base.
 *
 * Usage:
 *   DOTENV_CONFIG_PATH=.env.event-purity-production npx tsx scripts/diff-reserve-lt-base.ts
 */
import "dotenv/config";
import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";
import { getChainConfig } from "../src/config/chains";
import {
  BASE_PROTOCOL_DATA_PROVIDER,
  protocolDataProviderAbi,
} from "../src/config/oracleBootstrap";
import { BASE_CBBTC, BASE_USDC, BASE_WETH } from "../src/oracle/baseReserveAssets";
import { poolEmodeAbi, parseEModeCategoryData } from "../src/monitors/aaveEmode";
import {
  decodeLiquidationThresholdBps,
  isReserveEnabledOnBitmap,
  parseReserveConfigurationData,
} from "../src/monitors/reserveConfiguration";

const assets: ReadonlyArray<{ symbol: string; address: Address }> = [
  { symbol: "USDC", address: BASE_USDC },
  { symbol: "cbBTC", address: BASE_CBBTC },
  { symbol: "WETH", address: BASE_WETH },
];

const getReserveDataAbi = [
  {
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "configuration", type: "uint256" },
      { name: "liquidityIndex", type: "uint128" },
      { name: "currentLiquidityRate", type: "uint128" },
      { name: "variableBorrowIndex", type: "uint128" },
      { name: "currentVariableBorrowRate", type: "uint128" },
      { name: "currentStableBorrowRate", type: "uint128" },
      { name: "lastUpdateTimestamp", type: "uint40" },
      { name: "id", type: "uint16" },
      { name: "aTokenAddress", type: "address" },
      { name: "stableDebtTokenAddress", type: "address" },
      { name: "variableDebtTokenAddress", type: "address" },
      { name: "interestRateStrategyAddress", type: "address" },
      { name: "accruedToTreasury", type: "uint128" },
      { name: "unbacked", type: "uint128" },
      { name: "isolationModeTotalDebt", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "getReservesList",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
] as const;

function resolveRpc(): string {
  const candidates = [
    process.env.BASE_FORK_RPC_URL,
    process.env.EXECUTION_RPC_URL_PRIMARY,
    process.env.RPC_URL,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      return trimmed;
    }
  }
  throw new Error("Set RPC_URL (or EXECUTION_RPC_URL_PRIMARY) for Base");
}

async function main(): Promise<void> {
  const rpcUrl = resolveRpc();
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const pool = getChainConfig("base").aave.pool;

  const rows: Array<Record<string, string | number | boolean>> = [];

  for (const asset of assets) {
    const [pdpRaw, reserveData] = await Promise.all([
      client.readContract({
        address: BASE_PROTOCOL_DATA_PROVIDER,
        abi: protocolDataProviderAbi,
        functionName: "getReserveConfigurationData",
        args: [asset.address],
      }),
      client.readContract({
        address: pool,
        abi: getReserveDataAbi,
        functionName: "getReserveData",
        args: [asset.address],
      }),
    ]);
    const parsed = parseReserveConfigurationData(pdpRaw);
    const configLt = decodeLiquidationThresholdBps(BigInt(reserveData[0]));
    const pdpLt = parsed?.liquidationThresholdBps;
    rows.push({
      symbol: asset.symbol,
      asset: asset.address,
      reserveId: Number(reserveData[7]),
      pdpLt: pdpLt?.toString() ?? "parse_failed",
      configBitsLt: configLt.toString(),
      match: pdpLt !== undefined && pdpLt === configLt,
      notHardcoded8500: pdpLt !== undefined && pdpLt !== 8500n,
    });
  }

  let eModeRow: Record<string, string | number | boolean> | undefined;
  const reservesList = await client.readContract({
    address: pool,
    abi: getReserveDataAbi,
    functionName: "getReservesList",
  });

  for (let categoryId = 1; categoryId <= 16 && eModeRow === undefined; categoryId += 1) {
    try {
      const [data, bitmap] = await Promise.all([
        client.readContract({
          address: pool,
          abi: poolEmodeAbi,
          functionName: "getEModeCategoryData",
          args: [categoryId],
        }),
        client.readContract({
          address: pool,
          abi: poolEmodeAbi,
          functionName: "getEModeCategoryCollateralBitmap",
          args: [categoryId],
        }),
      ]);
      const parsed = parseEModeCategoryData(categoryId, data, BigInt(bitmap));
      if (parsed === undefined || parsed.liquidationThresholdBps === 0n) {
        continue;
      }
      for (let reserveId = 0; reserveId < reservesList.length; reserveId += 1) {
        if (!isReserveEnabledOnBitmap(parsed.collateralBitmap, reserveId)) {
          continue;
        }
        const asset = reservesList[reserveId] as Address;
        const known = assets.find((a) => a.address.toLowerCase() === asset.toLowerCase());
        eModeRow = {
          symbol: known?.symbol ?? `reserve[${reserveId}]`,
          asset,
          categoryId,
          eModeLt: parsed.liquidationThresholdBps.toString(),
          collateralBitmap: parsed.collateralBitmap.toString(),
          reserveId,
        };
        break;
      }
    } catch {
      // Category may not exist on this pool revision.
    }
  }

  const payload = {
    event: "reserve_lt_diff_base",
    reserves: rows,
    eModeSample: eModeRow ?? null,
    allPdpMatchConfigBits: rows.every((r) => r.match === true),
    noneHardcoded8500: rows.every((r) => r.notHardcoded8500 === true),
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
  if (!payload.allPdpMatchConfigBits || !payload.noneHardcoded8500) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
