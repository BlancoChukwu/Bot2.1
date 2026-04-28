import { formatEther, type Hash } from "viem";
import type { LiquidationCandidate } from "../protocols/aaveV3";

type TelegramFetch = (
  url: string,
  init: { readonly method: "POST"; readonly headers: Record<string, string>; readonly body: string },
) => Promise<{ readonly ok: boolean }>;

export interface TelegramAlertInput {
  readonly token: string | undefined;
  readonly chatId: string | undefined;
  readonly candidate: LiquidationCandidate;
  readonly mode: "simulated" | "executed";
  readonly evProfitWei: bigint;
  readonly txHash?: Hash;
  readonly fetcher?: TelegramFetch;
}

export async function sendLiquidationAlert(input: TelegramAlertInput): Promise<void> {
  if (input.token === undefined || input.chatId === undefined) {
    return;
  }

  const fetcher: TelegramFetch = input.fetcher ?? fetch;
  const response = await fetcher(`https://api.telegram.org/bot${input.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: input.chatId,
      parse_mode: "Markdown",
      text: formatLiquidationMessage(input),
    }),
  });

  if (!response.ok) {
    throw new Error("Telegram liquidation alert failed");
  }
}

function formatLiquidationMessage(input: TelegramAlertInput): string {
  const title = input.mode === "executed" ? "EXECUTED liquidation" : "SIMULATED liquidation";
  const txLine = input.txHash === undefined ? "" : `\nTx: \`${input.txHash}\``;

  return [
    `*${title}*`,
    `Account: \`${input.candidate.account}\``,
    `Collateral: \`${input.candidate.collateralAsset}\``,
    `Debt: \`${input.candidate.debtAsset}\``,
    `Debt to cover: \`${input.candidate.debtToCover.toString()}\``,
    `EV: *${formatEther(input.evProfitWei)} ETH*`,
    `Health factor: \`${input.candidate.healthFactor.toString()}\`${txLine}`,
  ].join("\n");
}
