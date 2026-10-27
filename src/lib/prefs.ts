// Device-local preferences: the sidebar width, whether the sidebar is shown,
// the reading column of rendered Markdown, the last editing layout, and each
// mount's view state (what was expanded, which tabs were open). All in
// localStorage, all disposable.

import { clampMinutes, DEFAULT_MINUTES } from "./recency";

const SIDEBAR_WIDTH_KEY = "foyer.sidebarWidth";
const SIDEBAR_SHOWN_KEY = "foyer.sidebarShown";
const VIEW_PREFIX = "foyer.view:";

export const SIDEBAR_WIDTH_DEFAULT = 272;
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 600;

/** Clamp a width to the usable range, leaving room for the preview pane.
 *  NaN (a corrupted stored value) falls back to the default. */
export function clampSidebarWidth(px: number, viewport = 1200): number {
  if (!Number.isFinite(px)) return SIDEBAR_WIDTH_DEFAULT;
  const max = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, viewport - 360));
  return Math.round(Math.min(max, Math.max(SIDEBAR_WIDTH_MIN, px)));
}

export function readSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw === null) return SIDEBAR_WIDTH_DEFAULT;
    return clampSidebarWidth(Number(raw), window.innerWidth);
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

export function writeSidebarWidth(px: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(px)));
  } catch {
    /* storage unavailable */
  }
}

export function readSidebarShown(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_SHOWN_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeSidebarShown(shown: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_SHOWN_KEY, shown ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

// ---- Reading column ---------------------------------------------------
// The measure of rendered Markdown. `px` null keeps the CSS default (78ch);
// `full` fills the pane whatever `px` says, and `px` survives so unticking
// Full width lands back on the last dragged width.

const READING_WIDTH_KEY = "foyer.readingWidth";

export interface ReadingWidth {
  px: number | null;
  full: boolean;
}

export const READING_WIDTH_DEFAULT: ReadingWidth = { px: null, full: false };
export const READING_WIDTH_MIN = 420;
export const READING_WIDTH_MAX = 2400;

/** Clamp a custom measure to the usable range. A corrupted value falls back
 *  to null, the CSS default, rather than to an arbitrary number. */
export function clampReadingWidth(px: number | null): number | null {
  if (px === null || !Number.isFinite(px)) return null;
  return Math.round(Math.min(READING_WIDTH_MAX, Math.max(READING_WIDTH_MIN, px)));
}

export function normalizeReadingWidth(w: Partial<ReadingWidth> | null | undefined): ReadingWidth {
  if (!w) return READING_WIDTH_DEFAULT;
  return { px: clampReadingWidth(typeof w.px === "number" ? w.px : null), full: w.full === true };
}

export function readReadingWidth(): ReadingWidth {
  try {
    const raw = localStorage.getItem(READING_WIDTH_KEY);
    if (!raw) return READING_WIDTH_DEFAULT;
    return normalizeReadingWidth(JSON.parse(raw) as Partial<ReadingWidth>);
  } catch {
    return READING_WIDTH_DEFAULT;
  }
}

export function writeReadingWidth(w: ReadingWidth): void {
  try {
    localStorage.setItem(READING_WIDTH_KEY, JSON.stringify(normalizeReadingWidth(w)));
  } catch {
    /* storage unavailable */
  }
}

// ---- Editing mode -------------------------------------------------------
// Which editing layout Ctrl+E and a new note open: the editor alone, or the
// editor beside a live preview. Whatever was picked last.

const EDIT_MODE_KEY = "foyer.editMode";

export function readEditMode(): "edit" | "split" {
  try {
    return localStorage.getItem(EDIT_MODE_KEY) === "split" ? "split" : "edit";
  } catch {
    return "edit";
  }
}

export function writeEditMode(mode: "edit" | "split"): void {
  try {
    localStorage.setItem(EDIT_MODE_KEY, mode);
  } catch {
    /* storage unavailable */
  }
}

/** What a mount looked like when it was last on screen. `recentMinutes` is the
 *  modified-within window; it is per mount because repos have different
 *  rhythms, and a state written before 0.4.0 simply has no field and takes the
 *  default. Whether the filter was ON is deliberately NOT stored: each search
 *  starts unfiltered unless opened from the sidebar's recent button. */
export interface ViewState {
  expanded: string[];
  tabs: string[];
  active: string | null;
  recentMinutes: number;
}

export const EMPTY_VIEW: ViewState = {
  expanded: [],
  tabs: [],
  active: null,
  recentMinutes: DEFAULT_MINUTES,
};

export function readViewState(mountId: string): ViewState {
  try {
    const raw = localStorage.getItem(VIEW_PREFIX + mountId);
    if (!raw) return EMPTY_VIEW;
    const v = JSON.parse(raw) as Partial<ViewState>;
    return {
      expanded: Array.isArray(v.expanded) ? v.expanded.filter((s) => typeof s === "string") : [],
      tabs: Array.isArray(v.tabs) ? v.tabs.filter((s) => typeof s === "string") : [],
      active: typeof v.active === "string" ? v.active : null,
      recentMinutes:
        typeof v.recentMinutes === "number" ? clampMinutes(v.recentMinutes) : DEFAULT_MINUTES,
    };
  } catch {
    return EMPTY_VIEW;
  }
}

export function writeViewState(mountId: string, v: ViewState): void {
  try {
    localStorage.setItem(VIEW_PREFIX + mountId, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

export function clearViewState(mountId: string): void {
  try {
    localStorage.removeItem(VIEW_PREFIX + mountId);
  } catch {
    /* storage unavailable */
  }
}
