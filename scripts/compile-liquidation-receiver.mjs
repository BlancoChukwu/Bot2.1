import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outDir = path.join(root, "contracts", "build");
const contractsToCompile = [
  "LiquidationFlashReceiver.sol",
  "MultiProtocolFlashReceiver.sol",
];
const sources = Object.fromEntries(
  contractsToCompile.map((name) => [
    name,
    { content: fs.readFileSync(path.join(root, "contracts", name), "utf8") },
  ]),
);
const input = {
  language: "Solidity",
  sources,
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

fs.mkdirSync(outDir, { recursive: true });
for (const contractFile of contractsToCompile) {
  const contractName = contractFile.replace(".sol", "");
  const compiled = output.contracts[contractFile]?.[contractName];
  if (compiled === undefined) {
    console.error(`Compiler did not produce ${contractName}`);
    process.exit(1);
  }
  const bytecode = compiled.evm?.bytecode?.object;
  if (bytecode === undefined || bytecode.length === 0) {
    console.error(`Missing bytecode object for ${contractName}`);
    process.exit(1);
  }
  const outPath = path.join(outDir, `${contractName}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        contractName,
        abi: compiled.abi,
        bytecode: bytecode.startsWith("0x") ? bytecode : `0x${bytecode}`,
      },
      null,
      2,
    ),
  );
  console.log(`Wrote ${path.relative(root, outPath)}`);
}
