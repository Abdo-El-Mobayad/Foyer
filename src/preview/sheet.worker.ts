// Workbook parsing off the UI thread. The main thread sends the bytes once;
// the parsed workbook stays here, and each sheet is converted on request.
// Rows are capped at read time (`sheetRows`), so a million-row sheet never
// materialises; the true row count is reported from the sheet's full range.

import * as XLSX from "xlsx";
import { ROW_CAP } from "../lib/tableModel";

export type SheetRequest =
  | { type: "load"; id: number; bytes: ArrayBuffer }
  | { type: "sheet"; id: number; index: number };

export type SheetResponse =
  | { type: "loaded"; id: number; sheetNames: string[] }
  | { type: "sheet"; id: number; index: number; rows: string[][]; total: number }
  | { type: "error"; id: number; message: string };

let book: XLSX.WorkBook | null = null;

function post(msg: SheetResponse) {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = (e: MessageEvent<SheetRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      book = XLSX.read(new Uint8Array(msg.bytes), {
        type: "array",
        cellDates: true,
        dense: true,
        sheetRows: ROW_CAP + 1,
      });
      post({ type: "loaded", id: msg.id, sheetNames: book.SheetNames });
      return;
    }
    if (!book) throw new Error("no workbook loaded");
    const name = book.SheetNames[msg.index] ?? book.SheetNames[0];
    const ws = book.Sheets[name];
    if (!ws) {
      post({ type: "sheet", id: msg.id, index: msg.index, rows: [], total: 0 });
      return;
    }
    const grid = XLSX.utils.sheet_to_json<Array<string | number | boolean | Date | null>>(ws, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    });
    const rows = grid.map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c))));
    const fullRef = (ws as { "!fullref"?: string })["!fullref"] ?? ws["!ref"];
    const total = fullRef ? XLSX.utils.decode_range(fullRef).e.r + 1 : rows.length;
    post({ type: "sheet", id: msg.id, index: msg.index, rows, total: Math.max(total, rows.length) });
  } catch (err) {
    post({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
