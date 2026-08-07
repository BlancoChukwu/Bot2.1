import type { Address, Hex } from "viem";
import type { ChainRegistry } from "../config/chainRegistry";
import type { AaveReservePair, ChainConfig } from "../config/chains";

export const ZERO_CURSOR_ID = "0x0000000000000000000000000000000000000000";

const wad = 1_000_000_000_000_000_000n;
const bpsDenominator = 10_000n;
const maxHealthFactor = (1n << 256n) - 1n;

export interface AaveUserAccount {
  readonly account: Address;
  readonly totalCollateralBase: bigint;
  readonly totalDebtBase: bigint;
  readonly availableBorrowsBase: bigint;
  readonly currentLiquidationThreshold: bigint;
  readonly loanToValue: bigint;
  readonly healthFactor: bigint;
}

export interface LiquidationCandidate {
  readonly account: Address;
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly debtToCover: bigint;
  readonly repayValueUsd: number;
  readonly liquidationBonusBps: number;
  readonly effectiveLiquidationBonusBps?: number;
  readonly closeFactorBps?: number;
  readonly collateralReceivedWei?: bigint;
  readonly bonusPercentage?: number;
  readonly gasEstimate?: bigint;
  readonly gasPrice?: bigint;
  readonly healthFactor: bigint;
}

export interface AaveAccountHealthInput {
  readonly totalCollateralBase: bigint;
  readonly totalDebtBase: bigint;
  readonly currentLiquidationThreshold: bigint;
  readonly healthFactor?: bigint;
}

export interface AaveScanStats {
  readonly scanned: number;
  readonly liquidatable: number;
}

export interface AaveV3Protocol {
  getLiquidatablePositions(): Promise<LiquidationCandidate[]>;
  getUserAccount?(account: Address): Promise<AaveUserAccount>;
  getBestLiquidationPair?(
    account: AaveUserAccount,
  ): Promise<Omit<LiquidationCandidate, "account" | "healthFactor">>;
  listBorrowerAddresses?(): Promise<readonly Address[]>;
  getLastScanStats?(): AaveScanStats;
  subscribeToReserveDataUpdated?(onEvent: (reserve?: Address) => void): Promise<() => void>;
}

interface AaveReadClient {
  readContract(parameters: {
    readonly address: Address;
    readonly abi: typeof aavePoolAbi;
    readonly functionName: "getUserAccountData";
    readonly args: readonly [Address];
  }): Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>;
}

/** Runtime reader for reserve/debt-token calls (viem PublicClient satisfies this at runtime). */
interface FlexibleContractReader {
  readContract(parameters: {
    readonly address: Address;
    readonly abi: readonly unknown[];
    readonly functionName: string;
    readonly args?: readonly unknown[];
  }): Promise<unknown>;
}

/** Minimal Pool.getReserveData fields used to resolve variable-debt token balances. */
const aaveReserveDataAbi = [
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
] as const;

const erc20BalanceOfAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

interface AaveEventClient {
  watchContractEvent?(parameters: {
    readonly address: Address;
    readonly abi: typeof aavePoolAbi;
    readonly eventName: "ReserveDataUpdated";
    readonly onLogs: (logs: readonly unknown[]) => void;
    readonly onError?: (error: Error) => void;
  }): () => void;
}

interface AaveGraphClient {
  request<T>(query: string, variables: Record<string, number | string>): Promise<T>;
}

export interface AavePositionScannerClient {
  readonly chain: ChainConfig;
  readonly publicClient: AaveReadClient;
  readonly graphClient: AaveGraphClient;
  readonly pageSize?: number;
  readonly registry: Pick<ChainRegistry, "getResolvedAave">;
}

interface BorrowerPage {
  readonly positions?: readonly { readonly id: string }[];
}

