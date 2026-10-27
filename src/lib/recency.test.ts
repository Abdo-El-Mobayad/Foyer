import { describe, expect, it } from "vitest";
import {
  clampMinutes,
  DEFAULT_MINUTES,
  formatAge,
  nextPreset,
  PRESETS,
  sinceMs,
  windowLabel,
} from "./recency";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

describe("window", () => {
  it("clamps a custom window and drops a corrupted one", () => {
    expect(clampMinutes(0)).toBe(1);
    expect(clampMinutes(-5)).toBe(1);
    expect(clampMinutes(90.4)).toBe(90);
    expect(clampMinutes(9_999_999)).toBe(525_600);
    expect(clampMinutes(Number.NaN)).toBe(DEFAULT_MINUTES);
    expect(clampMinutes(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MINUTES);
    expect(DEFAULT_MINUTES).toBe(3 * 24 * 60);
  });

  it("resolves to a cutoff behind now", () => {
    expect(sinceMs(60, NOW)).toBe(NOW - HOUR);
    expect(sinceMs(1440, NOW)).toBe(NOW - DAY);
    // A corrupted window still produces a usable cutoff, never NaN.
    expect(sinceMs(Number.NaN, NOW)).toBe(NOW - 3 * DAY);
  });

  it("labels a window the way a person would say it", () => {
    expect(windowLabel(30)).toBe("30m");
    expect(windowLabel(60)).toBe("1h");
    expect(windowLabel(1440)).toBe("24h");
    expect(windowLabel(2160)).toBe("36h");
    expect(windowLabel(10080)).toBe("7d");
    expect(windowLabel(43200)).toBe("30d");
  });

  it("offers the next wider preset, and nothing past the widest", () => {
    expect(nextPreset(60)?.id).toBe("3d");
    expect(nextPreset(4320)?.id).toBe("7d");
    expect(nextPreset(10080)).toBeNull();
    expect(nextPreset(20000)).toBeNull();
    // A custom window between presets widens to the one above it.
    expect(nextPreset(5000)?.id).toBe("7d");
  });

  it("exposes presets in ascending order", () => {
    const mins = PRESETS.map((p) => p.minutes);
    expect(mins).toEqual([...mins].sort((a, b) => a - b));
  });
});

describe("formatAge", () => {
  const age = (msAgo: number) => formatAge(NOW - msAgo, NOW);

  it("walks the units at their boundaries", () => {
    expect(age(0)).toBe("<1m");
    expect(age(59_000)).toBe("<1m");
    expect(age(MIN)).toBe("1m");
    expect(age(59 * MIN)).toBe("59m");
    expect(age(HOUR)).toBe("1h");
    expect(age(23 * HOUR)).toBe("23h");
    expect(age(DAY)).toBe("1d");
    expect(age(6 * DAY)).toBe("6d");
    expect(age(7 * DAY)).toBe("1w");
    expect(age(51 * 7 * DAY)).toBe("51w");
    expect(age(365 * DAY)).toBe("1y");
    expect(age(730 * DAY)).toBe("2y");
  });

  it("has no gap at the year boundary", () => {
    // Rolling weeks into years through days would read "0y" here.
    expect(age(364 * DAY)).toBe("1y");
    for (let days = 350; days <= 380; days++) {
      expect(age(days * DAY)).not.toBe("0y");
    }
  });

  it("clamps a future mtime instead of going negative", () => {
    expect(formatAge(NOW + HOUR, NOW)).toBe("<1m");
  });

  it("always fits the 8ch column with its suffix", () => {
    for (const msAgo of [0, MIN, 59 * MIN, 23 * HOUR, 6 * DAY, 51 * 7 * DAY, 3650 * DAY]) {
      expect(`${age(msAgo)} ago`.length).toBeLessThanOrEqual(8);
    }
  });
});
