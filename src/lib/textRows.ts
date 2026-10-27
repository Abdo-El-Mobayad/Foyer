// The row model behind the virtualized text viewer. Pure: no DOM, no React.
//
// A file is cut into ROWS: one per logical line, except that a line longer
// than CHUNK_CHARS is cut into continuation rows of at most CHUNK_CHARS. A
// one-line 4 MB JSON therefore becomes ~1,000 rows, each of which the
// browser can wrap in well under a millisecond, instead of one 4 MB line.
//
// Only row START offsets are stored (one Uint32 per row); row text is sliced
// from the source on render, so nothing is copied or escaped up front. Line
// numbers derive from the (sparse) list of continuation rows.

/** Longest row, in UTF-16 code units. Measured in Edge 152: a single line of
 *  4,096 chars lays out wrapped in ~0.5 ms; 65,536 chars takes ~4 ms. */
export const CHUNK_CHARS = 4096;

/** Files at or under this many chars render as one `<pre>` (native selection
 *  and find across the whole file, syntax colors). Above it the file is
 *  rendered as virtualized rows, where a Wrap toggle costs ~30 ms at any
 *  size.
 *
 *  Measured in the built app (WebView2 / Edge 152, this machine), time from
 *  the Wrap click to the second animation frame, worst direction:
 *    64 K chars: 113 ms    96 K: 181 ms    128 K: 246 ms    200 K: 392 ms
 *    4 MiB (v0.1.0, the bug): 1,055 ms of layout then a 232 s long task.
 *  Layout alone is near-linear (headless Edge: 4 MiB wraps in ~850 ms); the
 *  paint that follows is what explodes. 128 Ki keeps the one-off toggle
 *  cost of a monolithic file under a quarter of a second. */
export const MONOLITHIC_CAP = 128 * 1024;

export interface RowModel {
  /** Row i spans text[starts[i], starts[i + 1]) minus its line terminator. */
  starts: Uint32Array;
  /** Indices of continuation rows (a chunk of a line that began earlier), ascending. */
  cont: Uint32Array;
  /** Number of rows. */
  count: number;
  /** Number of logical lines. */
  lines: number;
  /** Chars in the longest row (bounded by CHUNK_CHARS). */
  maxRowChars: number;
}

/** Cut `text` into rows. Linear in the text length; allocates one Uint32 per
 *  row and nothing per line. */
export function buildRows(text: string, chunk = CHUNK_CHARS): RowModel {
  const len = text.length;
  // First pass: count rows so the typed array is allocated once.
  let rows = 0;
  let lines = 0;
  let pos = 0;
  while (true) {
    let nl = text.indexOf("\n", pos);
    if (nl === -1) nl = len;
    const lineLen = nl - pos;
    rows += lineLen > chunk ? Math.ceil(lineLen / chunk) : 1;
    lines++;
    if (nl >= len) break;
    pos = nl + 1;
  }
  const starts = new Uint32Array(rows + 1);
  const contList: number[] = [];
  let maxRowChars = 0;
  let r = 0;
  pos = 0;
  while (true) {
    let nl = text.indexOf("\n", pos);
    if (nl === -1) nl = len;
    let a = pos;
    while (nl - a > chunk) {
      starts[r++] = a;
      a += chunk;
      contList.push(r);
      if (chunk > maxRowChars) maxRowChars = chunk;
    }
    starts[r++] = a;
    const tail = nl - a - (nl > a && text.charCodeAt(nl - 1) === 13 ? 1 : 0);
    if (tail > maxRowChars) maxRowChars = tail;
    if (nl >= len) break;
    pos = nl + 1;
  }
  starts[rows] = len;
  return { starts, cont: Uint32Array.from(contList), count: rows, lines, maxRowChars };
}

/** The text of row i (no line terminator). */
export function rowText(text: string, m: RowModel, i: number): string {
  const a = m.starts[i];
  let b = m.starts[i + 1];
  if (b > a && text.charCodeAt(b - 1) === 10) b--;
  if (b > a && text.charCodeAt(b - 1) === 13) b--;
  return text.slice(a, b);
}

/** Chars in row i (no line terminator). */
export function rowChars(text: string, m: RowModel, i: number): number {
  const a = m.starts[i];
  let b = m.starts[i + 1];
  if (b > a && text.charCodeAt(b - 1) === 10) b--;
  if (b > a && text.charCodeAt(b - 1) === 13) b--;
  return b - a;
}

