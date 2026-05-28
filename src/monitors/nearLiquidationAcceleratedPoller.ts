import type { Address, PublicClient } from "viem";
import type { LoggerLike } from "../bot";
import type { SupportedChain } from "../config/chains";
import { aavePoolAbi } from "../protocols/aaveV3";
import {
  linearRegressionHf,
  projectHfBlocksAhead,
  type HfRegressionSample,
} from "../utils/hfLinearRegression";

const WAD = 1_000_000_000_000_000_000n;
const NEAR_LIQ_HF_WAD = 1_050_000_000_000_000_000n;
const MIN_DEBT_BASE_USD = 1_000n * 10n ** 8n;
const DEFAULT_POLL_MS = 200;
const MAX_SAMPLES = 10;
const PROJECT_BLOCKS = 10;
const DUST_HOTPATH_ACCOUNT = "0xc4d36f950cdb76dbc83717087775ff3303c6eeb7".toLowerCase();

export interface NearLiquidationAcceleratedPollerConfig {
  readonly chain: SupportedChain;
  readonly poolAddress: Address;
  readonly client: PublicClient;
  readonly logger: LoggerLike;
  readonly pollIntervalMs?: number;
  readonly resolveGasCostUsd: () => Promise<number>;
  readonly liquidationBonusBps?: number;
  readonly onUrgentAccounts: (accounts: readonly Address[], meta: NearLiqUrgentMeta) => void | Promise<void>;
}

export interface NearLiqUrgentMeta {
  readonly account: Address;
  readonly healthFactor: number;
  readonly slopePerMs: number;
  readonly rSquared: number;
  readonly projectedHf10Blocks: number;
}

interface AccountTrack {
  readonly samples: HfRegressionSample[];
  lastDebtBase: bigint;
  deprioritized: boolean;
}

/**
 * Fast HF poller for accounts with HF < 1.05 and debt > $1k (8-decimal base units).
 */
export class NearLiquidationAcceleratedPoller {
  private timer: NodeJS.Timeout | undefined;
  private readonly tracks = new Map<string, AccountTrack>();
  private readonly accounts = new Set<string>();

  public constructor(private readonly config: NearLiquidationAcceleratedPollerConfig) {}

  public setAccounts(accounts: readonly Address[]): void {
    this.accounts.clear();
    for (const account of accounts) {
      this.accounts.add(account.toLowerCase());
    }
  }

  public start(): void {
    if (this.timer !== undefined) {
      return;
    }
    const pollMs = this.config.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.timer = setInterval(() => {
      void this.poll().catch((error) => {
        this.config.logger.warn("near_liq_accelerated_poll_failed", {
          chain: this.config.chain,
          error: String(error),
        });
      });
    }, pollMs);
    this.timer.unref?.();
    this.config.logger.info("near_liq_accelerated_poller_started", {
      chain: this.config.chain,
      pollMs,
      trackedAccounts: this.accounts.size,
    });
  }

  public stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.tracks.clear();
  }

  private async poll(): Promise<void> {
    if (this.accounts.size === 0) {
      return;
    }
    const gasCostUsd = await this.config.resolveGasCostUsd();
    const bonusBps = this.config.liquidationBonusBps ?? 500;
    for (const accountLower of this.accounts) {
      const account = accountLower as Address;
      let data: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
      try {
        data = await this.config.client.readContract({
          address: this.config.poolAddress,
          abi: aavePoolAbi,
          functionName: "getUserAccountData",
          args: [account],
        }) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
      } catch {
        continue;
      }
      const debtBase = data[1];
      const hfWad = data[5];
      if (debtBase < MIN_DEBT_BASE_USD || hfWad >= NEAR_LIQ_HF_WAD) {
        this.tracks.delete(accountLower);
        continue;
      }
      const hf = Number(hfWad) / Number(WAD);
      const debtUsd = Number(debtBase) / 1e8;
      if (this.isDeprioritizedDust(accountLower, debtUsd, bonusBps, gasCostUsd)) {
        const track = this.tracks.get(accountLower) ?? { samples: [], lastDebtBase: debtBase, deprioritized: true };
        this.tracks.set(accountLower, { ...track, deprioritized: true, lastDebtBase: debtBase });
        continue;
      }

      const now = Date.now();
      const track = this.tracks.get(accountLower) ?? { samples: [], lastDebtBase: debtBase, deprioritized: false };
      const samples = [...track.samples, { atMs: now, healthFactor: hf }].slice(-MAX_SAMPLES);
      this.tracks.set(accountLower, { ...track, samples, lastDebtBase: debtBase, deprioritized: false });

      const regression = linearRegressionHf(samples);
      if (regression === undefined) {
        continue;
      }
      const last = samples[samples.length - 1]!;
      const projected = projectHfBlocksAhead(regression, last, PROJECT_BLOCKS);
      this.config.logger.info("near_liq_hf_trend", {
        chain: this.config.chain,
        account,
        healthFactor: hf,
        debtUsd,
        slopePerMs: regression.slopePerMs,
        rSquared: regression.rSquared,
        projectedHf10Blocks: projected,
        sampleCount: samples.length,
      });
      if (regression.slopePerMs < 0 && projected < 1) {
        await this.config.onUrgentAccounts([account], {
          account,
          healthFactor: hf,
          slopePerMs: regression.slopePerMs,
          rSquared: regression.rSquared,
          projectedHf10Blocks: projected,
        });
      }
    }
  }

  private isDeprioritizedDust(
    accountLower: string,
    debtUsd: number,
    bonusBps: number,
    gasCostUsd: number,
  ): boolean {
    if (accountLower !== DUST_HOTPATH_ACCOUNT) {
      return false;
    }
    const grossUsd = debtUsd * (bonusBps / 10_000);
    return grossUsd < gasCostUsd * 1.1;
  }
}
