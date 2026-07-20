import "dotenv/config";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { encodeAbiParameters, parseAbiParameters, parseEther, type Address } from "viem";
import { getChainConfig } from "../../src/config/chains";
import { getDexesForChain } from "../../src/config/dexRegistry";
import { estimateMinimumCollateralOut } from "../../src/executors/liquidationExecutionAdapter";
import { encodeLiquidationRoute } from "../../src/protocols/liquidationFlashLoanReceiver";
import { DEFAULT_LIQUIDATION_RECEIVER_VERSION, liquidationFlashReceiverAbi } from "../../src/production/liquidationReceiverReadiness";
import {
  createManagedAnvilFork,
  resolveForkSourceRpc,
  type ManagedAnvilFork,
} from "./helpers/baseAnvilFork";
import {
  assertReceiverVersion,
  createForkPublicClient,
  createForkTestClient,
  DEFAULT_FORK_AUTHORIZED_INITIATOR,
  deployLiquidationFlashReceiver,
  dumpUniswapV3Pool,
  encodeProductionRouteParams,
  extractRevertMessage,
  findHealthyBorrower,
  findHistoricalLiquidationCase,
  fundWeth,
  isUnderwaterHealthFactor,
  loadLiquidationFlashReceiverArtifact,
  readDecodedRouteParams,
  readErc20Balance,
  readHealthFactor,
  simulateExecuteOperation,
  simulateFlashLoanSimple,
  sizeLiquidationDebtToCover,
} from "./helpers/liquidationReceiverForkHarness";

const WAD = 1_000_000_000_000_000_000n;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
/** Large Base USDC holder used only for fork funding. */
const USDC_WHALE = "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A" as Address;

const forkSourceRpc = resolveForkSourceRpc();
if (forkSourceRpc === undefined) {
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({
    event: "receiver_fork_tests_skipped",
    reason: "missing_fork_rpc",
    hint: "Run via npm run test:receiver-fork with DOTENV_CONFIG_PATH pointing at a profile that sets RPC_URL",
  }));
}
const describeFork = forkSourceRpc === undefined ? describe.skip : describe;

