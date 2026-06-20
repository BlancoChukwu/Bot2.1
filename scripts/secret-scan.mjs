import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const staged = execSync("git diff --cached --name-only --diff-filter=ACM", { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean);

const blockedPathPattern =
  /^(?:\.env(?:\.|$)|\.runtime\/|logs\/|\.cache\/|\.cursor\/|.*\.heapsnapshot$|.*\.(?:pem|key)$)/i;
const skipContentScan = /\.(example|md)$/i;
const secretAssignment =
  /(?:PRIVATE_KEY|SECRET|MNEMONIC|(?:THE_GRAPH_|TELEGRAM_|PAGERDUTY_)?API_KEY)\s*=\s*['"]?(0x[a-fA-F0-9]{64}|[^\s#'"]+)/i;

let failed = false;
for (const file of staged) {
  const normalized = file.replace(/\\/g, "/");
  if (normalized === ".env.example") {
    continue;
  }
  if (blockedPathPattern.test(normalized)) {
    console.error(`secret-scan: blocked staged secret or local-runtime file: ${file}`);
    failed = true;
    continue;
  }
  if (skipContentScan.test(normalized)) {
    continue;
  }
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const match = content.match(secretAssignment);
  if (match === null) {
    continue;
  }
  const value = match[1] ?? "";
  if (/^0x0{64}$/i.test(value)) {
    continue;
  }
  if (normalized.includes("test/") && value.startsWith("0x")) {
    continue;
  }
  console.error(`secret-scan: secret assignment matched in ${file}`);
  failed = true;
}

if (failed) {
  process.exit(1);
}
