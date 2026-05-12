import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const sourcePath = path.join(root, "contracts", "LiquidationFlashReceiver.sol");
const outDir = path.join(root, "contracts", "build");
const outPath = path.join(outDir, "LiquidationFlashReceiver.json");

const source = fs.readFileSync(sourcePath, "utf8");
const input = {
  language: "Solidity",
  sources: { "LiquidationFlashReceiver.sol": { content: source } },
  settings: {
    viaIR: true,
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.bytecode.sourceMap"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
if (output.errors) {
  const fatal = output.errors.filter((e) => e.severity === "error");
  if (fatal.length > 0) {
    console.error(fatal.map((e) => e.formattedMessage).join("\n"));
    process.exit(1);
  }
}

const compiled = output.contracts["LiquidationFlashReceiver.sol"]?.LiquidationFlashReceiver;
if (compiled === undefined) {
  console.error("Compiler did not produce LiquidationFlashReceiver");
  process.exit(1);
}

const bytecode = compiled.evm?.bytecode?.object;
if (bytecode === undefined || bytecode.length === 0) {
  console.error("Missing bytecode object");
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      contractName: "LiquidationFlashReceiver",
      abi: compiled.abi,
      bytecode: bytecode.startsWith("0x") ? bytecode : `0x${bytecode}`,
    },
    null,
    2,
  ),
);

console.log(`Wrote ${path.relative(root, outPath)}`);
