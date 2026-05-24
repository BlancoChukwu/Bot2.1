import v8 from "node:v8";
import path from "node:path";
import type { LoggerLike } from "../bot";

export interface HeapSnapshotHarnessConfig {
  readonly logger: LoggerLike;
  readonly outputDir?: string;
  readonly schedulesMs?: readonly number[];
  readonly labels?: readonly string[];
}

/**
 * Optional dev harness — enable with ENABLE_HEAP_SNAPSHOTS=true (disable in production).
 */
export function scheduleHeapSnapshots(config: HeapSnapshotHarnessConfig): void {
  const outputDir = config.outputDir ?? path.join(process.cwd(), ".runtime");
  const schedules = config.schedulesMs ?? [5 * 60_000, 35 * 60_000];
  const labels = config.labels ?? ["t5", "t35"];

  for (let i = 0; i < schedules.length; i += 1) {
    const delayMs = schedules[i]!;
    const label = labels[i] ?? `t${i}`;
    const timer = setTimeout(() => {
      const file = path.join(outputDir, `heap-${label}-${Date.now()}.heapsnapshot`);
      v8.writeHeapSnapshot(file);
      config.logger.info("heap_snapshot_written", { file, label, delayMs });
    }, delayMs);
    timer.unref?.();
  }
}
