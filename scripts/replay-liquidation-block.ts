import "dotenv/config";
import { createPublicClient, http, parseAbiItem } from "viem";
import { base } from "viem/chains";

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL;
  if (rpcUrl === undefined) {
    throw new Error("RPC_URL is required");
  }
  const blockNumber = BigInt(process.env.REPLAY_LIQUIDATION_BLOCK ?? "");
  if (!Number.isFinite(Number(blockNumber))) {
    throw new Error("REPLAY_LIQUIDATION_BLOCK is required");
  }
  const poolAddress = process.env.REPLAY_POOL_ADDRESS ?? "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const startedAt = Date.now();
  const logs = await client.getLogs({
    address: poolAddress as `0x${string}`,
    event: parseAbiItem("event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)"),
    fromBlock: blockNumber,
    toBlock: blockNumber,
  });
  const detectionMs = Date.now() - startedAt;
  const withinTarget = detectionMs < 200;
  console.log(JSON.stringify({
    blockNumber: blockNumber.toString(),
    liquidationCalls: logs.length,
    detectionMs,
    targetMs: 200,
    withinTarget,
  }, null, 2));
  if (!withinTarget) {
    process.exitCode = 2;
  }
}

void main();
