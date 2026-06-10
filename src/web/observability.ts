/**
 * Operational observability surface for mc-prometheus / uptime tooling.
 *
 *   GET /health          → public liveness probe (no token, no PII)
 *   GET /health/session  → JSON, full session health + funnel + day (ADMIN_TOKEN)
 *   GET /metrics         → Prometheus text exposition (ADMIN_TOKEN)
 *   GET /leads           → JSON, warm-lead triage feed; PII (ADMIN_TOKEN)
 *
 * /metrics + /health/session are gated by ADMIN_TOKEN (?token=) because the
 * panel is fronted publicly by Caddy. mc-prometheus scrapes 127.0.0.1:8087 and
 * presents the token via its scrape config. The plain /health (up/halted booleans
 * only) stays public for liveness checks.
 *
 * This service only EXPOSES instantaneous state; the durable ">N min halted"
 * page is owned by mc-prometheus (an alert rule over the scraped gauges).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type Database from "better-sqlite3";
import {
  OUTREACH_STATES,
  disconnectAlertHours,
  evaluateSessionHealth,
  getBootTime,
  getSessionState,
  type SessionHealth,
} from "../bot/session-state.js";
import {
  getContactedCount,
  getDailySent,
  getFunnelCounts,
  getInboundMessageCount,
  getOutboundMessageCount,
  listLeads,
  type FunnelCounts,
} from "../db/models.js";
import { mxDayKey } from "../util/time.js";
import { clientIp, createRateLimiter, verifyAdminTokenQuery } from "./auth.js";

/** Ordered prospect statuses for the labeled funnel gauge. */
const FUNNEL_STATUSES: ReadonlyArray<keyof Omit<FunnelCounts, "total">> = [
  "pending",
  "queued",
  "sent",
  "replied",
  "interested",
  "not_interested",
  "opted_out",
  "failed",
  "invalid",
  "converted",
] as const;

/** unixepoch() seconds → ISO 8601 (UTC), or null. */
function epochToIso(sec: number | null): string | null {
  return sec != null ? new Date(sec * 1000).toISOString() : null;
}

/** Parse a `?limit=` query into a sane bound for the /leads feed. */
function clampLimit(raw: string | undefined, def = 100, max = 500): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

export interface OutreachSnapshot {
  health: SessionHealth;
  funnel: FunnelCounts;
  /** Prospects contacted ≥ once. */
  sentTotal: number;
  /** Outbound messages logged (incl. retries). */
  messagesOut: number;
  /** Inbound messages received. */
  repliesTotal: number;
  /** Sends recorded for today's MX day. */
  dailySent: number;
}

/** Gather every value /metrics + /health/session need, in one pass. */
export function computeOutreachSnapshot(
  db: Database.Database,
  nowMs: number = Date.now(),
): OutreachSnapshot {
  const health = evaluateSessionHealth(getSessionState(), {
    nowMs,
    thresholdMs: disconnectAlertHours() * 3_600_000,
    bootMs: getBootTime(),
  });
  return {
    health,
    funnel: getFunnelCounts(db),
    sentTotal: getContactedCount(db),
    messagesOut: getOutboundMessageCount(db),
    repliesTotal: getInboundMessageCount(db),
    dailySent: getDailySent(db, mxDayKey(nowMs)),
  };
}

/** Render the snapshot as Prometheus text (format 0.0.4). */
export function renderMetrics(s: OutreachSnapshot): string {
  const lines: string[] = [];

  lines.push(
    "# HELP outreach_session_up Whether the outreach session is currently connected (1/0).",
    "# TYPE outreach_session_up gauge",
    `outreach_session_up ${s.health.up ? 1 : 0}`,
    "# HELP outreach_session_halted Whether the session is latched HALTED (probable ban / gave up) (1/0).",
    "# TYPE outreach_session_halted gauge",
    `outreach_session_halted ${s.health.halted ? 1 : 0}`,
  );

  lines.push(
    "# HELP outreach_session_state Current session state (1 = current state).",
    "# TYPE outreach_session_state gauge",
  );
  for (const st of OUTREACH_STATES) {
    lines.push(
      `outreach_session_state{state="${st}"} ${s.health.state === st ? 1 : 0}`,
    );
  }

  lines.push(
    "# HELP outreach_session_down_seconds Seconds since last successful connection (0 while connected).",
    "# TYPE outreach_session_down_seconds gauge",
    `outreach_session_down_seconds ${s.health.downForSeconds ?? 0}`,
  );

  // These `_total` series are derived from COUNT(*) each scrape. They are
  // monotonic in steady-state pilot operation: messages/prospects are only
  // inserted (no hard-delete path), `sent`/contacted only grows, and opt-out is
  // permanent (qa-W1). `failed`, by contrast, is a CURRENT status count — a P3
  // retry can move a prospect out of `failed`, so it is a gauge, not a counter.
  lines.push(
    "# HELP outreach_sent_total Prospects contacted at least once.",
    "# TYPE outreach_sent_total counter",
    `outreach_sent_total ${s.sentTotal}`,
    "# HELP outreach_messages_out_total Outbound messages logged (incl. retries).",
    "# TYPE outreach_messages_out_total counter",
    `outreach_messages_out_total ${s.messagesOut}`,
    "# HELP outreach_replies_total Inbound messages received from prospects.",
    "# TYPE outreach_replies_total counter",
    `outreach_replies_total ${s.repliesTotal}`,
    "# HELP outreach_opted_out_total Prospects who opted out (permanent).",
    "# TYPE outreach_opted_out_total counter",
    `outreach_opted_out_total ${s.funnel.opted_out}`,
    "# HELP outreach_failed_total Prospects currently in the failed state.",
    "# TYPE outreach_failed_total gauge",
    `outreach_failed_total ${s.funnel.failed}`,
    "# HELP outreach_daily_sent Sends recorded for today's Mexico-City day.",
    "# TYPE outreach_daily_sent gauge",
    `outreach_daily_sent ${s.dailySent}`,
  );

  lines.push(
    "# HELP outreach_prospects Prospect count per funnel status.",
    "# TYPE outreach_prospects gauge",
  );
  for (const st of FUNNEL_STATUSES) {
    lines.push(`outreach_prospects{status="${st}"} ${s.funnel[st]}`);
  }
  lines.push(
    "# HELP outreach_prospects_total Total prospects imported.",
    "# TYPE outreach_prospects_total gauge",
    `outreach_prospects_total ${s.funnel.total}`,
  );

  return lines.join("\n") + "\n";
}

