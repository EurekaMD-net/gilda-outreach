/**
 * Outreach sender (P3) — the deterministic, ban-averse send engine.
 *
 * Modes (OUTREACH_MODE): off | shadow | live.
 *   off    — dormant. No tick loop. (Default; preserves the receiver-only daemon.)
 *   shadow — runs the full selection + pacing logic but only LOGS "would-send";
 *            never touches WhatsApp or prospect state. For review.
 *   live   — actually sends. Also requires OUTREACH_ENABLED=true (a second lock,
 *            enforced in index.ts) so flipping one flag can't message anyone.
 *
 * Every send is gated by: mode, send window (Mon–Fri 10–18 MX), the daily ramp
 * cap, a jittered min-gap (never bursty), the session NOT being halted (probable
 * ban), and a send-time blocklist re-check. The decision is a pure function
 * (decideTick); the I/O (WA send + DB write) is isolated in runTick.
 */

import type Database from "better-sqlite3";
import {
  getDailySent,
  getPriorSendDayCount,
  listProspectsByStatus,
  markProspectFailed,
  recordOutboundSend,
  type Prospect,
} from "../db/models.js";
import {
  isForbiddenNumber,
  loadBlocklist,
} from "../import/prospects-import.js";
import { isHalted } from "../bot/session-state.js";
import type { OutreachSession } from "../bot/baileys-manager.js";
import { mxDayKey } from "../util/time.js";
import { OUTREACH_MESSAGE, renderMessage } from "./copy.js";
import { isWithinSendWindow, loadWindowCfg, type WindowCfg } from "./window.js";
import { loadRamp, rampCapForDay } from "./ramp.js";

export type OutreachMode = "off" | "shadow" | "live";

/** Parse OUTREACH_MODE; anything but shadow/live is `off` (fail safe). */
export function loadMode(env: NodeJS.ProcessEnv = process.env): OutreachMode {
  const m = (env["OUTREACH_MODE"] ?? "off").trim().toLowerCase();
  return m === "shadow" || m === "live" ? m : "off";
}

// ─── Pure pacing / decision ─────────────────────────────────────────────────

const MIN_GAP_MS = 90_000; // never burst: ≥90s between sends
const MAX_GAP_MS = 30 * 60_000; // ≤30 min so low caps still finish in-window

/**
 * Gap until the next send: the window evenly divided by the day's cap, jittered
 * 60–140%, clamped to [90s, 30min]. Spreads the day's sends across business
 * hours without a detectable cadence.
 */
export function nextGapMs(
  cap: number,
  windowMs: number,
  rand: () => number = Math.random,
): number {
  const base = windowMs / Math.max(1, cap);
  const jittered = base * (0.6 + 0.8 * rand());
  return Math.round(Math.max(MIN_GAP_MS, Math.min(MAX_GAP_MS, jittered)));
}

export interface TickState {
  mode: OutreachMode;
  windowOpen: boolean;
  halted: boolean;
  todaySent: number;
  todayCap: number;
  now: number;
  lastSentAt: number | null;
  minGapMs: number;
}

export type TickDecision = { send: true } | { send: false; reason: string };

/** Pure: should this tick send? Gates in priority order. */
export function decideTick(s: TickState): TickDecision {
  if (s.mode === "off") return { send: false, reason: "mode=off" };
  if (s.halted) return { send: false, reason: "session halted (anti-ban)" };
  if (!s.windowOpen) return { send: false, reason: "outside send window" };
  if (s.todaySent >= s.todayCap)
    return {
      send: false,
      reason: `daily cap reached (${s.todaySent}/${s.todayCap})`,
    };
  if (s.lastSentAt != null && s.now - s.lastSentAt < s.minGapMs)
    return { send: false, reason: "min gap not elapsed" };
  return { send: true };
}

// ─── Selection ──────────────────────────────────────────────────────────────

/**
 * Next prospect to message: oldest `pending`, not blocklisted (re-checked at
 * send time, defense-in-depth), and — in shadow — not already virtually sent
 * this run. In live mode the real `sent` status advances, so no exclude set is
 * needed.
 */
