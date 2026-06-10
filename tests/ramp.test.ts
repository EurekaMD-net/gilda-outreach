import { describe, it, expect } from "vitest";
import { loadRamp, rampCapForDay } from "../src/sender/ramp.js";

describe("rampCapForDay", () => {
  const ramp = [5, 8, 12, 15, 20];

  it("returns the cap for the given prior-send-day index", () => {
    expect(rampCapForDay(0, ramp)).toBe(5);
    expect(rampCapForDay(1, ramp)).toBe(8);
    expect(rampCapForDay(4, ramp)).toBe(20);
  });

  it("holds the last (max) cap once the schedule is exhausted", () => {
    expect(rampCapForDay(5, ramp)).toBe(20);
    expect(rampCapForDay(99, ramp)).toBe(20);
  });

  it("clamps a negative index to day 0", () => {
    expect(rampCapForDay(-3, ramp)).toBe(5);
  });
});

describe("loadRamp", () => {
  it("defaults to the ban-averse schedule", () => {
    expect(loadRamp({})).toEqual([5, 8, 12, 15, 20, 25, 30, 35, 40]);
  });

  it("parses a comma-separated override", () => {
    expect(
      loadRamp({ OUTREACH_RAMP: "3, 6, 10" } as NodeJS.ProcessEnv),
    ).toEqual([3, 6, 10]);
  });

  it("drops non-positive / non-numeric entries and falls back if empty", () => {
    expect(
      loadRamp({ OUTREACH_RAMP: "2,x,-4,0,7" } as NodeJS.ProcessEnv),
    ).toEqual([2, 7]);
    expect(loadRamp({ OUTREACH_RAMP: "nope,," } as NodeJS.ProcessEnv)).toEqual([
      5, 8, 12, 15, 20, 25, 30, 35, 40,
    ]);
  });
});
