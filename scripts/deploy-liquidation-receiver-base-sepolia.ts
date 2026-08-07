/**
 * Base Sepolia (84532) deploy of LiquidationFlashReceiver v4.
 *
 * Usage:
 *   DOTENV_CONFIG_PATH=.env.event-purity-production \
 *   DEPLOY_RECEIVER_RPC_URL=https://base-sepolia.g.alchemy.com/v2/<key> \
 *   LIQUIDATION_AUTHORIZED_INITIATOR=0x... \
 *   npx ts-node scripts/deploy-liquidation-receiver-base-sepolia.ts
 *
 * Does NOT touch mainnet. Owner = deployer (msg.sender). Keep that key cold / distinct
 * from the hot authorizedInitiator used at runtime.
 */
import "dotenv/config";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, formatEther, http, isAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

/** Aave V3 Base Sepolia (bgd-labs/aave-address-book). */
const AAVE_POOL_BASE_SEPOLIA = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27" as Address;
/** Uniswap V3 SwapRouter02 on Base Sepolia. */
const UNISWAP_SWAP_ROUTER_02_BASE_SEPOLIA = "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4" as Address;

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
      + "Prefer a distinct hot key from the deploy/owner PRIVATE_KEY.",
    );
  }
  if (!isAddress(raw)) {
    throw new Error(`LIQUIDATION_AUTHORIZED_INITIATOR is not a valid address: ${raw}`);
  }
  return raw;
}

function resolveRpcUrl(): string {
  const candidates = [
    process.env.DEPLOY_RECEIVER_RPC_URL,
    process.env.BASE_SEPOLIA_RPC_URL,
    process.env.RPC_URL,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      return trimmed;
    }
  }
  throw new Error("Set DEPLOY_RECEIVER_RPC_URL or BASE_SEPOLIA_RPC_URL to a Base Sepolia HTTP endpoint");
}

function scaleFee(value: bigint, percent: bigint): bigint {
  return (value * percent) / 100n;
}

