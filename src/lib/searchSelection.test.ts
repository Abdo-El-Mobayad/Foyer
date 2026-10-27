import { describe, expect, it } from "vitest";
import { reselect } from "./searchSelection";

const hits = (...paths: string[]) => paths.map((path) => ({ path }));

describe("reselect", () => {
  it("follows the selected path as results reorder", () => {
    const before = hits("a.md", "b.md", "c.md");
    expect(reselect("c.md", before)).toBe(2);
    // A watcher batch bumps c.md to the top of a newest-first list.
    const after = hits("c.md", "a.md", "b.md");
    expect(reselect("c.md", after)).toBe(0);
  });

  it("falls back to the top when the selection is gone or absent", () => {
    expect(reselect("deleted.md", hits("a.md"))).toBe(0);
    expect(reselect(null, hits("a.md", "b.md"))).toBe(0);
  });

  it("never returns an index the list cannot hold", () => {
    expect(reselect("a.md", [])).toBe(0);
    expect(reselect(null, [])).toBe(0);
  });
});
