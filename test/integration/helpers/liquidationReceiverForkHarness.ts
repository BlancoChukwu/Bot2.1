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
import { encodeLiquidationRoute } from "../../../src/protocols/liquidationFlashLoanReceiver";
import { liquidationFlashReceiverAbi } from "../../../src/production/liquidationReceiverReadiness";
import { createManagedAnvilFork } from "./baseAnvilFork";

const WAD = 1_000_000_000_000_000_000n;
/** Default fork test operator / authorized flash-loan initiator (anvil account #0). */
export const DEFAULT_FORK_AUTHORIZED_INITIATOR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
/** Aave returns type(uint256).max when the account has no debt (infinite HF). */
const MAX_AAVE_HEALTH_FACTOR = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
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
  /** Collateral seized in the historical LiquidationCall (wei) — dump sizing hint. */
  readonly liquidatedCollateralAmount: bigint;
  readonly receiveAToken: boolean;
  readonly blockNumber: bigint;
  /** Block where HF was verified < 1e18 (at or before liquidation block). */
  readonly snapshotBlock: bigint;
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
    transport: http(rpcUrl, { timeout: 120_000 }),
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

export function isUnderwaterHealthFactor(healthFactor: bigint): boolean {
  return healthFactor > 0n && healthFactor < WAD && healthFactor < MAX_AAVE_HEALTH_FACTOR;
}

export async function findHistoricalLiquidationCase(
  forkUrl: string,
  pool: Address,
  lookbackBlocks = 2_000_000n,
  assetFilter?: {
    readonly collateralAsset?: Address;
    readonly debtAsset?: Address;
    readonly minDebtToCover?: bigint;
    /** Prefer positions with HF below this (e.g. 0.95e18 for 100% close factor). */
    readonly maxHealthFactor?: bigint;
  },
): Promise<LiquidationForkCase> {
  // Discovery uses the source RPC with historical eth_call — no anvil reset loop.
  const client = createPublicClient({
    chain: base,
    transport: http(forkUrl, { timeout: 120_000 }),
  });
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
    if (
      assetFilter?.collateralAsset !== undefined
      && log.args.collateralAsset.toLowerCase() !== assetFilter.collateralAsset.toLowerCase()
    ) {
      continue;
    }
    if (
      assetFilter?.debtAsset !== undefined
      && log.args.debtAsset.toLowerCase() !== assetFilter.debtAsset.toLowerCase()
    ) {
      continue;
    }
    if (
      assetFilter?.minDebtToCover !== undefined
      && log.args.debtToCover < assetFilter.minDebtToCover
    ) {
      continue;
    }
    let matchedHealthFactor: bigint | undefined;
    let matchedSnapshotBlock: bigint | undefined;
    const maxLookback = 10n;
    for (let offset = 1n; offset <= maxLookback; offset += 1n) {
      if (log.blockNumber < offset) {
        continue;
      }
      const snapshotBlock = log.blockNumber - offset;
      const accountData = await client.readContract({
        address: pool,
        abi: aavePoolAbi,
        functionName: "getUserAccountData",
        args: [log.args.user],
        blockNumber: snapshotBlock,
      });
      const healthFactor = accountData[5];
      if (isUnderwaterHealthFactor(healthFactor)) {
        if (
          assetFilter?.maxHealthFactor !== undefined
          && healthFactor >= assetFilter.maxHealthFactor
        ) {
          // Liquidatable but above requested HF band — skip this event.
          break;
        }
        matchedHealthFactor = healthFactor;
        matchedSnapshotBlock = snapshotBlock;
        break;
      }
    }
    if (matchedHealthFactor === undefined || matchedSnapshotBlock === undefined) {
      continue;
    }
    return {
      user: log.args.user,
      collateralAsset: log.args.collateralAsset,
      debtAsset: log.args.debtAsset,
      debtToCover: log.args.debtToCover,
      liquidatedCollateralAmount: log.args.liquidatedCollateralAmount ?? 0n,
      receiveAToken: log.args.receiveAToken ?? false,
      blockNumber: log.blockNumber,
      snapshotBlock: matchedSnapshotBlock,
      healthFactor: matchedHealthFactor,
    };
  }

  throw new Error(
    assetFilter?.maxHealthFactor !== undefined
      ? `No LiquidationCall case with HF < ${assetFilter.maxHealthFactor.toString()} found in lookback window`
      : "No LiquidationCall case with HF < 1e18 at block-1 found in lookback window",
  );
}

