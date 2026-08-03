import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/bot";
import { WsEventLayer } from "../../src/monitors/wsEventLayer";

type WsClientConfig = {
  onConnect?: () => void;
  onDisconnect?: () => void;
};

let lastWsClientConfig: WsClientConfig | undefined;

vi.mock("../../src/monitors/flashblocksWsClient", () => ({
  FlashblocksWsClient: vi.fn(function FlashblocksWsClient(this: unknown, config: WsClientConfig) {
    lastWsClientConfig = config;
    return {
      start: async () => {
        config.onConnect?.();
        return {
          active: 1,
          skipped: 0,
          activeRoles: ["logs", "newHeads", "newFlashblocks"],
        };
      },
      stop: () => undefined,
      getActiveSubscriptionCount: () => 1,
    };
  }),
}));

vi.mock("../../src/monitors/wsIngestionSubscriptions", () => ({
  isResilientWsIngestionEnabled: () => true,
  buildWsIngestionSubscriptions: () => [],
  assertWsIngestionReady: () => undefined,
}));

describe("WsEventLayer reconnect observability", () => {
  beforeEach(() => {
    lastWsClientConfig = undefined;
  });

  it("logs reconnect and notifies onWsReconnected after disconnect", async () => {
    const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const logger = createLogger("silent");
    logger.info = (msg: string, meta?: Record<string, unknown>) => {
      if (meta === undefined) {
        logs.push({ msg });
      } else {
        logs.push({ msg, meta });
      }
    };
    logger.warn = (msg: string, meta?: Record<string, unknown>) => {
      if (meta === undefined) {
        logs.push({ msg });
      } else {
        logs.push({ msg, meta });
      }
    };

    const reconnects: Array<{ downtimeMs: number | undefined }> = [];
    const layer = new WsEventLayer({
      chain: "base",
      poolAddress: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
      ingestionWsUrl: "wss://example.invalid",
      executionClient: {
        getBlockNumber: async () => 100n,
        getLogs: async () => [],
      } as never,
      feedRegistry: { optimism: {}, arbitrum: {}, base: {} },
      checkpoint: {
        loadLastProcessedBlock: async () => 100n,
        saveLastProcessedBlock: async () => undefined,
        close: async () => undefined,
      } as never,
      logger,
      onEvent: () => undefined,
      onFlashblockTick: () => undefined,
      onWsReconnected: (meta) => reconnects.push(meta),
    });

    await layer.start();
    expect(lastWsClientConfig).toBeDefined();

    lastWsClientConfig?.onDisconnect?.();
    lastWsClientConfig?.onConnect?.();

    expect(logs.some((row) => row.msg === "ws_event_layer_disconnected")).toBe(true);
    expect(logs.some((row) => row.msg === "ws_event_layer_reconnected")).toBe(true);
    expect(reconnects).toHaveLength(1);
    expect(reconnects[0]?.downtimeMs).toBeGreaterThanOrEqual(0);
  });
});
