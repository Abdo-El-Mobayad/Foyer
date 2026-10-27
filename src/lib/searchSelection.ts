// Keeping the keyboard cursor still while results move underneath it.
//
// The overlay re-queries whenever the index changes, and a watcher batch does
// that on every save. Resetting the selection to the top on each response
// means saving a file while browsing throws the cursor away. Selecting by PATH
// instead of by index survives reordering, insertion and removal.

export interface Selectable {
  path: string;
}

/** Where `prevPath` landed in the new results, or 0 when it is gone (or there
 *  was no selection). Never returns an out-of-range index. */
export function reselect(prevPath: string | null, hits: readonly Selectable[]): number {
  if (hits.length === 0) return 0;
  if (!prevPath) return 0;
  const i = hits.findIndex((h) => h.path === prevPath);
  return i === -1 ? 0 : i;
}
