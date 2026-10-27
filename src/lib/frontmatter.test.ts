import { describe, expect, it } from "vitest";
import { splitFrontMatter } from "./frontmatter";

describe("splitFrontMatter", () => {
  it("returns the text untouched without a block", () => {
    const r = splitFrontMatter("# Title\n\nbody");
    expect(r.fields).toEqual([]);
    expect(r.body).toBe("# Title\n\nbody");
  });

  it("flattens scalars, quoted strings, inline and block lists", () => {
    const text = [
      "---",
      'title: "Self-Hosted Setup: Server"',
      "type: reference",
      "date_ingested: '2026-09-06'",
      "topics: [notes, self-hosting, tauri]",
      "key_concepts:",
      "  [",
      "    notes,",
      "    search-index,",
      "  ]",
      "tags:",
      "  - one",
      "  - two",
      "status: evergreen",
      "---",
      "",
      "# Body",
    ].join("\n");
    const r = splitFrontMatter(text);
    expect(r.body).toBe("\n# Body");
    expect(r.fields).toEqual([
      ["title", "Self-Hosted Setup: Server"],
      ["type", "reference"],
      ["date_ingested", "2026-09-06"],
      ["topics", "notes, self-hosting, tauri"],
      ["key_concepts", "notes, search-index"],
      ["tags", "one two"],
      ["status", "evergreen"],
    ]);
  });

  it("handles CRLF and an empty block", () => {
    const r = splitFrontMatter("---\r\na: 1\r\n---\r\nbody");
    expect(r.fields).toEqual([["a", "1"]]);
    expect(r.body).toBe("body");
    expect(splitFrontMatter("---\n---\nx").fields).toEqual([]);
  });

  it("ignores a horizontal rule that is not front matter", () => {
    const r = splitFrontMatter("intro\n---\nmore");
    expect(r.fields).toEqual([]);
  });
});
