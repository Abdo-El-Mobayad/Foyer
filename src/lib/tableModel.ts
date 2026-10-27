// Budgets for the grid preview (CSV, TSV, spreadsheets). Pure.
//
// The row cap alone did not bound the work: every row is padded to the
// widest row, so 5,000 rows x 1,000 columns was five million cells. Columns
// and total cells are capped here, before anything is allocated for the DOM,
// and the grid itself only mounts the rows in view.

/** Data rows kept for the preview. */
export const ROW_CAP = 5000;
/** Columns shown; the rest are reported in the footer. */
export const COL_CAP = 256;
/** Cells kept in memory for the preview (rows x shown columns). */
export const CELL_CAP = 400_000;

export interface TableData {
  header: string[];
  rows: string[][];
  /** Total data rows before the row cap. */
  total: number;
  /** Columns shown. */
  cols: number;
  /** Columns in the widest row before the column cap. */
  totalCols: number;
}

/** Clamp a parsed grid to the budgets. `total` is the row count before the
 *  row cap (the caller may have counted past what it kept). */
export function shapeTable(header: string[], rows: string[][], total: number): TableData {
  let widest = header.length;
  for (const r of rows) if (r.length > widest) widest = r.length;
  const cols = Math.max(1, Math.min(COL_CAP, widest));
  const rowBudget = Math.max(1, Math.floor(CELL_CAP / cols));
  const keep = Math.min(rows.length, ROW_CAP, rowBudget);
  const out = rows.length > keep ? rows.slice(0, keep) : rows;
  const trimmed = widest > cols ? out.map((r) => (r.length > cols ? r.slice(0, cols) : r)) : out;
  return {
    header: header.length > cols ? header.slice(0, cols) : header,
    rows: trimmed,
    total: Math.max(total, rows.length),
    cols,
    totalCols: widest,
  };
}
