/**
 * Daily send ramp for warming a fresh number. The cap on a given send-day is
 * RAMP[min(priorSendDays, len-1)] — i.e. the schedule advances per ACTIVE
 * send-day (a weekend/holiday gap doesn't skip a step), and holds the last value
 * once the schedule is exhausted. Ban-averse: starts tiny, climbs slowly.
 */

const DEFAULT_RAMP = [5, 8, 12, 15, 20, 25, 30, 35, 40] as const;

/** Parse OUTREACH_RAMP (comma-separated positive ints); fall back to default. */
export function loadRamp(env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = env["OUTREACH_RAMP"];
  if (!raw) return [...DEFAULT_RAMP];
  const parsed = raw
    .split(",")
    .map((s) => Math.floor(Number(s.trim())))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length > 0 ? parsed : [...DEFAULT_RAMP];
}

/**
 * Today's cap given how many prior days already had sends. `priorSendDays` is
 * clamped to ≥0; values past the schedule length hold the final (max) cap.
 */
export function rampCapForDay(priorSendDays: number, ramp: number[]): number {
  const schedule = ramp.length > 0 ? ramp : [...DEFAULT_RAMP];
  const idx = Math.min(
    Math.max(0, Math.floor(priorSendDays)),
    schedule.length - 1,
  );
  return schedule[idx]!;
}
