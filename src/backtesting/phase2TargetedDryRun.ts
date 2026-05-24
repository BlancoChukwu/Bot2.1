import type { Address } from "viem";
import type { LoggerLike, BotMetrics } from "../bot";
import type { SupportedChain } from "../config/chains";
import { getChainConfig } from "../config/chains";
import type { OracleFeedRegistry } from "../utils/priceOracleCache";
import { buildLiquidationExecutionRequest } from "../executors/liquidationExecutionAdapter";
import { SafeTransactionExecutor } from "../executors/safeTransactionExecutor";
import { ViemExecutionClient, type ViemExecutionClientConfig } from "../executors/viemExecutionClient";
import { LocalNonceManager } from "../executors/nonceManager";
import { FlashLoanProviderRouter } from "../profitability/flashLoanProviderRouter";
import { LiquidationCandidateGate } from "../orchestrator/liquidationCandidateGate";
import { BorrowerCooldownRegistry } from "../utils/borrowerCooldown";
import { PriceOracleCache, canonicalBaseAaveOracleAddress } from "../utils/priceOracleCache";
import { createAsset, createAssetAmount } from "../utils/typedAssetMath";
import type { AaveV3Protocol, LiquidationCandidate } from "../protocols/aaveV3";
import { aavePoolAbi } from "../protocols/aaveV3";
import { phase2DustBorrowerAccounts } from "../constants/phase2DustBorrowers";
import { createChainRegistry } from "../config/chainRegistry";
const liquidationHealthFactor = 1_000_000_000_000_000_000n;

export interface Phase2TargetedDryRunConfig {
  readonly chain: SupportedChain;
  readonly rpcUrl: string;
  readonly fallbackRpcUrls: readonly string[];
  readonly aaveSubgraphUrl: string;
  readonly minLiquidationDebtUsd: number;
  readonly borrowerDeadLetterCooldownMs: number;
  readonly oracleMaxStaleMs: number;
  readonly minProfitUsd: number;
  readonly gasCostUsd: number;
  readonly slippageBps: number;
  readonly minProfitMarginBps: number;
  readonly flashLoanFeeBps: number;
  readonly flashLoanSlippageFloorBps: number;
  readonly liquidationReceiverAddress?: Address;
  readonly priceFeedRegistry?: OracleFeedRegistry;
}

export interface Phase2TargetedDryRunInput {
  readonly config: Phase2TargetedDryRunConfig;
  readonly logger: LoggerLike;
  readonly metrics: BotMetrics;
  readonly protocol: AaveV3Protocol;
  readonly publicClient: ViemExecutionClientConfig["publicClient"] & {
    readContract(args: Record<string, unknown>): Promise<unknown>;
  };
  readonly walletClient: ViemExecutionClientConfig["walletClient"];
  readonly accounts?: readonly Address[];
}

export interface Phase2TargetedDryRunResult {
  readonly accountsChecked: number;
  readonly liquidatableCandidates: number;
  readonly skippedHealthy: number;
  readonly dustFiltered: number;
  readonly passedGate: number;
  readonly flashLoanAttempts: number;
}

