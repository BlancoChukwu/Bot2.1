import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { parseEventPurityConfig, hfThresholdToWad } from "../../src/config/eventPurityConfig";
import { LocalPositionModel } from "../../src/monitors/localPositionModel";
import { BootstrapSnapshotStore, buildSnapshotFromModel } from "../../src/monitors/bootstrapSnapshotStore";

const weth = "0x4200000000000000000000000000000000000006" as const;
const user = "0x1111111111111111111111111111111111111111" as const;

describe("bootstrapSnapshotStore", () => {
  let tempDir = "";

  afterEach(async () => {
    if (tempDir.length > 0) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("loads fresh snapshots and applies them to the model", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bootstrap-snapshot-"));
    const filePath = join(tempDir, "snapshot.json");
    const purity = parseEventPurityConfig({});
    const model = new LocalPositionModel({
      purity,
      urgentHfWad: hfThresholdToWad(purity.localHfUrgent),
      watchHfWad: hfThresholdToWad(purity.localHfWatch),
    });
    model.registerReserve(weth, 8500n);
    model.seedFromOnChainSnapshot({
      account: user,
      blockNumber: 100n,
      eModeCategoryId: 0,
      healthFactorWad: 1_200_000_000_000_000_000n,
      totalCollateralBase: 1_000n,
      totalDebtBase: 100n,
      liquidationThreshold: 8_500n,
      reserves: [{ asset: weth, scaledCollateral: 1_000n, scaledDebt: 100n }],
    });

    const store = new BootstrapSnapshotStore({
      chain: "base",
      ttlHours: 24,
      diskPath: filePath,
    });
    await store.save(buildSnapshotFromModel(model, {
      chain: "base",
      discoverySource: "subgraph",
      blockNumber: 100n,
    }));

    const reloadModel = new LocalPositionModel({
      purity,
      urgentHfWad: hfThresholdToWad(purity.localHfUrgent),
      watchHfWad: hfThresholdToWad(purity.localHfWatch),
    });
    const cached = await store.loadIfFresh();
    expect(cached).toBeDefined();
    const seeded = store.applyToModel(reloadModel, cached!);
    expect(seeded).toBe(1);
    expect(reloadModel.size()).toBe(1);
  });
});
