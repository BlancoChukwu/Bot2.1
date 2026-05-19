import type { PublicClient } from "viem";
import type { LoggerLike } from "../bot";

const HEAD_BLOCK_RACE_MARKERS = [
  "block range extends beyond current head block",
  "greater than the current block",
  "exceeds the current head",
] as const;

const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;

export interface SafeGetLogsParams {
  readonly address?: `0x${string}` | readonly `0x${string}`[];
  readonly fromBlock?: bigint | number;
  readonly toBlock?: bigint | number;
  readonly blockHash?: `0x${string}`;
  readonly event?: unknown;
  readonly events?: unknown;
  readonly args?: unknown;
  readonly strict?: boolean;
  readonly topics?: readonly (readonly `0x${string}`[] | null)[];
}

export interface SafeGetLogsOptions {
  readonly maxRetries?: number;
  readonly logger?: LoggerLike;
  /** Structured log label (e.g. provider id, flashblocks). */
  readonly tag?: string;
}

type LogsClient = Pick<PublicClient, "getLogs" | "getBlockNumber">;
type ViemGetLogsParams = Parameters<PublicClient["getLogs"]>[0];
type GetLogsResult = Awaited<ReturnType<PublicClient["getLogs"]>>;

export function isHeadBlockRaceError(error: unknown): boolean {
  const text = collectErrorText(error).toLowerCase();
  if (HEAD_BLOCK_RACE_MARKERS.some((marker) => text.includes(marker))) {
    return true;
  }
  const code = getErrorCode(error);
  return code === -32602 && text.includes("head");
}

export async function safeGetLogs(
  client: LogsClient,
  params: SafeGetLogsParams,
  options: SafeGetLogsOptions = {},
): Promise<GetLogsResult> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  let attemptParams: SafeGetLogsParams = { ...params };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await client.getLogs(toViemGetLogsParams(attemptParams));
    } catch (error) {
      const isLastAttempt = attempt >= maxRetries - 1;
      if (!isHeadBlockRaceError(error) || isLastAttempt) {
        throw error;
      }

      await backoff(attempt);
      const head = await client.getBlockNumber();
      const previousFrom = attemptParams.fromBlock;
      const previousTo = attemptParams.toBlock;
      attemptParams = clampGetLogsRangeToHead(attemptParams, head);

      options.logger?.warn("eth_getlogs_head_race_retry", {
        tag: options.tag,
        attempt: attempt + 1,
        maxRetries,
        head: head.toString(),
        fromBlock: formatBlock(attemptParams.fromBlock),
        toBlock: formatBlock(attemptParams.toBlock),
        previousFromBlock: formatBlock(previousFrom),
        previousToBlock: formatBlock(previousTo),
      });
    }
  }

  throw new Error("safeGetLogs: exhausted retries");
}

function toViemGetLogsParams(params: SafeGetLogsParams): ViemGetLogsParams {
  return params as unknown as ViemGetLogsParams;
}

function clampGetLogsRangeToHead(
  params: SafeGetLogsParams,
  head: bigint,
): SafeGetLogsParams {
  const from = toNumericBlock(params.fromBlock);
  const to = toNumericBlock(params.toBlock);
  if (from === undefined && to === undefined) {
    return params;
  }

  let fromBlock = from ?? head;
  let toBlock = to ?? head;
  if (toBlock > head) {
    toBlock = head;
  }
  if (fromBlock > head) {
    fromBlock = head;
  }
  if (fromBlock > toBlock) {
    fromBlock = toBlock;
  }

  return { ...params, fromBlock, toBlock };
}

function toNumericBlock(block: SafeGetLogsParams["fromBlock"] | SafeGetLogsParams["toBlock"]): bigint | undefined {
  if (typeof block === "bigint") {
    return block;
  }
  if (typeof block === "number" && Number.isFinite(block)) {
    return BigInt(Math.max(0, Math.trunc(block)));
  }
  return undefined;
}

function formatBlock(block: SafeGetLogsParams["fromBlock"] | SafeGetLogsParams["toBlock"] | undefined): string {
  if (typeof block === "bigint") {
    return block.toString();
  }
  if (typeof block === "number") {
    return String(block);
  }
  if (block === undefined) {
    return "undefined";
  }
  return String(block);
}

function collectErrorText(error: unknown): string {
  if (error === null || typeof error !== "object") {
    return typeof error === "string" ? error : "";
  }
  const record = error as Record<string, unknown>;
  const cause = record.cause;
  const causeRecord = cause !== null && typeof cause === "object"
    ? cause as Record<string, unknown>
    : undefined;
  return [
    record.message,
    record.details,
    record.shortMessage,
    causeRecord?.message,
    causeRecord?.details,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
}

function getErrorCode(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const code = record.code;
  if (typeof code === "number") {
    return code;
  }
  const cause = record.cause;
  if (cause !== null && typeof cause === "object") {
    const causeCode = (cause as Record<string, unknown>).code;
    if (typeof causeCode === "number") {
      return causeCode;
    }
  }
  return undefined;
}

function backoff(attempt: number): Promise<void> {
  const delayMs = BACKOFF_BASE_MS * (attempt + 1);
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
