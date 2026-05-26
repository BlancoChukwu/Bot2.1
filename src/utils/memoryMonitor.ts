import type { LoggerLike } from "../bot";

const defaultWarnBytes = 3.5 * 1024 ** 3;
const defaultCeilBytes = 3.8 * 1024 ** 3;
const defaultIntervalMs = 60_000;

export interface MemoryMonitorConfig {
  readonly logger: LoggerLike;
  readonly warnBytes?: number;
  readonly ceilBytes?: number;
  readonly rssWarnBytes?: number;
  readonly intervalMs?: number;
  readonly onRssSample?: (rssBytes: number) => void;
  readonly onCeilingHit?: () => void;
  readonly exitProcess?: (code: number) => never;
}

export interface MemorySampleResult {
  readonly heapUsedMb: number;
  readonly heapTotalMb: number;
  readonly rssMb: number;
  readonly action?: "warn" | "ceiling";
}

export interface MemoryMonitorHandle {
  stop(): void;
  checkNow(): MemorySampleResult;
}

export function sampleMemoryUsage(config: {
  readonly warnBytes: number;
  readonly ceilBytes: number;
  readonly rssWarnBytes?: number;
}): MemorySampleResult {
  const { heapUsed, heapTotal, rss } = process.memoryUsage();
  const heapUsedMb = Math.round(heapUsed / 1e6);
  const result: MemorySampleResult = {
    heapUsedMb,
    heapTotalMb: Math.round(heapTotal / 1e6),
    rssMb: Math.round(rss / 1e6),
  };
  if (heapUsed > config.ceilBytes) {
    return { ...result, action: "ceiling" };
  }
  if (heapUsed > config.warnBytes) {
    return { ...result, action: "warn" };
  }
  if (config.rssWarnBytes !== undefined && rss > config.rssWarnBytes) {
    return { ...result, action: "warn" };
  }
  return result;
}

function applyMemorySample(
  config: MemoryMonitorConfig,
  warnBytes: number,
  ceilBytes: number,
  rssWarnBytes: number | undefined,
  emitStats: boolean,
): MemorySampleResult {
  const { rss, heapUsed } = process.memoryUsage();
  const sample = sampleMemoryUsage({
    warnBytes,
    ceilBytes,
    ...(rssWarnBytes === undefined ? {} : { rssWarnBytes }),
  });
  config.onRssSample?.(rss);
  if (emitStats) {
    config.logger.info("memory_stats", {
      heapUsedMb: sample.heapUsedMb,
      heapTotalMb: sample.heapTotalMb,
      rssMb: sample.rssMb,
    });
  }
  if (rssWarnBytes !== undefined && rss > rssWarnBytes && heapUsed <= warnBytes) {
    config.logger.warn("memory_high_rss_warning", {
      rssMb: sample.rssMb,
      rssWarnMb: Math.round(rssWarnBytes / 1e6),
    });
  }
  if (sample.action === "warn" || sample.action === "ceiling") {
    const level = sample.action === "ceiling" ? "error" : "warn";
    const message = sample.action === "ceiling" ? "memory_ceiling_hit" : "memory_warning";
    config.logger[level](message, {
      heapUsedMb: sample.heapUsedMb,
      rssMb: sample.rssMb,
      ...(sample.action === "ceiling" ? { action: "graceful_restart" } : {}),
    });
  }
  if (sample.action === "ceiling") {
    config.onCeilingHit?.();
    const exit = config.exitProcess ?? ((code: number) => process.exit(code));
    exit(0);
  }
  return sample;
}

export function startMemoryMonitor(config: MemoryMonitorConfig): MemoryMonitorHandle {
  const warnBytes = config.warnBytes ?? defaultWarnBytes;
  const ceilBytes = config.ceilBytes ?? defaultCeilBytes;
  const rssWarnBytes = config.rssWarnBytes;
  const intervalMs = config.intervalMs ?? defaultIntervalMs;

  const timer = setInterval(() => {
    applyMemorySample(config, warnBytes, ceilBytes, rssWarnBytes, true);
  }, intervalMs);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
    checkNow() {
      return applyMemorySample(config, warnBytes, ceilBytes, rssWarnBytes, false);
    },
  };
}
