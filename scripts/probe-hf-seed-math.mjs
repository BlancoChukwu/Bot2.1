/**
 * Seed-shaped local HF probe — addresses from getChainConfig / BASE_AAVE_ORACLE only.
 * Usage:
 *   RPC_URL=https://mainnet.base.org node scripts/probe-hf-seed-math.mjs [account...]
 */
import { createPublicClient, http, getAddress } from "viem";
import { base } from "viem/chains";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Prefer compiled dist; fall back to informing the operator.
function loadSource() {
  const candidates = [
    "../dist/src",
    "../dist",
  ];
  for (const root of candidates) {
    try {
      const { getChainConfig } = require(`${root}/config/chains.js`);
      const { BASE_AAVE_ORACLE } = require(`${root}/oracle/baseReserveAssets.js`);
      const { uiPoolDataProviderAbi } = require(`${root}/protocols/uiPoolDataProvider.js`);
      const { aavePoolAbi } = require(`${root}/protocols/aaveV3.js`);
      return { getChainConfig, BASE_AAVE_ORACLE, uiPoolDataProviderAbi, aavePoolAbi, root };
    } catch {
      // try next layout
    }
  }
  return null;
}

const RAY = 10n ** 27n;
const WAD = 10n ** 18n;
const BPS = 10_000n;
const LT_MASK = (1n << 16n) - 1n;

const DEFAULT_ACCOUNTS = [
  "0x31e518ad2f2fdcc95063846ba074625d0628266c",
  "0x2fe230adcacd6002728330ceb86f4ddf58184e52",
  "0x30df0412a1b238e869e318b853b8bbeb67aa4f39",
];

const reserveDataAbi = [
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
];

const oracleAbi = [
  {
    type: "function",
    name: "getAssetPrice",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];

function ltBpsFromConfig(configuration) {
  return (BigInt(configuration) >> 16n) & LT_MASK;
}

function indexNorm(indexRay) {
  return Number(indexRay / (RAY / 1000n)) / 1000;
}

async function probeAccount(client, cfg, oracle, abis, account) {
  const user = getAddress(account);
  const acct = await client.readContract({
    address: cfg.aave.pool,
    abi: abis.aavePoolAbi,
    functionName: "getUserAccountData",
    args: [user],
  });

  const collUsd = Number(acct[0]) / 1e8;
  const debtUsd = Number(acct[1]) / 1e8;
  const chainHf = Number(acct[5]) / 1e18;

  const [rows, emode] = await client.readContract({
    address: cfg.aave.uiPoolDataProvider,
    abi: abis.uiPoolDataProviderAbi,
    functionName: "getUserReservesData",
    args: [cfg.aave.poolAddressesProvider, user],
  });

  let wCollFlat = 0n;
  let debtFlat = 0n;
  let wCollPerLt = 0n;
  let debtPer = 0n;
  let wCollRay = 0n;
  let debtRay = 0n;
  const legs = [];

  for (const row of rows) {
    const scaledColl = row.usageAsCollateralEnabledOnUser ? row.scaledATokenBalance : 0n;
    const scaledDebt = row.scaledVariableDebt;
    if (scaledColl === 0n && scaledDebt === 0n) {
      continue;
    }

    const asset = row.underlyingAsset;
    const rd = await client.readContract({
      address: cfg.aave.pool,
      abi: reserveDataAbi,
      functionName: "getReserveData",
      args: [asset],
    });
    const configuration = rd[0];
    const li = BigInt(rd[1]);
    const vbi = BigInt(rd[3]);
    const ltBps = ltBpsFromConfig(configuration);
    const px8 = await client.readContract({
      address: oracle,
      abi: oracleAbi,
      functionName: "getAssetPrice",
      args: [asset],
    });
    const pxWad = px8 * 10n ** 10n;

    legs.push({
      asset,
      usageAsColl: row.usageAsCollateralEnabledOnUser,
      scaledColl: scaledColl.toString(),
      scaledDebt: scaledDebt.toString(),
      aTokenRaw: row.scaledATokenBalance.toString(),
      ltBps: Number(ltBps),
      liNorm: indexNorm(li),
      vbiNorm: indexNorm(vbi),
      pxUsd: Number(px8) / 1e8,
    });

    // Bot local path: scaled as-is (WAD short-circuit), flat BASE_LT_BPS=8500
    wCollFlat += (scaledColl * pxWad * 8500n) / BPS;
    debtFlat += scaledDebt * pxWad;

    // Same but per-asset LT from config bitmap
    wCollPerLt += (scaledColl * pxWad * ltBps) / BPS;
    debtPer += scaledDebt * pxWad;

    // Chain-like: rayMul + per-asset LT
    wCollRay += (((scaledColl * li) / RAY) * pxWad * ltBps) / BPS;
    debtRay += ((scaledDebt * vbi) / RAY) * pxWad;
  }

  const hf = (w, d) => (d === 0n ? null : Number((w * WAD) / d) / 1e18);

  return {
    account: user,
    collUsd,
    debtUsd,
    collBaseRaw: acct[0].toString(),
    debtBaseRaw: acct[1].toString(),
    chainLtBps: Number(acct[3]),
    chainHf,
    emode: Number(emode),
    isDust: collUsd < 1,
    legs,
    localHf_flatLt8500_noRayMul: hf(wCollFlat, debtFlat),
    localHf_perAssetLt_noRayMul: hf(wCollPerLt, debtPer),
    localHf_perAssetLt_withRayMul: hf(wCollRay, debtRay),
    ratio_flat_vs_chain:
      chainHf > 0 && hf(wCollFlat, debtFlat) !== null
        ? hf(wCollFlat, debtFlat) / chainHf
        : null,
    ratio_perLt_vs_chain:
      chainHf > 0 && hf(wCollPerLt, debtPer) !== null
        ? hf(wCollPerLt, debtPer) / chainHf
        : null,
  };
}

async function main() {
  const src = loadSource();
  if (src === null) {
    console.error("Missing dist/. Run: npm run build");
    process.exit(1);
  }

  const { getChainConfig, BASE_AAVE_ORACLE, uiPoolDataProviderAbi, aavePoolAbi } = src;
  const cfg = getChainConfig("base");
  const rpc = process.env.RPC_URL || process.env.EXECUTION_RPC_URL_PRIMARY || "https://mainnet.base.org";

  console.log("addresses_from_source", {
    pool: cfg.aave.pool,
    poolAddressesProvider: cfg.aave.poolAddressesProvider,
    uiPoolDataProvider: cfg.aave.uiPoolDataProvider,
    oracle: BASE_AAVE_ORACLE,
    rpcHost: (() => {
      try {
        return new URL(rpc).host;
      } catch {
        return "(unparsed)";
      }
    })(),
  });

  const client = createPublicClient({ chain: base, transport: http(rpc) });
  const accounts = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_ACCOUNTS;

  for (const account of accounts) {
    console.log("====");
    try {
      const result = await probeAccount(client, cfg, BASE_AAVE_ORACLE, {
        uiPoolDataProviderAbi,
        aavePoolAbi,
      }, account);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(account, String(error));
    }
  }
}

main();
