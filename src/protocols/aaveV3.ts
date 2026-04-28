import type { Address, Hex } from "viem";
import type { AaveReservePair, ChainConfig } from "../config/chains";

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
  getLastScanStats?(): AaveScanStats;
  subscribeToReserveDataUpdated?(onEvent: () => void): Promise<() => void>;
}

interface AaveReadClient {
  readContract(parameters: {
    readonly address: Address;
    readonly abi: typeof aavePoolAbi;
    readonly functionName: "getUserAccountData";
    readonly args: readonly [Address];
  }): Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>;
}

interface AaveEventClient {
  watchContractEvent?(parameters: {
    readonly address: Address;
    readonly abi: typeof aavePoolAbi;
    readonly eventName: "ReserveDataUpdated";
    readonly onLogs: () => void;
    readonly onError?: (error: Error) => void;
  }): () => void;
}

interface AaveGraphClient {
  request<T>(query: string, variables: Record<string, number>): Promise<T>;
}

export interface AavePositionScannerClient {
  readonly chain: ChainConfig;
  readonly publicClient: AaveReadClient;
  readonly graphClient: AaveGraphClient;
  readonly pageSize?: number;
}

interface BorrowerPage {
  /** Legacy Aave protocol-subgraphs (`users` / `userReserves`). */
  readonly users?: readonly { readonly id: string }[];
  readonly userReserves?: readonly { readonly user?: { readonly id: string }; readonly userAddress?: string }[];
  /** The Graph Network Aave V3 deployments (Messari-style schema: `positions` + `BORROWER`). */
  readonly positions?: readonly { readonly id?: string; readonly account?: { readonly id: string } }[];
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

  for (const account of borrowers) {
    const userAccount = await readUserAccount(optimismClient.publicClient, optimismClient.chain, account);
    if (calculateHealthFactor(userAccount) < wad) {
      positions.push(toLiquidationCandidate(userAccount, firstReservePair(optimismClient.chain)));
    }
  }

  return positions;
}

export class ViemAaveV3Protocol implements AaveV3Protocol {
  private lastScanStats: AaveScanStats = { scanned: 0, liquidatable: 0 };
  private nextBorrowerSkip = 0;

  public constructor(
    private readonly publicClient: AaveReadClient & AaveEventClient,
    private readonly chain: ChainConfig,
    private readonly graphClient?: AaveGraphClient,
    private readonly eventClient: AaveEventClient = publicClient,
    private readonly borrowerPageSize = 50,
  ) {}

  public async getUserAccount(account: Address): Promise<AaveUserAccount> {
    return readUserAccount(this.publicClient, this.chain, account);
  }

  public async getBestLiquidationPair(
    _account: AaveUserAccount,
  ): Promise<Omit<LiquidationCandidate, "account" | "healthFactor">> {
    const pair = firstReservePair(this.chain);
    return {
      collateralAsset: pair.collateralAsset,
      debtAsset: pair.debtAsset,
      debtToCover: pair.defaultDebtToCoverWei,
      repayValueUsd: pair.repayValueUsd,
      liquidationBonusBps: pair.liquidationBonusBps,
    };
  }

  public async getLiquidatablePositions(): Promise<LiquidationCandidate[]> {
    if (this.graphClient === undefined) {
      throw new Error("Aave subgraph client is required for broad market scanning");
    }

    const page = await fetchBorrowerPage(this.graphClient, this.borrowerPageSize, this.nextBorrowerSkip);
    const borrowers = extractBorrowerAddresses(page);
    const positions: LiquidationCandidate[] = [];

    for (const account of borrowers) {
      const userAccount = await this.getUserAccount(account);
      if (calculateHealthFactor(userAccount) < wad) {
        positions.push(toLiquidationCandidate(userAccount, firstReservePair(this.chain)));
      }
    }

    this.lastScanStats = { scanned: borrowers.length, liquidatable: positions.length };
    this.advanceBorrowerCursor(borrowerPageRowCount(page));
    return positions;
  }

  public getLastScanStats(): AaveScanStats {
    return this.lastScanStats;
  }

  public async subscribeToReserveDataUpdated(onEvent: () => void): Promise<() => void> {
    if (this.eventClient.watchContractEvent === undefined) {
      return () => undefined;
    }

    return this.eventClient.watchContractEvent({
      address: this.chain.aave.pool,
      abi: aavePoolAbi,
      eventName: "ReserveDataUpdated",
      onLogs: onEvent,
    });
  }

  private advanceBorrowerCursor(rowsRead: number): void {
    this.nextBorrowerSkip = rowsRead < this.borrowerPageSize ? 0 : this.nextBorrowerSkip + this.borrowerPageSize;
  }
}

async function readUserAccount(
  publicClient: AaveReadClient,
  chain: ChainConfig,
  account: Address,
): Promise<AaveUserAccount> {
  const result = await publicClient.readContract({
    address: chain.aave.pool,
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

async function fetchAllBorrowers(graphClient: AaveGraphClient, pageSize: number): Promise<Address[]> {
  const borrowers = new Set<Address>();
  let skip = 0;

  while (true) {
    const page = await fetchBorrowerPage(graphClient, pageSize, skip);
    const addresses = extractBorrowerAddresses(page);
    for (const address of addresses) {
      borrowers.add(address);
    }

    if (borrowerPageRowCount(page) < pageSize) {
      break;
    }
    skip += pageSize;
  }

  return [...borrowers];
}

async function fetchBorrowerPage(graphClient: AaveGraphClient, pageSize: number, skip: number): Promise<BorrowerPage> {
  return graphClient.request<BorrowerPage>(borrowerQuery, { first: pageSize, skip });
}

function borrowerPageRowCount(page: BorrowerPage): number {
  if (page.positions !== undefined) {
    return page.positions.length;
  }
  if (page.users !== undefined) {
    return page.users.length;
  }
  if (page.userReserves !== undefined) {
    return page.userReserves.length;
  }
  return 0;
}

function extractBorrowerAddresses(page: BorrowerPage): Address[] {
  const fromUsers = (page.users ?? []).map((user) => user.id);
  const fromReserves = (page.userReserves ?? []).map((reserve) => reserve.user?.id ?? reserve.userAddress);
  const fromPositions = (page.positions ?? []).map((row) => row.account?.id ?? extractAddressFromPositionId(row.id));
  return [...fromUsers, ...fromReserves, ...fromPositions]
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

const borrowerQuery = `
  query AaveV3Borrowers($first: Int!, $skip: Int!) {
    positions(
      first: $first
      skip: $skip
      orderBy: id
      orderDirection: asc
      where: { side: BORROWER, balance_gt: 0 }
    ) {
      id
    }
  }
`;
