import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBurnerWallet } from "../src/wallet/createBurnerWallet";

function main(): void {
  const wallet = createBurnerWallet();
  const writeEnv = process.argv.includes("--write-env");
  const envPath = join(process.cwd(), ".env.burner");

  console.log("Burner wallet created (Viem generatePrivateKey + privateKeyToAccount).");
  console.log("NEVER commit PRIVATE_KEY or .env — store only in local .env (gitignored).");
  console.log("Fund with a small amount of native gas on your target chain only.");
  console.log("");
  console.log(`Address:     ${wallet.address}`);
  console.log(`PRIVATE_KEY: ${wallet.privateKey}`);
  console.log("");
  console.log("Paste into .env (never commit .env or share this key):");
  console.log(`PRIVATE_KEY=${wallet.privateKey}`);

  if (writeEnv) {
    writeFileSync(envPath, `PRIVATE_KEY=${wallet.privateKey}\n`, { encoding: "utf8", mode: 0o600 });
    console.log("");
    console.log(`Wrote ${envPath} (mode 600). Merge PRIVATE_KEY into your main .env, then delete .env.burner.`);
  }
}

main();