export async function runPhase2TargetedDustDryRun(
  input: Phase2TargetedDryRunInput,
): Promise<Phase2TargetedDryRunResult> {
  const accounts = input.accounts ?? phase2DustBorrowerAccounts;
  const chain = input.config.chain;
  const chainConfig = getChainConfig(chain);

  const priceOracle = input.config.priceFeedRegistry === undefined
    ? undefined
    : new PriceOracleCache({
      publicClient: input.publicClient as unknown as {
        readContract(args: Record<string, unknown>): Promise<unknown>;
        multicall(args: Record<string, unknown>): Promise<unknown>;
      },
      chain,
      feedRegistry: input.config.priceFeedRegistry,
      maxStaleMs: input.config.oracleMaxStaleMs,
      ...(chain === "base" ? { aaveOracleAddress: canonicalBaseAaveOracleAddress } : {}),
      logger: input.logger,
      onFreshnessObserved: (observation) => {
        input.metrics.recordOracleFreshnessMs(
          observation.chain,
          observation.token,
          observation.freshnessMs,
          observation.source,
        );
      },
    });

  const resolveGasCostUsd = async (): Promise<number> => {
    if (priceOracle === undefined) {
      return input.config.gasCostUsd;
    }
    const gasPrice = await input.publicClient.getGasPrice();
    const nativeToken = nativeGasTokenForChain(chain);
    const prices = await priceOracle.batchGetUsdPrices([nativeToken]);
    const nativePriceRaw = prices[nativeToken] ?? 0n;
    if (nativePriceRaw <= 0n) {
      return input.config.gasCostUsd;
    }
    const gasCostWei = gasPrice * 500_000n;
    return Number((gasCostWei * nativePriceRaw) / 1_000_000_000_000_000_000n) / 1e8;
  };

  const gate = new LiquidationCandidateGate({
    minDebtUsd: input.config.minLiquidationDebtUsd,
    resolveGasCostUsd,
    resolveFlashFeeBps: async () => input.config.flashLoanFeeBps,
    ...(priceOracle === undefined ? {} : { priceOracle }),
    borrowerCooldown: new BorrowerCooldownRegistry({ cooldownMs: input.config.borrowerDeadLetterCooldownMs }),
    logger: input.logger,
    metrics: input.metrics,
  });

  const { candidates: rawCandidates, skippedHealthy } = await fetchLiquidationCandidates(
    input.protocol,
    accounts,
    input.logger,
  );
  const kept = await gate.filterCandidates(chain, rawCandidates, "phase2_dust_replay");
  const gasCostUsd = await resolveGasCostUsd();

  let flashLoanAttempts = 0;
  if (kept.length > 0) {
    const usd = createAsset({ symbol: "USD", decimals: 8 });
    const registry = createChainRegistry({
      chains: [{
        chain,
        rpcUrl: input.config.rpcUrl,
        fallbackRpcUrls: input.config.fallbackRpcUrls,
        aaveSubgraphUrl: input.config.aaveSubgraphUrl,
        flashLoanProviders: ["aaveV3"],
      }],
    });
    const router = new FlashLoanProviderRouter({
      registry,
      logger: input.logger,
      metrics: input.metrics,
      simulator: {
        simulate: async (simInput) => ({
          success: true as const,
          revenue: createAssetAmount(usd, simInput.revenue.raw),
          gas: createAssetAmount(usd, simInput.gas.raw),
          swapCost: createAssetAmount(usd, simInput.swapCost.raw),
        }),
      },
      providerFees: {},
    });
    const resolvedFlashLoanFeeBps = await readFlashLoanPremiumBps({
      publicClient: input.publicClient,
      pool: chainConfig.aave.pool,
      fallbackBps: input.config.flashLoanFeeBps,
      logger: input.logger,
    });
    const executor = new SafeTransactionExecutor({
      registry,
      router,
      nonceManager: new LocalNonceManager(),
      client: new ViemExecutionClient({ publicClient: input.publicClient, walletClient: input.walletClient }),
      logger: input.logger,
      metrics: input.metrics,
      dryRunMode: true,
    });
    for (const candidate of kept) {
      flashLoanAttempts += 1;
      const request = buildLiquidationExecutionRequest(chain, candidate, {
        account: input.walletClient.account!.address,
        minProfitUsd: input.config.minProfitUsd,
        gasCostUsd,
        slippageBps: input.config.slippageBps,
        minimumMarginBps: input.config.minProfitMarginBps,
        flashFeeBps: resolvedFlashLoanFeeBps,
        slippageBufferFloorBps: input.config.flashLoanSlippageFloorBps,
        requireFlashLoanWrapper: true,
        ...(input.config.liquidationReceiverAddress === undefined
          ? {}
          : { flashLoanReceiverAddress: input.config.liquidationReceiverAddress }),
      });
      await executor.execute(request);
    }
  }

  const dustFiltered = rawCandidates.length - kept.length;
  if (kept.length > 0 || flashLoanAttempts > 0) {
    throw new Error(
      `Phase 2 dust validation failed: ${kept.length} borrower(s) passed gate, ${flashLoanAttempts} flash attempt(s)`,
    );
  }

  input.logger.info("phase2_dust_validation_complete", {
    chain,
    accountsChecked: accounts.length,
    liquidatableCandidates: rawCandidates.length,
    skippedHealthy,
    dustFiltered,
    passedGate: kept.length,
    flashLoanAttempts,
    borrowers: accounts,
  });

  return {
    accountsChecked: accounts.length,
    liquidatableCandidates: rawCandidates.length,
    skippedHealthy,
    dustFiltered,
    passedGate: kept.length,
    flashLoanAttempts,
  };
}

async function fetchLiquidationCandidates(
  protocol: AaveV3Protocol,
  accounts: readonly Address[],
  logger: LoggerLike,
): Promise<{ candidates: LiquidationCandidate[]; skippedHealthy: number }> {
  if (protocol.getUserAccount === undefined || protocol.getBestLiquidationPair === undefined) {
    throw new Error("Protocol must support getUserAccount and getBestLiquidationPair for targeted dry-run");
  }
  const candidates: LiquidationCandidate[] = [];
  let skippedHealthy = 0;
  for (const account of accounts) {
    const userAccount = await protocol.getUserAccount(account);
    if (userAccount.healthFactor >= liquidationHealthFactor) {
      skippedHealthy += 1;
      logger.info("phase2_account_skipped_healthy", {
        account,
        healthFactor: userAccount.healthFactor.toString(),
      });
      continue;
    }
    const pair = await protocol.getBestLiquidationPair(userAccount);
    candidates.push({
      account,
      collateralAsset: pair.collateralAsset,
      debtAsset: pair.debtAsset,
      debtToCover: pair.debtToCover,
      repayValueUsd: pair.repayValueUsd,
      liquidationBonusBps: pair.liquidationBonusBps,
      healthFactor: userAccount.healthFactor,
    });
  }
  return { candidates, skippedHealthy };
}

function nativeGasTokenForChain(chain: SupportedChain): Address {
  if (chain === "arbitrum") {
    return "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
  }
  return "0x4200000000000000000000000000000000000006";
}

async function readFlashLoanPremiumBps(input: {
  readonly publicClient: { readContract(args: Record<string, unknown>): Promise<unknown> };
  readonly pool: Address;
  readonly fallbackBps: number;
  readonly logger: LoggerLike;
}): Promise<number> {
  try {
    const raw = await input.publicClient.readContract({
      address: input.pool,
      abi: aavePoolAbi,
      functionName: "FLASHLOAN_PREMIUM_TOTAL",
      args: [],
    });
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Invalid flash-loan premium value: ${String(raw)}`);
    }
    return parsed;
  } catch (error) {
    input.logger.warn("flash_loan_premium_fallback", { pool: input.pool, fallbackBps: input.fallbackBps, error: String(error) });
    return input.fallbackBps;
  }
}
