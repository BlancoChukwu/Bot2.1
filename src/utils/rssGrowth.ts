/**
 * RSS growth rate with warm-up exclusion.
 * Default: skip first 30 minutes so cache/heap ramp is not treated as a leak.
 */
export function rssGrowthMbPerHour(
  samples: readonly { readonly timeMs: number; readonly rssMb: number }[],
  options: { readonly warmupMs?: number } = {},
): number {
  const warmupMs = options.warmupMs ?? 30 * 60 * 1000;
  if (samples.length < 2) {
    return 0;
  }
  const t0 = samples[0]!.timeMs;
  const steady = samples.filter((s) => (s.timeMs - t0) >= warmupMs);
  const window = steady.length >= 2 ? steady : samples;
  const first = window[0]!;
  const last = window[window.length - 1]!;
  const elapsedHours = (last.timeMs - first.timeMs) / 3_600_000;
  if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) {
    return 0;
  }
  return (last.rssMb - first.rssMb) / elapsedHours;
}

export function rssGrowthMbPerHourFullWindow(
  samples: readonly { readonly timeMs: number; readonly rssMb: number }[],
): number {
  return rssGrowthMbPerHour(samples, { warmupMs: 0 });
}
