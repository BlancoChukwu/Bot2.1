import { describe, expect, it } from "vitest";
import { BaseError } from "viem";
import { decodeExecutionRevert, decodeRevertData } from "../../src/utils/revertDecoder";

describe("revertDecoder", () => {
  it("labels known flash-loan receiver selectors", () => {
    expect(decodeRevertData("0x34579b5e000000000000000000000000000000000000000000000000000000000000"))
      .toBe("InsufficientDebtForRepay");
  });

  it("walks nested viem errors and surfaces custom error names", () => {
    const error = new BaseError("Execution reverted", {
      cause: new BaseError("reverted with custom error 'DebtAssetMismatch()'"),
    });
    const decoded = decodeExecutionRevert(error);
    expect(decoded).toContain("DebtAssetMismatch");
  });
});
