import { type ChildProcess, spawn } from "node:child_process";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const ANVIL_HOST = process.env.ANVIL_HOST ?? "127.0.0.1";
const ANVIL_PORT = Number(process.env.ANVIL_PORT ?? "8545");

export function resolveForkSourceRpc(): string | undefined {
  const candidates = [
    process.env.BASE_FORK_RPC_URL,
    process.env.FORK_RPC_URL,
    process.env.EXECUTION_RPC_URL_PRIMARY,
    process.env.RPC_URL,
    process.env.DEPLOY_RECEIVER_RPC_URL,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

export function anvilRpcUrl(port = ANVIL_PORT): string {
  return `http://${ANVIL_HOST}:${port}`;
}

export async function waitForAnvilRpc(url: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const client = createPublicClient({ chain: base, transport: http(url) });
      await client.getBlockNumber();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Anvil RPC not ready at ${url} within ${timeoutMs}ms`);
}

export async function anvilReset(
  url: string,
  forkUrl: string,
  blockNumber?: bigint,
): Promise<void> {
  const forking: { jsonRpcUrl: string; blockNumber?: string } = { jsonRpcUrl: forkUrl };
  if (blockNumber !== undefined) {
    forking.blockNumber = `0x${blockNumber.toString(16)}`;
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_reset",
      params: [{ forking }],
    }),
  });
  const json = await response.json() as { error?: { message: string } };
  if (json.error !== undefined) {
    throw new Error(`anvil_reset failed: ${json.error.message}`);
  }
}

export function startAnvilProcess(forkUrl: string, port = ANVIL_PORT): ChildProcess {
  return spawn("anvil", ["--fork-url", forkUrl, "--port", String(port), "--silent"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function stopAnvilProcess(process: ChildProcess | undefined): Promise<void> {
  if (process === undefined || process.killed) {
    return;
  }
  process.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    process.once("exit", () => resolve());
    setTimeout(() => {
      if (!process.killed) {
        process.kill("SIGKILL");
      }
      resolve();
    }, 5_000);
  });
}

export interface ManagedAnvilFork {
  readonly rpcUrl: string;
  readonly process: ChildProcess;
  reset(blockNumber?: bigint): Promise<void>;
  stop(): Promise<void>;
}

export async function createManagedAnvilFork(input: {
  readonly forkUrl: string;
  readonly port?: number;
  readonly blockNumber?: bigint;
}): Promise<ManagedAnvilFork> {
  const port = input.port ?? ANVIL_PORT;
  const rpcUrl = anvilRpcUrl(port);
  const process = startAnvilProcess(input.forkUrl, port);
  process.on("error", (error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("anvil not found in PATH — install Foundry (https://book.getfoundry.sh/getting-started/installation)");
    }
    throw error;
  });
  await waitForAnvilRpc(rpcUrl);
  await anvilReset(rpcUrl, input.forkUrl, input.blockNumber);
  return {
    rpcUrl,
    process,
    reset: async (blockNumber?: bigint) => anvilReset(rpcUrl, input.forkUrl, blockNumber),
    stop: async () => stopAnvilProcess(process),
  };
}