/** Number of elements of a sorted Uint32Array that are <= x. */
function countLE(arr: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 1-based line number of row i, or 0 for a continuation row. */
export function lineNumberOf(m: RowModel, i: number): number {
  const k = countLE(m.cont, i);
  if (k > 0 && m.cont[k - 1] === i) return 0;
  return i + 1 - k;
}

/** Count "\n" without splitting. */
export function countLines(text: string): number {
  let n = 1;
  let pos = 0;
  while (true) {
    const nl = text.indexOf("\n", pos);
    if (nl === -1) break;
    n++;
    pos = nl + 1;
  }
  return text.length === 0 ? 1 : n;
}

/**
 * Vertical layout of the rows when some of them wrap. Every row is one
 * visual line, except the LONG rows (more chars than fit in one line),
 * which start with an estimate of ceil(chars / cols) lines and are corrected
 * from real measurements as they are rendered. Positions are in visual
 * lines; the caller multiplies by the line height.
 *
 * Long rows are kept sparse (index + line count + a running total of extra
 * lines) so a 4 MB file of short lines costs nothing here, and a minified
 * file is at most text.length / CHUNK_CHARS entries.
 */
export class RowLayout {
  private longIdx: number[] = [];
  private longLines: number[] = [];
  /** extra[k] = sum over j <= k of (longLines[j] - 1). */
  private extra: number[] = [];
  private cols = Infinity;

  constructor(
    private readonly count: number,
    private readonly charsOf: (i: number) => number,
  ) {}

  /** Re-estimate every row for `cols` characters per line. Infinity means
   *  no wrapping (every row is one line). Discards measurements. */
  configure(cols: number): void {
    this.cols = cols;
    this.longIdx = [];
    this.longLines = [];
    this.extra = [];
    if (!Number.isFinite(cols) || cols < 1) return;
    let running = 0;
    for (let i = 0; i < this.count; i++) {
      const c = this.charsOf(i);
      if (c > cols) {
        const lines = Math.ceil(c / cols);
        this.longIdx.push(i);
        this.longLines.push(lines);
        running += lines - 1;
        this.extra.push(running);
      }
    }
  }

  get columns(): number {
    return this.cols;
  }

  linesOf(i: number): number {
    const k = countLE(this.longIdx, i);
    return k > 0 && this.longIdx[k - 1] === i ? this.longLines[k - 1] : 1;
  }

  /** First visual line of row i. */
  top(i: number): number {
    const k = countLE(this.longIdx, i - 1);
    return i + (k > 0 ? this.extra[k - 1] : 0);
  }

  totalLines(): number {
    const L = this.extra.length;
    return this.count + (L > 0 ? this.extra[L - 1] : 0);
  }

  /** The row that contains visual line `line` (clamped to the row range). */
  rowAt(line: number): number {
    if (this.count === 0) return 0;
    if (line <= 0) return 0;
    // Largest k with top(longIdx[k]) <= line.
    let lo = 0;
    let hi = this.longIdx.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const j = this.longIdx[mid];
      const topJ = j + (mid > 0 ? this.extra[mid - 1] : 0);
      if (topJ <= line) lo = mid + 1;
      else hi = mid;
    }
    let row: number;
    if (lo === 0) {
      row = line;
    } else {
      const k = lo - 1;
      const j = this.longIdx[k];
      const topJ = j + (k > 0 ? this.extra[k - 1] : 0);
      const lines = this.longLines[k];
      row = line < topJ + lines ? j : j + 1 + (line - topJ - lines);
    }
    return Math.min(this.count - 1, Math.max(0, row));
  }

  /** Record the measured height (in visual lines) of row i. Returns true if
   *  the layout changed. */
  measure(i: number, lines: number): boolean {
    if (!Number.isFinite(lines) || lines < 1) lines = 1;
    const k = countLE(this.longIdx, i);
    const at = k - 1;
    if (at >= 0 && this.longIdx[at] === i) {
      if (this.longLines[at] === lines) return false;
      this.longLines[at] = lines;
      this.recompute(at);
      return true;
    }
    if (lines === 1) return false;
    this.longIdx.splice(k, 0, i);
    this.longLines.splice(k, 0, lines);
    this.extra.splice(k, 0, 0);
    this.recompute(k);
    return true;
  }

  private recompute(from: number): void {
    let running = from > 0 ? this.extra[from - 1] : 0;
    for (let k = from; k < this.longIdx.length; k++) {
      running += this.longLines[k] - 1;
      this.extra[k] = running;
    }
  }
}
