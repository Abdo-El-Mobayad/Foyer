import { describe, expect, it } from "vitest";
import { closeTabs, openTab, TAB_CAP, touchRecent } from "./tabs";

describe("bounded tabs", () => {
  it("adds new tabs in order and re-opening only touches recency", () => {
    let s = openTab({ tabs: [], recent: [] }, "a.md");
    s = openTab(s, "b.md");
    s = openTab(s, "a.md");
    expect(s.tabs).toEqual(["a.md", "b.md"]);
    expect(s.recent).toEqual(["a.md", "b.md"]);
    expect(touchRecent(["x", "y", "z"], "z")).toEqual(["z", "x", "y"]);
  });

  it("evicts the least recently viewed tab past the cap, never the one being opened", () => {
    let s = { tabs: [] as string[], recent: [] as string[] };
    for (let i = 0; i < TAB_CAP; i++) s = openTab(s, `f${i}`);
    expect(s.tabs.length).toBe(TAB_CAP);
    // f0 is the oldest; view it again so f1 becomes the oldest.
    s = openTab(s, "f0");
    s = openTab(s, "new");
    expect(s.tabs.length).toBe(TAB_CAP);
    expect(s.tabs).not.toContain("f1");
    expect(s.tabs).toContain("f0");
    expect(s.tabs[s.tabs.length - 1]).toBe("new");
    expect(s.recent[0]).toBe("new");
    expect(s.recent).not.toContain("f1");
  });

  it("evicts tabs with no recency record first (restored from a previous session)", () => {
    const s = openTab({ tabs: ["r1", "r2", "r3"], recent: ["r3"] }, "n", 3);
    expect(s.tabs.length).toBe(3);
    expect(s.tabs).toContain("r3");
    expect(s.tabs).toContain("n");
    expect(s.tabs).not.toContain("r1");
  });

  it("closes many tabs at once and picks the neighbour of the active one", () => {
    const state = { tabs: ["a", "b", "c", "d", "e"], recent: ["c", "a", "e"] };
    const r = closeTabs(state, ["b", "c", "d"], "c");
    expect(r.tabs).toEqual(["a", "e"]);
    expect(r.recent).toEqual(["a", "e"]);
    expect(r.active).toBe("e");
    // Closing the last tab falls back to the new last; closing everything -> null.
    expect(closeTabs(state, ["e"], "e").active).toBe("d");
    expect(closeTabs(state, state.tabs, "a").active).toBeNull();
    // Closing an inactive tab leaves the active one alone.
    expect(closeTabs(state, ["a"], "c").active).toBe("c");
    expect(closeTabs(state, [], "c")).toEqual({ ...state, active: "c" });
  });
});
