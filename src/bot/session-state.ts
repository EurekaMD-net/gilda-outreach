/**
 * Single-session Baileys connection-state registry for the outreach number.
 *
 * Unlike the salones-wa product bot — which is MULTI-tenant (one socket per
 * salon) and aggressively self-heals every stuck socket — outreach runs ONE
 * session and is deliberately BAN-AVERSE. The defining inversion (spec §6):
 *
 *   • A transient/network drop (428, 515, connection-lost) → reconnect, same as
 *     salones. A half-open zombie that never fires "close" is recovered by the
 *     liveness watchdog below.
 *   • A `logged_out` / 401 is a PROBABLE BAN → latch `halted`, alert the
 *     operator loudly, and NEVER auto-reconnect. Reconnecting a banned number
 *     digs the hole deeper. Recovery is a deliberate manual re-link only.
 *
 * In-memory by design (like salones-wa/baileys-state): the durable alerting is
 * owned off-process. `lastConnectedAt` resets on restart; the registry is only
 * the instantaneous signal that /metrics + the watchdog read.
 */

export type OutreachConnState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "logged_out";

/** Canonical ordering for the Prometheus enum gauge (one series per state). */
export const OUTREACH_STATES: readonly OutreachConnState[] = [
  "connecting",
  "connected",
  "reconnecting",
  "logged_out",
] as const;

export interface SessionState {
  state: OutreachConnState;
  /** Epoch ms the CURRENT state was entered (stable across repeats). */
  since: number;
  /** Epoch ms of the last time state became "connected" (null if never). */
  lastConnectedAt: number | null;
  /** Epoch ms of the last record write. */
  updatedAt: number;
  /**
   * Latched STOP. Set on a probable ban (logged_out/401) or when the watchdog
   * exhausts its reconnect strikes. While true, nothing auto-reconnects and (in
   * P3) nothing sends. Cleared only by actually reaching "connected" again
   * (i.e. a successful manual re-link).
   */
  halted: boolean;
  /** Human-readable reason the session was halted (null when not halted). */
  haltReason: string | null;
}

let session: SessionState | null = null;

/** Process boot time — reference for a session that has NEVER connected. */
const BOOT_TIME_MS = Date.now();

/** Boot reference, for callers that need it (watchdog / endpoints). */
export function getBootTime(): number {
  return BOOT_TIME_MS;
}

/**
 * Record a connection-state transition. Idempotent on the state value:
 * re-recording the same state preserves `since` (so a flapping reconnect
 * doesn't reset the "in state X since" clock). `lastConnectedAt` only advances
 * on "connected". Reaching "connected" CLEARS a prior halt (recovered); any
 * other transition preserves the latch.
 */
export function recordSessionState(
  state: OutreachConnState,
  nowMs: number = Date.now(),
): void {
  const prev = session;
  const recovered = state === "connected";
  session = {
    state,
    since: prev && prev.state === state ? prev.since : nowMs,
    lastConnectedAt: recovered ? nowMs : (prev?.lastConnectedAt ?? null),
    updatedAt: nowMs,
    halted: recovered ? false : (prev?.halted ?? false),
    haltReason: recovered ? null : (prev?.haltReason ?? null),
  };
}

/**
 * Latch the session HALTED — the ban-averse stop. Forces state to
 * `logged_out`, records the reason, and is sticky until a real reconnect
 * (`recordSessionState("connected")`) clears it. Called on a WA logout/401 and
 * when the watchdog gives up on a stuck socket.
 */
export function markHalted(reason: string, nowMs: number = Date.now()): void {
  const prev = session;
  session = {
    state: "logged_out",
    since: prev && prev.state === "logged_out" ? prev.since : nowMs,
    lastConnectedAt: prev?.lastConnectedAt ?? null,
    updatedAt: nowMs,
    halted: true,
    haltReason: reason,
  };
}

export function getSessionState(): SessionState | null {
  return session;
}

/** Latched ban-averse stop — read by the watchdog and (P3) the sender. */
export function isHalted(): boolean {
  return session?.halted ?? false;
}

/** Test helper — clear the registry between cases. */
export function resetSessionState(): void {
  session = null;
}

// ─── Health evaluation (pure) ──────────────────────────────────────────────

export interface SessionHealth {
  /** "unknown" = booted but no transition recorded yet. */
  state: OutreachConnState | "unknown";
  up: boolean;
  halted: boolean;
  haltReason: string | null;
  since: number | null;
  lastConnectedAt: number | null;
  /** Seconds since last connection (null while connected). */
  downForSeconds: number | null;
  /** True if not connected AND down longer than the alert threshold. */
  stale: boolean;
}

interface HealthOpts {
  nowMs: number;
  thresholdMs: number;
  bootMs: number;
}

/** Turn the (possibly absent) session record into a health verdict. */
export function evaluateSessionHealth(
  record: SessionState | null,
  opts: HealthOpts,
): SessionHealth {
  const state: OutreachConnState | "unknown" = record?.state ?? "unknown";
  const lastConnectedAt = record?.lastConnectedAt ?? null;
  const connected = state === "connected";
  const referenceMs = lastConnectedAt ?? opts.bootMs;
  const downForMs = connected ? 0 : Math.max(0, opts.nowMs - referenceMs);
  return {
    state,
    up: connected,
    halted: record?.halted ?? false,
    haltReason: record?.haltReason ?? null,
    since: record?.since ?? null,
    lastConnectedAt,
    downForSeconds: connected ? null : Math.floor(downForMs / 1000),
    stale: !connected && downForMs > opts.thresholdMs,
  };
}

