/**
 * Live position-cache coverage vs bootstrap seed universe.
 * Distinct from bootstrap debtor coverage (withDebt / discovered-at-boot).
 */
export function computeLivePositionCoveragePct(
  positionCacheSize: number,
  usersSeeded: number,
): number {
  if (usersSeeded <= 0) {
    return 0;
  }
  return (positionCacheSize / usersSeeded) * 100;
}
