/**
 * Time helpers. The daily send counter (`daily_sends.day`) is keyed by the
 * LOCAL Mexico-City calendar day, not UTC — a send at 23:30 MX must land on that
 * MX day, and the day must roll at MX midnight. `toISOString()` is UTC and would
 * mis-bucket the evening window, so we format with an explicit timeZone (per the
 * global timezone rule). `en-CA` yields an ISO-style `YYYY-MM-DD`.
 */

/** Current Mexico-City calendar day as 'YYYY-MM-DD' (the daily_sends key). */
export function mxDayKey(nowMs: number = Date.now()): string {
  return new Date(nowMs).toLocaleDateString("en-CA", {
    timeZone: "America/Mexico_City",
  });
}
