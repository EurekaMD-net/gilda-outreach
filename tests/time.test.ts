import { describe, it, expect } from "vitest";
import { mxDayKey } from "../src/util/time.js";

describe("mxDayKey", () => {
  it("formats as YYYY-MM-DD", () => {
    expect(mxDayKey(1_700_000_000_000)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("buckets a late-evening MX instant on the MX day, not the UTC next-day", () => {
    // 2026-06-11T05:30:00Z == 2026-06-10 23:30 in America/Mexico_City (UTC-6).
    // A naive toISOString() bucket would mis-file it as 2026-06-11.
    const utc = Date.parse("2026-06-11T05:30:00Z");
    expect(mxDayKey(utc)).toBe("2026-06-10");
  });

  it("rolls to the next day at MX midnight", () => {
    // 2026-06-11T06:00:00Z == 2026-06-11 00:00 MX → new day.
    const utc = Date.parse("2026-06-11T06:00:00Z");
    expect(mxDayKey(utc)).toBe("2026-06-11");
  });
});
