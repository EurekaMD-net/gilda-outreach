import { describe, it, expect } from "vitest";
import {
  isWithinSendWindow,
  loadWindowCfg,
  type WindowCfg,
} from "../src/sender/window.js";

// Tests run with TZ=America/Mexico_City (vitest.config), matching production.
const CFG: WindowCfg = { startHour: 10, endHour: 18, days: [1, 2, 3, 4, 5] };

// Build a local-time Date for a known weekday. 2026-06-10 is a Wednesday.
const wed = (h: number, m = 0) => new Date(2026, 5, 10, h, m, 0); // Jun=5
const sat = (h: number) => new Date(2026, 5, 13, h, 0, 0); // Saturday

describe("isWithinSendWindow", () => {
  it("is open inside business hours on a weekday", () => {
    expect(isWithinSendWindow(wed(10), CFG)).toBe(true);
    expect(isWithinSendWindow(wed(13, 30), CFG)).toBe(true);
    expect(isWithinSendWindow(wed(17, 59), CFG)).toBe(true);
  });

  it("is closed before/after hours (end is exclusive)", () => {
    expect(isWithinSendWindow(wed(9, 59), CFG)).toBe(false);
    expect(isWithinSendWindow(wed(18), CFG)).toBe(false);
    expect(isWithinSendWindow(wed(22), CFG)).toBe(false);
  });

  it("is closed on weekends regardless of hour", () => {
    expect(isWithinSendWindow(sat(12), CFG)).toBe(false);
  });
});

describe("loadWindowCfg", () => {
  it("defaults to Mon–Fri 10–18", () => {
    const c = loadWindowCfg({});
    expect(c.startHour).toBe(10);
    expect(c.endHour).toBe(18);
    expect([...c.days]).toEqual([1, 2, 3, 4, 5]);
  });

  it("honors env overrides", () => {
    const c = loadWindowCfg({
      OUTREACH_WINDOW_START_HOUR: "11",
      OUTREACH_WINDOW_END_HOUR: "16",
    } as NodeJS.ProcessEnv);
    expect(c.startHour).toBe(11);
    expect(c.endHour).toBe(16);
  });

  it("falls back to defaults on an inverted window", () => {
    const c = loadWindowCfg({
      OUTREACH_WINDOW_START_HOUR: "18",
      OUTREACH_WINDOW_END_HOUR: "10",
    } as NodeJS.ProcessEnv);
    expect(c.startHour).toBe(10);
    expect(c.endHour).toBe(18);
  });
});
