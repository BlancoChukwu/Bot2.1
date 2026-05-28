import "dotenv/config";
import { createPublicClient, http, parseAbiItem } from "viem";
import { base } from "viem/chains";

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL;
  if (rpcUrl === undefined) {
    throw new Error("RPC_URL is required");
  }
  const fromBlock = BigInt(process.env.REPLAY_FROM_BLOCK ?? "0");
  const toBlock = BigInt(process.env.REPLAY_TO_BLOCK ?? "0");
  if (fromBlock <= 0n || toBlock < fromBlock) {
    throw new Error("Set REPLAY_FROM_BLOCK and REPLAY_TO_BLOCK to a valid inclusive range");
  }
  const poolAddress = process.env.REPLAY_POOL_ADDRESS ?? "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const startedAt = Date.now();
  const logs = await client.getLogs({
    address: poolAddress as `0x${string}`,
    event: parseAbiItem("event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)"),
    fromBlock,
    toBlock,
  });

  console.log(JSON.stringify({
    range: { fromBlock: fromBlock.toString(), toBlock: toBlock.toString() },
    liquidationCalls: logs.length,
    latencyMs: Date.now() - startedAt,
  }, null, 2));
}

void main();
