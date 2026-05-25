import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
    pool: "forks",
    isolate: true,
    clearMocks: true,
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    teardownTimeout: 10_000,
    retry: 0,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "src/monitors/MultiWsEventSource.ts",
        "src/config/chainRegistry.ts",
        "src/utils/evCalculator.ts",
        "src/executors/liquidationExecutionAdapter.ts",
        "src/executors/safeTransactionExecutor.ts",
        "src/utils/gasPriceOracle.ts",
      ],
      thresholds: {
        perFile: true,
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 90,
      },
    },
  },
});
