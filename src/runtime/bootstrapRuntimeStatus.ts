import type { BotRuntimeStatus } from "../bot";

let current: BotRuntimeStatus = {};

export function setBootstrapRuntimeStatus(status: BotRuntimeStatus): void {
  current = status;
}

export function getBootstrapRuntimeStatus(): BotRuntimeStatus {
  return current;
}