export function selectNextProspect(
  db: Database.Database,
  excludeIds: ReadonlySet<string>,
  blocklist: ReadonlySet<string>,
  mode: OutreachMode,
): Prospect | null {
  const batch = listProspectsByStatus(db, "pending", 300);
  for (const p of batch) {
    if (mode === "shadow" && excludeIds.has(p.id)) continue;
    if (isForbiddenNumber(p.wa_jid, p.phone_raw, blocklist)) continue;
    return p;
  }
  return null;
}

// ─── Tick loop ──────────────────────────────────────────────────────────────

export interface SenderCtx {
  mode: OutreachMode;
  windowCfg: WindowCfg;
  ramp: number[];
  blocklist: ReadonlySet<string>;
  // mutable runtime state
  day: string;
  lastSentAt: number | null;
  currentGapMs: number;
  shadowCount: number;
  shadowSentIds: Set<string>;
  /** Reentrancy latch (qa-C1): a tick that stalls in `await sendMessage` must
   * not let the next interval fire a second send to the same pending prospect. */
  inFlight: boolean;
}

/** Hard ceiling on a single WhatsApp send. A stall longer than this is treated
 * as an UNCERTAIN outcome → mark-failed (at-most-once), never silently retried. */
const SEND_TIMEOUT_MS = 30_000;

/** Reject after `ms` if `p` hasn't settled (so one hung send can't wedge the loop). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("SEND_TIMEOUT")), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export interface TickOutcome {
  sent: boolean;
  reason?: string;
  prospectId?: string;
  shadow?: boolean;
}

function windowMsOf(cfg: WindowCfg): number {
  return (cfg.endHour - cfg.startHour) * 3_600_000;
}

/** One tick: decide, select, then (live) send + record or (shadow) log. */
export async function runTick(
  db: Database.Database,
  getSession: () => OutreachSession | null,
  ctx: SenderCtx,
): Promise<TickOutcome> {
  // qa-C1: a single tick at a time. If a prior tick is stalled inside
  // `await sendMessage`, this one no-ops — otherwise it would re-select the same
  // still-`pending` prospect and double-send (a ban trigger).
  if (ctx.inFlight) return { sent: false, reason: "tick already in flight" };
  ctx.inFlight = true;
  try {
    const now = Date.now();
    const today = mxDayKey(now);
    if (today !== ctx.day) {
      // New MX day → reset pacing + shadow bookkeeping.
      ctx.day = today;
      ctx.lastSentAt = null;
      ctx.shadowCount = 0;
      ctx.shadowSentIds.clear();
    }

    const windowOpen = isWithinSendWindow(new Date(now), ctx.windowCfg);
    const cap = rampCapForDay(getPriorSendDayCount(db, today), ctx.ramp);
    const realSent = getDailySent(db, today);
    const todaySent = ctx.mode === "shadow" ? ctx.shadowCount : realSent;

    const decision = decideTick({
      mode: ctx.mode,
      windowOpen,
      halted: isHalted(),
      todaySent,
      todayCap: cap,
      now,
      lastSentAt: ctx.lastSentAt,
      minGapMs: ctx.currentGapMs,
    });
    if (!decision.send) return { sent: false, reason: decision.reason };

    const session = getSession();
    if (ctx.mode === "live" && !session)
      return { sent: false, reason: "no live socket" };

    const prospect = selectNextProspect(
      db,
      ctx.shadowSentIds,
      ctx.blocklist,
      ctx.mode,
    );
    if (!prospect) return { sent: false, reason: "queue empty" };
    const body = renderMessage(prospect);

    if (ctx.mode === "live") {
      // Advance pacing BEFORE the await: a message is about to leave the wire,
      // so the min-gap clock must start now, not after the (possibly slow) send.
      ctx.lastSentAt = now;
      ctx.currentGapMs = nextGapMs(cap, windowMsOf(ctx.windowCfg));
      try {
        await withTimeout(
          session!.sendMessage(prospect.wa_jid, body),
          SEND_TIMEOUT_MS,
        );
      } catch (err) {
        // Uncertain outcome → at-most-once: mark failed, never retry this number.
        const reason = (err as Error)?.message ?? String(err);
        markProspectFailed(db, prospect.id, `send failed: ${reason}`);
        console.warn(
          `[sender] send FAILED → ${prospect.wa_jid}: ${reason} (marked failed, not retried)`,
        );
        return { sent: false, reason: "send failed (marked failed)" };
      }
      const recorded = recordOutboundSend(db, prospect.id, body, null, today);
      if (!recorded)
        return {
          sent: false,
          reason: "prospect left queue pre-send (message already out)",
        };
      console.log(
        `[sender] LIVE ${realSent + 1}/${cap} → ${prospect.wa_jid} (${prospect.colonia ?? "?"})`,
      );
      return { sent: true, prospectId: prospect.id };
    }

    // shadow
    ctx.shadowSentIds.add(prospect.id);
    ctx.shadowCount += 1;
    ctx.lastSentAt = now;
    ctx.currentGapMs = nextGapMs(cap, windowMsOf(ctx.windowCfg));
    console.log(
      `[sender] SHADOW ${ctx.shadowCount}/${cap} → ${prospect.wa_jid} (${prospect.colonia ?? "?"}): "${body.slice(0, 48)}…"`,
    );
    return { sent: true, prospectId: prospect.id, shadow: true };
  } finally {
    ctx.inFlight = false;
  }
}

