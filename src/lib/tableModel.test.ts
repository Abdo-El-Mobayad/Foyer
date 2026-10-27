import { describe, expect, it } from "vitest";
import { CELL_CAP, COL_CAP, ROW_CAP, shapeTable } from "./tableModel";

describe("shapeTable", () => {
  it("passes a small grid through and pads nothing", () => {
    const t = shapeTable(["a", "b"], [["1", "2"], ["3"]], 2);
    expect(t.cols).toBe(2);
    expect(t.totalCols).toBe(2);
    expect(t.rows).toEqual([["1", "2"], ["3"]]);
    expect(t.total).toBe(2);
  });

  it("caps columns and reports the true width", () => {
    const wide = Array.from({ length: 1000 }, (_, i) => `c${i}`);
    const t = shapeTable(wide, [wide, ["x"]], 2);
    expect(t.cols).toBe(COL_CAP);
    expect(t.totalCols).toBe(1000);
    expect(t.header.length).toBe(COL_CAP);
    expect(t.rows[0].length).toBe(COL_CAP);
    expect(t.rows[1]).toEqual(["x"]);
  });

  it("caps rows by the row cap and by the cell budget, whichever is tighter", () => {
    const rows = Array.from({ length: ROW_CAP + 10 }, () => ["v"]);
    const t = shapeTable(["h"], rows, rows.length);
    expect(t.rows.length).toBe(ROW_CAP);
    expect(t.total).toBe(ROW_CAP + 10);

    // 5,000 rows x 256 columns would be 1.28 M cells: the budget wins.
    const wideRows = Array.from({ length: ROW_CAP }, () => Array.from({ length: COL_CAP }, () => "v"));
    const w = shapeTable([], wideRows, ROW_CAP);
    expect(w.cols).toBe(COL_CAP);
    expect(w.rows.length).toBe(Math.floor(CELL_CAP / COL_CAP));
    expect(w.rows.length * w.cols).toBeLessThanOrEqual(CELL_CAP);
    expect(w.total).toBe(ROW_CAP);
  });

  it("a sparse grid never pays for the padding it does not render", () => {
    // One 1,000-column row among 4,999 one-column rows: the shown width is
    // capped, the kept rows stay one cell each.
    const rows = [Array.from({ length: 1000 }, () => "w"), ...Array.from({ length: 4999 }, () => ["v"])];
    const t = shapeTable([], rows, rows.length);
    expect(t.cols).toBe(COL_CAP);
    expect(t.rows[1].length).toBe(1);
    expect(t.rows.length).toBe(Math.min(ROW_CAP, Math.floor(CELL_CAP / COL_CAP)));
  });

  it("an empty grid still has one column", () => {
    expect(shapeTable([], [], 0).cols).toBe(1);
  });
});
