import { describe, expect, it } from "vitest";
import { GasPriceOracle } from "../../src/utils/gasPriceOracle";

describe("GasPriceOracle", () => {
  it("returns cached gas price within TTL", async () => {
    let now = 1_000;
    let calls = 0;
    const oracle = new GasPriceOracle({
      client: {
        getGasPrice: async () => {
          calls += 1;
          return 10n;
        },
      },
      ttlMs: 30_000,
      nowMs: () => now,
    });

    const first = await oracle.getGasPrice();
    now += 10_000;
    const second = await oracle.getGasPrice();

    expect(first).toBe(10n);
    expect(second).toBe(10n);
    expect(calls).toBe(1);
  });

  it("refreshes gas price after TTL expiration", async () => {
    let now = 1_000;
    let value = 10n;
    const oracle = new GasPriceOracle({
      client: {
        getGasPrice: async () => value,
      },
      ttlMs: 1_000,
      nowMs: () => now,
    });

    const first = await oracle.getGasPrice();
    value = 22n;
    now += 1_500;
    const second = await oracle.getGasPrice();

    expect(first).toBe(10n);
    expect(second).toBe(22n);
  });

  it("deduplicates concurrent refreshes with one in-flight call", async () => {
    let now = 0;
    let calls = 0;
    let resolveCall: (value: bigint) => void = () => undefined;
    const deferred = new Promise<bigint>((resolve) => {
      resolveCall = resolve;
    });
    const oracle = new GasPriceOracle({
      client: {
        getGasPrice: async () => {
          calls += 1;
          return await deferred;
        },
      },
      ttlMs: 1,
      nowMs: () => now,
    });

    const first = oracle.getGasPrice();
    const second = oracle.getGasPrice();
    resolveCall(33n);
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(33n);
    expect(b).toBe(33n);
    expect(calls).toBe(1);
    now += 10;
    expect(await oracle.getGasPrice()).toBe(33n);
  });

  it("falls back to default ttl and clears in-flight after rejection", async () => {
    let attempts = 0;
    const oracle = new GasPriceOracle({
      client: {
        getGasPrice: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("rpc unavailable");
          }
          return 99n;
        },
      },
    });

    await expect(oracle.getGasPrice()).rejects.toThrow("rpc unavailable");
    await expect(oracle.getGasPrice()).resolves.toBe(99n);
    expect(attempts).toBe(2);
  });
});