async function main(): Promise<void> {
  const rpcUrl = resolveRpcUrl();
  const pkRaw = process.env.PRIVATE_KEY;
  if (pkRaw === undefined || pkRaw === "") {
    throw new Error("PRIVATE_KEY is required");
  }
  const artifact = loadArtifact();
  const account = privateKeyToAccount(parsePrivateKey(pkRaw));
  const authorizedInitiator = resolveAuthorizedInitiator();
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport });

  const chainId = await publicClient.getChainId();
  if (chainId !== baseSepolia.id) {
    throw new Error(
      `This script deploys on Base Sepolia (chainId ${baseSepolia.id}). RPC returned chainId ${chainId}.`,
    );
  }

  const balance = await publicClient.getBalance({ address: account.address });
  if (balance === 0n) {
    throw new Error(
      `Deployer ${account.address} has 0 ETH on Base Sepolia — fund via faucet before deploying.`,
    );
  }
  console.log("Deployer Base Sepolia balance (ETH):", formatEther(balance));

  const pool = AAVE_POOL_BASE_SEPOLIA;
  const swapRouter = UNISWAP_SWAP_ROUTER_02_BASE_SEPOLIA;
  const swapFee = parseSwapFee(process.env.LIQUIDATION_SWAP_POOL_FEE);
  const swapSlippageBps = parseSwapSlippageBps(process.env.LIQUIDATION_SWAP_SLIPPAGE_BPS);

  const ownerEqualsInitiator = account.address.toLowerCase() === authorizedInitiator.toLowerCase();
  console.log(JSON.stringify({
    event: "liquidation_receiver_v5_sepolia_deploy_starting",
    note: "Base Sepolia only — owner will be deployer (msg.sender). Deploy v5; retire v1–v4 addresses.",
    chainId: baseSepolia.id,
    deployerOwner: account.address,
    authorizedInitiator,
    ownerEqualsInitiator,
    ownerHygieneWarning: ownerEqualsInitiator
      ? "owner === authorizedInitiator — single-key compromise can redirect initiator AND zero slippage"
      : "owner distinct from initiator (good)",
    pool,
    swapRouter,
    swapFee,
    swapSlippageBps: swapSlippageBps.toString(),
  }, null, 2));

  const fees = await publicClient.estimateFeesPerGas();
  const maxPriorityFeePerGas = scaleFee(fees.maxPriorityFeePerGas ?? 1_000_000n, 150n);
  const maxFeePerGas = scaleFee(fees.maxFeePerGas ?? 1_000_000n, 150n);

  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [pool, swapRouter, swapFee, authorizedInitiator, swapSlippageBps],
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const deployed = receipt.contractAddress;
  if (deployed === null || deployed === undefined) {
    throw new Error("Deployment receipt missing contractAddress");
  }
  console.log("LiquidationFlashReceiver v5 deployed on Base Sepolia at:", deployed);
  console.log(`Set LIQUIDATION_RECEIVER_ADDRESS=${deployed}`);
  console.log(`Set LIQUIDATION_RECEIVER_EXPECTED_VERSION=5`);
  console.log("Retire any prior LIQUIDATION_RECEIVER_ADDRESS (v1–v4) from .env / .runtime — do not dual-point.");

  const onChainVersion = await publicClient.readContract({
    address: deployed,
    abi: artifact.abi,
    functionName: "receiverVersion",
  }) as bigint;
  const onChainOwner = await publicClient.readContract({
    address: deployed,
    abi: artifact.abi,
    functionName: "owner",
  }) as Address;
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
  const onChainPool = await publicClient.readContract({
    address: deployed,
    abi: artifact.abi,
    functionName: "aavePool",
  }) as Address;
  const onChainRouter = await publicClient.readContract({
    address: deployed,
    abi: artifact.abi,
    functionName: "swapRouter",
  }) as Address;

  const readback = {
    event: "liquidation_receiver_v5_sepolia_deploy_readback",
    receiver: deployed,
    txHash: hash,
    explorer: `https://sepolia.basescan.org/address/${deployed}`,
    receiverVersion: onChainVersion.toString(),
    owner: onChainOwner,
    authorizedInitiator: onChainInitiator,
    swapSlippageBps: onChainSlippage.toString(),
    boundPool: onChainPool,
    boundRouter: onChainRouter,
  };
  console.log(JSON.stringify(readback, null, 2));

  if (onChainVersion !== 5n) {
    throw new Error(`Post-deploy version readback expected 5, got ${onChainVersion.toString()}`);
  }
  if (onChainOwner.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`Post-deploy owner mismatch: expected ${account.address}, got ${onChainOwner}`);
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

  const runtimeDir = join(process.cwd(), ".runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const addressOut = join(runtimeDir, "receiver-addresses-base-sepolia.json");
  writeFileSync(addressOut, JSON.stringify({
    chain: "base-sepolia",
    chainId: baseSepolia.id,
    liquidationFlashReceiverV5: deployed,
    retiredVersions: ["v1", "v2", "v3", "v4"],
    owner: onChainOwner,
    authorizedInitiator: onChainInitiator,
    swapFee,
    swapSlippageBps: onChainSlippage.toString(),
    pool: onChainPool,
    swapRouter: onChainRouter,
    deployTxHash: hash,
    deployedAt: new Date().toISOString(),
  }, null, 2));
  console.log(`Wrote ${addressOut}`);
  console.log(JSON.stringify({
    event: "liquidation_receiver_v5_sepolia_deploy_complete",
    receiver: deployed,
    runtimeFile: addressOut,
    nextSteps: [
      "Set LIQUIDATION_RECEIVER_ADDRESS to the v5 Sepolia address",
      "Set LIQUIDATION_RECEIVER_EXPECTED_VERSION=5",
      "VERIFY_CHAIN=base-sepolia npm run verify:liquidation-receiver",
    ],
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
