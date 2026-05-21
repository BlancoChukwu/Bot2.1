import { config } from "dotenv";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(root, ".env") });

const require = createRequire(import.meta.url);
const { parseRuntimeConfig } = require(resolve(root, "dist/src/index.js"));

const env = { ...process.env };
if (process.argv.includes("--live")) {
  env.SIMULATION_MODE = "false";
}
env.MIN_LIQUIDATION_DEBT_USD = env.MIN_LIQUIDATION_DEBT_USD ?? "100";
env.DRY_RUN_SUCCESS = "true";
env.DRY_RUN_VALIDATED_AT_MS = String(Date.now());
env.DRY_RUN_CONFIG_HASH = "pending";

const runtime = parseRuntimeConfig(env);
const hash = runtime.dryRunValidation?.expectedConfigHash;
if (hash === undefined) {
  console.error("emit-dry-run-receipt: unable to compute config hash");
  process.exit(1);
}

const outDir = resolve(root, ".runtime");
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "dry-run-receipt.json"), JSON.stringify({
  validatedAtMs: env.DRY_RUN_VALIDATED_AT_MS,
  configHash: hash,
}, null, 2), "utf8");

console.log(hash);
