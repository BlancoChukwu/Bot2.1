type Env = Record<string, string | undefined>;

function parseMinNumber(value: string | undefined, fallback: number, min: number, name: string): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${name} must be a number greater than or equal to ${min}`);
  }
  return parsed;
}

export function parseTopBorrowerPollIntervalMs(env: Env): number {
  return parseMinNumber(env.TOP_BORROWER_POLL_INTERVAL_MS, 30_000, 1000, "TOP_BORROWER_POLL_INTERVAL_MS");
}
