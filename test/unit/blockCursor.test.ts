import { describe, expect, it, vi } from "vitest";
import { createBlockCursor } from "../../src/utils/blockCursor";

describe("BlockCursor", () => {
  it("loads zero when unset and persists block numbers in memory fallback", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const cursor = await createBlockCursor("base", { logger });
    expect(cursor.backend).toBe("memory");
    expect(logger.error).toHaveBeenCalledWith(
      "block_cursor_in_memory",
      expect.objectContaining({ chain: "base" }),
    );
    expect(await cursor.load()).toBe(0n);
    await cursor.save(12_345n);
    expect(await cursor.load()).toBe(12_345n);
  });

  it("isolates keys per chain in memory mode", async () => {
    const cursorA = await createBlockCursor("base");
    const cursorB = await createBlockCursor("optimism");
    await cursorA.save(10n);
    await cursorB.save(20n);
    expect(await cursorA.load()).toBe(10n);
    expect(await cursorB.load()).toBe(20n);
  });
});
