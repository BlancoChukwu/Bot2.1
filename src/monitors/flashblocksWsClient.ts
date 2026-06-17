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

export type FlashblocksSubscriptionKind = "pendingLogs" | "logs" | "newFlashblocks" | "newHeads";

export interface FlashblocksWsClientConfig {
  readonly wsUrl: string;
  readonly logger: LoggerLike;
  readonly onPendingLog: (log: Record<string, unknown>) => void;
  readonly onConfirmedLog?: (log: Record<string, unknown>) => void;
  readonly onNewFlashblock?: (payload: { readonly blockNumber: bigint; readonly flashblockIndex?: number }) => void;
  readonly onDisconnect?: () => void;
  readonly onConnect?: () => void;
  readonly maxReconnectDelayMs?: number;
  /** When true, failed/timed-out eth_subscribe calls are skipped instead of aborting startup. */
  readonly gracefulSubscribe?: boolean;
  readonly subscribeTimeoutMs?: number;
}

export interface FlashblocksWsStartResult {
  readonly active: readonly FlashblocksSubscriptionKind[];
  readonly activeRoles: readonly string[];
  readonly skipped: readonly {
    readonly kind: FlashblocksSubscriptionKind;
    readonly role?: string;
    readonly reason: string;
  }[];
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
    readonly role?: string;
  }[]): Promise<FlashblocksWsStartResult> {
    this.stopped = false;
    return await this.connect(subscriptions);
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
      readonly role?: string;
    }[],
  ): Promise<FlashblocksWsStartResult> {
    if (this.stopped) {
      return { active: [], activeRoles: [], skipped: [] };
    }
    return await new Promise<FlashblocksWsStartResult>((resolve, reject) => {
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
      readonly role?: string;
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
      readonly role?: string;
    }[],
  ): Promise<FlashblocksWsStartResult> {
    const active: FlashblocksSubscriptionKind[] = [];
    const activeRoles: string[] = [];
    const skipped: { kind: FlashblocksSubscriptionKind; role?: string; reason: string }[] = [];
    for (const sub of subscriptions) {
      try {
        await this.subscribe(sub.kind, sub.params);
        active.push(sub.kind);
        if (sub.role !== undefined) {
          activeRoles.push(sub.role);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (this.config.gracefulSubscribe !== true) {
          throw error;
        }
        skipped.push({
          kind: sub.kind,
          reason,
          ...(sub.role === undefined ? {} : { role: sub.role }),
        });
        this.config.logger.warn("flashblocks_ws_subscribe_skipped", {
          kind: sub.kind,
          role: sub.role,
          reason,
        });
      }
    }
    return { active, activeRoles, skipped };
  }

  private subscribe(kind: FlashblocksSubscriptionKind, params?: Record<string, unknown>): Promise<string> {
    const timeoutMs = this.config.subscribeTimeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      const id = this.requestId;
      this.requestId += 1;
      const timeout = setTimeout(() => {
        if (!this.pendingRequests.has(id)) {
          return;
        }
        this.pendingRequests.delete(id);
        reject(new Error(`eth_subscribe timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref?.();
      this.pendingRequests.set(id, {
        kind,
        resolve: (subscriptionId) => {
          clearTimeout(timeout);
          resolve(subscriptionId);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
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
    if (kind === "newFlashblocks" || kind === "newHeads") {
        const blockNumber = extractSubscriptionBlockNumber(result);
      if (blockNumber !== undefined) {
        const payload: { readonly blockNumber: bigint; readonly flashblockIndex?: number } = {
          blockNumber,
        };
        const flashblockIndex = kind === "newFlashblocks" ? extractFlashblockIndex(result) : undefined;
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

export function extractSubscriptionBlockNumber(result: unknown): bigint | undefined {
  if (typeof result === "string") {
    return BigInt(result);
  }
  if (result !== null && typeof result === "object") {
    const record = result as Record<string, unknown>;
    const raw = record.blockNumber ?? record.number;
    if (typeof raw === "string") {
      return BigInt(raw);
    }
    if (typeof raw === "number" && Number.isInteger(raw)) {
      return BigInt(raw);
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

export function aavePoolConfirmedLogsFilter(poolAddress: Address): Record<string, unknown> {
  return { address: poolAddress };
}
