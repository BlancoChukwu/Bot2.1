import { z } from "zod";

export interface Asset {
  readonly symbol: string;
  readonly decimals: number;
}

export interface AssetAmount {
  readonly asset: Asset;
  readonly raw: bigint;
}

export interface NetProfitInput {
  readonly revenue: AssetAmount;
  readonly debt: AssetAmount;
  readonly gas: AssetAmount;
  readonly flashLoanFee: AssetAmount;
  readonly swapCost: AssetAmount;
  readonly slippageBuffer?: AssetAmount;
  readonly safetyBuffer?: AssetAmount;
}

export interface MinimumMarginInput {
  readonly netProfit: AssetAmount;
  readonly capitalAtRisk: AssetAmount;
  readonly minimumMarginBps: number;
}

const assetSchema = z.object({
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
});
const bpsDenominator = 10_000n;

export function createAsset(input: Asset): Asset {
  return assetSchema.parse(input);
}

export function createAssetAmount(asset: Asset, raw: bigint): AssetAmount {
  if (raw < 0n) {
    throw new Error("Asset amount cannot be negative");
  }

  return { asset: createAsset(asset), raw };
}

export function convertToQuote(amount: AssetAmount, pricePerWholeToken: AssetAmount): AssetAmount {
  const scale = 10n ** BigInt(amount.asset.decimals);
  return createAssetAmount(
    pricePerWholeToken.asset,
    (amount.raw * pricePerWholeToken.raw) / scale,
  );
}

export function calculateNetProfit(input: NetProfitInput): AssetAmount {
  const costs = addAssetAmounts(
    input.debt,
    input.gas,
    input.flashLoanFee,
    input.swapCost,
    input.slippageBuffer ?? createAssetAmount(input.debt.asset, 0n),
    input.safetyBuffer ?? createAssetAmount(input.debt.asset, 0n),
  );
  return subtractAssetAmounts(input.revenue, costs);
}

export function calculateMarginBps(netProfit: AssetAmount, capitalAtRisk: AssetAmount): bigint {
  assertSameAsset(netProfit, capitalAtRisk);
  if (capitalAtRisk.raw === 0n) {
    return 0n;
  }

  return (netProfit.raw * bpsDenominator) / capitalAtRisk.raw;
}

export function meetsMinimumProfitMargin(input: MinimumMarginInput): boolean {
  assertSameAsset(input.netProfit, input.capitalAtRisk);
  if (input.minimumMarginBps < 0 || !Number.isInteger(input.minimumMarginBps)) {
    throw new Error("minimumMarginBps must be a non-negative integer");
  }
  if (input.capitalAtRisk.raw === 0n) {
    return false;
  }

  return input.netProfit.raw * bpsDenominator
    >= input.capitalAtRisk.raw * BigInt(input.minimumMarginBps);
}

export function subtractAssetAmounts(left: AssetAmount, right: AssetAmount): AssetAmount {
  assertSameAsset(left, right);
  if (right.raw > left.raw) {
    throw new Error("Asset subtraction would be negative");
  }

  return createAssetAmount(left.asset, left.raw - right.raw);
}

function addAssetAmounts(first: AssetAmount, ...rest: readonly AssetAmount[]): AssetAmount {
  return rest.reduce((sum, amount) => {
    assertSameAsset(sum, amount);
    return createAssetAmount(sum.asset, sum.raw + amount.raw);
  }, first);
}

function assertSameAsset(left: AssetAmount, right: AssetAmount): void {
  if (left.asset.symbol !== right.asset.symbol || left.asset.decimals !== right.asset.decimals) {
    throw new Error(`Asset mismatch: ${left.asset.symbol} != ${right.asset.symbol}`);
  }
}
