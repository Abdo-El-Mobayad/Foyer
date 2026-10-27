import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeReadingWidth, readReadingWidth, writeReadingWidth, type ReadingWidth } from "../lib/prefs";

/**
 * The reading column of rendered Markdown, restored from localStorage.
 * `set` is the live value during a drag; `commit` also persists it. One
 * MarkdownView is mounted at a time, so local state is the whole truth and
 * the next document reads the stored value on mount. The article gets the
 * value as a CSS variable, so a drag never re-renders the rendered HTML.
 */
export function useReadingWidth(): {
  width: ReadingWidth;
  set: (w: Partial<ReadingWidth>) => void;
  commit: (w: Partial<ReadingWidth>) => void;
} {
  const [width, setWidth] = useState(readReadingWidth);
  const latest = useRef(width);
  useEffect(() => {
    latest.current = width;
  }, [width]);

  const set = useCallback((w: Partial<ReadingWidth>) => {
    setWidth((prev) => normalizeReadingWidth({ ...prev, ...w }));
  }, []);

  const commit = useCallback((w: Partial<ReadingWidth>) => {
    const next = normalizeReadingWidth({ ...latest.current, ...w });
    latest.current = next;
    setWidth(next);
    writeReadingWidth(next);
  }, []);

  return { width, set, commit };
}
