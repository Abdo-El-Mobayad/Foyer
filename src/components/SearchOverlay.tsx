import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { badgeOf } from "../lib/fileKinds";
import * as ipc from "../lib/ipc";
import type { SearchHit } from "../lib/ipc";
import { dirname, formatCount, formatDate } from "../lib/paths";
import { formatAge, nextPreset, PRESETS, sinceMs, windowLabel } from "../lib/recency";
import { reselect } from "../lib/searchSelection";
import { useStore } from "../store";
import { IconClock, IconFolder, IconSearch } from "./Icons";

/** How often a live window is re-evaluated. A rolling window expires with no
 *  filesystem event behind it, so nothing else would ever drop a file out of
 *  "modified in the last hour". One pass over an in-memory vector is cheap;
 *  what makes the refresh unobtrusive is that the selection follows its path
 *  rather than resetting to the top. */
const TICK_MS = 60_000;

/**
 * File-name search as a centered overlay, and the mount's modified-within
 * filter. Every whitespace-separated term must appear somewhere in the path;
 * the index ranks name matches first, unless the filter is on, in which case
 * it ranks by mtime and an empty query is legal.
 * Arrow keys move, Enter opens (a folder reveals and expands), Esc closes.
 */
export function SearchOverlay({ onClose }: { onClose: () => void }) {
  const mount = useStore((s) => s.mount);
  const indexStats = useStore((s) => s.indexStats);
  const armRecent = useStore((s) => s.searchArmRecent);
  const storedMinutes = useStore((s) => s.recentMinutes);

  const [query, setQuery] = useState("");
  const [recentOn, setRecentOn] = useState(armRecent);
  const [minutes, setMinutes] = useState(storedMinutes);
  const [custom, setCustom] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<"idle" | "building" | "error">("idle");
  // WHICH FILE is selected, never which row. `active` is derived from it.
  const [selPath, setSelPath] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const timer = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const seq = useRef(0);

  // The selected row, recomputed from the selected path every time the results
  // change. A file that survives a refresh keeps the cursor; one that drops out
  // of the window hands it to the top of the list.
  const active = reselect(selPath, hits);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A live window goes stale on the clock alone. Tick only while filtering.
  useEffect(() => {
    if (!recentOn) return;
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [recentOn]);

  const hasQuery = query.trim().length > 0;
  const searching = hasQuery || recentOn;

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    // Recency browsing is legal with no query at all; relevance search is not.
    if (!searching || !mount) {
      setHits([]);
      setTotal(0);
      setSelPath(null);
      setStatus("idle");
      return;
    }
    const mine = ++seq.current;
    timer.current = window.setTimeout(async () => {
      try {
        const cutoff = recentOn ? sinceMs(minutes, Date.now()) : undefined;
        const r = await ipc.searchNames(mount.id, query, cutoff);
        if (mine !== seq.current) return;
        setHits(r.hits);
        setTotal(r.total);
        // Keep the cursor on the file it was on. A watcher batch re-runs this
        // effect on every save, and dropping back to the top would throw the
        // selection away mid-browse. Only a file that left the results loses it.
        setSelPath((prev) =>
          prev && r.hits.some((h) => h.path === prev) ? prev : (r.hits[0]?.path ?? null),
        );
        setStatus("idle");
      } catch (e) {
        if (mine !== seq.current) return;
        setStatus(ipc.errorText(e).startsWith("index-building") ? "building" : "error");
      }
    }, 90);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [query, mount, indexStats, searching, recentOn, minutes, now]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const open = useCallback(
    (hit: SearchHit) => {
      const st = useStore.getState();
      if (hit.isDir) {
        void st.revealPath(hit.path).then(() => st.setExpanded(hit.path, true));
      } else {
        void st.revealPath(hit.path);
        st.openFile(hit.path);
      }
      onClose();
    },
    [onClose],
  );

  /** Change the window and remember it for this mount. */
  const setWindow = useCallback((m: number, isCustom: boolean) => {
    setMinutes(m);
    setCustom(isCustom);
    setRecentOn(true);
    useStore.getState().setRecentMinutes(m);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown" && hits.length)
      setSelPath(hits[(active + 1) % hits.length].path);
    else if (e.key === "ArrowUp" && hits.length)
      setSelPath(hits[(active - 1 + hits.length) % hits.length].path);
    else if (e.key === "Enter" && hits[active]) open(hits[active]);
    else return;
    e.preventDefault();
  };

  // One string per query, so memoized rows compare terms by value.
  const termKey = query.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  const label = windowLabel(minutes);
  const wider = nextPreset(minutes);
  const capped = total > hits.length;

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        className="search-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Search file names"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="search-field">
          <IconSearch className="search-icon" />
          <input
            ref={inputRef}
            className="search-input"
            placeholder={
              recentOn
                ? `Narrow the last ${label}, or leave empty to see all of it`
                : mount
                  ? `Search file names in ${mount.name}`
                  : "Search"
            }
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="search-esc">esc</kbd>
        </div>

        <div className="search-filter">
          <label className="check">
            <input
              type="checkbox"
              checked={recentOn}
              onChange={(e) => {
                setRecentOn(e.target.checked);
                if (!e.target.checked) setCustom(false);
              }}
            />
            <span>Recently modified</span>
          </label>
          <div className="segmented" role="group" aria-label="Time window">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                className={recentOn && !custom && minutes === p.minutes ? "on" : ""}
                onClick={() => setWindow(p.minutes, false)}
              >
                {p.id}
              </button>
            ))}
            <button className={custom ? "on" : ""} onClick={() => setWindow(minutes, true)}>
              Custom
            </button>
          </div>
          {custom && (
            <span className="search-custom">
              <input
                type="number"
                min={1}
                value={Math.max(1, Math.round(minutes / 60))}
                aria-label="Custom window, in hours"
                onChange={(e) => setWindow(Number(e.target.value) * 60, true)}
              />
              <span>hours</span>
            </span>
          )}
        </div>

        {searching && (
          <ul className={`search-results${recentOn ? " aged" : ""}`} ref={listRef}>
            {status === "building" && <li className="search-none">Index is still building…</li>}
            {status === "error" && <li className="search-none">Search failed.</li>}
            {status === "idle" && hits.length === 0 && (
              <li className="search-none">
                {recentOn ? (
                  <>
                    <span>
                      No indexed files modified in the last {label}
                      {hasQuery ? " match that search" : ""}.
                    </span>
                    <span className="search-none-actions">
                      {wider && (
                        <button className="btn" onClick={() => setWindow(wider.minutes, false)}>
                          Widen to {wider.id}
                        </button>
                      )}
                      <button
                        className="btn"
                        onClick={() => {
                          setRecentOn(false);
                          setCustom(false);
                        }}
                      >
                        Clear filter
                      </button>
                    </span>
                  </>
                ) : (
                  "No matches"
                )}
              </li>
            )}
            {hits.map((h, i) => (
              <HitRow
                key={h.path}
                hit={h}
                idx={i}
                isActive={i === active}
                termKey={termKey}
                now={recentOn ? now : 0}
                onHover={setSelPath}
                onOpen={open}
              />
            ))}
          </ul>
        )}
        <div className="search-foot">
          {recentOn && status === "idle" && hits.length > 0 ? (
            <span>
              {capped ? `Newest ${hits.length} of ${formatCount(total)}` : formatCount(total)}
              {total === 1 ? " indexed file" : " indexed files"} modified in the last {label}
            </span>
          ) : indexStats ? (
            <span>
              {formatCount(indexStats.files)} files, {formatCount(indexStats.dirs)} folders indexed
              {indexStats.truncated ? " (truncated)" : ""}
            </span>
          ) : (
            <span>Indexing…</span>
          )}
          <span className="search-foot-keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd> move <kbd>↵</kbd> open
          </span>
        </div>
      </div>
    </div>
  );
}

