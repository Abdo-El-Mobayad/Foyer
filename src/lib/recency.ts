// The "modified within" window: presets, the cutoff it resolves to, and how
// an age reads in a row. Pure (no Tauri, no DOM), so it runs in tests.
//
// Every window is a ROLLING duration, not a calendar boundary. "24h" means the
// last 24 hours, not "since midnight"; a file leaves the window as the clock
// moves, with no filesystem event behind it, which is why the overlay re-runs
// its query on a timer rather than waiting for the watcher.

export interface Preset {
  id: string;
  minutes: number;
}

export const PRESETS: readonly Preset[] = [
  { id: "3d", minutes: 4320 },
  { id: "7d", minutes: 10080 },
];

/** The window a filter starts on when nothing is stored. */
export const DEFAULT_MINUTES = 4320;

const MIN_MINUTES = 1;
/** One year. Past this the filter stops being a filter. */
const MAX_MINUTES = 525_600;

/** Bound a window to something meaningful; a corrupted value falls back to the
 *  default rather than to an arbitrary number, matching `clampReadingWidth`. */
export function clampMinutes(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MINUTES;
  return Math.round(Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, n)));
}

/** The epoch-millis cutoff a window resolves to right now. */
export function sinceMs(minutes: number, now: number): number {
  return now - clampMinutes(minutes) * 60_000;
}

/** How a window reads in prose: "3d", "7d", "36h". Hours up to two days,
 *  because "36h" is how people say it and "1.5d" is not. */
export function windowLabel(minutes: number): string {
  const m = clampMinutes(minutes);
  if (m < 60) return `${m}m`;
  if (m % 60 === 0 && m <= 2880) return `${m / 60}h`;
  if (m % 1440 === 0) return `${m / 1440}d`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}

/** The next wider preset, or null when the window is already at or past the
 *  widest one. Drives the "widen" action on the empty state. */
export function nextPreset(minutes: number): Preset | null {
  return PRESETS.find((p) => p.minutes > clampMinutes(minutes)) ?? null;
}

/** A row's age, at most 4 characters so `${age} ago` fits an 8ch column.
 *  Weeks roll into years through weeks, not days, so there is no gap at the
 *  year boundary where a 364-day file would read "0y". A future mtime (clock
 *  skew, or a file dated ahead) clamps to "<1m" rather than going negative. */
export function formatAge(modified: number, now: number): string {
  const diff = Math.max(0, now - modified);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return `${weeks}w`;
  return `${Math.floor(weeks / 52)}y`;
}
