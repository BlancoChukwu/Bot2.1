#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Placeholder for Dune/Graph top-pair selection. Writes recommended BASE_PAIRS extension list.
 */
const pairs = [
  { symbol: "WETH/USDC", tokenIn: "0x4200000000000000000000000000000000000006", tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  { symbol: "USDC/USDT", tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tokenOut: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" },
  { symbol: "cbBTC/WETH", tokenIn: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", tokenOut: "0x4200000000000000000000000000000000000006" },
  { symbol: "WETH/cbETH", tokenIn: "0x4200000000000000000000000000000000000006", tokenOut: "0x2Ae3F1Ec7F1F5016CADC734AfF6bD4dEf090F9f3" },
  { symbol: "AERO/WETH", tokenIn: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", tokenOut: "0x4200000000000000000000000000000000000006" },
];

const outDir = join(process.cwd(), "logs");
mkdirSync(outDir, { recursive: true });
const path = join(outDir, "top-base-pairs.json");
writeFileSync(path, JSON.stringify({ generatedAt: new Date().toISOString(), pairs }, null, 2));
console.log(`Wrote ${path} (${pairs.length} pairs)`);
