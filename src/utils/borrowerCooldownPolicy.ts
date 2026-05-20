/** Dead-letter reasons that start a borrower cooldown (retry-storm prevention). */
const cooldownEligibleDeadLetterReasons = new Set([
  "final_simulation_failed",
  "receipt_reverted",
  "executor_exception",
  "send_failed",
]);

export function shouldApplyBorrowerCooldown(deadLetterReason: string): boolean {
  return cooldownEligibleDeadLetterReasons.has(deadLetterReason);
}
