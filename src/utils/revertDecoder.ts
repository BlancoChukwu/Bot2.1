import { BaseError, type Hex } from "viem";

const knownErrorSignatures: Record<string, string> = {
  "0x3653732b": "HEALTH_FACTOR_NOT_BELOW_THRESHOLD",
  "0x366eb54d": "HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD",
  "0x4b602735": "OnlyPool",
  "0x5fc483c5": "OnlyOwner",
  "0xebbd4204": "DebtAssetMismatch",
  "0x34579b5e": "InsufficientDebtForRepay",
  "0x0dafab8f": "NoCollateralToSwap",
  "0x22a73446": "SPECIFIED_CURRENCY_NOT_BORROWED_BY_USER",
  "0x895f7dc8": "COLLATERAL_CANNOT_BE_LIQUIDATED",
  "0x7fea6f36": "INVALID_FLASHLOAN_EXECUTOR_RETURN",
  "0x692c45ea": "INVALID_HF",
};

const selectorPattern = /0x[a-fA-F0-9]{8}/g;

export function decodeExecutionRevert(error: unknown): string {
  const details = collectRevertMessages(error);
  if (details.length === 0) {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  const joined = [...new Set(details)].join(" | ");
  const labeled = labelKnownSelectors(joined);
  const nested = extractNestedRevertReason(joined);
  if (nested !== undefined && !labeled.includes(nested)) {
    return `${labeled} | inner: ${nested}`;
  }
  return labeled;
}

export function isExecutionRevertError(error: unknown): boolean {
  const message = decodeExecutionRevert(error).toLowerCase();
  return message.includes("revert")
    || message.includes("execution reverted")
    || message.includes("estimategas");
}

export function decodeRevertData(data: Hex | string | undefined): string | undefined {
  if (data === undefined || data.length < 10) {
    return undefined;
  }
  const normalized = data.startsWith("0x") ? data : `0x${data}`;
  const selector = normalized.slice(0, 10).toLowerCase();
  const known = knownErrorSignatures[selector];
  if (known !== undefined) {
    return known;
  }
  return `unknown_selector:${selector}`;
}

function collectRevertMessages(error: unknown): string[] {
  const details: string[] = [];
  if (error instanceof BaseError) {
    if (error.shortMessage.length > 0) {
      details.push(error.shortMessage);
    }
    const walked = error.walk();
    if (walked instanceof Error && walked.message.length > 0) {
      details.push(walked.message);
    }
    const maybeDetails = (error as unknown as { details?: unknown }).details;
    if (typeof maybeDetails === "string" && maybeDetails.length > 0) {
      details.push(maybeDetails);
    }
    const maybeData = (error as unknown as { data?: unknown }).data;
    if (typeof maybeData === "string") {
      const decoded = decodeRevertData(maybeData);
      if (decoded !== undefined) {
        details.push(decoded);
      }
    }
    const maybeMeta = (error as unknown as { metaMessages?: unknown }).metaMessages;
    if (Array.isArray(maybeMeta)) {
      for (const message of maybeMeta) {
        if (typeof message === "string" && message.length > 0) {
          details.push(message);
        }
      }
    }
    const maybeCause = (error as unknown as { cause?: unknown }).cause;
    if (maybeCause !== undefined) {
      details.push(...collectRevertMessages(maybeCause));
    }
  } else if (error instanceof Error) {
    details.push(error.message);
    const maybeCause = (error as { cause?: unknown }).cause;
    if (maybeCause !== undefined) {
      details.push(...collectRevertMessages(maybeCause));
    }
  } else if (typeof error === "string") {
    details.push(error);
  }

  return details;
}

function labelKnownSelectors(message: string): string {
  let output = message;
  for (const [signature, name] of Object.entries(knownErrorSignatures)) {
    if (output.toLowerCase().includes(signature)) {
      output = `${name} | ${output}`;
    }
  }
  return output;
}

function extractNestedRevertReason(message: string): string | undefined {
  const reasonMatch = message.match(/reverted with reason string ['"]([^'"]+)['"]/i);
  if (reasonMatch?.[1] !== undefined) {
    return reasonMatch[1];
  }
  const customErrorMatch = message.match(/reverted with custom error ['"]([^'"]+)['"]/i);
  if (customErrorMatch?.[1] !== undefined) {
    return customErrorMatch[1];
  }
  const selectors = message.match(selectorPattern);
  if (selectors === null) {
    return undefined;
  }
  const labels = selectors
    .map((selector) => knownErrorSignatures[selector.toLowerCase()] ?? selector)
    .filter((entry, index, all) => all.indexOf(entry) === index);
  return labels.length > 0 ? labels.join(", ") : undefined;
}
