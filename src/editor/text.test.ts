import { describe, expect, it } from "vitest";
import { adoptShape, fromDisk, minimalChange, reconcile, toDisk } from "./text";

describe("disk shape", () => {
  const roundTrip = (raw: string) => {
    const { text, shape } = fromDisk(raw);
    return toDisk(text, shape);
  };

  it("keeps LF, CRLF and a BOM byte for byte", () => {
    for (const raw of ["a\nb\n", "a\r\nb\r\n", "﻿# t\r\n\r\nx", "", "no newline", "﻿"]) {
      expect(roundTrip(raw)).toBe(raw);
    }
  });

  it("hands the editor plain LF text without the BOM", () => {
    const { text, shape } = fromDisk("﻿a\r\nb\r\n");
    expect(text).toBe("a\nb\n");
    expect(shape).toEqual({ eol: "\r\n", bom: true });
  });

  it("normalizes a mixed file to its majority ending", () => {
    expect(fromDisk("a\r\nb\r\nc\nd").shape.eol).toBe("\r\n");
    expect(fromDisk("a\nb\nc\r\nd").shape.eol).toBe("\n");
    expect(fromDisk("a\r\nb\n").shape.eol).toBe("\n");
    expect(fromDisk("old\rmac").text).toBe("old\nmac");
  });

  it("writes edits in the file's own ending", () => {
    const { shape } = fromDisk("x\r\ny\r\n");
    expect(toDisk("x\ny\nnew line\n", shape)).toBe("x\r\ny\r\nnew line\r\n");
  });
});

describe("adoptShape", () => {
  it("takes the disk's endings and BOM once its text is accepted", () => {
    const crlfBom = { eol: "\r\n" as const, bom: true };
    expect(adoptShape(crlfBom, { eol: "\n", bom: false }, "a\nb")).toEqual({ eol: "\n", bom: false });
  });

  it("keeps the current ending when the disk text has no line break to show one", () => {
    expect(adoptShape({ eol: "\r\n", bom: false }, { eol: "\n", bom: true }, "one line")).toEqual({
      eol: "\r\n",
      bom: true,
    });
  });
});

describe("minimalChange", () => {
  const apply = (a: string, c: ReturnType<typeof minimalChange>) =>
    c ? a.slice(0, c.from) + c.insert + a.slice(c.to) : a;

  it("replaces only the middle", () => {
    expect(minimalChange("hello world", "hello brave world")).toEqual({ from: 6, to: 6, insert: "brave " });
    expect(minimalChange("abc", "abc")).toBeNull();
    expect(minimalChange("abcdef", "abXYef")).toEqual({ from: 2, to: 4, insert: "XY" });
  });

  it("produces the target text in every overlap case", () => {
    const pairs: Array<[string, string]> = [
      ["", "new"],
      ["old", ""],
      ["aaa", "aaaa"],
      ["aaaa", "aa"],
      ["x\ny\n", "x\n\ny\n"],
      ["same start, other end", "same start, new end!"],
    ];
    for (const [a, b] of pairs) expect(apply(a, minimalChange(a, b))).toBe(b);
  });
});

describe("reconcile", () => {
  const note = (baseline: string, doc: string, inFlight: string | null = null) => ({ baseline, doc, inFlight });

  it("ignores our own save echoing back", () => {
    expect(reconcile(note("v1", "v1"), "v1")).toBe("same");
    expect(reconcile(note("v1", "v2", "v2"), "v2")).toBe("same");
    expect(reconcile(note("v1", "v3", "v2"), "v2")).toBe("same");
  });

  it("adopts another writer's text when nothing is unsaved", () => {
    expect(reconcile(note("v1", "v1"), "theirs")).toBe("adopt");
  });

  it("never overwrites unsaved text", () => {
    expect(reconcile(note("v1", "mine"), "theirs")).toBe("conflict");
  });

  it("recognizes both sides arriving at the same text", () => {
    expect(reconcile(note("v1", "both"), "both")).toBe("converged");
  });
});
