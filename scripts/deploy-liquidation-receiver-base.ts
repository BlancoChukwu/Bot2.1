import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { getChainConfig } from "../src/config/chains";
import { getDexesForChain } from "../src/config/dexRegistry";

interface ReceiverArtifact {
  readonly abi: readonly unknown[];
  readonly bytecode: `0x${string}`;
}

function loadArtifact(): ReceiverArtifact {
  const path = join(__dirname, "..", "contracts", "build", "LiquidationFlashReceiver.json");
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as { abi: readonly unknown[]; bytecode: string };
  if (!parsed.bytecode.startsWith("0x") || parsed.bytecode.length < 4) {
    throw new Error(`Invalid bytecode in ${path}; run npm run compile:contracts`);
  }
  return { abi: parsed.abi, bytecode: parsed.bytecode as `0x${string}` };
}

function parsePrivateKey(raw: string): `0x${string}` {
  const trimmed = raw.trim();
  const hex = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (hex.length !== 66) {
    throw new Error("PRIVATE_KEY must be a 32-byte hex string (with or without 0x prefix)");
  }
  return hex as `0x${string}`;
}

function parseSwapFee(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    return 3000;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000 || !Number.isInteger(n)) {
    throw new Error("LIQUIDATION_SWAP_POOL_FEE must be a positive integer (Uniswap V3 fee tier, e.g. 3000)");
  }
  return n;
}

function scaleFee(value: bigint, percent: bigint): bigint {
  return (value * percent) / 100n;
}

async function main(): Promise<void> {
  const rpcUrl =
    process.env.DEPLOY_RECEIVER_RPC_URL?.trim()
    || process.env.RPC_URL?.trim()
    || "";
  if (rpcUrl === "") {
    throw new Error("Set RPC_URL or DEPLOY_RECEIVER_RPC_URL to a Base mainnet HTTP endpoint");
  }
  const pkRaw = process.env.PRIVATE_KEY;
  if (pkRaw === undefined || pkRaw === "") {
    throw new Error("PRIVATE_KEY is required");
  }
  const artifact = loadArtifact();
  const account = privateKeyToAccount(parsePrivateKey(pkRaw));
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: base, transport });
  const walletClient = createWalletClient({ account, chain: base, transport });

  const chainId = await publicClient.getChainId();
  if (chainId !== base.id) {
    throw new Error(
      `This script deploys on Base (chainId ${base.id}). RPC returned chainId ${chainId}. Use a Base RPC (or set DEPLOY_RECEIVER_RPC_URL) while keeping other env for other chains.`,
    );
  }

  const balance = await publicClient.getBalance({ address: account.address });
  if (balance === 0n) {
    throw new Error(
      `Deployer ${account.address} has 0 ETH on Base — send a small amount of ETH on Base for gas before deploying.`,
    );
  }
  console.log("Deployer Base balance (ETH):", formatEther(balance));

  const pool = getChainConfig("base").aave.pool;
  const uniswap = getDexesForChain("base").find((d) => d.name === "UniswapV3");
  if (uniswap === undefined) {
    throw new Error("DEX registry has no UniswapV3 entry for base");
  }
  const swapFee = parseSwapFee(process.env.LIQUIDATION_SWAP_POOL_FEE);

  console.log("Deploying LiquidationFlashReceiver on Base with:", {
    deployer: account.address,
    pool,
    swapRouter: uniswap.router,
    swapFee,
  });

  const fees = await publicClient.estimateFeesPerGas();
  const maxPriorityFeePerGas = scaleFee(fees.maxPriorityFeePerGas, 150n);
  const maxFeePerGas = scaleFee(fees.maxFeePerGas, 150n);

  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [pool, uniswap.router, swapFee],
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const deployed = receipt.contractAddress;
  if (deployed === null || deployed === undefined) {
    throw new Error("Deployment receipt missing contractAddress");
  }
  console.log("Deployed at:", deployed);
  console.log(`Set LIQUIDATION_RECEIVER_ADDRESS=${deployed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
