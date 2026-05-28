/** Parse `--max-old-space-size=<mb>` from NODE_OPTIONS for memory guard tuning. */
export function parseMaxOldSpaceSizeMb(fallbackMb = 650): number {
  const options = process.env.NODE_OPTIONS ?? "";
  const match = /--max-old-space-size=(\d+)/.exec(options);
  if (match === null) {
    return fallbackMb;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMb;
}

export function memoryLimitsFromNodeHeap(maxHeapMb = parseMaxOldSpaceSizeMb()): {
  readonly warnBytes: number;
  readonly ceilBytes: number;
  readonly rssWarnBytes: number;
} {
  const warnBytes = Math.floor(maxHeapMb * 0.72) * 1024 * 1024;
  const ceilBytes = Math.floor(maxHeapMb * 0.9) * 1024 * 1024;
  const rssWarnBytes = 380 * 1024 * 1024;
  return { warnBytes, ceilBytes, rssWarnBytes };
}
