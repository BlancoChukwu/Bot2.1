import "dotenv/config";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, formatEther, http, isAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { getChainConfig } from "../src/config/chains";
import { getDexesForChain } from "../src/config/dexRegistry";

interface ReceiverArtifact {
  readonly abi: readonly unknown[];
  readonly bytecode: `0x${string}`;
}

function loadArtifact(name: "LiquidationFlashReceiver" | "MultiProtocolFlashReceiver"): ReceiverArtifact {
  const path = join(__dirname, "..", "contracts", "build", `${name}.json`);
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
  if (!Number.isFinite(n) || !Number.isInteger(n) || ![100, 500, 3_000, 10_000].includes(n)) {
    throw new Error("LIQUIDATION_SWAP_POOL_FEE must be one of 100, 500, 3000, 10000");
  }
  return n;
}

function parseSwapSlippageBps(raw: string | undefined): bigint {
  if (raw === undefined || raw === "") {
    return 200n;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error("LIQUIDATION_SWAP_SLIPPAGE_BPS must be a non-negative integer");
  }
  const parsed = BigInt(raw.trim());
  if (parsed >= 10_000n || parsed > 1_000n) {
    throw new Error("LIQUIDATION_SWAP_SLIPPAGE_BPS must be <= 1000 (10%) and < 10000");
  }
  return parsed;
}

