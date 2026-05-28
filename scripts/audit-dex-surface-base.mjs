#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const surface = {
  generatedAt: new Date().toISOString(),
  dexScope: ["AerodromeSlipstream", "AerodromeClassic", "UniswapV3"],
  contracts: {
    aerodromeSlipstreamRouter: "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5",
    aerodromeSlipstreamQuoter: "0x254cF9E1E6e233aa1AC962CB9B05b2cFeAAe15b0",
    aerodromeSlipstreamClFactory: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
    aerodromeClassicRouter: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
    uniswapV3Router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    uniswapV3Quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  },
  plannedPairs: [
    "WETH/USDC",
    "USDC/USDT",
    "cbBTC/WETH",
  ],
};

const outDir = join(process.cwd(), "logs");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const path = join(outDir, `audit-dex-surface-${stamp}.json`);
writeFileSync(path, JSON.stringify(surface, null, 2));
console.log(`Wrote ${path}`);
