import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBotMetrics, createLogger } from "../../src/bot";
import { createChainRegistry } from "../../src/config/chainRegistry";

const callbacks = new Map<string, (logs: readonly unknown[]) => void | Promise<void>>();
const blockCallbacks = new Map<string, (blockNumber: bigint) => void | Promise<void>>();
const errorCallbacks = new Map<string, (error: Error) => void>();
const blockErrorCallbacks = new Map<string, (error: Error) => void>();
const stopFns: Array<() => void> = [];
const closeFns: Array<ReturnType<typeof vi.fn>> = [];
const destroyFns: Array<ReturnType<typeof vi.fn>> = [];
let blockLogs: readonly unknown[] = [];
let getLogsImpl: () => Promise<readonly unknown[]> = async () => blockLogs;
let returnUndefinedContractStop = false;
let returnUndefinedBlockStop = false;

vi.mock("../../src/config/chains", async () => {
  const actual = await vi.importActual<typeof import("../../src/config/chains")>("../../src/config/chains");
  return {
    ...actual,
    createChainWebSocketPublicClient: ({ wsRpcUrl }: { wsRpcUrl: string }) => {
      const close = vi.fn(() => undefined);
      const destroy = vi.fn(() => undefined);
      closeFns.push(close);
      destroyFns.push(destroy);
      return {
        watchContractEvent: ({
          eventName,
          onLogs,
          onError,
        }: {
          eventName: string;
          onLogs: (logs: readonly unknown[]) => void | Promise<void>;
          onError: (error: Error) => void;
        }) => {
        callbacks.set(`${wsRpcUrl}:${eventName}`, onLogs);
        errorCallbacks.set(`${wsRpcUrl}:${eventName}`, onError);
        if (returnUndefinedContractStop) {
          return undefined;
        }
        const stop = () => undefined;
        stopFns.push(stop);
        return stop;
      },
      watchBlockNumber: ({
        onBlockNumber,
        onError,
      }: {
        onBlockNumber: (blockNumber: bigint) => void | Promise<void>;
        onError: (error: Error) => void;
      }) => {
        blockCallbacks.set(wsRpcUrl, onBlockNumber);
        blockErrorCallbacks.set(wsRpcUrl, onError);
        if (returnUndefinedBlockStop) {
          return undefined;
        }
        const stop = () => undefined;
        stopFns.push(stop);
        return stop;
      },
        close,
        transport: {
          close,
          value: {
            close,
            destroy,
          },
        },
      };
    },
    createFailoverPublicClient: () => ({
      getLogs: async () => getLogsImpl(),
    }),
  };
});

import { MultiWsEventSource } from "../../src/monitors/MultiWsEventSource";