export interface StartSenderOpts {
  mode: OutreachMode;
  intervalMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Start the sender tick loop. Returns the interval handle (cleared on SIGTERM). */
export function startSender(
  db: Database.Database,
  getSession: () => OutreachSession | null,
  opts: StartSenderOpts,
): NodeJS.Timeout {
  const env = opts.env ?? process.env;
  const ctx: SenderCtx = {
    mode: opts.mode,
    windowCfg: loadWindowCfg(env),
    ramp: loadRamp(env),
    // qa-W2: captured once at start. The daemon reads OUTREACH_BLOCKLIST from the
    // systemd EnvironmentFile at boot, so process.env is frozen for this run —
    // a blocklist edit in .env only takes effect on `systemctl restart`. The
    // import (sole ingress) already filtered, and the default product line keeps
    // the set non-empty; this send-time check is defense-in-depth on top.
    blocklist: loadBlocklist(env),
    day: mxDayKey(),
    lastSentAt: null,
    currentGapMs: 0,
    shadowCount: 0,
    shadowSentIds: new Set(),
    inFlight: false,
  };
  const intervalMs = opts.intervalMs ?? 60_000;
  const timer = setInterval(() => {
    void runTick(db, getSession, ctx).catch((err) =>
      console.error("[sender] tick error:", err),
    );
  }, intervalMs);
  timer.unref();
  return timer;
}

// ─── Plan (for the shadow-plan review script; window-independent) ────────────

export interface DayPlan {
  day: string;
  mode: OutreachMode;
  priorSendDays: number;
  cap: number;
  sentToday: number;
  remaining: number;
  batch: Prospect[];
  message: string;
}

/** What today's batch WOULD be (ignores the window gate) — for operator review. */
export function planToday(
  db: Database.Database,
  env: NodeJS.ProcessEnv = process.env,
): DayPlan {
  const day = mxDayKey();
  const ramp = loadRamp(env);
  const priorSendDays = getPriorSendDayCount(db, day);
  const cap = rampCapForDay(priorSendDays, ramp);
  const sentToday = getDailySent(db, day);
  const remaining = Math.max(0, cap - sentToday);
  const blocklist = loadBlocklist(env);
  const batch = listProspectsByStatus(db, "pending", remaining + 100)
    .filter((p) => !isForbiddenNumber(p.wa_jid, p.phone_raw, blocklist))
    .slice(0, remaining);
  return {
    day,
    mode: loadMode(env),
    priorSendDays,
    cap,
    sentToday,
    remaining,
    batch,
    message: OUTREACH_MESSAGE,
  };
}