function resolveAuthorizedInitiator(): Address {
  const raw = process.env.LIQUIDATION_AUTHORIZED_INITIATOR?.trim();
  if (raw === undefined || raw === "") {
    throw new Error(
      "Set LIQUIDATION_AUTHORIZED_INITIATOR to the bot operator wallet (flash-loan initiator). "
      + "This is typically the PRIVATE_KEY account at runtime, not the deploy key.",
    );
  }
  if (!isAddress(raw)) {
    throw new Error(`LIQUIDATION_AUTHORIZED_INITIATOR is not a valid address: ${raw}`);
  }
  return raw;
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
  const artifact = loadArtifact("LiquidationFlashReceiver");
  const multiProtocolArtifact = loadArtifact("MultiProtocolFlashReceiver");
  const account = privateKeyToAccount(parsePrivateKey(pkRaw));
  const authorizedInitiator = resolveAuthorizedInitiator();
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
  const swapSlippageBps = parseSwapSlippageBps(process.env.LIQUIDATION_SWAP_SLIPPAGE_BPS);

  console.log(JSON.stringify({
    event: "liquidation_receiver_v5_deploy_starting",
    note: "Deploy v5 only — retire v1–v4 addresses from runtime; do not point LIQUIDATION_RECEIVER_ADDRESS at legacy bytecode",
    deployer: account.address,
    authorizedInitiator,
    operatorMatchesDeployer: account.address.toLowerCase() === authorizedInitiator.toLowerCase(),
    pool,
    swapRouter: uniswap.router,
    swapFee,
    swapSlippageBps: swapSlippageBps.toString(),
  }, null, 2));

  const fees = await publicClient.estimateFeesPerGas();
  const maxPriorityFeePerGas = scaleFee(fees.maxPriorityFeePerGas, 150n);
  const maxFeePerGas = scaleFee(fees.maxFeePerGas, 150n);

  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [pool, uniswap.router, swapFee, authorizedInitiator, swapSlippageBps],
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const deployed = receipt.contractAddress;
  if (deployed === null || deployed === undefined) {
    throw new Error("Deployment receipt missing contractAddress");
  }
  console.log("LiquidationFlashReceiver v5 deployed at:", deployed);
  console.log(`Set LIQUIDATION_RECEIVER_ADDRESS=${deployed}`);
  console.log(`Set LIQUIDATION_RECEIVER_EXPECTED_VERSION=5`);
  console.log("Retire any prior LIQUIDATION_RECEIVER_ADDRESS (v1–v4) from .env / .runtime — do not dual-point.");

  // Post-deploy readback — same fields verify-liquidation-receiver checks.
  const onChainVersion = await publicClient.readContract({
    address: deployed,
    abi: artifact.abi,
    functionName: "receiverVersion",
  }) as bigint;
  const onChainInitiator = await publicClient.readContract({
    address: deployed,
    abi: artifact.abi,
    functionName: "authorizedInitiator",
  }) as Address;
  const onChainSlippage = await publicClient.readContract({
    address: deployed,
    abi: artifact.abi,
    functionName: "swapSlippageBps",
  }) as bigint;
  console.log(JSON.stringify({
    event: "liquidation_receiver_v5_deploy_readback",
    receiver: deployed,
    receiverVersion: onChainVersion.toString(),
    authorizedInitiator: onChainInitiator,
    swapSlippageBps: onChainSlippage.toString(),
    pool,
    swapRouter: uniswap.router,
    swapFee,
  }, null, 2));
  if (onChainVersion !== 5n) {
    throw new Error(`Post-deploy version readback expected 5, got ${onChainVersion.toString()}`);
  }
  if (onChainInitiator.toLowerCase() !== authorizedInitiator.toLowerCase()) {
    throw new Error(
      `Post-deploy authorizedInitiator mismatch: expected ${authorizedInitiator}, got ${onChainInitiator}`,
    );
  }
  if (onChainSlippage !== swapSlippageBps) {
    throw new Error(
      `Post-deploy swapSlippageBps mismatch: expected ${swapSlippageBps.toString()}, got ${onChainSlippage.toString()}`,
    );
  }

  const deployMultiProtocol = process.env.DEPLOY_MULTI_PROTOCOL_RECEIVER?.trim().toLowerCase() === "true";
  let multiProtocolDeployed: Address | undefined;
  if (deployMultiProtocol) {
    const multiHash = await walletClient.deployContract({
      abi: multiProtocolArtifact.abi,
      bytecode: multiProtocolArtifact.bytecode,
      args: [pool, uniswap.router, swapFee],
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    const multiReceipt = await publicClient.waitForTransactionReceipt({ hash: multiHash });
    multiProtocolDeployed = multiReceipt.contractAddress ?? undefined;
    if (multiProtocolDeployed === undefined) {
      throw new Error("MultiProtocolFlashReceiver deployment receipt missing contractAddress");
    }
    console.log("MultiProtocolFlashReceiver deployed at:", multiProtocolDeployed);
    console.log(`Set MULTI_PROTOCOL_RECEIVER_ADDRESS=${multiProtocolDeployed}`);
  } else {
    console.log("Skipping MultiProtocolFlashReceiver deploy (set DEPLOY_MULTI_PROTOCOL_RECEIVER=true to enable)");
  }

  const runtimeDir = join(process.cwd(), ".runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const addressOut = join(runtimeDir, "receiver-addresses.json");
  writeFileSync(addressOut, JSON.stringify({
    chain: "base",
    liquidationFlashReceiverV5: deployed,
    retiredVersions: ["v1", "v2", "v3", "v4"],
    authorizedInitiator,
    swapFee,
    swapSlippageBps: swapSlippageBps.toString(),
    ...(multiProtocolDeployed === undefined ? {} : { multiProtocolFlashReceiver: multiProtocolDeployed }),
    deployedAt: new Date().toISOString(),
  }, null, 2));
  console.log(`Wrote ${addressOut}`);
  console.log(JSON.stringify({
    event: "liquidation_receiver_v5_deploy_complete",
    receiver: deployed,
    runtimeFile: addressOut,
    nextSteps: [
      "Set LIQUIDATION_RECEIVER_ADDRESS to the v5 address above",
      "Set LIQUIDATION_RECEIVER_EXPECTED_VERSION=5",
      "Clear any stale v1–v4 receiver addresses from env/runtime",
      "Run npm run verify:liquidation-receiver and paste eth_call output",
    ],
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
