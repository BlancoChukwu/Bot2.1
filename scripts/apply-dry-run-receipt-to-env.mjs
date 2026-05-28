import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const receiptPath = resolve(root, ".runtime/dry-run-receipt.json");
const envPath = resolve(root, ".env");

const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
const configHash = receipt.configHash;
const validatedAtMs = String(receipt.validatedAtMs);

let env = readFileSync(envPath, "utf8");

const upsert = (key, value) => {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(env)) {
    env = env.replace(pattern, line);
  } else {
    env += `\n${line}\n`;
  }
};

upsert("DRY_RUN_SUCCESS", "true");
upsert("DRY_RUN_VALIDATED_AT_MS", validatedAtMs);
upsert("DRY_RUN_CONFIG_HASH", configHash);
if (!/^DRY_RUN_CHAINS=/m.test(env)) {
  upsert("DRY_RUN_CHAINS", "base");
}

writeFileSync(envPath, env, "utf8");
console.log("dry_run_receipt_applied", {
  validatedAtMs,
  receiptPath,
  ttlMinutes: 15,
});
