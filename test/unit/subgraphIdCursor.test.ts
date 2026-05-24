import { describe, expect, it } from "vitest";
import { SUBGRAPH_ID_CURSOR_START, nextSubgraphIdCursor } from "../../src/utils/subgraphIdCursor";

describe("subgraphIdCursor", () => {
  it("starts at zero address", () => {
    expect(SUBGRAPH_ID_CURSOR_START).toBe("0x0000000000000000000000000000000000000000");
  });

  it("advances cursor from last row id", () => {
    const rows = [{ id: "0x0000000000000000000000000000000000000001" }, { id: "0x0000000000000000000000000000000000000002" }];
    expect(nextSubgraphIdCursor(rows, SUBGRAPH_ID_CURSOR_START)).toBe(rows[1]!.id);
  });
});
