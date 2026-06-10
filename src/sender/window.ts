/**
 * Send-window gate. Cold outreach goes out only during business hours, Mon–Fri,
 * in Mexico-City local time. The daemon runs with TZ=America/Mexico_City (systemd
 * unit + vitest config), so `getDay()`/`getHours()` are already MX-local — no
 * manual offset. Env-overridable for tuning.
 */

export interface WindowCfg {
  /** Inclusive start hour, 0–23 (local). */
  startHour: number;
  /** Exclusive end hour, 0–24 (local). */
  endHour: number;
  /** Allowed weekdays as getDay() values (0=Sun … 6=Sat). Default Mon–Fri. */
  days: ReadonlyArray<number>;
}

const DEFAULT_START = 10;
const DEFAULT_END = 18;
const DEFAULT_DAYS = [1, 2, 3, 4, 5] as const; // Mon–Fri

function intEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = Number(env[key]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

/** Build the send-window config from env (with safe defaults + clamping). */
export function loadWindowCfg(env: NodeJS.ProcessEnv = process.env): WindowCfg {
  const startHour = intEnv(
    env,
    "OUTREACH_WINDOW_START_HOUR",
    DEFAULT_START,
    0,
    23,
  );
  const endHour = intEnv(env, "OUTREACH_WINDOW_END_HOUR", DEFAULT_END, 1, 24);
  // Guard against an inverted window (start >= end) → fall back to defaults.
  if (endHour <= startHour) {
    return {
      startHour: DEFAULT_START,
      endHour: DEFAULT_END,
      days: DEFAULT_DAYS,
    };
  }
  return { startHour, endHour, days: DEFAULT_DAYS };
}

/** True if `date` (MX-local) is inside the send window. */
export function isWithinSendWindow(date: Date, cfg: WindowCfg): boolean {
  if (!cfg.days.includes(date.getDay())) return false;
  const h = date.getHours();
  return h >= cfg.startHour && h < cfg.endHour;
}
