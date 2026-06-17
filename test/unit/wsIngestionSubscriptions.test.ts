import { afterEach, describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { OracleFeedRegistry } from "../../src/utils/priceOracleCache";
import {
  assertWsIngestionReady,
  buildWsIngestionSubscriptions,
  isResilientWsIngestionEnabled,
} from "../../src/monitors/wsIngestionSubscriptions";

const pool = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as Address;
const feedRegistry = {
  base: {
    "0x4200000000000000000000000000000000000006": { feed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" as Address },
  },
  optimism: {},
  arbitrum: {},
} satisfies OracleFeedRegistry;

describe("wsIngestionSubscriptions", () => {
  afterEach(() => {
    delete process.env.RPC_BUDGET_MODE;
    delete process.env.WS_INGESTION_GRACEFUL;
  });

  it("enables resilient mode from RPC_BUDGET_MODE", () => {
    process.env.RPC_BUDGET_MODE = "true";
    expect(isResilientWsIngestionEnabled()).toBe(true);
  });

  it("builds minimal subscriptions when not resilient", () => {
    const subs = buildWsIngestionSubscriptions({
      chain: "base",
      poolAddress: pool,
      feedRegistry,
      resilient: false,
    });
    expect(subs.map((s) => s.role)).toEqual([
      "pending_pool",
      "flashblock_clock",
      "chainlink",
    ]);
  });

  it("adds confirmed pool logs and newHeads fallbacks when resilient", () => {
    const subs = buildWsIngestionSubscriptions({
      chain: "base",
      poolAddress: pool,
      feedRegistry,
      resilient: true,
    });
    expect(subs.map((s) => s.role)).toEqual([
      "pending_pool",
      "confirmed_pool",
      "block_clock",
      "flashblock_clock",
      "chainlink",
    ]);
  });

  it("requires ingestion and clock roles", () => {
    expect(() => assertWsIngestionReady([])).toThrow(/pendingLogs or confirmed pool logs/);
    expect(() => assertWsIngestionReady(["pending_pool"])).toThrow(/newFlashblocks or newHeads/);
    expect(() =>
      assertWsIngestionReady(["confirmed_pool", "block_clock"]),
    ).not.toThrow();
    expect(() =>
      assertWsIngestionReady(["pending_pool", "flashblock_clock"]),
    ).not.toThrow();
  });
});
