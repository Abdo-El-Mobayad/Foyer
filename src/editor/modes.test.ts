import { describe, expect, it } from "vitest";
import { resolveMode, toggledMode } from "./modes";

describe("markdown modes", () => {
  it("opens every editable file in Preview until the editor is asked for", () => {
    expect(resolveMode(undefined, true, false)).toBe("preview");
    expect(resolveMode(undefined, true, true)).toBe("preview");
    expect(resolveMode("edit", true, false)).toBe("edit");
    expect(resolveMode("split", true, true)).toBe("split");
    expect(resolveMode("source", true, false)).toBe("preview");
  });

  it("never puts a read-only file in the editor", () => {
    expect(resolveMode("edit", false, false)).toBe("source");
    expect(resolveMode("split", false, true)).toBe("source");
    expect(resolveMode("preview", false, true)).toBe("preview");
    // A large read-only document still opens in Source, as before 0.6.0.
    expect(resolveMode(undefined, false, true)).toBe("source");
    expect(resolveMode(undefined, false, false)).toBe("preview");
  });

  it("toggles between Preview and the last editing mode", () => {
    expect(toggledMode("preview", true, "split")).toBe("split");
    expect(toggledMode("edit", true, "split")).toBe("preview");
    expect(toggledMode("split", true, "edit")).toBe("preview");
    expect(toggledMode("preview", false, "edit")).toBe("source");
    expect(toggledMode("source", false, "edit")).toBe("preview");
  });
});
