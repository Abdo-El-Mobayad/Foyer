import { memo, useEffect, useMemo, useRef, useState } from "react";
import { formatCount } from "../lib/paths";
import type { TableData } from "../lib/tableModel";

/** Fixed row height, matched by `.grid td` in App.css. */
const ROW_H = 28;
/** Rows and columns kept beyond each edge of the viewport. */
const OVERSCAN = 6;
const COL_OVERSCAN = 3;
/** The window moves in steps of this many rows / columns, so a scroll of a
 *  few pixels changes nothing and a wheel notch re-creates at most one
 *  block. */
const BLOCK = 6;
const COL_BLOCK = 4;
/** Rows sampled for column widths. */
const WIDTH_SAMPLE = 200;
/** Column width bounds and the monospace advance at the grid's 12px font. */
const COL_MIN = 56;
const COL_MAX = 420;
const CHAR_PX = 7.3;
const CELL_PAD = 21;
const NUM_COL = 48;

/**
 * A grid with a sticky header and row numbers; cells are monospace. Both
 * axes are windowed: only the rows AND columns in view (plus overscan) are
 * in the DOM, with spacer rows and spacer cells holding the scroll size, so
 * 5,000 x 256 cells never mount at once and a scroll jump on a 256-column
 * grid creates a few hundred cells, not ten thousand.
 *
 * The table uses fixed layout with column widths computed once from a
 * sample of rows. With auto layout every row that entered the window made
 * the browser re-measure every cell in the window to settle column widths;
 * with fixed widths a new cell costs itself only.
 */
export function TableView({ data, note }: { data: TableData; note?: string }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [size, setSize] = useState({ height: 600, width: 900 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => setSize({ height: el.clientHeight, width: el.clientWidth });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, []);

  const cols = data.cols;
  const header = useMemo(() => Array.from({ length: cols }, (_, i) => data.header[i] ?? ""), [data.header, cols]);
  // Column widths from a sample, then their running offsets (edges[c] is
  // where column c starts, edges[cols] is the table's full width).
  const edges = useMemo(() => {
    const chars = new Array<number>(cols).fill(0);
    const consider = (row: string[]) => {
      const n = Math.min(cols, row.length);
      for (let c = 0; c < n; c++) if (row[c].length > chars[c]) chars[c] = row[c].length;
    };
    consider(header);
    const step = Math.max(1, Math.floor(data.rows.length / WIDTH_SAMPLE));
    for (let r = 0; r < data.rows.length; r += step) consider(data.rows[r]);
    const out = new Array<number>(cols + 1);
    out[0] = NUM_COL;
    for (let c = 0; c < cols; c++) {
      out[c + 1] = out[c] + Math.round(Math.min(COL_MAX, Math.max(COL_MIN, chars[c] * CHAR_PX + CELL_PAD)));
    }
    return out;
  }, [header, data.rows, cols]);
  const tableWidth = edges[cols];

  const firstVisible = Math.floor(scrollTop / ROW_H);
  const r0 = Math.max(0, Math.floor((firstVisible - OVERSCAN) / BLOCK) * BLOCK);
  const r1 = Math.min(data.rows.length, Math.ceil((firstVisible + size.height / ROW_H + OVERSCAN) / BLOCK) * BLOCK);
  const before = r0 * ROW_H;
  const after = Math.max(0, data.rows.length - r1) * ROW_H;

  // Column window: the last column starting at or before the left edge,
  // through the first column starting past the right edge.
  const colAt = (x: number) => {
    let lo = 0;
    let hi = cols;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (edges[mid + 1] <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const c0 = Math.max(0, Math.floor((colAt(scrollLeft + NUM_COL) - COL_OVERSCAN) / COL_BLOCK) * COL_BLOCK);
  const c1 = Math.min(cols, Math.ceil((colAt(scrollLeft + size.width) + 1 + COL_OVERSCAN) / COL_BLOCK) * COL_BLOCK);
  const leftPad = edges[c0] - NUM_COL;
  const rightPad = tableWidth - edges[c1];

  const colEls: React.ReactNode[] = [<col key="num" style={{ width: NUM_COL }} />];
  if (leftPad > 0) colEls.push(<col key="l" style={{ width: leftPad }} />);
  for (let c = c0; c < c1; c++) colEls.push(<col key={c} style={{ width: edges[c + 1] - edges[c] }} />);
  if (rightPad > 0) colEls.push(<col key="r" style={{ width: rightPad }} />);
  const span = 1 + (leftPad > 0 ? 1 : 0) + (c1 - c0) + (rightPad > 0 ? 1 : 0);

  const body: React.ReactNode[] = [];
  for (let r = r0; r < r1; r++) {
    body.push(<GridRow key={r} r={r} row={data.rows[r]} c0={c0} c1={c1} leftPad={leftPad} rightPad={rightPad} />);
  }

  return (
    <div
      className="table-wrap"
      ref={wrapRef}
      onScroll={(e) => {
        const { scrollTop: top, scrollLeft: left } = e.currentTarget;
        setScrollTop((prev) => (Math.floor(prev / ROW_H) === Math.floor(top / ROW_H) ? prev : top));
        setScrollLeft((prev) => (Math.floor(prev / 48) === Math.floor(left / 48) ? prev : left));
      }}
    >
      <table className="grid grid-fixed" style={{ width: tableWidth }}>
        <colgroup>{colEls}</colgroup>
        <thead>
          <tr>
            <th className="grid-num">#</th>
            {leftPad > 0 && <th className="grid-pad" />}
            {header.slice(c0, c1).map((h, i) => (
              <th key={c0 + i} title={h}>
                {h}
              </th>
            ))}
            {rightPad > 0 && <th className="grid-pad" />}
          </tr>
        </thead>
        <tbody>
          {before > 0 && (
            <tr className="grid-spacer" style={{ height: before }}>
              <td colSpan={span} />
            </tr>
          )}
          {body}
          {after > 0 && (
            <tr className="grid-spacer" style={{ height: after }}>
              <td colSpan={span} />
            </tr>
          )}
        </tbody>
      </table>
      <div className="table-foot">
        {data.total > data.rows.length
          ? `Showing ${formatCount(data.rows.length)} of ${formatCount(data.total)} rows`
          : `${formatCount(data.total)} rows`}
        , {data.totalCols > cols ? `showing ${cols} of ${formatCount(data.totalCols)} columns` : `${cols} columns`}
        {note ? `, ${note}` : ""}
      </div>
    </div>
  );
}

const GridRow = memo(function GridRow({
  r,
  row,
  c0,
  c1,
  leftPad,
  rightPad,
}: {
  r: number;
  row: string[];
  c0: number;
  c1: number;
  leftPad: number;
  rightPad: number;
}) {
  const cells: React.ReactNode[] = [];
  for (let c = c0; c < c1; c++) {
    const v = row[c] ?? "";
    cells.push(
      <td key={c} title={v}>
        {v}
      </td>,
    );
  }
  return (
    <tr>
      <td className="grid-num">{r + 1}</td>
      {leftPad > 0 && <td className="grid-pad" />}
      {cells}
      {rightPad > 0 && <td className="grid-pad" />}
    </tr>
  );
});
