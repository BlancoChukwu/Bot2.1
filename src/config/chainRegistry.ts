import { z } from "zod";
import { getChainConfig, parseSupportedChain, type ChainConfig, type SupportedChain } from "./chains";

export type FlashLoanProviderId = "aaveV3" | "balancer" | "uniswapV3";
export type CircuitBreakerName = "rpc" | "subgraph" | "execution";
export type CircuitBreakerStatus = "closed" | "open" | "half_open";

export interface ChainRegistryInput {
  readonly chains: readonly ChainRuntimeInput[];
}

export interface ChainRuntimeInput {
  readonly chain: SupportedChain;
  readonly rpcUrl: string;
  readonly fallbackRpcUrls: readonly string[];
  readonly wsRpcUrl?: string;
  readonly detection?: {
    readonly wsPrimary?: string;
    readonly wsSecondary?: string;
    readonly wsTertiary?: string;
    readonly flashblocksEnabled?: boolean;
  };
  readonly execution?: {
    readonly httpPrimary?: string;
    readonly fallbacks?: readonly string[];
  };
  readonly sequencer?: {
    readonly uptimeFeed?: string;
    readonly directRpc?: string;
  };
  readonly resolvedAave?: {
    readonly pool?: string;
    readonly poolAddressesProvider?: string;
    readonly uiPoolDataProvider?: string;
  };
  readonly aaveSubgraphUrl: string;
  readonly flashLoanProviders?: readonly FlashLoanProviderId[];
  readonly protocolHooks?: readonly ProtocolHook[];
}

export interface ProtocolHook {
  readonly protocol: string;
  readonly adapterKey: string;
}

export interface GasProfile {
  readonly gasLimit: bigint;
  readonly updatedAtMs: number;
}

export interface CircuitBreakerState {
  readonly status: CircuitBreakerStatus;
  readonly failures: number;
  readonly openedAtMs?: number;
}

export interface RegisteredChain {
  readonly name: SupportedChain;
  readonly chainConfig: ChainConfig;
  readonly rpc: {
    readonly primaryUrl: string;
    readonly fallbackUrls: readonly string[];
    readonly wsUrl?: string;
  };
  readonly detection: {
    readonly wsPrimary?: string;
    readonly wsSecondary?: string;
    readonly wsTertiary?: string;
    readonly flashblocksEnabled: boolean;
  };
  readonly execution: {
    readonly httpPrimary: string;
    readonly fallbacks: readonly string[];
  };
  readonly sequencer: {
    readonly uptimeFeed?: string;
    readonly directRpc?: string;
  };
  readonly aaveSubgraphUrl: string;
  readonly flashLoanProviders: readonly FlashLoanProviderId[];
  readonly protocolHooks: readonly ProtocolHook[];
  readonly gasProfileCache: Map<string, GasProfile>;
  readonly circuitBreakers: Record<CircuitBreakerName, CircuitBreakerState>;
}

export interface ChainRegistry {
  listChains(): SupportedChain[];
  get(chain: SupportedChain): RegisteredChain;
  getResolvedAave(chain: SupportedChain): RegisteredChain["chainConfig"]["aave"];
  setCircuitBreakerState(chain: SupportedChain, name: CircuitBreakerName, state: CircuitBreakerState): void;
}

const flashLoanProviderSchema = z.enum(["aaveV3", "balancer", "uniswapV3"]);
const chainRuntimeSchema = z.object({
  chain: z.string().transform((value) => parseSupportedChain(value)),
  rpcUrl: z.string().url(),
  fallbackRpcUrls: z.array(z.string().url()),
  wsRpcUrl: z.string().url().optional(),
  detection: z.object({
    wsPrimary: z.string().url().optional(),
    wsSecondary: z.string().url().optional(),
    wsTertiary: z.string().url().optional(),
    flashblocksEnabled: z.boolean().optional(),
  }).optional(),
  execution: z.object({
    httpPrimary: z.string().url().optional(),
    fallbacks: z.array(z.string().url()).optional(),
  }).optional(),
  sequencer: z.object({
    uptimeFeed: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
    directRpc: z.string().url().optional(),
  }).optional(),
  resolvedAave: z.object({
    pool: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
    poolAddressesProvider: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
    uiPoolDataProvider: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  }).optional(),
  aaveSubgraphUrl: z.string().url(),
  flashLoanProviders: z.array(flashLoanProviderSchema).optional(),
  protocolHooks: z.array(z.object({
    protocol: z.string().min(1),
    adapterKey: z.string().min(1),
  })).optional(),
});
const registryInputSchema = z.object({
  chains: z.array(chainRuntimeSchema).min(1),
});