/** @deprecated Use findHistoricalLiquidationCase — head HF is meaningless after liquidation. */
export async function findRecentLiquidationCase(
  client: Pick<PublicClient, "getBlockNumber" | "getLogs" | "readContract">,
  pool: Address,
  lookbackBlocks = 2_000_000n,
): Promise<LiquidationForkCase> {
  const forkUrl = process.env.BASE_FORK_RPC_URL
    ?? process.env.FORK_RPC_URL
    ?? process.env.EXECUTION_RPC_URL_PRIMARY
    ?? process.env.RPC_URL
    ?? process.env.DEPLOY_RECEIVER_RPC_URL;
  if (forkUrl === undefined || forkUrl.trim() === "") {
    throw new Error("findRecentLiquidationCase requires fork RPC env — use findHistoricalLiquidationCase");
  }
  return findHistoricalLiquidationCase(forkUrl.trim(), pool, lookbackBlocks);
}

export function encodeProductionRouteParams(input: {
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly user: Address;
  readonly debtToCover: bigint;
  readonly receiveAToken: boolean;
  readonly minDebtOut?: bigint;
  readonly fee?: 100 | 500 | 3_000 | 10_000;
}): Hex {
  return encodeLiquidationRoute({
    collateralAsset: input.collateralAsset,
    debtAsset: input.debtAsset,
    user: input.user,
    debtToCover: input.debtToCover,
    minDebtOut: input.minDebtOut ?? 0n,
    receiveAToken: input.receiveAToken,
    fee: input.fee ?? 3_000,
  });
}

/** @deprecated TEST-ONLY legacy 5-field schema — use encodeProductionRouteParams (production encoder). */
export function encodeExecuteOperationParamsLegacy5Field(input: {
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

/** @deprecated Use encodeProductionRouteParams — wraps production 8-field encoder. */
export function encodeExecuteOperationParams(input: {
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly user: Address;
  readonly debtToCover: bigint;
  readonly receiveAToken: boolean;
  readonly minDebtOut?: bigint;
  readonly fee?: 100 | 500 | 3_000 | 10_000;
}): Hex {
  return encodeProductionRouteParams(input);
}

export async function readDecodedRouteParams(
  client: Pick<PublicClient, "readContract">,
  receiver: Address,
  params: Hex,
): Promise<readonly [number, Address, Address, Address, bigint, bigint, boolean, number]> {
  return client.readContract({
    address: receiver,
    abi: liquidationFlashReceiverAbi,
    functionName: "decodeRouteParams",
    args: [params],
  });
}

export interface DeployReceiverOptions {
  readonly swapFee?: number;
  readonly swapSlippageBps?: bigint;
  readonly authorizedInitiator?: Address;
}

export async function deployLiquidationFlashReceiver(
  rpcUrl: string,
  artifact: ReceiverArtifact,
  options: DeployReceiverOptions = {},
): Promise<Address> {
  const testClient = createForkTestClient(rpcUrl);
  const deployer = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
  await testClient.setBalance({ address: deployer, value: parseEther("10") });
  const pool = getChainConfig("base").aave.pool;
  const uniswap = getDexesForChain("base").find((dex) => dex.name === "UniswapV3");
  if (uniswap === undefined) {
    throw new Error("UniswapV3 missing from dex registry for base");
  }
  const swapFee = options.swapFee ?? Number(process.env.LIQUIDATION_SWAP_POOL_FEE ?? "3000");
  const authorizedInitiator = options.authorizedInitiator ?? DEFAULT_FORK_AUTHORIZED_INITIATOR;
  const swapSlippageBps = options.swapSlippageBps
    ?? BigInt(process.env.LIQUIDATION_SWAP_SLIPPAGE_BPS ?? "200");
  const hash = await testClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [pool, uniswap.router, swapFee, authorizedInitiator, swapSlippageBps],
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

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
] as const;

const swapRouter02Abi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

/** Fund `to` with WETH by depositing ETH as anvil account #0. */
export async function fundWeth(rpcUrl: string, to: Address, amountWei: bigint): Promise<void> {
  const weth = "0x4200000000000000000000000000000000000006" as Address;
  const testClient = createForkTestClient(rpcUrl);
  const funder = DEFAULT_FORK_AUTHORIZED_INITIATOR;
  await testClient.setBalance({ address: funder, value: amountWei + parseEther("1") });
  const depositHash = await testClient.writeContract({
    address: weth,
    abi: erc20Abi,
    functionName: "deposit",
    args: [],
    account: funder,
    value: amountWei,
  });
  await testClient.waitForTransactionReceipt({ hash: depositHash });
  if (to.toLowerCase() !== funder.toLowerCase()) {
    const transferHash = await testClient.writeContract({
      address: weth,
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, amountWei],
      account: funder,
    });
    await testClient.waitForTransactionReceipt({ hash: transferHash });
  }
}

/**
 * Pull ERC20 from a whale via impersonation (anvil). Used to fund flash-loan debt onto the receiver.
 */
export async function fundErc20FromWhale(input: {
  readonly rpcUrl: string;
  readonly token: Address;
  readonly whale: Address;
  readonly to: Address;
  readonly amount: bigint;
}): Promise<void> {
  const testClient = createForkTestClient(input.rpcUrl);
  await testClient.impersonateAccount({ address: input.whale });
  await testClient.setBalance({ address: input.whale, value: parseEther("1") });
  const hash = await testClient.writeContract({
    address: input.token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [input.to, input.amount],
    account: input.whale,
  });
  await testClient.waitForTransactionReceipt({ hash });
}

/**
 * Degrade Uniswap V3 executable price by dumping `tokenIn` into the pool (amountOutMinimum = 0).
 * Does NOT touch the Aave oracle — only the DEX pool the receiver will swap against.
 */
export async function dumpUniswapV3Pool(input: {
  readonly rpcUrl: string;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly fee: number;
  readonly router: Address;
}): Promise<Hex> {
  const testClient = createForkTestClient(input.rpcUrl);
  const attacker = DEFAULT_FORK_AUTHORIZED_INITIATOR;
  if (input.tokenIn.toLowerCase() === "0x4200000000000000000000000000000000000006") {
    await fundWeth(input.rpcUrl, attacker, input.amountIn);
  }
  const approveHash = await testClient.writeContract({
    address: input.tokenIn,
    abi: erc20Abi,
    functionName: "approve",
    args: [input.router, input.amountIn],
    account: attacker,
  });
  await testClient.waitForTransactionReceipt({ hash: approveHash });
  const swapHash = await testClient.writeContract({
    address: input.router,
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        fee: input.fee,
        recipient: attacker,
        amountIn: input.amountIn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      },
    ],
    account: attacker,
    gas: 8_000_000n,
  });
  const receipt = await testClient.waitForTransactionReceipt({ hash: swapHash });
  if (receipt.status !== "success") {
    // Surface the revert reason — silent status=reverted previously hid failed dumps.
    let reason = `status=${receipt.status}`;
    try {
      await testClient.simulateContract({
        address: input.router,
        abi: swapRouter02Abi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: input.tokenIn,
            tokenOut: input.tokenOut,
            fee: input.fee,
            recipient: attacker,
            amountIn: input.amountIn,
            amountOutMinimum: 0n,
            sqrtPriceLimitX96: 0n,
          },
        ],
        account: attacker,
      });
    } catch (error) {
      reason = error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400);
    }
    throw new Error(
      `dumpUniswapV3Pool swap reverted fee=${input.fee} amountIn=${input.amountIn} hash=${swapHash} reason=${reason}`,
    );
  }
  return swapHash;
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
  readonly initiator?: Address;
}): Promise<void> {
  await impersonatePoolCaller(input.rpcUrl, input.pool);
  await input.client.simulateContract({
    address: input.receiver,
    abi: input.artifact.abi,
    functionName: "executeOperation",
    args: [
      input.debtAsset,
      input.amount,
      input.premium,
      input.initiator ?? DEFAULT_FORK_AUTHORIZED_INITIATOR,
      input.params,
    ],
    account: input.pool,
  });
}

