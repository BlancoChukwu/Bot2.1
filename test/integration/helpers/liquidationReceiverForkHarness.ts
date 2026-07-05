import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createTestClient,
  encodeAbiParameters,
  http,
  parseAbiParameters,
  parseEther,
  publicActions,
  walletActions,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { base } from "viem/chains";
import { getChainConfig } from "../../../src/config/chains";
import { getDexesForChain } from "../../../src/config/dexRegistry";
import { aavePoolAbi } from "../../../src/protocols/aaveV3";
import { liquidationFlashReceiverAbi } from "../../../src/production/liquidationReceiverReadiness";

const WAD = 1_000_000_000_000_000_000n;
const HF_PROBE_ACCOUNTS = [
  "0xf109945302561dcbf6bede6a33f36602ae9537c0",
  "0xa7ac810c71781482427ebd7d98255acb0e0375d6",
  "0x675c8697949e0cc6269e8625d805a2749fad6707",
  "0x8b81420441ac3933c58d1190c8499c2f89eb1263",
  "0x2E09f38C7d8B3B89b984D77F1a109F44afc79950",
] as const;

const liquidationCallEvent = {
  type: "event",
  name: "LiquidationCall",
  inputs: [
    { indexed: true, name: "collateralAsset", type: "address" },
    { indexed: true, name: "debtAsset", type: "address" },
    { indexed: true, name: "user", type: "address" },
    { indexed: false, name: "debtToCover", type: "uint256" },
    { indexed: false, name: "liquidatedCollateralAmount", type: "uint256" },
    { indexed: false, name: "liquidator", type: "address" },
    { indexed: false, name: "receiveAToken", type: "bool" },
  ],
} as const;

export interface ReceiverArtifact {
  readonly abi: readonly unknown[];
  readonly bytecode: Hex;
}

export interface LiquidationForkCase {
  readonly user: Address;
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly debtToCover: bigint;
  readonly receiveAToken: boolean;
  readonly blockNumber: bigint;
  readonly healthFactor: bigint;
}

export function loadLiquidationFlashReceiverArtifact(): ReceiverArtifact {
  const path = join(process.cwd(), "contracts", "build", "LiquidationFlashReceiver.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    abi: readonly unknown[];
    bytecode: string;
  };
  if (!parsed.bytecode.startsWith("0x")) {
    throw new Error("Receiver artifact bytecode missing 0x prefix — run npm run compile:contracts");
  }
  return { abi: parsed.abi, bytecode: parsed.bytecode as Hex };
}

export function createForkPublicClient(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl) });
}

export type ForkPublicClient = ReturnType<typeof createForkPublicClient>;

export function createForkTestClient(rpcUrl: string) {
  return createTestClient({
    chain: base,
    mode: "anvil",
    transport: http(rpcUrl),
  }).extend(publicActions).extend(walletActions);
}

export async function readHealthFactor(
  client: Pick<PublicClient, "readContract">,
  pool: Address,
  user: Address,
): Promise<bigint> {
  const accountData = await client.readContract({
    address: pool,
    abi: aavePoolAbi,
    functionName: "getUserAccountData",
    args: [user],
  });
  return accountData[5];
}

export async function findHealthyBorrower(
  client: Pick<PublicClient, "readContract">,
  pool: Address,
): Promise<{ user: Address; healthFactor: bigint }> {
  for (const account of HF_PROBE_ACCOUNTS) {
    const healthFactor = await readHealthFactor(client, pool, account);
    const accountData = await client.readContract({
      address: pool,
      abi: aavePoolAbi,
      functionName: "getUserAccountData",
      args: [account],
    });
    if (accountData[1] > 0n && healthFactor >= WAD) {
      return { user: account, healthFactor };
    }
  }
  throw new Error("No healthy Aave borrower found in probe set — expand HF_PROBE_ACCOUNTS");
}

