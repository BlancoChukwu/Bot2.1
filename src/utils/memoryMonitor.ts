import type { LoggerLike } from "../bot";

const defaultWarnBytes = 3.5 * 1024 ** 3;
const defaultCeilBytes = 3.8 * 1024 ** 3;
const defaultIntervalMs = 60_000;

export interface MemoryMonitorConfig {
  readonly logger: LoggerLike;
  readonly warnBytes?: number;
  readonly ceilBytes?: number;
  readonly intervalMs?: number;
  readonly onCeilingHit?: () => void;
}

export interface MemoryMonitorHandle {
  stop(): void;
}

export function startMemoryMonitor(config: MemoryMonitorConfig): MemoryMonitorHandle {
  const warnBytes = config.warnBytes ?? defaultWarnBytes;
  const ceilBytes = config.ceilBytes ?? defaultCeilBytes;
  const intervalMs = config.intervalMs ?? defaultIntervalMs;

  const timer = setInterval(() => {
    const { heapUsed, heapTotal, rss } = process.memoryUsage();
    config.logger.info("memory_stats", {
      heapUsedMb: Math.round(heapUsed / 1e6),
      heapTotalMb: Math.round(heapTotal / 1e6),
      rssMb: Math.round(rss / 1e6),
    });
    if (heapUsed > warnBytes) {
      config.logger.warn("memory_warning", { heapUsedMb: Math.round(heapUsed / 1e6) });
    }
    if (heapUsed > ceilBytes) {
      config.logger.error("memory_ceiling_hit", {
        heapUsedMb: Math.round(heapUsed / 1e6),
        action: "graceful_restart",
      });
      config.onCeilingHit?.();
      process.exit(0);
    }
  }, intervalMs);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
