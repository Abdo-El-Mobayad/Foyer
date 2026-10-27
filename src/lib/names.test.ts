import { describe, expect, it } from "vitest";
import {
  isMarkdownName,
  isUnder,
  nameProblem,
  nameTaken,
  noteFileName,
  remapPath,
  stemLength,
  untitledStem,
} from "./names";

describe("names", () => {
  it("accepts ordinary names", () => {
    for (const ok of ["Meeting notes.md", "2026-09-24", ".notes", "a.b.c", "Ünïcode ✓"]) {
      expect(nameProblem(ok)).toBeNull();
    }
  });

  it("refuses what Windows refuses", () => {
    for (const bad of ["", ".", "..", "a/b", "a\\b", "a:b", 'q"', "x?", "star*", "p|q", "<x>", "tab\there"]) {
      expect(nameProblem(bad), bad).not.toBeNull();
    }
    for (const bad of ["trailing.", "trailing ", "CON", "con.md", "Lpt3.txt", "nul", "COM1"]) {
      expect(nameProblem(bad), bad).not.toBeNull();
    }
    expect(nameProblem("x".repeat(256))).not.toBeNull();
    expect(nameProblem("console.md")).toBeNull();
    expect(nameProblem("COM10")).toBeNull();
  });

  it("gives a typed note name a Markdown extension", () => {
    expect(noteFileName("Meeting")).toBe("Meeting.md");
    expect(noteFileName("  Meeting.md ")).toBe("Meeting.md");
    expect(noteFileName("Spec.MDX")).toBe("Spec.MDX");
    expect(noteFileName("v1.2")).toBe("v1.2.md");
    expect(noteFileName("renamed", "markdown")).toBe("renamed.markdown");
    expect(isMarkdownName("x.markdown")).toBe(true);
    expect(isMarkdownName("x.txt")).toBe(false);
  });

  it("finds the first free Untitled", () => {
    expect(untitledStem([])).toBe("Untitled");
    expect(untitledStem(["untitled.md"])).toBe("Untitled 2");
    expect(untitledStem(["Untitled.md", "Untitled 2.md", "Untitled 4.md"])).toBe("Untitled 3");
    expect(untitledStem(["Untitled"])).toBe("Untitled");
  });

  it("selects the stem of a file and the whole of a folder", () => {
    expect(stemLength("note.md", false)).toBe(4);
    expect(stemLength("archive.tar.md", false)).toBe(11);
    expect(stemLength(".env", false)).toBe(4);
    expect(stemLength("v1.2", true)).toBe(4);
  });

  it("remaps a renamed file and everything under a renamed folder", () => {
    expect(remapPath("a/b.md", "a/b.md", "a/c.md")).toBe("a/c.md");
    expect(remapPath("a/x/y.md", "a/x", "a/z")).toBe("a/z/y.md");
    expect(remapPath("a/xy.md", "a/x", "a/z")).toBeNull();
    expect(remapPath("other.md", "a", "b")).toBeNull();
  });

  it("scopes paths under a folder", () => {
    expect(isUnder("a/b.md", "a")).toBe(true);
    expect(isUnder("a", "a")).toBe(true);
    expect(isUnder("ab/c.md", "a")).toBe(false);
    expect(isUnder("anything", "")).toBe(true);
  });

  it("treats a case-only rename of the same entry as free", () => {
    expect(nameTaken("Note.md", ["note.md", "b.md"])).toBe(true);
    expect(nameTaken("Note.md", ["note.md", "b.md"], "dir/note.md")).toBe(false);
    expect(nameTaken("B.md", ["note.md", "b.md"], "dir/note.md")).toBe(true);
    expect(nameTaken("c.md", ["note.md", "b.md"])).toBe(false);
  });
});