/** One result row. Memoized on its own props, so hovering re-renders the
 *  two rows whose `isActive` changed, not all 200. `now` is passed in rather
 *  than read per row, so the age column stays comparable by value; 0 means the
 *  filter is off and the column is not rendered. */
const HitRow = memo(function HitRow({
  hit,
  idx,
  isActive,
  termKey,
  now,
  onHover,
  onOpen,
}: {
  hit: SearchHit;
  idx: number;
  isActive: boolean;
  termKey: string;
  now: number;
  onHover: (path: string) => void;
  onOpen: (h: SearchHit) => void;
}) {
  const folder = dirname(hit.path);
  const badge = hit.isDir ? null : badgeOf(hit.name);
  return (
    <li
      data-idx={idx}
      className={`search-hit${isActive ? " active" : ""}`}
      onMouseEnter={() => onHover(hit.path)}
      onClick={() => onOpen(hit)}
    >
      <span className="search-hit-icon">{hit.isDir ? <IconFolder /> : null}</span>
      <span className="search-hit-name">
        {/* One flex item for the whole name: bare, the text runs and each
            <mark> would be separate items, and the row's gap would open up
            inside the word around every match. */}
        <span className="search-hit-text">
          <Highlight text={hit.name} termKey={termKey} />
        </span>
        {badge && <span className="tree-badge">{badge}</span>}
      </span>
      <span className="search-hit-dir">{folder ? <Highlight text={folder} termKey={termKey} /> : " "}</span>
      {now > 0 && (
        <span className="search-hit-age" title={formatDate(hit.modified)}>
          {formatAge(hit.modified, now)} ago
        </span>
      )}
    </li>
  );
});

/** The ranges of `text` matched by any term, merged. Pure. */
export function matchRanges(text: string, terms: string[]): Array<[number, number]> {
  const lower = text.toLowerCase();
  const marks: Array<[number, number]> = [];
  for (const t of terms) {
    if (!t) continue;
    let from = 0;
    while (from <= lower.length) {
      const i = lower.indexOf(t, from);
      if (i === -1) break;
      marks.push([i, i + t.length]);
      from = i + Math.max(1, t.length);
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const m of marks) {
    const lastM = merged[merged.length - 1];
    if (lastM && m[0] <= lastM[1]) lastM[1] = Math.max(lastM[1], m[1]);
    else merged.push([m[0], m[1]]);
  }
  return merged;
}

/** The text with each search term wrapped in <mark>. */
function Highlight({ text, termKey }: { text: string; termKey: string }) {
  const merged = useMemo(() => matchRanges(text, termKey.split(" ")), [text, termKey]);
  if (merged.length === 0) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let pos = 0;
  merged.forEach(([a, b], i) => {
    if (a > pos) out.push(text.slice(pos, a));
    out.push(<mark key={i}>{text.slice(a, b)}</mark>);
    pos = b;
  });
  if (pos < text.length) out.push(text.slice(pos));
  return <>{out}</>;
}

/** The sidebar's entry point into the filter: opens this overlay already
 *  armed, so the feature is reachable without knowing the shortcut. */
export function RecentTrigger() {
  return (
    <button
      className="icon-btn"
      title="Recently modified (Ctrl+Shift+P)"
      aria-label="Recently modified"
      onClick={() => useStore.getState().setSearchOpen(true, true)}
    >
      <IconClock />
    </button>
  );
}
