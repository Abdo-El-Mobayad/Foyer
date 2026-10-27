import { describe, expect, it } from "vitest";
import {
  buildRows,
  CHUNK_CHARS,
  countLines,
  lineNumberOf,
  MONOLITHIC_CAP,
  rowChars,
  RowLayout,
  rowText,
} from "./textRows";

describe("buildRows", () => {
  it("makes one row per line and strips terminators", () => {
    const m = buildRows("a\nbb\n\nccc");
    expect(m.count).toBe(4);
    expect(m.lines).toBe(4);
    expect([0, 1, 2, 3].map((i) => rowText("a\nbb\n\nccc", m, i))).toEqual(["a", "bb", "", "ccc"]);
    expect(m.cont.length).toBe(0);
    expect(m.maxRowChars).toBe(3);
    expect([0, 1, 2, 3].map((i) => lineNumberOf(m, i))).toEqual([1, 2, 3, 4]);
  });

  it("handles a trailing newline, CRLF, and the empty file", () => {
    const t = "x\r\ny\n";
    const m = buildRows(t);
    expect(m.count).toBe(3);
    expect([0, 1, 2].map((i) => rowText(t, m, i))).toEqual(["x", "y", ""]);
    expect(rowChars(t, m, 0)).toBe(1);
    const e = buildRows("");
    expect(e.count).toBe(1);
    expect(rowText("", e, 0)).toBe("");
    expect(countLines("")).toBe(1);
    expect(countLines("a\nb\n")).toBe(3);
  });

  it("splits a long line into continuation rows of at most the chunk size", () => {
    const long = "x".repeat(10);
    const t = `head\n${long}\ntail`;
    const m = buildRows(t, 4);
    // head | xxxx | xxxx | xx | tail
    expect(m.count).toBe(5);
    expect(m.lines).toBe(3);
    expect([0, 1, 2, 3, 4].map((i) => rowText(t, m, i))).toEqual(["head", "xxxx", "xxxx", "xx", "tail"]);
    expect(Array.from(m.cont)).toEqual([2, 3]);
    expect([0, 1, 2, 3, 4].map((i) => lineNumberOf(m, i))).toEqual([1, 2, 0, 0, 3]);
    expect(m.maxRowChars).toBe(4);
    // A line of exactly the chunk size is not split.
    const exact = buildRows("abcd\nef", 4);
    expect(exact.count).toBe(2);
    expect(exact.cont.length).toBe(0);
  });

  it("bounds a one-line multi-megabyte file to text.length / CHUNK_CHARS rows", () => {
    const t = "{" + '"k":"v",'.repeat(60_000); // ~480 K chars, one line, well past the cap
    const m = buildRows(t);
    expect(m.lines).toBe(1);
    expect(m.count).toBe(Math.ceil(t.length / CHUNK_CHARS));
    for (let i = 0; i < m.count; i++) expect(rowChars(t, m, i)).toBeLessThanOrEqual(CHUNK_CHARS);
    expect(m.maxRowChars).toBe(CHUNK_CHARS);
    expect(lineNumberOf(m, 0)).toBe(1);
    expect(lineNumberOf(m, 1)).toBe(0);
  });

  it("a newline-only file costs one Uint32 per row and no strings", () => {
    const t = "\n".repeat(100_000);
    const m = buildRows(t);
    expect(m.count).toBe(100_001);
    expect(m.starts.length).toBe(100_002);
    expect(m.cont.length).toBe(0);
    expect(rowText(t, m, 50_000)).toBe("");
    expect(lineNumberOf(m, 99_999)).toBe(100_000);
  });

  it("the monolithic budget is the measured 128 Ki, well under the 4 MiB read cap", () => {
    expect(MONOLITHIC_CAP).toBe(131_072);
    expect(MONOLITHIC_CAP).toBeLessThan(4 * 1024 * 1024);
  });
});

describe("RowLayout", () => {
  const chars = [10, 250, 10, 10, 1000, 10];
  const layout = () => new RowLayout(chars.length, (i) => chars[i]);

  it("is the identity without wrapping", () => {
    const l = layout();
    l.configure(Infinity);
    expect(l.totalLines()).toBe(6);
    expect(l.top(4)).toBe(4);
    expect(l.rowAt(4)).toBe(4);
    expect(l.linesOf(4)).toBe(1);
  });

  it("estimates long rows from the column count and maps lines to rows", () => {
    const l = layout();
    l.configure(100);
    // rows: 1, 3, 1, 1, 10, 1 lines
    expect(l.linesOf(1)).toBe(3);
    expect(l.linesOf(4)).toBe(10);
    expect(l.totalLines()).toBe(17);
    expect([0, 1, 2, 3, 4, 5].map((i) => l.top(i))).toEqual([0, 1, 4, 5, 6, 16]);
    expect([0, 1, 2, 3, 4, 5, 6, 10, 15, 16, 99].map((y) => l.rowAt(y))).toEqual([
      0, 1, 1, 1, 2, 3, 4, 4, 4, 5, 5,
    ]);
    expect(l.rowAt(-3)).toBe(0);
  });

  it("corrects itself from measurements, including a short row that turned out tall", () => {
    const l = layout();
    l.configure(100);
    expect(l.measure(1, 3)).toBe(false);
    expect(l.measure(1, 4)).toBe(true);
    expect(l.top(2)).toBe(5);
    expect(l.top(4)).toBe(7);
    expect(l.totalLines()).toBe(18);
    // A 10-char row that wrapped to 2 lines (wide glyphs, a tab).
    expect(l.measure(2, 2)).toBe(true);
    expect(l.linesOf(2)).toBe(2);
    expect(l.top(3)).toBe(7);
    expect(l.top(4)).toBe(8);
    expect(l.rowAt(7)).toBe(3);
    expect(l.rowAt(8)).toBe(4);
    expect(l.measure(2, 1)).toBe(true);
    expect(l.top(4)).toBe(7);
    // Reconfiguring drops the measurements.
    l.configure(100);
    expect(l.linesOf(1)).toBe(3);
  });

  it("stays consistent on a large sparse model", () => {
    const n = 200_000;
    const l = new RowLayout(n, (i) => (i % 997 === 0 ? 5000 : 30));
    l.configure(120);
    // Every long row is 42 lines; rowAt(top(i)) is i for every row.
    for (let i = 0; i < n; i += 1231) expect(l.rowAt(l.top(i))).toBe(i);
    expect(l.rowAt(l.totalLines() + 50)).toBe(n - 1);
  });
});
