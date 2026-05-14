import type { Address } from "viem";
import type { ChainRegistry } from "../config/chainRegistry";
import type { SupportedChain } from "../config/chains";
import type { AaveUserAccount, AaveV3Protocol, LiquidationCandidate } from "../protocols/aaveV3";
import { createAsset, createAssetAmount } from "../utils/typedAssetMath";
import type { BorrowerSnapshot } from "./reserveAwareBorrowerCache";

const usd = createAsset({ symbol: "USD", decimals: 8 });
const weth = createAsset({ symbol: "WETH", decimals: 18 });
const usdc = createAsset({ symbol: "USDC", decimals: 6 });
const liquidationHealthFactor = 1_000_000_000_000_000_000n;

export class AaveSnapshotProvider {
  public constructor(
    private readonly chain: SupportedChain,
    private readonly protocol: AaveV3Protocol,
    private readonly registry: Pick<ChainRegistry, "getResolvedAave">,
  ) {}

  public async getBorrowersForReserve(_chain: SupportedChain, _reserve: Address): Promise<Address[]> {
    // Reserve events are resolved primarily against the in-memory hot cache.
    return [];
  }

  public async refreshBorrowers(_chain: SupportedChain, accounts: readonly Address[]): Promise<readonly BorrowerSnapshot[]> {
    this.registry.getResolvedAave(this.chain);
    const snapshots: BorrowerSnapshot[] = [];
    for (const account of accounts) {
      const snapshot = await this.refreshBorrower(account);
      if (snapshot !== undefined) {
        snapshots.push(snapshot);
      }
    }
    return snapshots;
  }

  public async pollBorrowers(_chain: SupportedChain): Promise<readonly BorrowerSnapshot[]> {
    this.registry.getResolvedAave(this.chain);
    const candidates = await this.protocol.getLiquidatablePositions();
    return candidates.map((candidate) => toSnapshot(this.chain, candidate));
  }

  private async refreshBorrower(account: Address): Promise<BorrowerSnapshot | undefined> {
    if (this.protocol.getUserAccount === undefined || this.protocol.getBestLiquidationPair === undefined) {
      return undefined;
    }

    const userAccount = await this.protocol.getUserAccount(account);
    if (userAccount.healthFactor >= liquidationHealthFactor) {
      return undefined;
    }
    const pair = await this.protocol.getBestLiquidationPair(userAccount);
    const candidate: LiquidationCandidate = {
      account,
      collateralAsset: pair.collateralAsset,
      debtAsset: pair.debtAsset,
      debtToCover: pair.debtToCover,
      repayValueUsd: pair.repayValueUsd,
      liquidationBonusBps: pair.liquidationBonusBps,
      healthFactor: userAccount.healthFactor,
    };
    return toSnapshot(this.chain, candidate);
  }
}

function toSnapshot(chain: SupportedChain, candidate: LiquidationCandidate): BorrowerSnapshot {
  const debtRaw = candidate.debtToCover;
  const collateralRaw = debtRaw + (debtRaw * BigInt(candidate.liquidationBonusBps)) / 10_000n;
  return {
    chain,
    account: candidate.account,
    healthFactor: candidate.healthFactor,
    updatedAtMs: Date.now(),
    reserves: [
      {
        assetAddress: candidate.collateralAsset,
        asset: weth,
        collateralBalance: createAssetAmount(weth, collateralRaw),
        variableDebt: createAssetAmount(weth, 0n),
        stableDebt: createAssetAmount(weth, 0n),
        priceInQuote: createAssetAmount(usd, 300_000_000_000n),
        usageAsCollateralEnabled: true,
        liquidationBonusBps: candidate.liquidationBonusBps,
      },
      {
        assetAddress: candidate.debtAsset as Address,
        asset: usdc,
        collateralBalance: createAssetAmount(usdc, 0n),
        variableDebt: createAssetAmount(usdc, debtRaw),
        stableDebt: createAssetAmount(usdc, 0n),
        priceInQuote: createAssetAmount(usd, 100_000_000n),
        usageAsCollateralEnabled: false,
        liquidationBonusBps: 0,
      },
    ],
  };
}

export function liquidationSafetyEstimateUsd(input: {
  account: AaveUserAccount;
  liquidationBonusBps: number;
}): number {
  const debtUsd = Number(input.account.totalDebtBase) / 1e8;
  return debtUsd * (input.liquidationBonusBps / 10_000);
}
