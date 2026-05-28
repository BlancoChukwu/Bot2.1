import { mkdirSync } from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import type { LoggerLike } from "../bot";

export interface HeapSnapshotOnSignalConfig {
  readonly logger: LoggerLike;
  readonly signal?: NodeJS.Signals;
  readonly outputDir?: string;
}

export function registerHeapSnapshotOnSignal(config: HeapSnapshotOnSignalConfig): () => void {
  const signal = config.signal ?? "SIGUSR2";
  const outputDir = config.outputDir ?? path.join(process.cwd(), ".runtime");
  mkdirSync(outputDir, { recursive: true });
  const handler = () => {
    try {
      const file = path.join(outputDir, `heap-signal-${Date.now()}.heapsnapshot`);
      v8.writeHeapSnapshot(file);
      config.logger.info("heap_snapshot_signal_written", { signal, file });
    } catch (error) {
      config.logger.error("heap_snapshot_signal_failed", {
        signal,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  process.on(signal, handler);
  return () => {
    process.off(signal, handler);
  };
}
