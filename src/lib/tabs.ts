// Bounded tabs. Pure.
//
// Every distinct file opened used to add a tab for the life of the session.
// Tabs are now capped: past the cap, the least recently viewed tab that is
// not the one being opened is closed. `recent` is most-recent-first.

export const TAB_CAP = 40;

export interface TabState {
  tabs: string[];
  recent: string[];
}

/** Move `path` to the front of the recency list. */
export function touchRecent(recent: string[], path: string): string[] {
  return [path, ...recent.filter((p) => p !== path)];
}

/** Add `path` as a tab (if new) and mark it most recent, evicting the least
 *  recently viewed tabs beyond `cap`. Tab order is preserved. */
export function openTab(state: TabState, path: string, cap = TAB_CAP): TabState {
  const tabs = state.tabs.includes(path) ? state.tabs : [...state.tabs, path];
  let recent = touchRecent(state.recent, path);
  if (tabs.length <= cap) return { tabs, recent };
  // Rank every tab by recency (unknown = oldest), evict from the back.
  const rank = new Map<string, number>();
  recent.forEach((p, i) => rank.set(p, i));
  const byAge = tabs.filter((t) => t !== path).sort((a, b) => (rank.get(b) ?? Infinity) - (rank.get(a) ?? Infinity));
  const evict = new Set(byAge.slice(0, tabs.length - cap));
  const kept = tabs.filter((t) => !evict.has(t));
  recent = recent.filter((p) => !evict.has(p));
  return { tabs: kept, recent };
}

/** Drop tabs. Returns the surviving tabs and recency, plus the tab to make
 *  active if the current one went away (the neighbour of the first closed
 *  tab, as before), or null when nothing is left. */
export function closeTabs(
  state: TabState,
  paths: Iterable<string>,
  active: string | null,
): TabState & { active: string | null } {
  const gone = new Set(paths);
  if (gone.size === 0) return { ...state, active };
  const tabs = state.tabs.filter((t) => !gone.has(t));
  const recent = state.recent.filter((p) => !gone.has(p));
  let next = active;
  if (active !== null && gone.has(active)) {
    const i = state.tabs.indexOf(active);
    // Nearest survivor to the right of the closed tab's slot, else the last.
    const right = state.tabs.slice(i + 1).find((t) => !gone.has(t));
    next = right ?? tabs[tabs.length - 1] ?? null;
  }
  return { tabs, recent, active: next };
}
