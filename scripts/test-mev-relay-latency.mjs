#!/usr/bin/env node
/**
 * MEV relay latency binary test (public vs private submit).
 * Usage: node scripts/test-mev-relay-latency.mjs --public-rpc <url> [--private-rpc <url>]
 */
import { createWalletClient, createPublicClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const publicRpc = arg("--public-rpc") ?? process.env.EXECUTION_RPC_URL_PRIMARY ?? process.env.RPC_URL;
const privateRpc = arg("--private-rpc") ?? process.env.PRIVATE_TX_RPC_URL;
const pk = process.env.PRIVATE_KEY;

if (!publicRpc || !pk) {
  console.error(JSON.stringify({
    event: "mev_relay_test_failed",
    reason: "missing_public_rpc_or_private_key",
  }));
  process.exit(2);
}

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);

async function measure(rpcUrl, label) {
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain: base, transport: http(rpcUrl), account });
  const started = Date.now();
  const hash = await walletClient.sendTransaction({
    to: account.address,
    value: 0n,
    gas: 21_000n,
  });
  await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  return { label, latencyMs: Date.now() - started, hash };
}

const tPublic = await measure(publicRpc, "public");
let tPrivate;
if (privateRpc) {
  try {
    tPrivate = await measure(privateRpc, "private");
  } catch (error) {
    tPrivate = { label: "private", error: String(error) };
  }
}

const latencyDeltaMs = tPrivate?.latencyMs === undefined
  ? null
  : tPrivate.latencyMs - tPublic.latencyMs;
const strategy = latencyDeltaMs !== null && latencyDeltaMs < 500 ? "B_private_relay" : "A_public_mempool";

console.log(JSON.stringify({
  event: "mev_relay_test_complete",
  t_public_ms: tPublic.latencyMs,
  t_private_ms: tPrivate?.latencyMs ?? null,
  latency_delta_ms: latencyDeltaMs,
  recommended_strategy: strategy,
  private_error: tPrivate?.error,
}));