/**
 * Full Aave path: initiator → pool.flashLoanSimple → receiver.executeOperation → …
 * Use this (not bare executeOperation) when proving callback unwind / flash-loan atomicity.
 */
export async function simulateFlashLoanSimple(input: {
  readonly client: ForkPublicClient;
  readonly rpcUrl: string;
  readonly pool: Address;
  readonly receiver: Address;
  readonly debtAsset: Address;
  readonly amount: bigint;
  readonly params: Hex;
  readonly initiator?: Address;
}): Promise<void> {
  const initiator = input.initiator ?? DEFAULT_FORK_AUTHORIZED_INITIATOR;
  const testClient = createForkTestClient(input.rpcUrl);
  await testClient.setBalance({ address: initiator, value: parseEther("1") });
  await input.client.simulateContract({
    address: input.pool,
    abi: aavePoolAbi,
    functionName: "flashLoanSimple",
    args: [input.receiver, input.debtAsset, input.amount, input.params, 0],
    account: initiator,
  });
}

export async function readErc20Balance(
  client: Pick<ForkPublicClient, "readContract">,
  token: Address,
  account: Address,
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
}

const getReserveDataAbi = [
  {
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
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
    ],
  },
] as const;

/**
 * Find a debtToCover that simulates successfully against Aave (avoids MustNotLeaveDust).
 * Tries full debt, half, then stepped fractions. Returns the first amount that does not revert.
 */