/** Routes mounted at the app root. */
export function createObservabilityRoutes(db: Database.Database): Hono {
  const app = new Hono();
  const rateLimiter = createRateLimiter();

  /** Rate-limit by IP, then constant-time token check. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gate = (c: Context<any, any, any>): Response | null => {
    const ip = clientIp(c);
    if (!rateLimiter.check(ip))
      return c.text("Demasiados intentos. Espera 1 minuto.", 429);
    if (!verifyAdminTokenQuery(c)) {
      rateLimiter.recordFailure(ip);
      return c.text("Token de administrador requerido o inválido", 401);
    }
    return null;
  };

  // ─── Public liveness probe (no token, no PII) ───────────────────────────
  app.get("/health", (c) => {
    const health = evaluateSessionHealth(getSessionState(), {
      nowMs: Date.now(),
      thresholdMs: disconnectAlertHours() * 3_600_000,
      bootMs: getBootTime(),
    });
    return c.json({
      ok: true,
      ts: new Date().toISOString(),
      up: health.up,
      halted: health.halted,
    });
  });

  // ─── Full session health (token-gated JSON) ─────────────────────────────
  app.get("/health/session", (c) => {
    const denied = gate(c);
    if (denied) return denied;

    const s = computeOutreachSnapshot(db);
    return c.json({
      ok: true,
      ts: new Date().toISOString(),
      thresholdHours: disconnectAlertHours(),
      day: mxDayKey(),
      dailySent: s.dailySent,
      session: {
        state: s.health.state,
        up: s.health.up,
        halted: s.health.halted,
        haltReason: s.health.haltReason,
        since:
          s.health.since != null
            ? new Date(s.health.since).toISOString()
            : null,
        lastConnectedAt:
          s.health.lastConnectedAt != null
            ? new Date(s.health.lastConnectedAt).toISOString()
            : null,
        downForSeconds: s.health.downForSeconds,
        stale: s.health.stale,
      },
      funnel: s.funnel,
    });
  });

  // ─── Prometheus metrics (token-gated) ───────────────────────────────────
  app.get("/metrics", (c) => {
    const denied = gate(c);
    if (denied) return denied;

    return c.body(renderMetrics(computeOutreachSnapshot(db)), 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });

  // ─── Warm-lead triage feed (token-gated JSON; carries PII) ──────────────
  // The durable replacement for direct DB-file reads: a WAL SQLite file's
  // -wal/-shm sidecars are recreated at mode 600 on every restart, so a chmod
  // grant on the DB can't persist. This loopback, token-gated seam hands the
  // operator / Jarvis the same lead detail without ever widening the file's
  // permissions. `?limit=` clamps to [1,500] (default 100).
  app.get("/leads", (c) => {
    const denied = gate(c);
    if (denied) return denied;

    const limit = clampLimit(c.req.query("limit"));
    const leads = listLeads(db, limit).map((l) => ({
      id: l.id,
      name: l.name,
      colonia: l.colonia,
      waJid: l.wa_jid,
      status: l.status,
      replyCount: l.reply_count,
      firstReplyAt: epochToIso(l.first_reply_at),
      lastInboundAt: epochToIso(l.last_inbound_at),
      lastInboundBody: l.last_inbound_body,
    }));
    return c.json({
      ok: true,
      ts: new Date().toISOString(),
      count: leads.length,
      leads,
    });
  });

  return app;
}