const defaultCircuitBreakers: Record<CircuitBreakerName, CircuitBreakerState> = {
  rpc: { status: "closed", failures: 0 },
  subgraph: { status: "closed", failures: 0 },
  execution: { status: "closed", failures: 0 },
};

export function createChainRegistry(input: ChainRegistryInput): ChainRegistry {
  const parsedInput = registryInputSchema.parse(input);
  const entries = new Map<SupportedChain, RegisteredChain>();
  for (const chainInput of parsedInput.chains) {
    if (entries.has(chainInput.chain)) {
      throw new Error(`Duplicate chain registry entry: ${chainInput.chain}`);
    }
    entries.set(chainInput.chain, createRegisteredChain(chainInput));
  }

  return {
    listChains: () => [...entries.keys()],
    get(chain) {
      const entry = entries.get(chain);
      if (entry === undefined) {
        throw new Error(`Chain is not registered: ${chain}`);
      }
      return entry;
    },
    getResolvedAave(chain) {
      return this.get(chain).chainConfig.aave;
    },
    setCircuitBreakerState(chain, name, state) {
      const entry = this.get(chain);
      entries.set(chain, updateCircuitBreakerState(entry, name, state));
    },
  };
}

export function updateCircuitBreakerState(
  chain: RegisteredChain,
  name: CircuitBreakerName,
  state: CircuitBreakerState,
): RegisteredChain {
  return {
    ...chain,
    circuitBreakers: {
      ...chain.circuitBreakers,
      [name]: state,
    },
  };
}

function createRegisteredChain(input: z.infer<typeof chainRuntimeSchema>): RegisteredChain {
  const primaryWs = input.detection?.wsPrimary ?? input.wsRpcUrl;
  const baseConfig = getChainConfig(input.chain);
  const chainConfig: ChainConfig = {
    ...baseConfig,
    aave: {
      ...baseConfig.aave,
      ...(input.resolvedAave?.pool === undefined ? {} : { pool: input.resolvedAave.pool as `0x${string}` }),
      ...(input.resolvedAave?.poolAddressesProvider === undefined ? {} : { poolAddressesProvider: input.resolvedAave.poolAddressesProvider as `0x${string}` }),
      ...(input.resolvedAave?.uiPoolDataProvider === undefined ? {} : { uiPoolDataProvider: input.resolvedAave.uiPoolDataProvider as `0x${string}` }),
    },
  };
  return {
    name: input.chain,
    chainConfig,
    rpc: {
      primaryUrl: input.rpcUrl,
      fallbackUrls: input.fallbackRpcUrls,
      ...(input.wsRpcUrl === undefined ? {} : { wsUrl: input.wsRpcUrl }),
    },
    detection: {
      ...(primaryWs === undefined ? {} : { wsPrimary: primaryWs }),
      ...(input.detection?.wsSecondary !== undefined ? { wsSecondary: input.detection.wsSecondary } : {}),
      ...(input.detection?.wsTertiary !== undefined ? { wsTertiary: input.detection.wsTertiary } : {}),
      flashblocksEnabled: input.detection?.flashblocksEnabled ?? false,
    },
    execution: {
      httpPrimary: input.execution?.httpPrimary ?? input.rpcUrl,
      fallbacks: input.execution?.fallbacks ?? input.fallbackRpcUrls,
    },
    sequencer: {
      ...(input.sequencer?.uptimeFeed !== undefined ? { uptimeFeed: input.sequencer.uptimeFeed } : {}),
      ...(input.sequencer?.directRpc !== undefined ? { directRpc: input.sequencer.directRpc } : {}),
    },
    aaveSubgraphUrl: input.aaveSubgraphUrl,
    flashLoanProviders: input.flashLoanProviders ?? ["aaveV3"],
    protocolHooks: input.protocolHooks ?? [],
    gasProfileCache: new Map<string, GasProfile>(),
    circuitBreakers: {
      rpc: { ...defaultCircuitBreakers.rpc },
      subgraph: { ...defaultCircuitBreakers.subgraph },
      execution: { ...defaultCircuitBreakers.execution },
    },
  };
}
