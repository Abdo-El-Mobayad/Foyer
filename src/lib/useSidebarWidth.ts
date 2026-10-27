import { useCallback, useEffect, useState } from "react";
import { clampSidebarWidth, readSidebarWidth } from "./prefs";

/**
 * The user's sidebar width, restored from localStorage and kept honest
 * against the window size. Handed to the layout as a CSS variable rather
 * than kept in the store, so a drag never re-renders the tree.
 */
export function useSidebarWidth(): {
  width: number;
  setWidth: (px: number) => void;
} {
  const [width, setWidthState] = useState(readSidebarWidth);

  const setWidth = useCallback((px: number) => {
    setWidthState(clampSidebarWidth(px, window.innerWidth));
  }, []);

  useEffect(() => {
    const onResize = () => setWidthState((w) => clampSidebarWidth(w, window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return { width, setWidth };
}
