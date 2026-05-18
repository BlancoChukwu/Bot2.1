export interface HealthLoggerInputs {
  readonly sequencerUp: () => boolean;
  readonly getCurrentPrimaryProvider: () => string;
  readonly getFtrlRegret: () => number;
  readonly getPendingOpportunities: () => number;
  readonly getLastEventTimestamp: () => number;
  readonly intervalMs?: number;
}

export interface HealthLoggerHandle {
  stop(): void;
}

// Quick console + Prometheus-ready health logger.
export function startHealthLogger(inputs: HealthLoggerInputs): HealthLoggerHandle {
  const intervalMs = inputs.intervalMs ?? 30_000;
  const timer = setInterval(() => {
    console.log({
      sequencerUp: inputs.sequencerUp(),
      primaryProvider: inputs.getCurrentPrimaryProvider(),
      ftrlRegret: inputs.getFtrlRegret(),
      pendingOpportunities: inputs.getPendingOpportunities(),
      lastEventMs: Date.now() - inputs.getLastEventTimestamp(),
    });
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
