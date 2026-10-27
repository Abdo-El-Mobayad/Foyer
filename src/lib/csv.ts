// Bounded CSV/TSV parsing. Pure (papaparse only), so it runs in tests.
//
// Papa's row callback keeps memory at the row cap whatever the input size:
// rows past the cap are counted, not stored, and no second copy of the
// whole grid is made.

import Papa from "papaparse";
import { ROW_CAP } from "./tableModel";

export interface ParsedCsv {
  /** Every row up to the cap, including the header row if any. */
  rows: string[][];
  /** Rows in the input (before the cap). */
  total: number;
  delimiter: "comma" | "semicolon" | "pipe" | "tab";
}

export function parseCsvBounded(text: string, opts: { tsv?: boolean; rowCap?: number } = {}): ParsedCsv {
  const cap = opts.rowCap ?? ROW_CAP + 1; // +1 so a header row does not eat a data row
  const rows: string[][] = [];
  let total = 0;
  let delimiter = "";
  Papa.parse<string[]>(text, {
    delimiter: opts.tsv ? "\t" : "",
    skipEmptyLines: "greedy",
    step: (result) => {
      if (!delimiter) delimiter = result.meta.delimiter;
      total++;
      if (rows.length < cap) rows.push(result.data.map((c) => (c ?? "").toString()));
    },
  });
  return {
    rows,
    total,
    delimiter: delimiter === "\t" ? "tab" : delimiter === ";" ? "semicolon" : delimiter === "|" ? "pipe" : "comma",
  };
}
