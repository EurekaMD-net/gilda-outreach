/**
 * gilda-outreach — service entry point (P1: long-running daemon).
 *
 * Opens the DB, serves the observability surface (127.0.0.1:8087), links the
 * dedicated outreach number via Baileys (pairing code), wires inbound replies to
 * the receiver, and (P3) runs the sender per OUTREACH_MODE (off|shadow|live).
 *
 * Recovery is INVERTED vs the salones product bot: a WA logout/401 is a probable
 * ban → latch HALTED + alert, never auto-reconnect. Only transient drops retry.
 */
import { serve } from "@hono/node-server";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import qrcodeTerminal from "qrcode-terminal";
import { getDb } from "./db/database.js";
import { getFunnelCounts } from "./db/models.js";
import { createObservabilityRoutes } from "./web/observability.js";
import { createAlertChannel } from "./alert/channel.js";
import {
  initOutreachSession,
  reinitOutreachSession,
  isSessionRegistered,
  getSession,
  type OutreachSessionOptions,
} from "./bot/baileys-manager.js";
import {
  getSessionState,
  markHalted,
  reconnectMaxStrikes,
  reconnectStuckMinutes,
  planOutreachWatchdogTick,
  getBootTime,
  type WatchdogMemory,
} from "./bot/session-state.js";
import { loadMode, startSender, type OutreachMode } from "./sender/sender.js";

const PORT = parseInt(process.env["PORT"] ?? "8087");
const DB_PATH = process.env["DB_PATH"] ?? "./data/outreach.db";
const SESSIONS_DIR = process.env["SESSIONS_DIR"] ?? "./data/sessions";
const BIND_HOST = process.env["BIND_HOST"] ?? "127.0.0.1";

// ── Required config (hard-fail fast) ───────────────────────────────────────
const ADMIN_TOKEN = process.env["ADMIN_TOKEN"];
if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 16) {
  console.error(
    "[gilda-outreach] FATAL: ADMIN_TOKEN must be set and ≥16 chars (gates /metrics).",
  );
  console.error(
    "[gilda-outreach] Generate: node -e \"console.log(require('crypto').randomBytes(24).toString('hex'))\"",
  );
  process.exit(1);
}