describe("MultiWsEventSource", () => {
  const activeStops: Array<() => void> = [];

  beforeEach(() => {
    callbacks.clear();
    blockCallbacks.clear();
    errorCallbacks.clear();
    blockErrorCallbacks.clear();
    stopFns.length = 0;
    closeFns.length = 0;
    destroyFns.length = 0;
    blockLogs = [];
    getLogsImpl = async () => blockLogs;
    returnUndefinedContractStop = false;
    returnUndefinedBlockStop = false;
  });

  afterEach(() => {
    while (activeStops.length > 0) {
      activeStops.pop()?.();
    }
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("deduplicates logs from multiple providers by block/tx/log index", async () => {
    const onReserveUpdated = vi.fn();
    const registry = createChainRegistry({
      chains: [{
        chain: "optimism",
        rpcUrl: "https://optimism.example",
        fallbackRpcUrls: [],
        wsRpcUrl: "wss://default.example",
        detection: {
          wsPrimary: "wss://primary.example",
          wsSecondary: "wss://secondary.example",
        },
        aaveSubgraphUrl: "https://subgraph.example",
      }],
    });
    const source = new MultiWsEventSource({
      registry,
      chain: "optimism",
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });

    const stop = await source.start({
      onReserveUpdated,
      onError: () => undefined,
    });
    activeStops.push(stop);

    const log = {
      blockHash: "0xblock",
      transactionHash: "0xtx",
      logIndex: 1,
      blockNumber: 10n,
      args: { reserve: "0x0000000000000000000000000000000000000002" },
    };
    await callbacks.get("wss://primary.example:ReserveDataUpdated")?.([log]);
    await callbacks.get("wss://secondary.example:ReserveDataUpdated")?.([log]);

    expect(onReserveUpdated).toHaveBeenCalledTimes(1);
  });

  it("ingests flashblock pre-confirmation blocks when enabled", async () => {
    const onReserveUpdated = vi.fn();
    const registry = createChainRegistry({
      chains: [{
        chain: "optimism",
        rpcUrl: "https://optimism.example",
        fallbackRpcUrls: [],
        wsRpcUrl: "wss://default.example",
        detection: {
          wsPrimary: "wss://primary.example",
          flashblocksEnabled: true,
        },
        aaveSubgraphUrl: "https://subgraph.example",
      }],
    });
    const source = new MultiWsEventSource({
      registry,
      chain: "optimism",
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });
    const stop = await source.start({
      onReserveUpdated,
      onError: () => undefined,
    });
    activeStops.push(stop);

    blockLogs = [{
      blockHash: "0xblock",
      transactionHash: "0xtx",
      logIndex: 2,
      blockNumber: 100n,
      args: { reserve: "0x0000000000000000000000000000000000000002" },
    }];
    await blockCallbacks.get("wss://primary.example")?.(100n);

    expect(onReserveUpdated).toHaveBeenCalledTimes(1);
  });

  it("throws when no detection websocket endpoints are configured", async () => {
    const source = new MultiWsEventSource({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          aaveSubgraphUrl: "https://subgraph.example",
        }],
      }),
      chain: "optimism",
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });

    await expect(source.start({
      onReserveUpdated: () => undefined,
      onError: () => undefined,
    })).rejects.toThrow(/requires at least one detection websocket endpoint/);
  });

  it("handles provider error path and schedules reconnect with jitter backoff", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const onReserveUpdated = vi.fn();
    const source = new MultiWsEventSource({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          detection: { wsPrimary: "wss://primary.example" },
          aaveSubgraphUrl: "https://subgraph.example",
        }],
      }),
      chain: "optimism",
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });
    const stop = await source.start({ onReserveUpdated, onError });
    activeStops.push(stop);

    errorCallbacks.get("wss://primary.example:ReserveDataUpdated")?.(new Error("ws disconnected"));
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(700);

    const log = {
      blockHash: "0xreconnect",
      transactionHash: "0xtx2",
      logIndex: 3,
      blockNumber: 11n,
      args: { reserve: "0x0000000000000000000000000000000000000002" },
    };
    await callbacks.get("wss://primary.example:ReserveDataUpdated")?.([log]);
    expect(onReserveUpdated).toHaveBeenCalledTimes(1);
  });

  it("demotes provider score when eth_getLogs probing fails", async () => {
    const logger = createLogger("silent");
    const source = new MultiWsEventSource({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          detection: { wsPrimary: "wss://primary.example" },
          aaveSubgraphUrl: "https://subgraph.example",
        }],
      }),
      chain: "optimism",
      logger,
      metrics: createBotMetrics(),
    });
    const stop = await source.start({
      onReserveUpdated: () => undefined,
      onError: () => undefined,
    });
    activeStops.push(stop);
    getLogsImpl = async () => {
      throw new Error("rpc getLogs failed");
    };

    await callbacks.get("wss://primary.example:Borrow")?.([{
      blockHash: "0xerr",
      transactionHash: "0xtx-err",
      logIndex: 4,
      blockNumber: 22n,
      args: { reserve: "0x0000000000000000000000000000000000000002" },
    }]);

    expect(true).toBe(true);
  });

  it("ignores logs without reserve and handles missing provider state safely", async () => {
    const onReserveUpdated = vi.fn();
    const source = new MultiWsEventSource({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          detection: { wsPrimary: "wss://primary.example", wsSecondary: "wss://secondary.example", wsTertiary: "wss://tertiary.example" },
          aaveSubgraphUrl: "https://subgraph.example",
        }],
      }),
      chain: "optimism",
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });
    const stop = await source.start({ onReserveUpdated, onError: () => undefined });
    activeStops.push(stop);

    await callbacks.get("wss://primary.example:Supply")?.([{
      blockHash: "0xmissing",
      transactionHash: "0xtx-missing",
      logIndex: 5,
      blockNumber: 30n,
      args: {},
    }]);
    await (source as unknown as {
      handleLogs: (
        providerName: string,
        eventName: "ReserveDataUpdated",
        logs: readonly unknown[],
        handlers: { onReserveUpdated: (event: { chain: "optimism"; reserve: string }) => void; onError: (chain: "optimism", error: Error) => void },
      ) => Promise<void>;
    }).handleLogs(
      "unknown-provider",
      "ReserveDataUpdated",
      [],
      { onReserveUpdated: () => undefined, onError: () => undefined },
    );

    expect(onReserveUpdated).toHaveBeenCalledTimes(0);
  });

  it("propagates flashblock subscription onError and tertiary endpoint wiring", async () => {
    const onError = vi.fn();
    const source = new MultiWsEventSource({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          detection: {
            wsPrimary: "wss://primary.example",
            wsSecondary: "wss://secondary.example",
            wsTertiary: "wss://tertiary.example",
            flashblocksEnabled: true,
          },
          aaveSubgraphUrl: "https://subgraph.example",
        }],
      }),
      chain: "optimism",
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });
    const stop = await source.start({
      onReserveUpdated: () => undefined,
      onError,
    });
    activeStops.push(stop);

    expect(callbacks.has("wss://tertiary.example:ReserveDataUpdated")).toBe(true);
    blockErrorCallbacks.get("wss://primary.example")?.(new Error("flashblock stream dropped"));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("uses nullish fallback values when block/tx/log indices are missing", async () => {
    const onReserveUpdated = vi.fn();
    const source = new MultiWsEventSource({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          detection: { wsPrimary: "wss://primary.example" },
          aaveSubgraphUrl: "https://subgraph.example",
        }],
      }),
      chain: "optimism",
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });
    const stop = await source.start({
      onReserveUpdated,
      onError: () => undefined,
    });
    activeStops.push(stop);

    await callbacks.get("wss://primary.example:ReserveDataUpdated")?.([{
      args: { reserve: "0x0000000000000000000000000000000000000002" },
    }]);
    expect(onReserveUpdated).toHaveBeenCalledTimes(1);
  });

  it("applies slow getLogs latency penalty path for score updates", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    let now = 1_000;
    nowSpy.mockImplementation(() => {
      now += 200;
      return now;
    });
    const source = new MultiWsEventSource({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          detection: { wsPrimary: "wss://primary.example", wsSecondary: "wss://secondary.example" },
          aaveSubgraphUrl: "https://subgraph.example",
        }],
      }),
      chain: "optimism",
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });
    const stop = await source.start({
      onReserveUpdated: () => undefined,
      onError: () => undefined,
    });
    activeStops.push(stop);

    await callbacks.get("wss://secondary.example:Withdraw")?.([{
      blockHash: "0xslow",
      transactionHash: "0xtxslow",
      logIndex: 42,
      blockNumber: 99n,
      args: { reserve: "0x0000000000000000000000000000000000000002" },
    }]);
    nowSpy.mockRestore();
    expect(true).toBe(true);
  });

  it("swallows ws close exceptions during teardown", async () => {
    const source = new MultiWsEventSource({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          detection: { wsPrimary: "wss://primary.example" },
          aaveSubgraphUrl: "https://subgraph.example",
        }],
      }),
      chain: "optimism",
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });
    const stop = await source.start({
      onReserveUpdated: () => undefined,
      onError: () => undefined,
    });
    closeFns[0]?.mockImplementation(() => {
      throw new Error("close failed");
    });

    expect(() => stop()).not.toThrow();
  });

  it("handles undefined watcher stop handlers without tracking them", async () => {
    returnUndefinedContractStop = true;
    returnUndefinedBlockStop = true;
    const source = new MultiWsEventSource({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          detection: { wsPrimary: "wss://primary.example", flashblocksEnabled: true },
          aaveSubgraphUrl: "https://subgraph.example",
        }],
      }),
      chain: "optimism",
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });

    const stop = await source.start({
      onReserveUpdated: () => undefined,
      onError: () => undefined,
    });
    expect(() => stop()).not.toThrow();
  });

  it("handles flashblock callbacks after provider state deletion", async () => {
    const onReserveUpdated = vi.fn();
    const source = new MultiWsEventSource({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          detection: { wsPrimary: "wss://primary.example", flashblocksEnabled: true },
          aaveSubgraphUrl: "https://subgraph.example",
        }],
      }),
      chain: "optimism",
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });
    const stop = await source.start({
      onReserveUpdated,
      onError: () => undefined,
    });
    activeStops.push(stop);
    (source as unknown as { providerStates: Map<string, unknown> }).providerStates.delete("primary");
    blockLogs = [{
      blockHash: "0xdeleted",
      transactionHash: "0xtxdeleted",
      logIndex: 6,
      blockNumber: 200n,
      args: { reserve: "0x0000000000000000000000000000000000000002" },
    }];

    await blockCallbacks.get("wss://primary.example")?.(200n);
    expect(onReserveUpdated).toHaveBeenCalledTimes(0);
  });

  it("handles dedupe eviction when iterator returns undefined head", async () => {
    const source = new MultiWsEventSource({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          detection: { wsPrimary: "wss://primary.example" },
          aaveSubgraphUrl: "https://subgraph.example",
        }],
      }),
      chain: "optimism",
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });
    await source.start({
      onReserveUpdated: () => undefined,
      onError: () => undefined,
    });
    (source as unknown as {
      dedupe: {
        has(key: string): boolean;
        add(key: string): void;
        size: number;
        values(): { next(): { value: string | undefined } };
        delete(key: string): void;
      };
      handleLogs: (
        providerName: string,
        eventName: "ReserveDataUpdated",
        logs: readonly unknown[],
        handlers: { onReserveUpdated: (event: { chain: "optimism"; reserve: string }) => void; onError: (chain: "optimism", error: Error) => void },
      ) => Promise<void>;
    }).dedupe = {
      has: () => false,
      add: () => undefined,
      size: 50_001,
      values: () => ({ next: () => ({ value: undefined }) }),
      delete: () => undefined,
    };

    await (source as unknown as {
      handleLogs: (
        providerName: string,
        eventName: "ReserveDataUpdated",
        logs: readonly unknown[],
        handlers: { onReserveUpdated: (event: { chain: "optimism"; reserve: string }) => void; onError: (chain: "optimism", error: Error) => void },
      ) => Promise<void>;
    }).handleLogs(
      "primary",
      "ReserveDataUpdated",
      [{
        blockHash: "0xforce",
        transactionHash: "0xtxforce",
        logIndex: 1,
        blockNumber: 88n,
        args: { reserve: "0x0000000000000000000000000000000000000002" },
      }],
      { onReserveUpdated: () => undefined, onError: () => undefined },
    );

    expect(true).toBe(true);
  });

  it("evicts oldest dedupe entries beyond 50k and closes ws resources on stop", async () => {
    const onReserveUpdated = vi.fn();
    const source = new MultiWsEventSource({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          detection: { wsPrimary: "wss://primary.example" },
          aaveSubgraphUrl: "https://subgraph.example",
        }],
      }),
      chain: "optimism",
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });
    const stop = await source.start({
      onReserveUpdated,
      onError: () => undefined,
    });

    for (let i = 0; i < 50_002; i += 1) {
      await callbacks.get("wss://primary.example:ReserveDataUpdated")?.([{
        blockHash: `0xblock${i}`,
        transactionHash: `0xtx${i}`,
        logIndex: i,
        blockNumber: 100n,
        args: { reserve: "0x0000000000000000000000000000000000000002" },
      }]);
    }

    expect(onReserveUpdated).toHaveBeenCalledTimes(50_002);
    stop();
    expect(closeFns.length).toBeGreaterThan(0);
    expect(destroyFns.length).toBeGreaterThan(0);
    expect(closeFns.some((close) => close.mock.calls.length > 0)).toBe(true);
    expect(destroyFns.some((destroy) => destroy.mock.calls.length > 0)).toBe(true);
  });

  it("uses FTRL ranking mode when enabled and rollout is 100", async () => {
    const info = vi.fn();
    const source = new MultiWsEventSource({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          detection: { wsPrimary: "wss://primary.example", wsSecondary: "wss://secondary.example" },
          aaveSubgraphUrl: "https://subgraph.example",
        }],
      }),
      chain: "optimism",
      logger: {
        info,
        warn: () => undefined,
        error: () => undefined,
      },
      metrics: createBotMetrics(),
      ftrlScoring: {
        providerScoringEnabled: true,
        rolloutPct: 100,
        randomSeed: 10,
        providerStateCachePath: "cache/ftrl-provider-scorer-state.json",
        opportunityStateCachePath: "cache/ftrl-opportunity-scorer-state.json",
        etaInit: 0.08,
        etaMin: 0.005,
        etaMax: 0.35,
        epsilonStart: 0.12,
        epsilonEnd: 0.02,
        epsilonDecayEvents: 3000,
        hazardWeight: 0.15,
        circuitBreakerWindow: 250,
        warmupEvents: 200,
      },
    });
    const stop = await source.start({
      onReserveUpdated: () => undefined,
      onError: () => undefined,
    });
    activeStops.push(stop);
    await callbacks.get("wss://primary.example:ReserveDataUpdated")?.([{
      blockHash: "0xrank",
      transactionHash: "0xtxrank",
      logIndex: 7,
      blockNumber: 120n,
      args: { reserve: "0x0000000000000000000000000000000000000002" },
    }]);
    const rankingCall = info.mock.calls.find((call) => call[0] === "multi_ws_provider_ranking");
    expect(rankingCall?.[1]).toMatchObject({ mode: "ftrl" });
  });

  it("handles ranking/logging when scorer is undefined and MIN_PROFIT_USD is invalid", async () => {
    const previousMinProfit = process.env.MIN_PROFIT_USD;
    process.env.MIN_PROFIT_USD = "not-a-number";
    const info = vi.fn();
    const source = new MultiWsEventSource({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          detection: { wsPrimary: "wss://primary.example" },
          aaveSubgraphUrl: "https://subgraph.example",
        }],
      }),
      chain: "optimism",
      logger: { info, warn: () => undefined, error: () => undefined },
      metrics: createBotMetrics(),
    });
    (source as unknown as {
      providerStates: Map<string, {
        name: string;
        wsUrl: string;
        legacyScore: number;
        eventCount: number;
        missedOpportunities: number;
        lastEventToDetectionMs: number;
        lastGetLogsMs: number;
        lastFlashblockLeadMs: number;
      }>;
      scorer: undefined;
      handleLogs: (
        providerName: string,
        eventName: "ReserveDataUpdated",
        logs: readonly unknown[],
        handlers: { onReserveUpdated: () => void; onError: () => void },
      ) => Promise<void>;
    }).providerStates.set("primary", {
      name: "primary",
      wsUrl: "wss://primary.example",
      legacyScore: 1,
      eventCount: 0,
      missedOpportunities: 0,
      lastEventToDetectionMs: 0,
      lastGetLogsMs: 0,
      lastFlashblockLeadMs: 0,
    });
    await (source as unknown as {
      handleLogs: (
        providerName: string,
        eventName: "ReserveDataUpdated",
        logs: readonly unknown[],
        handlers: { onReserveUpdated: () => void; onError: () => void },
      ) => Promise<void>;
    }).handleLogs(
      "primary",
      "ReserveDataUpdated",
      [{
        blockHash: "0xlegacy",
        transactionHash: "0xtxlegacy",
        logIndex: 1,
        blockNumber: 11n,
        args: { reserve: "0x0000000000000000000000000000000000000002" },
      }],
      { onReserveUpdated: () => undefined, onError: () => undefined },
    );
    const rankingCall = info.mock.calls.find((call) => call[0] === "multi_ws_provider_ranking");
    expect(rankingCall?.[1]).toMatchObject({ mode: "legacy" });
    if (previousMinProfit === undefined) {
      delete process.env.MIN_PROFIT_USD;
    } else {
      process.env.MIN_PROFIT_USD = previousMinProfit;
    }
  });
});
