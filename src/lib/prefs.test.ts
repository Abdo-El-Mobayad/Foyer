import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampReadingWidth,
  clampSidebarWidth,
  normalizeReadingWidth,
  READING_WIDTH_DEFAULT,
  READING_WIDTH_MAX,
  READING_WIDTH_MIN,
  readReadingWidth,
  readViewState,
  SIDEBAR_WIDTH_DEFAULT,
  writeReadingWidth,
  writeViewState,
} from "./prefs";
import { DEFAULT_MINUTES } from "./recency";

/** The slice of Storage the prefs use, over a Map. */
function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  } as Storage;
}

describe("reading width", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("clamps a custom measure and drops a corrupted one", () => {
    expect(clampReadingWidth(100)).toBe(READING_WIDTH_MIN);
    expect(clampReadingWidth(99999)).toBe(READING_WIDTH_MAX);
    expect(clampReadingWidth(801.6)).toBe(802);
    expect(clampReadingWidth(Number.NaN)).toBeNull();
    expect(clampReadingWidth(null)).toBeNull();
  });

  it("normalizes partial or garbage input to a whole preference", () => {
    expect(normalizeReadingWidth(undefined)).toEqual(READING_WIDTH_DEFAULT);
    expect(normalizeReadingWidth({})).toEqual({ px: null, full: false });
    expect(normalizeReadingWidth({ px: "wide" as unknown as number, full: "1" as unknown as boolean })).toEqual({
      px: null,
      full: false,
    });
    expect(normalizeReadingWidth({ px: 900, full: true })).toEqual({ px: 900, full: true });
  });

  it("round-trips through storage and survives bad or missing storage", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    writeReadingWidth({ px: 1200, full: false });
    expect(readReadingWidth()).toEqual({ px: 1200, full: false });
    writeReadingWidth({ px: 1200, full: true });
    expect(readReadingWidth()).toEqual({ px: 1200, full: true });
    localStorage.setItem("foyer.readingWidth", "{not json");
    expect(readReadingWidth()).toEqual(READING_WIDTH_DEFAULT);

    const broken = fakeStorage();
    broken.getItem = () => {
      throw new Error("quota");
    };
    vi.stubGlobal("localStorage", broken);
    expect(readReadingWidth()).toEqual(READING_WIDTH_DEFAULT);
    expect(() => writeReadingWidth({ px: 800, full: false })).not.toThrow();
  });
});

describe("sidebar width", () => {
  it("leaves room for the preview on a narrow window", () => {
    expect(clampSidebarWidth(500, 700)).toBe(340);
    expect(clampSidebarWidth(500, 1600)).toBe(500);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });
});

describe("view state", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips the modified-within window per mount", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    writeViewState("m1", { expanded: ["a"], tabs: ["a/b.md"], active: "a/b.md", recentMinutes: 4320 });
    writeViewState("m2", { expanded: [], tabs: [], active: null, recentMinutes: 10080 });
    expect(readViewState("m1").recentMinutes).toBe(4320);
    expect(readViewState("m2").recentMinutes).toBe(10080);
    expect(readViewState("m1").tabs).toEqual(["a/b.md"]);
  });

  it("takes the default for a state written before the field existed", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    // Exactly what 0.3.0 wrote: no recentMinutes key at all.
    localStorage.setItem(
      "foyer.view:old",
      JSON.stringify({ expanded: ["x"], tabs: [], active: null }),
    );
    const v = readViewState("old");
    expect(v.recentMinutes).toBe(DEFAULT_MINUTES);
    expect(v.expanded).toEqual(["x"]);
  });

  it("clamps a hand-edited window and survives a corrupted one", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    localStorage.setItem("foyer.view:m", JSON.stringify({ recentMinutes: 0 }));
    expect(readViewState("m").recentMinutes).toBe(1);
    localStorage.setItem("foyer.view:m", JSON.stringify({ recentMinutes: 1e9 }));
    expect(readViewState("m").recentMinutes).toBe(525_600);
    localStorage.setItem("foyer.view:m", JSON.stringify({ recentMinutes: "soon" }));
    expect(readViewState("m").recentMinutes).toBe(DEFAULT_MINUTES);
    localStorage.setItem("foyer.view:m", "{not json");
    expect(readViewState("m").recentMinutes).toBe(DEFAULT_MINUTES);
  });
});