const OUTREACH_NUMBER = (process.env["OUTREACH_NUMBER"] ?? "").replace(
  /\D/g,
  "",
);
if (OUTREACH_NUMBER.length < 10 || OUTREACH_NUMBER.length > 15) {
  console.error(
    "[gilda-outreach] FATAL: OUTREACH_NUMBER must be the dedicated SIM's full " +
      "international number, digits only (e.g. 5215512345678). Set it in .env — " +
      "never in committed source.",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  console.log("[gilda-outreach] starting...");

  const db = getDb(DB_PATH);
  console.log("[gilda-outreach] DB ready:", DB_PATH);

  // Harden file permissions at startup (idempotent).
  const sessionsDir = path.resolve(SESSIONS_DIR);
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.chmodSync(sessionsDir, 0o700);
  const dbFile = path.resolve(DB_PATH);
  for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) {
    if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
  }

  // Operator alert channel (journald always; Telegram if configured in .env).
  const alerts = createAlertChannel();

  // ── Web surface (Hono) — public /health + token-gated /metrics ───────────
  const app = new Hono();
  app.route("/", createObservabilityRoutes(db));
  serve({ fetch: app.fetch, port: PORT, hostname: BIND_HOST }, () => {
    console.log(`[gilda-outreach] web surface on ${BIND_HOST}:${PORT}`);
    console.log(
      `[gilda-outreach] /metrics gated by ADMIN_TOKEN (<set, ${ADMIN_TOKEN!.length} chars>)`,
    );
  });

  // ── Baileys outreach session ─────────────────────────────────────────────
  const sessionOptions: OutreachSessionOptions = {
    sessionDir: SESSIONS_DIR,
    outreachNumber: OUTREACH_NUMBER,
    db,
    onQR: (qr) => {
      console.log("[gilda-outreach] QR (fallback) — scan in WhatsApp:");
      qrcodeTerminal.generate(qr, { small: true });
    },
    onPairingCode: (code) => {
      console.log(
        `[gilda-outreach] ⇣ PAIRING CODE: ${code}\n` +
          "  WhatsApp → Dispositivos vinculados → Vincular con número de teléfono → enter this code.",
      );
    },
    onAlert: (a) => {
      void alerts.send({ kind: "interested-lead", ...a });
    },
    onHalt: (reason) => {
      void alerts.send({ kind: "session-halted", reason });
    },
  };

  await initOutreachSession(sessionOptions);
  console.log(
    "[gilda-outreach] session init requested — awaiting link/connect.",
  );

  // ── Funnel summary + kill-switch sanity ──────────────────────────────────
  const f = getFunnelCounts(db);
  console.log(
    `[gilda-outreach] funnel: total=${f.total} pending=${f.pending} ` +
      `sent=${f.sent} replied=${f.replied} interested=${f.interested} ` +
      `opted_out=${f.opted_out} failed=${f.failed}`,
  );
  if (f.total === 0) {
    console.log(
      "[gilda-outreach] no prospects yet — run: npm run import-prospects.",
    );
  }
  // ── Sender mode (off | shadow | live) ────────────────────────────────────
  // `live` ADDITIONALLY requires OUTREACH_ENABLED=true — a second, independent
  // lock, so flipping a single flag can never message real prospects.
  let mode: OutreachMode = loadMode();
  if (mode === "live" && process.env["OUTREACH_ENABLED"] !== "true") {
    console.warn(
      "[gilda-outreach] OUTREACH_MODE=live but OUTREACH_ENABLED!=true → staying in SHADOW (second lock).",
    );
    mode = "shadow";
  }

  console.log("[gilda-outreach] ready ✅");

  // ── Liveness watchdog (INVERTED self-heal) ───────────────────────────────
  // Recovers a stuck transient socket (the half-open zombie a close-event-driven
  // reconnect can't catch). NEVER reconnects a logged_out/halted session — that
  // is a probable ban (manual re-link only). After the strike budget it latches
  // HALTED + alerts. Kill switch: OUTREACH_WATCHDOG_ENABLED=false.
  let watchdog: NodeJS.Timeout | undefined;
  if (process.env["OUTREACH_WATCHDOG_ENABLED"] !== "false") {
    const WATCHDOG_INTERVAL_MS = 60_000;
    const mem: WatchdogMemory = { strikes: 0, lastHealAt: 0 };
    watchdog = setInterval(() => {
      try {
        const stuckMs = reconnectStuckMinutes() * 60_000;
        const maxStrikes = reconnectMaxStrikes();
        const { reinit, gaveUp } = planOutreachWatchdogTick(
          getSessionState(),
          mem,
          {
            nowMs: Date.now(),
            stuckMs,
            cooldownMs: stuckMs,
            bootMs: getBootTime(),
            maxStrikes,
            isRegistered: () => isSessionRegistered(SESSIONS_DIR),
          },
        );
        if (gaveUp) {
          const reason = `watchdog gave up after ${maxStrikes} reconnect attempts — manual check required`;
          console.warn(`[outreach-watchdog] ${reason}`);
          markHalted(reason);
          void alerts.send({ kind: "session-halted", reason });
        } else if (reinit) {
          console.warn(
            `[outreach-watchdog] session stuck non-connected — forcing reconnect (${mem.strikes}/${maxStrikes})`,
          );
          void reinitOutreachSession(sessionOptions).catch((err) =>
            console.error("[outreach-watchdog] reinit failed:", err),
          );
        }
      } catch (err) {
        console.error("[outreach-watchdog] error", err);
      }
    }, WATCHDOG_INTERVAL_MS);
    watchdog.unref();
    console.log(
      `[gilda-outreach] liveness watchdog active (every ${WATCHDOG_INTERVAL_MS / 1000}s, ` +
        `stuck>${reconnectStuckMinutes()}min, max ${reconnectMaxStrikes()} strikes; logged_out → HALT, no retry)`,
    );
  }

  // ── Sender (P3) ──────────────────────────────────────────────────────────
  let senderTimer: NodeJS.Timeout | undefined;
  if (mode === "off") {
    console.log(
      "[gilda-outreach] sender mode=off — no outbound (receiver only).",
    );
  } else {
    senderTimer = startSender(db, getSession, { mode });
    console.log(
      `[gilda-outreach] sender mode=${mode} — ` +
        (mode === "shadow"
          ? "SHADOW (logs would-sends; nothing leaves)."
          : "LIVE (sending within window + ramp + caps)."),
    );
  }

  // ── Graceful shutdown ────────────────────────────────────────────────────
  process.on("SIGTERM", () => {
    console.log("[gilda-outreach] shutting down...");
    if (watchdog) clearInterval(watchdog);
    if (senderTimer) clearInterval(senderTimer);
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[gilda-outreach] fatal startup error:", err);
  process.exit(1);
});
