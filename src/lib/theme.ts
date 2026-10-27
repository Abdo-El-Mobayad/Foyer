// Theme controller. The user cycles light, dark, system; the choice persists
// in localStorage. "system" follows the OS via prefers-color-scheme and
// updates live. The mode resolves to a concrete theme stamped as `data-theme`
// on the root element, so tokens.css only needs :root (light) plus
// [data-theme="dark"].

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "foyer.theme";
const MODES: ThemeMode[] = ["light", "dark", "system"];

const mql = () =>
  typeof window !== "undefined" && "matchMedia" in window
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

export function getThemeMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") return mql()?.matches ? "dark" : "light";
  return mode;
}

function paint(mode: ThemeMode) {
  document.documentElement.setAttribute("data-theme", resolveTheme(mode));
}

export function setThemeMode(mode: ThemeMode) {
  try {
    if (mode === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* storage unavailable: the choice just does not persist */
  }
  paint(mode);
}

/** Advance to the next mode in the cycle and apply it; returns the new mode. */
export function cycleThemeMode(): ThemeMode {
  const next = MODES[(MODES.indexOf(getThemeMode()) + 1) % MODES.length];
  setThemeMode(next);
  return next;
}

/** Call once at startup: paint the stored mode and keep "system" live. */
export function initTheme(): () => void {
  paint(getThemeMode());
  const m = mql();
  const onChange = () => {
    if (getThemeMode() === "system") paint("system");
  };
  m?.addEventListener?.("change", onChange);
  return () => m?.removeEventListener?.("change", onChange);
}