export async function findRecentLiquidationCase(
  client: Pick<PublicClient, "getBlockNumber" | "getLogs" | "readContract">,
  pool: Address,
  lookbackBlocks = 2_000_000n,
): Promise<LiquidationForkCase> {
  const head = await client.getBlockNumber();
  const fromBlock = head > lookbackBlocks ? head - lookbackBlocks : 0n;
  const logs = await client.getLogs({
    address: pool,
    event: liquidationCallEvent,
    fromBlock,
    toBlock: head,
  });
  if (logs.length === 0) {
    throw new Error(`No LiquidationCall events found in last ${lookbackBlocks.toString()} blocks`);
  }

  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const log = logs[index];
    if (log === undefined) {
      continue;
    }
    if (log.args.user === undefined || log.args.collateralAsset === undefined || log.args.debtAsset === undefined) {
      continue;
    }
    if (log.args.debtToCover === undefined || log.args.debtToCover === 0n) {
      continue;
    }
    const healthFactor = await readHealthFactor(client, pool, log.args.user);
    return {
      user: log.args.user,
      collateralAsset: log.args.collateralAsset,
      debtAsset: log.args.debtAsset,
      debtToCover: log.args.debtToCover,
      receiveAToken: log.args.receiveAToken ?? false,
      blockNumber: log.blockNumber,
      healthFactor,
    };
  }

  throw new Error("No recent liquidatable LiquidationCall case found for fork test");
}

export function encodeExecuteOperationParams(input: {
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly user: Address;
  readonly debtToCover: bigint;
  readonly receiveAToken: boolean;
}): Hex {
  return encodeAbiParameters(
    parseAbiParameters("address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken"),
    [
      input.collateralAsset,
      input.debtAsset,
      input.user,
      input.debtToCover,
      input.receiveAToken,
    ],
  );
}

export async function deployLiquidationFlashReceiver(
  rpcUrl: string,
  artifact: ReceiverArtifact,
): Promise<Address> {
  const testClient = createForkTestClient(rpcUrl);
  const deployer = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
  await testClient.setBalance({ address: deployer, value: parseEther("10") });
  const pool = getChainConfig("base").aave.pool;
  const uniswap = getDexesForChain("base").find((dex) => dex.name === "UniswapV3");
  if (uniswap === undefined) {
    throw new Error("UniswapV3 missing from dex registry for base");
  }
  const swapFee = Number(process.env.LIQUIDATION_SWAP_POOL_FEE ?? "3000");
  const hash = await testClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [pool, uniswap.router, swapFee],
    account: deployer,
  });
  const receipt = await testClient.waitForTransactionReceipt({ hash });
  if (receipt.contractAddress === undefined || receipt.contractAddress === null) {
    throw new Error("Receiver deployment missing contractAddress");
  }
  return receipt.contractAddress;
}

export async function impersonatePoolCaller(
  rpcUrl: string,
  pool: Address,
): Promise<void> {
  const testClient = createForkTestClient(rpcUrl);
  await testClient.impersonateAccount({ address: pool });
  await testClient.setBalance({ address: pool, value: parseEther("1") });
}

export async function simulateExecuteOperation(input: {
  readonly client: ForkPublicClient;
  readonly rpcUrl: string;
  readonly receiver: Address;
  readonly pool: Address;
  readonly debtAsset: Address;
  readonly amount: bigint;
  readonly premium: bigint;
  readonly params: Hex;
  readonly artifact: ReceiverArtifact;
}): Promise<void> {
  await impersonatePoolCaller(input.rpcUrl, input.pool);
  await input.client.simulateContract({
    address: input.receiver,
    abi: input.artifact.abi,
    functionName: "executeOperation",
    args: [input.debtAsset, input.amount, input.premium, input.pool, input.params],
    account: input.pool,
  });
}

export function extractRevertMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function assertReceiverVersion(
  client: Pick<ForkPublicClient, "readContract">,
  receiver: Address,
  expectedVersion: bigint,
): Promise<void> {
  const version = await client.readContract({
    address: receiver,
    abi: liquidationFlashReceiverAbi,
    functionName: "receiverVersion",
  });
  if (version !== expectedVersion) {
    throw new Error(`Deployed receiver version mismatch: expected ${expectedVersion.toString()}, got ${version.toString()}`);
  }
}