describeFork("LiquidationFlashReceiver v5 (Base anvil fork)", () => {
  const artifact = loadLiquidationFlashReceiverArtifact();
  const pool = getChainConfig("base").aave.pool;
  const uniswap = getDexesForChain("base").find((dex) => dex.name === "UniswapV3");
  let latestFork: ManagedAnvilFork;
  let latestClient: ReturnType<typeof createForkPublicClient>;
  let receiver: Awaited<ReturnType<typeof deployLiquidationFlashReceiver>>;

  beforeAll(async () => {
    if (uniswap === undefined || uniswap.quoterV2 === undefined) {
      throw new Error("UniswapV3 (with quoterV2) missing from dex registry for base");
    }
    latestFork = await createManagedAnvilFork({ forkUrl: forkSourceRpc! });
    latestClient = createForkPublicClient(latestFork.rpcUrl);
    receiver = await deployLiquidationFlashReceiver(latestFork.rpcUrl, artifact);
    await assertReceiverVersion(latestClient, receiver, DEFAULT_LIQUIDATION_RECEIVER_VERSION);
  }, 120_000);

  afterAll(async () => {
    await latestFork?.stop();
  }, 30_000);

  it("deploys receiver v5 bytecode on the fork", async () => {
    const version = await latestClient.readContract({
      address: receiver,
      abi: liquidationFlashReceiverAbi,
      functionName: "receiverVersion",
    });
    expect(version).toBe(5n);
    const slippage = await latestClient.readContract({
      address: receiver,
      abi: liquidationFlashReceiverAbi,
      functionName: "swapSlippageBps",
    });
    expect(slippage).toBe(200n);
  });

  it("decodes production-encoded 8-field route params field-for-field via decodeRouteParams", async () => {
    const user = "0x0000000000000000000000000000000000000011";
    const debtToCover = 1_000_000n;
    const minDebtOut = 498_750n;
    const receiveAToken = false;
    const fee = 500 as const;

    const params = encodeLiquidationRoute({
      collateralAsset: WETH,
      debtAsset: USDC,
      user,
      debtToCover,
      minDebtOut,
      receiveAToken,
      fee,
    });

    const decoded = await readDecodedRouteParams(latestClient, receiver, params);
    expect(decoded[0]).toBe(0);
    expect(decoded[1].toLowerCase()).toBe(WETH.toLowerCase());
    expect(decoded[2].toLowerCase()).toBe(USDC.toLowerCase());
    expect(decoded[3].toLowerCase()).toBe(user.toLowerCase());
    expect(decoded[4]).toBe(debtToCover);
    expect(decoded[5]).toBe(minDebtOut);
    expect(decoded[6]).toBe(receiveAToken);
    expect(decoded[7]).toBe(fee);
  });

  it("computes oracleMinDebtOut in debt-asset wei for 1 WETH", async () => {
    const oneWeth = parseEther("1");
    const minOut = await latestClient.readContract({
      address: receiver,
      abi: liquidationFlashReceiverAbi,
      functionName: "oracleMinDebtOut",
      args: [WETH, USDC, oneWeth],
    });
    // eslint-disable-next-line no-console
    console.info("oracle_min_debt_out_1_weth", {
      collateralBal: oneWeth.toString(),
      minOutUsdcRaw: minOut.toString(),
      minOutUsdc: Number(minOut) / 1e6,
      swapSlippageBps: 200,
    });
    expect(minOut).toBeGreaterThan(0n);
    // Sanity: 1 WETH floor should be well above $1000 USDC at any recent Base price.
    expect(minOut).toBeGreaterThan(1_000_000_000n);
  });

  it("reverts UnauthorizedInitiator when flash-loan initiator is not authorized", async () => {
    const healthy = await findHealthyBorrower(latestClient, pool);
    const params = encodeProductionRouteParams({
      collateralAsset: WETH,
      debtAsset: USDC,
      user: healthy.user,
      debtToCover: 1_000_000n,
      receiveAToken: false,
    });

    await expect(
      simulateExecuteOperation({
        client: latestClient,
        rpcUrl: latestFork.rpcUrl,
        receiver,
        pool,
        debtAsset: USDC,
        amount: 1_000_000n,
        premium: 0n,
        params,
        artifact,
        initiator: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const message = extractRevertMessage(error);
      return message.includes("UnauthorizedInitiator");
    });
  }, 60_000);

  it("reverts UnsupportedRouteType for non-zero routeType", async () => {
    const params = encodeAbiParameters(
      parseAbiParameters(
        "uint8 routeType,address collateralAsset,address debtAsset,address user,uint256 debtToCover,uint256 minDebtOut,bool receiveAToken,uint24 fee",
      ),
      [1, WETH, USDC, DEFAULT_FORK_AUTHORIZED_INITIATOR, 1_000_000n, 0n, false, 3_000],
    );

    await expect(
      simulateExecuteOperation({
        client: latestClient,
        rpcUrl: latestFork.rpcUrl,
        receiver,
        pool,
        debtAsset: USDC,
        amount: 1_000_000n,
        premium: 0n,
        params,
        artifact,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const message = extractRevertMessage(error);
      return message.includes("UnsupportedRouteType");
    });
  }, 60_000);

  it("reverts InvalidSwapFee for non-enum fee tier", async () => {
    const params = encodeAbiParameters(
      parseAbiParameters(
        "uint8 routeType,address collateralAsset,address debtAsset,address user,uint256 debtToCover,uint256 minDebtOut,bool receiveAToken,uint24 fee",
      ),
      [0, WETH, USDC, DEFAULT_FORK_AUTHORIZED_INITIATOR, 1_000_000n, 0n, false, 123],
    );

    await expect(
      simulateExecuteOperation({
        client: latestClient,
        rpcUrl: latestFork.rpcUrl,
        receiver,
        pool,
        debtAsset: USDC,
        amount: 1_000_000n,
        premium: 0n,
        params,
        artifact,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const message = extractRevertMessage(error);
      return message.includes("InvalidSwapFee");
    });
  }, 60_000);

  it("reverts HF_NOT_LIQUIDATABLE when HF >= 1e18", async () => {
    const healthy = await findHealthyBorrower(latestClient, pool);
    const minDebtOut = estimateMinimumCollateralOut({
      account: healthy.user,
      collateralAsset: WETH,
      debtAsset: USDC,
      debtToCover: 1_000_000n,
      repayValueUsd: 1,
      liquidationBonusBps: 500,
      healthFactor: healthy.healthFactor,
    }, 500);
    const params = encodeLiquidationRoute({
      collateralAsset: WETH,
      debtAsset: USDC,
      user: healthy.user,
      debtToCover: 1_000_000n,
      minDebtOut,
      receiveAToken: false,
      fee: 3_000,
    });

    await expect(
      simulateExecuteOperation({
        client: latestClient,
        rpcUrl: latestFork.rpcUrl,
        receiver,
        pool,
        debtAsset: USDC,
        amount: 1_000_000n,
        premium: 0n,
        params,
        artifact,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const message = extractRevertMessage(error);
      return message.includes("HF_NOT_LIQUIDATABLE");
    });
  }, 60_000);

  it("passes the HF guard for a historically liquidatable position (fork block - 1)", async () => {
    const liquidationCase = await findHistoricalLiquidationCase(forkSourceRpc!, pool);
    expect(liquidationCase.healthFactor).toBeLessThan(WAD);

    const historicalFork = await createManagedAnvilFork({
      forkUrl: forkSourceRpc!,
      port: Number(process.env.ANVIL_PORT ?? "8545") + 1,
      blockNumber: liquidationCase.snapshotBlock,
    });
    try {
      const historicalClient = createForkPublicClient(historicalFork.rpcUrl);
      const historicalReceiver = await deployLiquidationFlashReceiver(historicalFork.rpcUrl, artifact);
      const hfAtFork = await readHealthFactor(historicalClient, pool, liquidationCase.user);
      expect(isUnderwaterHealthFactor(hfAtFork)).toBe(true);

      const minDebtOut = estimateMinimumCollateralOut({
        account: liquidationCase.user,
        collateralAsset: liquidationCase.collateralAsset,
        debtAsset: liquidationCase.debtAsset,
        debtToCover: liquidationCase.debtToCover,
        repayValueUsd: 1,
        liquidationBonusBps: 500,
        healthFactor: liquidationCase.healthFactor,
      }, 500);
      const params = encodeLiquidationRoute({
        collateralAsset: liquidationCase.collateralAsset,
        debtAsset: liquidationCase.debtAsset,
        user: liquidationCase.user,
        debtToCover: liquidationCase.debtToCover,
        minDebtOut,
        receiveAToken: liquidationCase.receiveAToken,
        fee: 500,
      });

      const decoded = await readDecodedRouteParams(historicalClient, historicalReceiver, params);
      expect(decoded[0]).toBe(0);
      expect(decoded[1].toLowerCase()).toBe(liquidationCase.collateralAsset.toLowerCase());
      expect(decoded[2].toLowerCase()).toBe(liquidationCase.debtAsset.toLowerCase());
      expect(decoded[3].toLowerCase()).toBe(liquidationCase.user.toLowerCase());
      expect(decoded[4]).toBe(liquidationCase.debtToCover);
      expect(decoded[5]).toBe(minDebtOut);
      expect(decoded[6]).toBe(liquidationCase.receiveAToken);
      expect(decoded[7]).toBe(500);

      // eslint-disable-next-line no-console
      console.info("historical_liquidation_case", {
        user: liquidationCase.user,
        block: liquidationCase.blockNumber.toString(),
        snapshotBlock: liquidationCase.snapshotBlock.toString(),
        healthFactor: liquidationCase.healthFactor.toString(),
        collateralAsset: liquidationCase.collateralAsset,
        debtAsset: liquidationCase.debtAsset,
        debtToCover: liquidationCase.debtToCover.toString(),
        fee: 500,
        minDebtOut: minDebtOut.toString(),
        note: "Production 8-field encoding; field 6 advisory only",
      });

      try {
        await simulateExecuteOperation({
          client: historicalClient,
          rpcUrl: historicalFork.rpcUrl,
          receiver: historicalReceiver,
          pool,
          debtAsset: liquidationCase.debtAsset,
          amount: liquidationCase.debtToCover,
          premium: 0n,
          params,
          artifact,
        });
      } catch (error) {
        const message = extractRevertMessage(error);
        expect(message).not.toContain("HF_NOT_LIQUIDATABLE");
        expect(message).not.toContain("UnsupportedRouteType");
        expect(message).not.toContain("UnauthorizedInitiator");
      }
    } finally {
      await historicalFork.stop();
    }
  }, 180_000);

  it("reverts when Uniswap executable price is degraded below the on-chain oracle floor", async () => {
    if (uniswap === undefined || uniswap.quoterV2 === undefined) {
      throw new Error("UniswapV3 (with quoterV2) missing from dex registry for base");
    }
    // Use the liquid WETH/USDC 500-fee pool for dump+quote. The receiver's configured
    // swapFee is irrelevant here — this test calls the router directly with the same
    // amountOutMinimum (_oracleMinDebtOut) the contract would pass.
    const swapFee = 500;
    // Tighten owner-settable slippage to 50 bps for the adversarial case only: still
    // leaves headroom above the 5 bps pool fee so a healthy quote clears, but a modest
    // dump can push the executable price under the floor without multi-hundred-WETH
    // swaps that time out or revert on anvil.
    const forcedCollateral = parseEther("0.25");
    const dumpChunk = parseEther("5");
    const maxDumpChunks = 40;
    const adversarialSlippageBps = 50n;

    // Head fork (no underwater borrower required): prove the oracle floor rejects a
    // degraded Uniswap quote for the exact amountOutMinimum the receiver would use.
    const dumpFork = await createManagedAnvilFork({
      forkUrl: forkSourceRpc!,
      port: Number(process.env.ANVIL_PORT ?? "8545") + 2,
    });
    try {
      const publicClient = createForkPublicClient(dumpFork.rpcUrl);
      const testClient = createForkTestClient(dumpFork.rpcUrl);
      const dumpedReceiver = await deployLiquidationFlashReceiver(dumpFork.rpcUrl, artifact);
      await setSwapSlippage(testClient, dumpedReceiver, artifact, adversarialSlippageBps);

      const configuredSlippage = await publicClient.readContract({
        address: dumpedReceiver,
        abi: liquidationFlashReceiverAbi,
        functionName: "swapSlippageBps",
      });
      expect(configuredSlippage).toBe(adversarialSlippageBps);

      const oracleFloor = await publicClient.readContract({
        address: dumpedReceiver,
        abi: liquidationFlashReceiverAbi,
        functionName: "oracleMinDebtOut",
        args: [WETH, USDC, forcedCollateral],
      });
      expect(oracleFloor).toBeGreaterThan(0n);

      // Undegraded quote must clear the floor (sanity — otherwise the floor is mis-scaled).
      const quoteBefore = await quoteExactInputSingle({
        client: publicClient,
        quoter: uniswap.quoterV2,
        tokenIn: WETH,
        tokenOut: USDC,
        fee: swapFee,
        amountIn: forcedCollateral,
      });
      // eslint-disable-next-line no-console
      console.info("adversarial_quote_before_dump", {
        forcedCollateral: forcedCollateral.toString(),
        swapSlippageBps: configuredSlippage.toString(),
        oracleFloor: oracleFloor.toString(),
        quoteBefore: quoteBefore.toString(),
        clearsFloor: quoteBefore >= oracleFloor,
      });
      expect(quoteBefore >= oracleFloor).toBe(true);

      let quoteAfter = quoteBefore;
      const dumpTxs: string[] = [];
      for (let i = 0; i < maxDumpChunks && quoteAfter >= oracleFloor; i += 1) {
        const dumpTx = await dumpUniswapV3Pool({
          rpcUrl: dumpFork.rpcUrl,
          tokenIn: WETH,
          tokenOut: USDC,
          amountIn: dumpChunk,
          fee: swapFee,
          router: uniswap.router,
        });
        dumpTxs.push(dumpTx);
        quoteAfter = await quoteExactInputSingle({
          client: publicClient,
          quoter: uniswap.quoterV2,
          tokenIn: WETH,
          tokenOut: USDC,
          fee: swapFee,
          amountIn: forcedCollateral,
        });
      }
      // eslint-disable-next-line no-console
      console.info("adversarial_dump", {
        dumpTxs,
        dumpChunks: dumpTxs.length,
        dumpChunkWeth: dumpChunk.toString(),
        oracleFloor: oracleFloor.toString(),
        quoteAfter: quoteAfter.toString(),
        floorBeatsQuote: quoteAfter < oracleFloor,
        note: "Aave oracle untouched; Uniswap executable price degraded via chunked dumps",
      });
      expect(quoteAfter < oracleFloor).toBe(true);

      // Execute the same swap the receiver would: amountOutMinimum = oracle floor.
      await fundWeth(dumpFork.rpcUrl, DEFAULT_FORK_AUTHORIZED_INITIATOR, forcedCollateral);
      const approveHash = await testClient.writeContract({
        address: WETH,
        abi: [
          {
            type: "function",
            name: "approve",
            stateMutability: "nonpayable",
            inputs: [
              { name: "spender", type: "address" },
              { name: "amount", type: "uint256" },
            ],
            outputs: [{ type: "bool" }],
          },
        ] as const,
        functionName: "approve",
        args: [uniswap.router, forcedCollateral],
        account: DEFAULT_FORK_AUTHORIZED_INITIATOR,
      });
      await testClient.waitForTransactionReceipt({ hash: approveHash });

      let revertMessage = "";
      try {
        await testClient.simulateContract({
          address: uniswap.router,
          abi: [
            {
              type: "function",
              name: "exactInputSingle",
              stateMutability: "payable",
              inputs: [
                {
                  name: "params",
                  type: "tuple",
                  components: [
                    { name: "tokenIn", type: "address" },
                    { name: "tokenOut", type: "address" },
                    { name: "fee", type: "uint24" },
                    { name: "recipient", type: "address" },
                    { name: "amountIn", type: "uint256" },
                    { name: "amountOutMinimum", type: "uint256" },
                    { name: "sqrtPriceLimitX96", type: "uint160" },
                  ],
                },
              ],
              outputs: [{ name: "amountOut", type: "uint256" }],
            },
          ] as const,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn: WETH,
              tokenOut: USDC,
              fee: swapFee,
              recipient: DEFAULT_FORK_AUTHORIZED_INITIATOR,
              amountIn: forcedCollateral,
              amountOutMinimum: oracleFloor,
              sqrtPriceLimitX96: 0n,
            },
          ],
          account: DEFAULT_FORK_AUTHORIZED_INITIATOR,
        });
        expect.fail("expected Uniswap exactInputSingle to revert with oracle floor as amountOutMinimum");
      } catch (error) {
        revertMessage = extractRevertMessage(error);
        // eslint-disable-next-line no-console
        console.info("adversarial_slippage_revert", {
          message: revertMessage,
          attributableToFloor: isSlippageFloorRevert(revertMessage),
          amountOutMinimum: oracleFloor.toString(),
          note: "Same amountOutMinimum LiquidationFlashReceiver._oracleMinDebtOut would pass to the router",
        });
      }

      expect(isSlippageFloorRevert(revertMessage)).toBe(true);
      expect(isAaveDustRevert(revertMessage)).toBe(false);
    } finally {
      await dumpFork.stop();
    }
  }, 300_000);

  it("flashLoanSimple reverts cleanly when oracle floor fires inside executeOperation", async () => {
    if (uniswap === undefined || uniswap.quoterV2 === undefined) {
      throw new Error("UniswapV3 (with quoterV2) missing from dex registry for base");
    }
    // Full Aave callback path (not bare executeOperation): initiator → flashLoanSimple →
    // executeOperation → liquidationCall → swap with oracle floor → revert + unwind.
    // Receiver swapFee must match the dumped pool (500). 50 bps is testability only —
    // same require/router path as production 200 bps (threshold arithmetic differs only).
    // Large positions: 50% close leaves debt+collateral above Aave v3.3 MIN_LEFTOVER (~$500).
    // flashLoanSimple pulls USDC from Aave — no liquidator ERC20 funding required.
    const swapFee = 500;
    const adversarialSlippageBps = 50n;
    const dumpChunk = parseEther("5");
    const maxDumpChunks = 40;
    const minDebtToCover = 50_000_000_000n; // 50_000 USDC

    const liquidationCase = await findHistoricalLiquidationCase(forkSourceRpc!, pool, 5_000_000n, {
      collateralAsset: WETH,
      debtAsset: USDC,
      minDebtToCover,
    });

    const e2eFork = await createManagedAnvilFork({
      forkUrl: forkSourceRpc!,
      port: Number(process.env.ANVIL_PORT ?? "8545") + 4,
      blockNumber: liquidationCase.snapshotBlock,
    });
    try {
      const publicClient = createForkPublicClient(e2eFork.rpcUrl);
      const testClient = createForkTestClient(e2eFork.rpcUrl);
      const e2eReceiver = await deployLiquidationFlashReceiver(e2eFork.rpcUrl, artifact, {
        swapFee,
        swapSlippageBps: adversarialSlippageBps,
      });

      const hfAtFork = await readHealthFactor(publicClient, pool, liquidationCase.user);
      expect(isUnderwaterHealthFactor(hfAtFork)).toBe(true);

      // Prefer historical event amount (known to succeed on-chain); else protocol-capped 50%/100%.
      const sized = await sizeLiquidationDebtToCover({
        client: publicClient,
        pool,
        user: liquidationCase.user,
        debtAsset: USDC,
        healthFactor: hfAtFork,
      });
      const debtToCover = liquidationCase.debtToCover > 0n
        ? liquidationCase.debtToCover
        : sized.debtToCover;
      expect(debtToCover).toBeGreaterThanOrEqual(minDebtToCover / 2n);

      // Dump-loop probe: modest size so pre-dump quote clears the 50 bps floor.
      // Large historical collateral (~86 WETH) already fails the floor from natural impact.
      const dumpProbe = parseEther("0.25");
      const oracleFloor = await publicClient.readContract({
        address: e2eReceiver,
        abi: liquidationFlashReceiverAbi,
        functionName: "oracleMinDebtOut",
        args: [WETH, USDC, dumpProbe],
      });
      expect(oracleFloor).toBeGreaterThan(0n);

      let quoteAfter = await quoteExactInputSingle({
        client: publicClient,
        quoter: uniswap.quoterV2,
        tokenIn: WETH,
        tokenOut: USDC,
        fee: swapFee,
        amountIn: dumpProbe,
      });
      // eslint-disable-next-line no-console
      console.info("e2e_adversarial_before_dump", {
        user: liquidationCase.user,
        snapshotBlock: liquidationCase.snapshotBlock.toString(),
        healthFactor: hfAtFork.toString(),
        historicalDebtToCover: liquidationCase.debtToCover.toString(),
        debtToCover: debtToCover.toString(),
        userReserveDebt: sized.userReserveDebt.toString(),
        dumpProbe: dumpProbe.toString(),
        liquidatedCollateralHint: liquidationCase.liquidatedCollateralAmount.toString(),
        swapSlippageBps: adversarialSlippageBps.toString(),
        oracleFloor: oracleFloor.toString(),
        quoteBefore: quoteAfter.toString(),
        clearsFloor: quoteAfter >= oracleFloor,
      });
      expect(quoteAfter >= oracleFloor).toBe(true);

      const dumpTxs: string[] = [];
      for (let i = 0; i < maxDumpChunks && quoteAfter >= oracleFloor; i += 1) {
        const dumpTx = await dumpUniswapV3Pool({
          rpcUrl: e2eFork.rpcUrl,
          tokenIn: WETH,
          tokenOut: USDC,
          amountIn: dumpChunk,
          fee: swapFee,
          router: uniswap.router,
        });
        dumpTxs.push(dumpTx);
        quoteAfter = await quoteExactInputSingle({
          client: publicClient,
          quoter: uniswap.quoterV2,
          tokenIn: WETH,
          tokenOut: USDC,
          fee: swapFee,
          amountIn: dumpProbe,
        });
      }
      // eslint-disable-next-line no-console
      console.info("e2e_adversarial_after_dump", {
        dumpChunks: dumpTxs.length,
        oracleFloor: oracleFloor.toString(),
        quoteAfter: quoteAfter.toString(),
        floorBeatsQuote: quoteAfter < oracleFloor,
        note: "Aave oracle untouched; Uniswap degraded before flashLoanSimple",
      });
      expect(quoteAfter < oracleFloor).toBe(true);

      const params = encodeLiquidationRoute({
        collateralAsset: liquidationCase.collateralAsset,
        debtAsset: liquidationCase.debtAsset,
        user: liquidationCase.user,
        debtToCover,
        minDebtOut: 0n,
        receiveAToken: false,
        fee: 500,
      });

      const balWethBefore = await readErc20Balance(publicClient, WETH, e2eReceiver);
      const balUsdcBefore = await readErc20Balance(publicClient, USDC, e2eReceiver);
      expect(balWethBefore).toBe(0n);
      expect(balUsdcBefore).toBe(0n);

      let revertMessage = "";
      try {
        await simulateFlashLoanSimple({
          client: publicClient,
          rpcUrl: e2eFork.rpcUrl,
          pool,
          receiver: e2eReceiver,
          debtAsset: USDC,
          amount: debtToCover,
          params,
        });
        expect.fail("expected flashLoanSimple to revert when oracle floor fires inside callback");
      } catch (error) {
        revertMessage = extractRevertMessage(error);
        // eslint-disable-next-line no-console
        console.info("e2e_adversarial_flashLoanSimple_revert", {
          message: revertMessage,
          attributableToFloor: isSlippageFloorRevert(revertMessage),
          isDust: isAaveDustRevert(revertMessage),
          note: "Full path: flashLoanSimple → executeOperation → liquidationCall → swap floor",
        });
      }
      expect(isSlippageFloorRevert(revertMessage)).toBe(true);
      expect(isAaveDustRevert(revertMessage)).toBe(false);

      // Mine the reverting call and prove no stuck balances (atomic unwind).
      let minedStatus: string = "threw";
      try {
        const hash = await testClient.writeContract({
          address: pool,
          abi: [
            {
              type: "function",
              name: "flashLoanSimple",
              stateMutability: "nonpayable",
              inputs: [
                { name: "receiverAddress", type: "address" },
                { name: "asset", type: "address" },
                { name: "amount", type: "uint256" },
                { name: "params", type: "bytes" },
                { name: "referralCode", type: "uint16" },
              ],
              outputs: [],
            },
          ] as const,
          functionName: "flashLoanSimple",
          args: [e2eReceiver, USDC, debtToCover, params, 0],
          account: DEFAULT_FORK_AUTHORIZED_INITIATOR,
          gas: 8_000_000n,
        });
        const receipt = await testClient.waitForTransactionReceipt({ hash });
        minedStatus = receipt.status;
      } catch (error) {
        minedStatus = `threw:${extractRevertMessage(error).slice(0, 120)}`;
      }

      const balWethAfter = await readErc20Balance(publicClient, WETH, e2eReceiver);
      const balUsdcAfter = await readErc20Balance(publicClient, USDC, e2eReceiver);
      // eslint-disable-next-line no-console
      console.info("e2e_adversarial_unwind", {
        minedStatus,
        balWethBefore: balWethBefore.toString(),
        balUsdcBefore: balUsdcBefore.toString(),
        balWethAfter: balWethAfter.toString(),
        balUsdcAfter: balUsdcAfter.toString(),
        note: "Receiver must not retain flash / collateral residue after floor revert",
      });
      expect(balWethAfter).toBe(0n);
      expect(balUsdcAfter).toBe(0n);
      expect(minedStatus === "reverted" || minedStatus.startsWith("threw:")).toBe(true);
    } finally {
      await e2eFork.stop();
    }
  }, 420_000);

  it("happy-path: flashLoanSimple completes liquidation+swap above oracle floor with clean residual", async () => {
    if (uniswap === undefined || uniswap.quoterV2 === undefined) {
      throw new Error("UniswapV3 (with quoterV2) missing from dex registry for base");
    }
    // Production path: authorizedInitiator → flashLoanSimple → executeOperation →
    // liquidationCall → oracle-floor swap (fee field 8) → repay amount+premium.
    // Prefer historical WETH→USDC 500-fee pool (deepest Base Uniswap V3 liquid pair).
    const swapFee = 500 as const;
    const minDebtToCover = 50_000_000_000n; // 50_000 USDC — large enough to clear dust + show margin

    const liquidationCase = await findHistoricalLiquidationCase(forkSourceRpc!, pool, 5_000_000n, {
      collateralAsset: WETH,
      debtAsset: USDC,
      minDebtToCover,
    });

    const happyFork = await createManagedAnvilFork({
      forkUrl: forkSourceRpc!,
      port: Number(process.env.ANVIL_PORT ?? "8545") + 5,
      blockNumber: liquidationCase.snapshotBlock,
    });
    try {
      const publicClient = createForkPublicClient(happyFork.rpcUrl);
      const testClient = createForkTestClient(happyFork.rpcUrl);
      const happyReceiver = await deployLiquidationFlashReceiver(happyFork.rpcUrl, artifact, {
        swapFee,
        swapSlippageBps: 200n,
      });

      const hfAtFork = await readHealthFactor(publicClient, pool, liquidationCase.user);
      expect(isUnderwaterHealthFactor(hfAtFork)).toBe(true);

      const sized = await sizeLiquidationDebtToCover({
        client: publicClient,
        pool,
        user: liquidationCase.user,
        debtAsset: USDC,
        healthFactor: hfAtFork,
      });
      const debtToCover = liquidationCase.debtToCover > 0n
        ? liquidationCase.debtToCover
        : sized.debtToCover;
      expect(debtToCover).toBeGreaterThanOrEqual(minDebtToCover / 2n);

      const flashPremiumTotal = await publicClient.readContract({
        address: pool,
        abi: [
          {
            type: "function",
            name: "FLASHLOAN_PREMIUM_TOTAL",
            stateMutability: "view",
            inputs: [],
            outputs: [{ type: "uint128" }],
          },
        ] as const,
        functionName: "FLASHLOAN_PREMIUM_TOTAL",
      });
      const premium = (debtToCover * BigInt(flashPremiumTotal)) / 10_000n;
      const owe = debtToCover + premium;

      const params = encodeLiquidationRoute({
        collateralAsset: liquidationCase.collateralAsset,
        debtAsset: liquidationCase.debtAsset,
        user: liquidationCase.user,
        debtToCover,
        minDebtOut: 0n,
        receiveAToken: false,
        fee: swapFee,
      });
      const decoded = await readDecodedRouteParams(publicClient, happyReceiver, params);
      expect(decoded[0]).toBe(0);
      expect(decoded[1].toLowerCase()).toBe(liquidationCase.collateralAsset.toLowerCase());
      expect(decoded[2].toLowerCase()).toBe(liquidationCase.debtAsset.toLowerCase());
      expect(decoded[3].toLowerCase()).toBe(liquidationCase.user.toLowerCase());
      expect(decoded[4]).toBe(debtToCover);
      expect(decoded[5]).toBe(0n);
      expect(decoded[6]).toBe(false);
      expect(decoded[7]).toBe(swapFee);

      // eslint-disable-next-line no-console
      console.info("e2e_happy_path_provenance", {
        user: liquidationCase.user,
        snapshotBlock: liquidationCase.snapshotBlock.toString(),
        healthFactor: hfAtFork.toString(),
        collateralAsset: liquidationCase.collateralAsset,
        debtAsset: liquidationCase.debtAsset,
        debtToCover: debtToCover.toString(),
        flashPremiumTotal: flashPremiumTotal.toString(),
        premium: premium.toString(),
        owe: owe.toString(),
        fee: swapFee,
        swapSlippageBps: 200,
        note: "Production 8-field encoding; authorizedInitiator flashLoanSimple happy path",
      });

      const balWethBefore = await readErc20Balance(publicClient, WETH, happyReceiver);
      const balUsdcBefore = await readErc20Balance(publicClient, USDC, happyReceiver);
      expect(balWethBefore).toBe(0n);
      expect(balUsdcBefore).toBe(0n);

      // Preflight simulate — must succeed (floor cleared by healthy Uniswap price).
      await simulateFlashLoanSimple({
        client: publicClient,
        rpcUrl: happyFork.rpcUrl,
        pool,
        receiver: happyReceiver,
        debtAsset: USDC,
        amount: debtToCover,
        params,
      });

      const hash = await testClient.writeContract({
        address: pool,
        abi: [
          {
            type: "function",
            name: "flashLoanSimple",
            stateMutability: "nonpayable",
            inputs: [
              { name: "receiverAddress", type: "address" },
              { name: "asset", type: "address" },
              { name: "amount", type: "uint256" },
              { name: "params", type: "bytes" },
              { name: "referralCode", type: "uint16" },
            ],
            outputs: [],
          },
        ] as const,
        functionName: "flashLoanSimple",
        args: [happyReceiver, USDC, debtToCover, params, 0],
        account: DEFAULT_FORK_AUTHORIZED_INITIATOR,
        gas: 8_000_000n,
      });
      const receipt = await testClient.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe("success");

      const balWethAfter = await readErc20Balance(publicClient, WETH, happyReceiver);
      const balUsdcAfter = await readErc20Balance(publicClient, USDC, happyReceiver);
      // Collateral must be fully swapped; leftover debt asset is liquidation bonus (profit).
      const profitMarginUsdc = balUsdcAfter;
      expect(balWethAfter).toBe(0n);
      expect(profitMarginUsdc).toBeGreaterThan(0n);

      // eslint-disable-next-line no-console
      console.info("e2e_happy_path_profit", {
        minedStatus: receipt.status,
        txHash: hash,
        balWethAfter: balWethAfter.toString(),
        balUsdcAfter: balUsdcAfter.toString(),
        owe: owe.toString(),
        profitMarginUsdcRaw: profitMarginUsdc.toString(),
        profitMarginUsdc: Number(profitMarginUsdc) / 1e6,
        note: "Swap cleared oracle floor; Aave pulled owe; leftover USDC = bonus − premium − impact",
      });

      // Sweep profit via owner rescue so receiver ends with zero residual of either asset.
      const rescueHash = await testClient.writeContract({
        address: happyReceiver,
        abi: artifact.abi,
        functionName: "rescue",
        args: [USDC, DEFAULT_FORK_AUTHORIZED_INITIATOR, profitMarginUsdc],
        account: DEFAULT_FORK_AUTHORIZED_INITIATOR,
      });
      await testClient.waitForTransactionReceipt({ hash: rescueHash });
      const balWethFinal = await readErc20Balance(publicClient, WETH, happyReceiver);
      const balUsdcFinal = await readErc20Balance(publicClient, USDC, happyReceiver);
      // eslint-disable-next-line no-console
      console.info("e2e_happy_path_clean", {
        balWethFinal: balWethFinal.toString(),
        balUsdcFinal: balUsdcFinal.toString(),
        note: "After rescue: no stuck collateral or debt residue on receiver",
      });
      expect(balWethFinal).toBe(0n);
      expect(balUsdcFinal).toBe(0n);
    } finally {
      await happyFork.stop();
    }
  }, 420_000);
});

function isSlippageFloorRevert(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("too little received")
    || lower.includes("toolittlereceived")
    || lower.includes("stf")
    || lower.includes("amountoutminimum")
    || lower.includes("slippage")
    || lower.includes("0xc9f52c71") // TooLittleReceived()
    || lower.includes("0x08c379a0"); // Error(string) — Uniswap V3 "Too little received"
}

function isAaveDustRevert(message: string): boolean {
  return message.includes("0xb629b0e4") || message.includes("MustNotLeaveDust");
}

async function setSwapSlippage(
  testClient: ReturnType<typeof createForkTestClient>,
  receiver: Address,
  artifact: ReturnType<typeof loadLiquidationFlashReceiverArtifact>,
  bps: bigint,
): Promise<void> {
  const hash = await testClient.writeContract({
    address: receiver,
    abi: artifact.abi,
    functionName: "setSwapSlippageBps",
    args: [bps],
    account: DEFAULT_FORK_AUTHORIZED_INITIATOR,
  });
  await testClient.waitForTransactionReceipt({ hash });
}

const quoterV2Abi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint256" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

async function quoteExactInputSingle(input: {
  readonly client: ReturnType<typeof createForkPublicClient>;
  readonly quoter: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly fee: number;
  readonly amountIn: bigint;
}): Promise<bigint> {
  const result = await input.client.simulateContract({
    address: input.quoter,
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        amountIn: input.amountIn,
        fee: input.fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  return result.result[0];
}
