import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { highlight } from "../lib/highlight";
import {
  buildRows,
  countLines,
  lineNumberOf,
  MONOLITHIC_CAP,
  rowChars,
  RowLayout,
  rowText,
} from "../lib/textRows";

/** Past this, highlighting is skipped: the tokenizer would stall the pane.
 *  Equal to the monolithic budget, so a highlighted file is always one
 *  `<pre>` and a virtualized file is always plain text. */
export const HIGHLIGHT_CAP = MONOLITHIC_CAP;

/** The text budget behind the Wrap checkbox on the monolithic path: wrapping
 *  a single `<pre>` past this is what stalled the app. Files over it never
 *  reach that path (they are virtualized), so this is the belt to that
 *  suspender. */
export function withinWrapBudget(chars: number): boolean {
  return chars <= MONOLITHIC_CAP;
}

export function isVirtualized(chars: number): boolean {
  return chars > MONOLITHIC_CAP;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Text with a line-number gutter, optional syntax colors and optional soft
 * wrap. Two renderers behind one prop shape:
 *
 * - up to MONOLITHIC_CAP chars: one `<pre>`, highlighted when a language is
 *   known. Native selection and find work across the whole file.
 * - above it: virtualized rows. Only the rows in view (plus overscan) are in
 *   the DOM; a line longer than CHUNK_CHARS is shown as continuation rows.
 *   Wrap is per row, so a one-line multi-megabyte JSON wraps in bounded
 *   pieces instead of as one layout of the whole file.
 */
export function TextViewer({ text, lang, wrap }: { text: string; lang: string | null; wrap: boolean }) {
  if (isVirtualized(text.length)) return <VirtualText text={text} wrap={wrap} />;
  return <MonolithicText text={text} lang={lang} wrap={wrap} />;
}

function MonolithicText({ text, lang, wrap }: { text: string; lang: string | null; wrap: boolean }) {
  const body = useMemo(() => {
    const lines = countLines(text);
    const gutter = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
    const highlighted = Boolean(lang) && text.length <= HIGHLIGHT_CAP;
    // One object per text: React re-assigns innerHTML whenever this object's
    // identity changes, and re-parsing the whole file on a Wrap toggle was
    // a 600 ms cost on a 4 MB file.
    const html = { __html: highlighted && lang ? highlight(text, lang) : escapeHtml(text) };
    return { gutter, html };
  }, [text, lang]);
  const wrapOn = wrap && withinWrapBudget(text.length);
  return (
    <div className={`code-scroll${wrapOn ? " wrap" : ""}`}>
      <pre className="code-gutter" aria-hidden="true">
        {body.gutter}
      </pre>
      <pre className="code-body hljs" dangerouslySetInnerHTML={body.html} />
    </div>
  );
}

/** Rows kept in the DOM beyond each edge of the viewport. */
const OVERSCAN = 20;
/** Vertical padding of the row area, matching `.code-scroll pre`. */
const PAD_TOP = 12;
const PAD_BOTTOM = 48;
/** Horizontal padding of `.trow-text` plus the gutter's own padding and border. */
const TEXT_PAD = 12 + 24;
const GUTTER_PAD = 21;

function VirtualText({ text, wrap }: { text: string; wrap: boolean }) {
  const model = useMemo(() => buildRows(text), [text]);
  const layout = useMemo(() => new RowLayout(model.count, (i) => rowChars(text, model, i)), [model, text]);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const windowRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLDivElement | null>(null);
  const [metrics, setMetrics] = useState({ charW: 7.5, lineH: 20 });
  const [view, setView] = useState({ top: 0, height: 600, width: 800 });
  const [, bump] = useReducer((x: number) => x + 1, 0);

  // Font metrics from a hidden probe row, re-read once the web font lands.
  useLayoutEffect(() => {
    const read = () => {
      const probe = probeRef.current;
      if (!probe) return;
      const span = probe.querySelector<HTMLElement>(".trow-text");
      const w = span ? span.getBoundingClientRect().width : 0;
      const charW = w > 0 ? (w - TEXT_PAD) / 100 : 7.5;
      const lineH = probe.offsetHeight || 20;
      setMetrics((m) => (Math.abs(m.charW - charW) < 0.01 && m.lineH === lineH ? m : { charW, lineH }));
    };
    read();
    let alive = true;
    void document.fonts?.ready.then(() => alive && read());
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setView((v) => (v.height === el.clientHeight && v.width === el.clientWidth ? v : { ...v, height: el.clientHeight, width: el.clientWidth }));
    });
    ro.observe(el);
    setView((v) => ({ ...v, height: el.clientHeight, width: el.clientWidth }));
    return () => ro.disconnect();
  }, []);

  const digits = String(model.lines).length;
  const gutterPx = digits * metrics.charW + GUTTER_PAD;
  const cols = wrap ? Math.max(8, Math.floor((view.width - gutterPx - TEXT_PAD) / metrics.charW)) : Infinity;
  // Re-estimate every row when the column count changes (a resize, the Wrap
  // toggle). Deterministic for its inputs, so a memo is the right home.
  useMemo(() => {
    layout.configure(cols);
    return cols;
  }, [layout, cols]);

  const { lineH } = metrics;
  const firstLine = Math.floor(Math.max(0, view.top - PAD_TOP) / lineH);
  const lastLine = Math.ceil(Math.max(0, view.top + view.height - PAD_TOP) / lineH);
  const first = Math.max(0, layout.rowAt(firstLine) - OVERSCAN);
  const last = Math.min(model.count, layout.rowAt(lastLine) + OVERSCAN + 1);
  const totalPx = PAD_TOP + layout.totalLines() * lineH + PAD_BOTTOM;
  const topPx = PAD_TOP + layout.top(first) * lineH;

  // Wrapped rows: replace estimates with what the browser laid out. One
  // forced layout per pass, over the visible rows only; a second pass runs
  // only when something changed, and stops once the model agrees.
  useLayoutEffect(() => {
    if (!wrap) return;
    const win = windowRef.current;
    if (!win) return;
    let changed = false;
    for (const el of Array.from(win.children) as HTMLElement[]) {
      const i = Number(el.dataset.i);
      if (!Number.isFinite(i)) continue;
      const lines = Math.max(1, Math.round(el.offsetHeight / lineH));
      if (layout.measure(i, lines)) changed = true;
    }
    if (changed) bump();
  });

  const rows: React.ReactNode[] = [];
  for (let i = first; i < last; i++) {
    const n = lineNumberOf(model, i);
    rows.push(
      <div className="trow" data-i={i} key={i}>
        <span className="trow-ln" aria-hidden="true">
          {n === 0 ? "" : n}
        </span>
        <span className="trow-text">{rowText(text, model, i)}</span>
      </div>,
    );
  }

  return (
    <div
      className={`trows${wrap ? " wrap" : ""}`}
      ref={scrollerRef}
      style={{ "--gutter-ch": digits } as React.CSSProperties}
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        setView((v) => (v.top === top ? v : { ...v, top }));
      }}
    >
      <div className="trow trow-probe" ref={probeRef} aria-hidden="true">
        <span className="trow-ln">0</span>
        <span className="trow-text">{"0".repeat(100)}</span>
      </div>
      <div
        className="trows-space"
        style={{
          height: totalPx,
          minWidth: wrap ? undefined : gutterPx + TEXT_PAD + model.maxRowChars * metrics.charW,
        }}
      >
        <div className="trows-window" ref={windowRef} style={{ top: topPx }}>
          {rows}
        </div>
      </div>
    </div>
  );
}
