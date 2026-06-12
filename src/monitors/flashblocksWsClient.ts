import type { Address } from "viem";
import type { LoggerLike } from "../bot";
import { rawLogToViemLog } from "./aaveEventParser";

interface WsClient {
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

function createWsClient(url: string): WsClient {
  const Ctor = globalThis.WebSocket as unknown as new (url: string) => WsClient;
  if (typeof Ctor !== "function") {
    throw new Error("WebSocket is unavailable in this Node runtime");
  }
  return new Ctor(url);
}

export type FlashblocksSubscriptionKind = "pendingLogs" | "logs" | "newFlashblocks";

export interface FlashblocksWsClientConfig {
  readonly wsUrl: string;
  readonly logger: LoggerLike;
  readonly onPendingLog: (log: Record<string, unknown>) => void;
  readonly onConfirmedLog?: (log: Record<string, unknown>) => void;
  readonly onNewFlashblock?: (payload: { readonly blockNumber: bigint; readonly flashblockIndex?: number }) => void;
  readonly onDisconnect?: () => void;
  readonly onConnect?: () => void;
  readonly maxReconnectDelayMs?: number;
}

interface PendingRequest {
  readonly kind: FlashblocksSubscriptionKind;
  readonly resolve: (subscriptionId: string) => void;
  readonly reject: (error: Error) => void;
}

export class FlashblocksWsClient {
  private ws: WsClient | undefined;
  private requestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private reconnectAttempt = 0;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly subscriptions = new Map<string, FlashblocksSubscriptionKind>();

  public constructor(private readonly config: FlashblocksWsClientConfig) {}

  public async start(subscriptions: readonly {
    readonly kind: FlashblocksSubscriptionKind;
    readonly params?: Record<string, unknown>;
  }[]): Promise<void> {
    this.stopped = false;
    await this.connect(subscriptions);
  }

  public stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.ws?.close();
    this.ws = undefined;
  }

  private async connect(
    subscriptions: readonly {
      readonly kind: FlashblocksSubscriptionKind;
      readonly params?: Record<string, unknown>;
    }[],
  ): Promise<void> {
    if (this.stopped) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const ws = createWsClient(this.config.wsUrl);
      this.ws = ws;
      ws.addEventListener("open", () => {
        this.reconnectAttempt = 0;
        this.config.onConnect?.();
        void this.subscribeAll(subscriptions).then(resolve).catch(reject);
      });
      ws.addEventListener("message", (event) => {
        const data = (event as { data?: unknown }).data;
        this.handleMessage(String(data));
      });
      ws.addEventListener("close", () => {
        this.config.onDisconnect?.();
        this.scheduleReconnect(subscriptions);
      });
      ws.addEventListener("error", () => {
        // close handler schedules reconnect
      });
    });
  }

  private scheduleReconnect(
    subscriptions: readonly {
      readonly kind: FlashblocksSubscriptionKind;
      readonly params?: Record<string, unknown>;
    }[],
  ): void {
    if (this.stopped || this.reconnectTimer !== undefined) {
      return;
    }
    const maxDelay = this.config.maxReconnectDelayMs ?? 30_000;
    const delay = Math.min(maxDelay, 250 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect(subscriptions).catch((error) => {
        this.config.logger.warn("flashblocks_ws_reconnect_failed", { error: String(error) });
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async subscribeAll(
    subscriptions: readonly {
      readonly kind: FlashblocksSubscriptionKind;
      readonly params?: Record<string, unknown>;
    }[],
  ): Promise<void> {
    for (const sub of subscriptions) {
      await this.subscribe(sub.kind, sub.params);
    }
  }

  private subscribe(kind: FlashblocksSubscriptionKind, params?: Record<string, unknown>): Promise<string> {
    return new Promise((resolve, reject) => {
      const id = this.requestId;
      this.requestId += 1;
      this.pendingRequests.set(id, { kind, resolve, reject });
      const payload = {
        jsonrpc: "2.0",
        id,
        method: "eth_subscribe",
        params: params === undefined ? [kind] : [kind, params],
      };
      this.ws?.send(JSON.stringify(payload));
    });
  }

  private handleMessage(raw: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof parsed.id === "number" && this.pendingRequests.has(parsed.id)) {
      const pending = this.pendingRequests.get(parsed.id)!;
      this.pendingRequests.delete(parsed.id);
      if (parsed.error !== undefined && parsed.error !== null) {
        pending.reject(new Error(JSON.stringify(parsed.error)));
        return;
      }
      const result = parsed.result;
      if (typeof result === "string") {
        this.subscriptions.set(result, pending.kind);
        pending.resolve(result);
      } else {
        pending.reject(new Error("eth_subscribe returned non-string id"));
      }
      return;
    }
    if (parsed.method !== "eth_subscription") {
      return;
    }
    const params = parsed.params as { readonly subscription?: string; readonly result?: unknown } | undefined;
    const subscriptionId = params?.subscription;
    const kind = subscriptionId === undefined ? undefined : this.subscriptions.get(subscriptionId);
    const result = params?.result;
    if (kind === "newFlashblocks") {
      const blockNumber = extractBlockNumber(result);
      if (blockNumber !== undefined) {
        const payload: { readonly blockNumber: bigint; readonly flashblockIndex?: number } = {
          blockNumber,
        };
        const flashblockIndex = extractFlashblockIndex(result);
        if (flashblockIndex !== undefined) {
          this.config.onNewFlashblock?.({ blockNumber, flashblockIndex });
          return;
        }
        this.config.onNewFlashblock?.(payload);
      }
      return;
    }
    if (kind === "pendingLogs" && result !== undefined && typeof result === "object") {
      this.config.onPendingLog(result as Record<string, unknown>);
      return;
    }
    if (kind === "logs" && result !== undefined && typeof result === "object") {
      this.config.onConfirmedLog?.(result as Record<string, unknown>);
    }
  }
}

function extractBlockNumber(result: unknown): bigint | undefined {
  if (typeof result === "string") {
    return BigInt(result);
  }
  if (result !== null && typeof result === "object") {
    const blockNumber = (result as Record<string, unknown>).blockNumber;
    if (typeof blockNumber === "string") {
      return BigInt(blockNumber);
    }
  }
  return undefined;
}

function extractFlashblockIndex(result: unknown): number | undefined {
  if (result !== null && typeof result === "object") {
    const index = (result as Record<string, unknown>).index ?? (result as Record<string, unknown>).flashblockIndex;
    if (typeof index === "number") {
      return index;
    }
    if (typeof index === "string") {
      return Number.parseInt(index, 10);
    }
  }
  return undefined;
}

export function pendingLogToRaw(log: Record<string, unknown>): ReturnType<typeof rawLogToViemLog> {
  return rawLogToViemLog(log);
}

export function chainlinkLogsFilter(feed: Address): Record<string, unknown> {
  return {
    address: feed,
    topics: [
      "0x0559884fd3a460db3073d7f8961304184bd105c8d1956eed26df2440bf4172f",
    ],
  };
}

export function aavePoolPendingLogsFilter(poolAddress: Address): Record<string, unknown> {
  return { address: poolAddress };
}