export async function findDustSafeDebtToCover(input: {
  readonly client: ForkPublicClient;
  readonly rpcUrl: string;
  readonly pool: Address;
  readonly user: Address;
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly liquidator?: Address;
  /** Prefer this amount first (e.g. historical LiquidationCall debtToCover). */
  readonly preferredDebtToCover?: bigint;
}): Promise<{ debtToCover: bigint; userReserveDebt: bigint }> {
  const liquidator = input.liquidator ?? DEFAULT_FORK_AUTHORIZED_INITIATOR;
  const sized = await sizeLiquidationDebtToCover({
    client: input.client,
    pool: input.pool,
    user: input.user,
    debtAsset: input.debtAsset,
    healthFactor: await readHealthFactor(input.client, input.pool, input.user),
  });
  const candidates = [
    sized.userReserveDebt,
    sized.debtToCover,
    (sized.userReserveDebt * 40n) / 100n,
    (sized.userReserveDebt * 30n) / 100n,
    (sized.userReserveDebt * 25n) / 100n,
    (sized.userReserveDebt * 20n) / 100n,
    (sized.userReserveDebt * 15n) / 100n,
    (sized.userReserveDebt * 10n) / 100n,
    (sized.userReserveDebt * 5n) / 100n,
  ].filter((v, i, arr) => v > 1_000_000n && arr.indexOf(v) === i); // at least 1 USDC
  if (input.preferredDebtToCover !== undefined && input.preferredDebtToCover > 0n) {
    candidates.unshift(input.preferredDebtToCover);
  }

  const testClient = createForkTestClient(input.rpcUrl);
  // Fund liquidator with enough debt asset for the largest candidate.
  const maxNeed = candidates.reduce((a, b) => (a > b ? a : b), 0n);
  if (input.debtAsset.toLowerCase() === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") {
    await fundErc20FromWhale({
      rpcUrl: input.rpcUrl,
      token: input.debtAsset,
      whale: "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A" as Address,
      to: liquidator,
      amount: maxNeed,
    });
  }
  await testClient.setBalance({ address: liquidator, value: parseEther("1") });
  const approveHash = await testClient.writeContract({
    address: input.debtAsset,
    abi: erc20Abi,
    functionName: "approve",
    args: [input.pool, maxNeed],
    account: liquidator,
  });
  await testClient.waitForTransactionReceipt({ hash: approveHash });

  const failures: string[] = [];
  for (const amount of candidates) {
    try {
      await input.client.simulateContract({
        address: input.pool,
        abi: aavePoolAbi,
        functionName: "liquidationCall",
        args: [input.collateralAsset, input.debtAsset, input.user, amount, false],
        account: liquidator,
      });
      return { debtToCover: amount, userReserveDebt: sized.userReserveDebt };
    } catch (error) {
      const message = extractRevertMessage(error);
      const tag = message.includes("0xb629b0e4") || message.includes("MustNotLeaveDust")
        ? "DUST"
        : message.includes("Health factor") || message.includes("HEALTH_FACTOR")
          ? "HF"
          : message.slice(0, 80).replace(/\s+/g, " ");
      failures.push(`${amount.toString()}:${tag}`);
      continue;
    }
  }
  throw new Error(
    `No dust-safe debtToCover found for ${input.user} `
    + `(reserveDebt=${sized.userReserveDebt.toString()}, tried ${candidates.length} sizes) `
    + `failures=[${failures.join("; ")}]`,
  );
}

/**
 * Size debtToCover to avoid Aave v3.3 MustNotLeaveDust:
 * - HF < 0.95 → full reserve debt (100% close factor)
 * - else → 50% of reserve debt (default close factor)
 */
export async function sizeLiquidationDebtToCover(input: {
  readonly client: Pick<ForkPublicClient, "readContract">;
  readonly pool: Address;
  readonly user: Address;
  readonly debtAsset: Address;
  readonly healthFactor: bigint;
}): Promise<{ debtToCover: bigint; userReserveDebt: bigint }> {
  const reserve = await input.client.readContract({
    address: input.pool,
    abi: getReserveDataAbi,
    functionName: "getReserveData",
    args: [input.debtAsset],
  });
  const variableDebt = await readErc20Balance(
    input.client,
    reserve.variableDebtTokenAddress,
    input.user,
  );
  const stableDebt = await readErc20Balance(
    input.client,
    reserve.stableDebtTokenAddress,
    input.user,
  );
  const userReserveDebt = variableDebt + stableDebt;
  if (userReserveDebt === 0n) {
    throw new Error(`User ${input.user} has zero debt in ${input.debtAsset}`);
  }
  const closeFactorHfThreshold = 950_000_000_000_000_000n; // 0.95e18
  const debtToCover = input.healthFactor < closeFactorHfThreshold
    ? userReserveDebt
    : userReserveDebt / 2n;
  return { debtToCover: debtToCover > 0n ? debtToCover : userReserveDebt, userReserveDebt };
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
