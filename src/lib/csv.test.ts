import { describe, expect, it } from "vitest";
import { parseCsvBounded } from "./csv";
import { ROW_CAP } from "./tableModel";

describe("parseCsvBounded", () => {
  it("parses, detects the delimiter, and skips blank lines", () => {
    const p = parseCsvBounded("a;b\n1;2\n\n3;4\n");
    expect(p.delimiter).toBe("semicolon");
    expect(p.rows).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
    expect(p.total).toBe(3);
    expect(parseCsvBounded("a\tb\n1\t2", { tsv: true }).delimiter).toBe("tab");
    expect(parseCsvBounded("a|b\n1|2").delimiter).toBe("pipe");
  });

  it("keeps at most the cap plus a header row and counts the rest", () => {
    const lines = ["h1,h2"];
    for (let i = 0; i < ROW_CAP + 500; i++) lines.push(`${i},x`);
    const p = parseCsvBounded(lines.join("\n"));
    expect(p.rows.length).toBe(ROW_CAP + 1);
    expect(p.total).toBe(ROW_CAP + 501);
    expect(p.rows[0]).toEqual(["h1", "h2"]);
    expect(p.rows[ROW_CAP]).toEqual([String(ROW_CAP - 1), "x"]);
  });

  it("honours an explicit row cap", () => {
    const p = parseCsvBounded("a\nb\nc\nd", { rowCap: 2 });
    expect(p.rows).toEqual([["a"], ["b"]]);
    expect(p.total).toBe(4);
  });
});