const DEFAULT_ALERT_HOURS = 24;

/**
 * Stale-disconnect threshold in hours (env OUTREACH_DISCONNECT_ALERT_HOURS,
 * floored to 1h, default 24). Only used to flag `stale` in /health; the durable
 * page is owned off-process.
 */
export function disconnectAlertHours(): number {
  const raw = Number(process.env["OUTREACH_DISCONNECT_ALERT_HOURS"]);
  if (!Number.isFinite(raw)) return DEFAULT_ALERT_HOURS;
  return Math.max(1, Math.floor(raw));
}

// ─── Liveness watchdog (INVERTED self-heal) ─────────────────────────────────

const DEFAULT_STUCK_MINUTES = 5;

/**
 * Minutes the session may sit non-`connected` (and non-halted) before the
 * watchdog force-reconnects a transient zombie. Env
 * OUTREACH_RECONNECT_STUCK_MINUTES, floored at 1, default 5.
 */
export function reconnectStuckMinutes(): number {
  const raw = Number(process.env["OUTREACH_RECONNECT_STUCK_MINUTES"]);
  if (!Number.isFinite(raw)) return DEFAULT_STUCK_MINUTES;
  return Math.max(1, Math.floor(raw));
}

// Ban-averse: FEWER strikes than the salones product bot (default 5). After 3
// failed transient-reconnects we stop and escalate to a human rather than keep
// hammering WA's backend from a data-center IP.
const DEFAULT_MAX_STRIKES = 3;

/**
 * Max consecutive transient-reconnect attempts before the watchdog gives up and
 * latches HALTED (manual check). Env OUTREACH_RECONNECT_MAX_STRIKES, floored at
 * 1, default 3. Strikes reset on reaching "connected".
 */
export function reconnectMaxStrikes(): number {
  const raw = Number(process.env["OUTREACH_RECONNECT_MAX_STRIKES"]);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_STRIKES;
  return Math.max(1, Math.floor(raw));
}

/** Mutable watchdog memory (persisted across ticks in index.ts). */
export interface WatchdogMemory {
  /** Consecutive reinit attempts since last "connected". */
  strikes: number;
  /** Epoch ms of the last reinit (burn-loop cooldown anchor). */
  lastHealAt: number;
}

export interface OutreachWatchdogOpts {
  nowMs: number;
  /** Non-connected longer than this (ms) → transient-recovery candidate. */
  stuckMs: number;
  /** Min gap (ms) between reinits (burn-loop guard). */
  cooldownMs: number;
  /** Process boot, for a session with no record yet. */
  bootMs: number;
  /** Give up + halt after this many consecutive reinits. */
  maxStrikes: number;
  /** qa-W4 parity: never reinit an unregistered (mid-pairing) session. */
  isRegistered: () => boolean;
}

export interface OutreachWatchdogResult {
  /** Force a fresh socket this tick (transient recovery). */
  reinit: boolean;
  /** This tick exhausted the strike budget — caller should latch + alert. */
  gaveUp: boolean;
}

/**
 * Decide one watchdog tick for the single outreach session. Pure except for the
 * injected `isRegistered` predicate and the in-place mutation of `mem`.
 *
 * THE INVERSION lives here: a `logged_out`/`halted` session is NEVER reinited
 * (probable ban → manual re-link only). Only a stuck transient socket
 * (connecting/reconnecting that froze past `stuckMs`) is recovered — that is
 * the half-open-zombie case the close-event-driven reconnect can't catch. After
 * `maxStrikes` consecutive failures we give up and signal the caller to latch
 * HALTED + alert, rather than hammer WA's backend forever.
 */
export function planOutreachWatchdogTick(
  record: SessionState | null,
  mem: WatchdogMemory,
  opts: OutreachWatchdogOpts,
): OutreachWatchdogResult {
  // Recovered → clean slate (a future incident gets a fresh strike allowance).
  if (record?.state === "connected") {
    mem.strikes = 0;
    mem.lastHealAt = 0;
    return { reinit: false, gaveUp: false };
  }
  // THE INVERSION: a banned / halted session is never auto-reconnected.
  if (record?.state === "logged_out" || record?.halted) {
    return { reinit: false, gaveUp: false };
  }
  // Never burn an in-flight pairing code (session not yet registered).
  if (!opts.isRegistered()) return { reinit: false, gaveUp: false };
  // Budget exhausted — GIVE UP (a separate tick from the last reinit, so we
  // never reinit AND halt in the same tick). The caller latches HALTED + alerts
  // a human; once latched, the logged_out check above makes every later tick a
  // no-op. Fires once.
  if (mem.strikes >= opts.maxStrikes) {
    return { reinit: false, gaveUp: true };
  }
  // Post-heal cooldown.
  if (opts.nowMs - mem.lastHealAt < opts.cooldownMs) {
    return { reinit: false, gaveUp: false };
  }
  // Stuck check. No record at all → treat as stuck-since-boot.
  const referenceMs = record ? record.since : opts.bootMs;
  if (opts.nowMs - referenceMs <= opts.stuckMs) {
    return { reinit: false, gaveUp: false };
  }
  // Recover the transient zombie. This consumes one strike; the give-up halt is
  // decided on a LATER tick (above) once the budget is spent.
  mem.strikes += 1;
  mem.lastHealAt = opts.nowMs;
  return { reinit: true, gaveUp: false };
}
