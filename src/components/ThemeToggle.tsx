import { useState } from "react";
import { cycleThemeMode, getThemeMode, type ThemeMode } from "../lib/theme";
import { IconMonitor, IconMoon, IconSun } from "./Icons";

const LABELS: Record<ThemeMode, string> = { light: "Light", dark: "Dark", system: "System" };

/** Cycles light, dark, system and persists the choice. */
export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(() => getThemeMode());
  const Icon = mode === "light" ? IconSun : mode === "dark" ? IconMoon : IconMonitor;
  return (
    <button
      type="button"
      className="icon-btn theme-toggle"
      onClick={() => setMode(cycleThemeMode())}
      title={`Theme: ${LABELS[mode]} (click to change)`}
      aria-label={`Theme: ${LABELS[mode]}. Click to change.`}
    >
      <Icon />
    </button>
  );
}
