import "dotenv/config";
import { evaluateRuntimeDeploymentSafety, parseRuntimeConfig } from "../src/index";

function main(): void {
  const env = { ...process.env };
  if (!env.DRY_RUN_CONFIG_HASH?.trim()) {
    env.DRY_RUN_CONFIG_HASH = "__pending__";
  }
  if (!env.DRY_RUN_VALIDATED_AT_MS?.trim()) {
    env.DRY_RUN_VALIDATED_AT_MS = String(Date.now());
  }

  const config = parseRuntimeConfig(env);
  const expectedHash = config.dryRunValidation?.expectedConfigHash;
  if (expectedHash === undefined) {
    throw new Error("Could not compute dry-run config hash");
  }

  const liveConfig = { ...config, simulationMode: false };
  const safety = evaluateRuntimeDeploymentSafety(liveConfig);

  if (process.argv.includes("--quiet")) {
    process.stdout.write(
      [
        "DRY_RUN_CONFIG_HASH=" + expectedHash,
        "DRY_RUN_VALIDATED_AT_MS=" + String(Date.now()),
        "DRY_RUN_CHAINS=" + config.chains.join(","),
        "DRY_RUN_SUCCESS=true",
        "",
      ].join("\n"),
    );
  } else {
    console.log("DRY_RUN_CONFIG_HASH=<computed — use npm run apply-dry-run-receipt to write .env>");
    console.log("DRY_RUN_VALIDATED_AT_MS=" + String(Date.now()));
    console.log("DRY_RUN_CHAINS=" + config.chains.join(","));
    console.log("DRY_RUN_SUCCESS=true");
    console.log("");
    console.log("Live gate (SIMULATION_MODE=false):", safety.status);
  }
  if (safety.status === "blocked") {
    for (const reason of safety.reasons) {
      console.log("  -", reason);
    }
  }
}

main();