export const aavePoolAbi = [
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "FLASHLOAN_PREMIUM_TOTAL",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "liquidationCall",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralAsset", type: "address" },
      { name: "debtAsset", type: "address" },
      { name: "user", type: "address" },
      { name: "debtToCover", type: "uint256" },
      { name: "receiveAToken", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "flashLoanSimple",
    stateMutability: "nonpayable",
    inputs: [
      { name: "receiverAddress", type: "address" },
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "params", type: "bytes" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "ReserveDataUpdated",
    inputs: [
      { name: "reserve", type: "address", indexed: true },
      { name: "liquidityRate", type: "uint256", indexed: false },
      { name: "stableBorrowRate", type: "uint256", indexed: false },
      { name: "variableBorrowRate", type: "uint256", indexed: false },
      { name: "liquidityIndex", type: "uint256", indexed: false },
      { name: "variableBorrowIndex", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Supply",
    inputs: [
      { name: "reserve", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "onBehalfOf", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "referralCode", type: "uint16", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Borrow",
    inputs: [
      { name: "reserve", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "onBehalfOf", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "interestRateMode", type: "uint8", indexed: false },
      { name: "borrowRate", type: "uint256", indexed: false },
      { name: "referralCode", type: "uint16", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Repay",
    inputs: [
      { name: "reserve", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "repayer", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "useATokens", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdraw",
    inputs: [
      { name: "reserve", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LiquidationCall",
    inputs: [
      { name: "collateralAsset", type: "address", indexed: true },
      { name: "debtAsset", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "debtToCover", type: "uint256", indexed: false },
      { name: "liquidatedCollateralAmount", type: "uint256", indexed: false },
      { name: "liquidator", type: "address", indexed: false },
      { name: "receiveAToken", type: "bool", indexed: false },
    ],
  },
] as const;

export interface LiquidationCallParams {
  readonly address: Address;
  readonly abi: typeof aavePoolAbi;
  readonly functionName: "liquidationCall";
  readonly args: readonly [Address, Address, Address, bigint, boolean];
}

export interface FlashLoanSimpleInput {
  readonly pool: Address;
  readonly receiverAddress: Address;
  readonly asset: Address;
  readonly amount: bigint;
  readonly encodedParams: Hex;
  readonly referralCode: number;
}

export interface FlashLoanSimpleParams {
  readonly address: Address;
  readonly abi: typeof aavePoolAbi;
  readonly functionName: "flashLoanSimple";
  readonly args: readonly [Address, Address, bigint, Hex, number];
}

export function calculateHealthFactor(account: AaveAccountHealthInput): bigint {
  if (account.healthFactor !== undefined) {
    return account.healthFactor;
  }

  if (account.totalDebtBase === 0n) {
    return maxHealthFactor;
  }

  return (account.totalCollateralBase * account.currentLiquidationThreshold * wad)
    / (account.totalDebtBase * bpsDenominator);
}

export function buildLiquidationCallParams(
  position: LiquidationCandidate,
  pool: Address,
): LiquidationCallParams {
  return {
    address: pool,
    abi: aavePoolAbi,
    functionName: "liquidationCall",
    args: [
      position.collateralAsset,
      position.debtAsset,
      position.account,
      position.debtToCover,
      false,
    ],
  };
}

export function buildFlashLoanSimpleParams(input: FlashLoanSimpleInput): FlashLoanSimpleParams {
  return {
    address: input.pool,
    abi: aavePoolAbi,
    functionName: "flashLoanSimple",
    args: [
      input.receiverAddress,
      input.asset,
      input.amount,
      input.encodedParams,
      input.referralCode,
    ],
  };
}

export async function getLiquidatablePositions(
  optimismClient: AavePositionScannerClient,
): Promise<LiquidationCandidate[]> {
  const borrowers = await fetchAllBorrowers(optimismClient.graphClient, optimismClient.pageSize ?? 1_000);
  const positions: LiquidationCandidate[] = [];
  const resolvedPool = optimismClient.registry.getResolvedAave(optimismClient.chain.name).pool;

  for (const account of borrowers) {
    const userAccount = await readUserAccount(optimismClient.publicClient, account, resolvedPool);
    if (calculateHealthFactor(userAccount) < wad) {
      positions.push(toLiquidationCandidate(userAccount, firstReservePair(optimismClient.chain)));
    }
  }

  return positions;
}

export class ViemAaveV3Protocol implements AaveV3Protocol {
  private lastScanStats: AaveScanStats = { scanned: 0, liquidatable: 0 };
  private lastBorrowerCursorId = ZERO_CURSOR_ID;

  public constructor(
    private readonly publicClient: AaveReadClient & AaveEventClient,
    private readonly chain: ChainConfig,
    private readonly graphClient?: AaveGraphClient,
    private readonly eventClient: AaveEventClient = publicClient,
    private readonly borrowerPageSize = 50,
    private readonly registry?: Pick<ChainRegistry, "getResolvedAave">,
  ) {}

  public async getUserAccount(account: Address): Promise<AaveUserAccount> {
    return readUserAccount(this.publicClient, account, this.resolveAavePool());
  }

  public async getBestLiquidationPair(
    account: AaveUserAccount,
  ): Promise<Omit<LiquidationCandidate, "account" | "healthFactor">> {
    const pair = selectBestReservePairForAccount(this.chain, account);
    const debtToCover = await this.readVariableDebtBalance(pair.debtAsset, account.account);
    // Prefer on-chain debt token balance. Config defaultDebtToCoverWei (1e6) is a placeholder only.
    const sizedDebt = debtToCover > 0n ? debtToCover : pair.defaultDebtToCoverWei;
    const repayValueUsd = estimateRepayValueUsd(account.totalDebtBase, sizedDebt, pair);
    return {
      collateralAsset: pair.collateralAsset,
      debtAsset: pair.debtAsset,
      debtToCover: sizedDebt,
      repayValueUsd,
      liquidationBonusBps: pair.liquidationBonusBps,
    };
  }

  /** Compounded variable-debt token balance for `debtAsset` (actual wei to cover). */
  private async readVariableDebtBalance(debtAsset: Address, user: Address): Promise<bigint> {
    const pool = this.resolveAavePool();
    const reader = this.publicClient as unknown as FlexibleContractReader;
    const reserveData = await reader.readContract({
      address: pool,
      abi: aaveReserveDataAbi as unknown as readonly unknown[],
      functionName: "getReserveData",
      args: [debtAsset],
    }) as readonly unknown[];
    const variableDebtToken = reserveData[10];
    if (typeof variableDebtToken !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(variableDebtToken)) {
      return 0n;
    }
    const balance = await reader.readContract({
      address: variableDebtToken as Address,
      abi: erc20BalanceOfAbi as unknown as readonly unknown[],
      functionName: "balanceOf",
      args: [user],
    });
    return typeof balance === "bigint" ? balance : 0n;
  }

  public async listBorrowerAddresses(): Promise<readonly Address[]> {
    if (this.graphClient === undefined) {
      throw new Error("Aave subgraph client is required for borrower enumeration");
    }
    return fetchAllBorrowers(this.graphClient, this.borrowerPageSize);
  }

  public async getLiquidatablePositions(): Promise<LiquidationCandidate[]> {
    if (this.graphClient === undefined) {
      throw new Error("Aave subgraph client is required for broad market scanning");
    }

    const page = await fetchBorrowerPage(this.graphClient, this.borrowerPageSize, this.lastBorrowerCursorId);
    const borrowers = extractBorrowerAddresses(page);
    const positions: LiquidationCandidate[] = [];

    for (const account of borrowers) {
      const userAccount = await this.getUserAccount(account);
      if (calculateHealthFactor(userAccount) < wad) {
        positions.push(toLiquidationCandidate(userAccount, firstReservePair(this.chain)));
      }
    }

    const rowsRead = borrowerPageRowCount(page);
    this.lastScanStats = { scanned: borrowers.length, liquidatable: positions.length };
    this.lastBorrowerCursorId = rowsRead < this.borrowerPageSize
      ? ZERO_CURSOR_ID
      : lastBorrowerPageCursorId(page) ?? ZERO_CURSOR_ID;
    return positions;
  }

  public getLastScanStats(): AaveScanStats {
    return this.lastScanStats;
  }

  public async subscribeToReserveDataUpdated(onEvent: (reserve?: Address) => void): Promise<() => void> {
    if (this.eventClient.watchContractEvent === undefined) {
      return () => undefined;
    }

    return this.eventClient.watchContractEvent({
      address: this.resolveAavePool(),
      abi: aavePoolAbi,
      eventName: "ReserveDataUpdated",
      onLogs: (logs) => {
        for (const log of logs) {
          const reserve = (log as { readonly args?: { readonly reserve?: Address } }).args?.reserve;
          onEvent(reserve);
        }
      },
    });
  }

  private resolveAavePool(): Address {
    if (this.registry === undefined) {
      throw new Error("ViemAaveV3Protocol requires chain registry for resolved Aave addresses");
    }
    return this.registry.getResolvedAave(this.chain.name).pool;
  }
}

async function readUserAccount(
  publicClient: AaveReadClient,
  account: Address,
  pool: Address,
): Promise<AaveUserAccount> {
  const result = await publicClient.readContract({
    address: pool,
    abi: aavePoolAbi,
    functionName: "getUserAccountData",
    args: [account],
  });

  return {
    account,
    totalCollateralBase: result[0],
    totalDebtBase: result[1],
    availableBorrowsBase: result[2],
    currentLiquidationThreshold: result[3],
    loanToValue: result[4],
    healthFactor: result[5],
  };
}

/**
 * Gate/exec need a USD notion before oracle refresh.
 * Use totalDebtBase (Aave 8-decimal USD) when debt was sized on-chain; keep pair placeholder only for zero debt.
 */
function estimateRepayValueUsd(
  totalDebtBase: bigint,
  debtToCover: bigint,
  pair: AaveReservePair,
): number {
  if (debtToCover <= 0n) {
    return 0;
  }
  if (debtToCover === pair.defaultDebtToCoverWei) {
    return pair.repayValueUsd;
  }
  const fromBase = Number(totalDebtBase) / 1e8;
  return Number.isFinite(fromBase) && fromBase > 0 ? fromBase : pair.repayValueUsd;
}

async function fetchAllBorrowers(graphClient: AaveGraphClient, pageSize: number): Promise<Address[]> {
  const borrowers = new Set<Address>();
  let lastId = ZERO_CURSOR_ID;

  while (true) {
    const page = await fetchBorrowerPage(graphClient, pageSize, lastId);
    const positions = page.positions ?? [];
    if (positions.length === 0) {
      break;
    }
    for (const position of positions) {
      const address = extractAddressFromPositionId(position.id);
      if (address !== undefined) {
        borrowers.add(address.toLowerCase() as Address);
      }
      lastId = position.id;
    }
    if (positions.length < pageSize) {
      break;
    }
  }

  return [...borrowers];
}

async function fetchBorrowerPage(
  graphClient: AaveGraphClient,
  pageSize: number,
  lastId: string,
): Promise<BorrowerPage> {
  return graphClient.request<BorrowerPage>(borrowerQueryPositions, { first: pageSize, lastId });
}

function borrowerPageRowCount(page: BorrowerPage): number {
  return page.positions?.length ?? 0;
}

function lastBorrowerPageCursorId(page: BorrowerPage): string | undefined {
  const positions = page.positions;
  if (positions === undefined || positions.length === 0) {
    return undefined;
  }
  return positions[positions.length - 1]?.id;
}

function extractBorrowerAddresses(page: BorrowerPage): Address[] {
  return (page.positions ?? [])
    .map((row) => extractAddressFromPositionId(row.id))
    .filter((value): value is string => value !== undefined)
    .map((value) => value.toLowerCase())
    .filter((value): value is Address => /^0x[a-f0-9]{40}$/.test(value));
}

function extractAddressFromPositionId(positionId: string | undefined): string | undefined {
  return positionId?.split("-")[0];
}

function toLiquidationCandidate(account: AaveUserAccount, pair: AaveReservePair): LiquidationCandidate {
  return {
    account: account.account,
    collateralAsset: pair.collateralAsset,
    debtAsset: pair.debtAsset,
    debtToCover: pair.defaultDebtToCoverWei,
    repayValueUsd: pair.repayValueUsd,
    liquidationBonusBps: pair.liquidationBonusBps,
    healthFactor: calculateHealthFactor(account),
  };
}

function firstReservePair(chain: ChainConfig): AaveReservePair {
  const pair = chain.aave.reservePairs[0];
  if (pair === undefined) {
    throw new Error(`No Aave reserve pairs configured for ${chain.name}`);
  }

  return pair;
}

function selectBestReservePairForAccount(chain: ChainConfig, account: AaveUserAccount): AaveReservePair {
  const pairs = chain.aave.reservePairs;
  const first = pairs[0];
  if (first === undefined) {
    throw new Error(`No Aave reserve pairs configured for ${chain.name}`);
  }

  const collateralHeavy = account.totalCollateralBase > account.totalDebtBase * 2n;
  const sorted = [...pairs].sort((left, right) => {
    const bonusDiff = right.liquidationBonusBps - left.liquidationBonusBps;
    if (bonusDiff !== 0) {
      return bonusDiff;
    }
    const repayDiff = right.repayValueUsd - left.repayValueUsd;
    if (repayDiff !== 0) {
      return repayDiff;
    }
    return 0;
  });
  return collateralHeavy ? sorted[0] ?? first : first;
}

const borrowerQueryPositions = `
  query AaveV3BorrowersPositions($first: Int!, $lastId: String!) {
    positions(
      first: $first
      orderBy: id
      orderDirection: asc
      where: { side: BORROWER, balance_gt: 0, id_gt: $lastId }
    ) {
      id
    }
  }
`;
