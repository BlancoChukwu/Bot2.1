/** Lexicographic cursor start for Graph `id_gt` pagination (avoids `skip`). */
export const SUBGRAPH_ID_CURSOR_START = "0x0000000000000000000000000000000000000000";

export function nextSubgraphIdCursor<T extends { readonly id: string }>(
  rows: readonly T[],
  currentCursor: string,
): string {
  if (rows.length === 0) {
    return currentCursor;
  }
  return rows[rows.length - 1]!.id;
}
