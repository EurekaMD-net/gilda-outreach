/**
 * Single-session Baileys manager for the dedicated outreach number.
 *
 * Ported from salones-wa/baileys-manager but rewritten for ONE session and
 * INVERTED recovery (spec §6). Hard-won guards kept verbatim in spirit:
 *  - generation fencing — a superseded (zombie) socket's late events no-op, so
 *    a frozen half-open socket can't delete the live session or flip its state.
 *  - pairing-code throttle — each requestPairingCode INVALIDATES the prior code
 *    on WA's backend; regenerating faster than the operator can type it makes
 *    every code appear dead. ~50s throttle keeps a code valid.
 *  - WA-Web browser signature — data-center IPs get pairing rejected with a
 *    custom browser string; Browsers.ubuntu("Chrome") mimics a real client.
 *  - LID handling — Baileys 7 surfaces opaque @lid sender ids; prefer the
 *    phone-format remoteJidAlt for prospect matching.
 *
 * THE INVERSION: a WA logout/401 is treated as a PROBABLE BAN → latch HALTED +
 * alert the operator, NEVER auto-reconnect. Only transient/network drops
 * reconnect. The receiver NEVER sends an auto-reply to a cold lead — an
 * interested prospect surfaces via onAlert to the operator, who replies by hand.
 *
 * Test mode (OUTREACH_ENV=test): returns a stub session and does NOT import the
 * Baileys runtime, so the pure logic is testable before any SIM is linked.
 */

import { mkdirSync, readFileSync } from "fs";
import { join } from "path";
import type Database from "better-sqlite3";
import { handleInboundMessage, type OutreachAlert } from "./receiver.js";
import { recordSessionState, markHalted, isHalted } from "./session-state.js";

// ─── Pure, socket-free helpers (unit-tested directly) ───────────────────────

/** WhatsApp logout status code (Baileys DisconnectReason.loggedOut === 401). */
export const WA_LOGGED_OUT = 401;

export type DisconnectVerdict = "reconnect" | "halt";

/**
 * Ban-averse disconnect policy (spec §6). A WA logout/401 is a probable ban →
 * HALT (no auto-reconnect). Everything else — 428 precondition-required, 515
 * restart-required, connection-lost, or an undefined code — is a
 * transient/network drop → reconnect. This is the INVERSE of nothing in
 * salones; salones reconnects on the same set but stays SILENT on logout. Here,
 * "halt" additionally latches a stop and shouts.
 */
export function classifyDisconnect(
  statusCode: number | undefined,
): DisconnectVerdict {
  return statusCode === WA_LOGGED_OUT ? "halt" : "reconnect";
}

export type CloseAction = "ban-halt" | "retry";

/**
 * Decide what a socket `close` means, given whether the session was already
 * linked. A WA logout/401 is a probable BAN → halt — but ONLY for an
 * already-REGISTERED session. The identical code on an UNREGISTERED (still
 * pairing) session just means "not linked yet": the pairing window ended before
 * the operator entered a code, so we must keep cycling to offer fresh codes, NOT
 * latch the ban-halt. (Onboarding rule — same spirit as the watchdog's qa-W4
 * skip-unregistered gate; the original P1 close-handler applied the inversion
 * unconditionally and false-halted during the very first link attempt.)
 * Every non-401 code is a transient drop → retry.
 */
export function decideClose(
  statusCode: number | undefined,
  registered: boolean,
): CloseAction {
  return classifyDisconnect(statusCode) === "halt" && registered
    ? "ban-halt"
    : "retry";
}

/** Structural shape of a Baileys text message (avoids a runtime baileys dep). */
interface InboundTextSource {
  conversation?: string | null;
  extendedTextMessage?: { text?: string | null } | null;
}

/** Extract plain text from an inbound message (conversation or extended text). */
export function extractInboundText(
  message: InboundTextSource | null | undefined,
): string {
  return message?.conversation ?? message?.extendedTextMessage?.text ?? "";
}

/**
 * Pick the JID to match a prospect by. Baileys 7 surfaces opaque @lid sender
 * ids; the phone-format JID (when present) is on remoteJidAlt. Prefer it so we
 * match an imported `52…@s.whatsapp.net` prospect; otherwise fall back to the
 * raw remoteJid (the receiver rejects non-individual JIDs anyway).
 */
export function pickMatchJid(
  remoteJid: string,
  remoteJidAlt: string | null | undefined,
): string {
  return remoteJidAlt && remoteJidAlt.endsWith("@s.whatsapp.net")
    ? remoteJidAlt
    : remoteJid;
}

// ─── Session lifecycle ──────────────────────────────────────────────────────

export interface OutreachSession {
  outreachNumber: string;
  /** Send an outbound message. WIRED FOR P3 (sender); unused in P1. */
  sendMessage: (toJidOrNumber: string, text: string) => Promise<void>;
  /** Logout + drop the session (releases the WA linked-device slot). */
  disconnect: () => Promise<void>;
}

export interface OutreachSessionOptions {
  /** Single session dir (NOT per-salon). */
  sessionDir: string;
  /** E.164 digits of the outreach SIM, for the pairing-code request. */
  outreachNumber: string;
  db: Database.Database;
  /** Interested-lead alert (forwarded from the receiver) → operator. */
  onAlert?: (alert: OutreachAlert) => void;
  /** Session HALTED (probable ban / watchdog gave up) → operator. */
  onHalt?: (reason: string) => void;
  onQR?: (qr: string) => void;
  onPairingCode?: (code: string) => void;
}

let currentSession: OutreachSession | null = null;
// Single module-level socket generation. Each (re)init claims the next value;
// once superseded, an older socket's handlers no-op (generation fence).
let socketGeneration = 0;
// Synchronous concurrency latch (qa-W2): claimed before the first await in
// initOutreachSession so two overlapping init calls can't spin up parallel
// sockets and request the pairing code twice (which would invalidate the
// operator's in-flight code). Released in a finally once the build completes.
let initInFlight = false;

export function getSession(): OutreachSession | null {
  return currentSession;
}

/** Test helper — clear session + generation between cases. */
export function resetSessionForTest(): void {
  currentSession = null;
  socketGeneration = 0;
}

const silentLogger = {
  level: "silent",
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: (msg: unknown) => console.warn("[baileys]", msg),
  error: (msg: unknown) => console.error("[baileys]", msg),
  child: () =>
    ({
      level: "silent",
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => ({}),
    }) as never,
} as never;

function createStubSession(outreachNumber: string): OutreachSession {
  return {
    outreachNumber,
    sendMessage: async (to: string, text: string) => {
      console.log(`[outreach-stub] → ${to}: ${text.slice(0, 80)}`);
    },
    disconnect: async () => {
      currentSession = null;
    },
  };
}

/**
 * Initialize the outreach Baileys session. Idempotent — returns the live
 * session if one exists. Returns a stub in test mode.
 */
export async function initOutreachSession(
  options: OutreachSessionOptions,
): Promise<OutreachSession> {
  // Ban-averse chokepoint (qa-C1): the SINGLE reconnect entry point refuses to
  // (re)connect a HALTED session — this closes EVERY banned-reconnect path at
  // once, including an orphaned reconnect timer that outlived the halt. Checked
  // BEFORE the idempotent fast-path so a stale currentSession can't bypass it.
  if (isHalted()) {
    throw new Error(
      "[outreach] init refused — session HALTED (anti-ban). Manual re-link only.",
    );
  }

  if (currentSession) return currentSession;

  if (process.env["OUTREACH_ENV"] === "test") {
    const stub = createStubSession(options.outreachNumber);
    currentSession = stub;
    recordSessionState("connected");
    return stub;
  }

  // qa-W2: refuse an overlapping init — a second concurrent socket would
  // re-request the pairing code and invalidate the operator's in-flight one.
  if (initInFlight) throw new Error("[outreach] init already in progress");
  initInFlight = true;
  try {
    return await buildOutreachSocket(options);
  } finally {
    initInFlight = false;
  }
}

/**
 * Build + wire the live Baileys socket. Only ever called via
 * initOutreachSession, which owns the halt / idempotency / concurrency gates.
 */
async function buildOutreachSocket(
  options: OutreachSessionOptions,
): Promise<OutreachSession> {
  // Claim a generation synchronously (before any await) so any zombie socket is
  // superseded immediately.
  const myGeneration = ++socketGeneration;
  const isCurrentGeneration = () => socketGeneration === myGeneration;

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers,
  } = await import("@whiskeysockets/baileys");

  mkdirSync(options.sessionDir, { recursive: true });
  recordSessionState("connecting");

  const { state, saveCreds } = await useMultiFileAuthState(options.sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    logger: silentLogger,
  });

  sock.ev.on("creds.update", saveCreds);

  // Pairing-code throttle (see salones-wa W-audit): regenerating faster than the
  // operator can type a code invalidates the one they're entering.
  const PAIRING_REGEN_INTERVAL_MS = 50_000;
  let pairingRequestInFlight = false;
  let lastPairingRequestAt = 0;
  const onPairingCodeCb = options.onPairingCode;

  sock.ev.on("connection.update", (update) => {
    if (!isCurrentGeneration()) return; // superseded zombie → no-op
    const { connection, lastDisconnect, qr } = update;

    if (qr && options.onQR) options.onQR(qr);

    if (
      qr &&
      !pairingRequestInFlight &&
      !state.creds.registered &&
      onPairingCodeCb
    ) {
      const now = Date.now();
      if (now - lastPairingRequestAt >= PAIRING_REGEN_INTERVAL_MS) {
        lastPairingRequestAt = now;
        pairingRequestInFlight = true;
        sock
          .requestPairingCode(options.outreachNumber)
          .then((code) => onPairingCodeCb(code))
          .catch((err) => {
            lastPairingRequestAt = 0; // allow a future qr event to retry
            console.error("[outreach] pairing-code request failed:", err);
          })
          .finally(() => {
            pairingRequestInFlight = false;
          });
      }
    }

    if (connection === "close") {
      const statusCode = (
        lastDisconnect?.error as { output?: { statusCode?: number } }
      )?.output?.statusCode;
      const reason = lastDisconnect?.error?.message ?? "unknown";
      currentSession = null;

      if (decideClose(statusCode, state.creds.registered) === "ban-halt") {
        // THE INVERSION: a logout/401 on an ALREADY-LINKED session → probable
        // ban → latch + shout, never auto-reconnect.
        const haltReason = `WA logout/401 (code=${statusCode ?? "?"}, ${reason}) — probable ban`;
        markHalted(haltReason);
        console.error(
          `[outreach] ⛔ session HALTED — ${haltReason}. NO auto-reconnect (anti-ban). Manual re-link only.`,
        );
        options.onHalt?.(haltReason);
      } else {
        recordSessionState("reconnecting");
        // A 401 while still UNREGISTERED = "pairing window ended, not linked
        // yet". Back off longer (20s vs 5s) so we open fresh pairing windows
        // without hammering WA's backend if it is rate-limiting the attempts.
        const onboarding401 =
          classifyDisconnect(statusCode) === "halt" && !state.creds.registered;
        const delayMs = onboarding401 ? 20_000 : 5_000;
        console.log(
          onboarding401
            ? `[outreach] not linked yet (code=${statusCode ?? "?"}, ${reason}) — new pairing window in ${delayMs / 1000}s...`
            : `[outreach] transient drop (code=${statusCode ?? "?"}, ${reason}) — reconnecting in ${delayMs / 1000}s...`,
        );
        // qa-C1: fence the timer to THIS generation. If a newer socket (e.g. a
        // watchdog reinit) has superseded us before the timer fires, it owns
        // reconnection — this orphaned timer must no-op. initOutreachSession's
        // isHalted() gate is the backstop if the newer socket then got banned.
        setTimeout(() => {
          if (!isCurrentGeneration()) return;
          void initOutreachSession(options).catch((err) =>
            console.error("[outreach] reconnect failed:", err),
          );
        }, delayMs);
      }
    }

    if (connection === "open") {
      recordSessionState("connected");
      console.log(`[outreach] connected ✅ (${options.outreachNumber})`);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (!isCurrentGeneration()) return;
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const from = msg.key.remoteJid;
      if (!from) continue;
      const idJid = pickMatchJid(from, msg.key.remoteJidAlt);
      const body = extractInboundText(msg.message);
      if (!body) continue;

      try {
        // Pure reply handler — logs the inbound, updates status, and (on an
        // interested signal) fires onAlert. It NEVER returns an auto-reply: we
        // do not message a cold lead back from the bot. So there is no
        // sock.sendMessage here by design.
        handleInboundMessage(
          options.db,
          { jid: idJid, body, waMsgId: msg.key.id ?? undefined },
          { onAlert: options.onAlert },
        );
      } catch (err) {
        console.error(
          `[outreach] inbound handler error: ${(err as Error)?.message ?? String(err)}`,
          err,
        );
      }
    }
  });

  const session: OutreachSession = {
    outreachNumber: options.outreachNumber,
    sendMessage: async (to: string, text: string) => {
      const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
      await sock.sendMessage(jid, { text });
    },
    disconnect: async () => {
      await sock.logout();
      currentSession = null;
    },
  };

  // Only publish if still current (a concurrent reinit could have superseded).
  if (isCurrentGeneration()) currentSession = session;
  return session;
}

/**
 * Force a fresh socket WITHOUT logging out (creds stay on disk for a silent
 * re-auth). The liveness watchdog calls this for a stuck transient socket where
 * no "close" event ever fired. NEVER called for a logged_out/halted session.
 */
export async function reinitOutreachSession(
  options: OutreachSessionOptions,
): Promise<OutreachSession> {
  // qa-C1: never tear down + rebuild a HALTED session (the watchdog already
  // refuses, but guard here too — defense in depth at the chokepoint).
  if (isHalted()) {
    throw new Error("[outreach] reinit refused — session HALTED (anti-ban).");
  }
  currentSession = null;
  return initOutreachSession(options);
}

/**
 * Whether the on-disk session has completed pairing (creds.registered === true).
 * The watchdog uses this to never force-reconnect a session mid-pairing (which
 * would burn the operator's in-flight code) — qa-W4 parity with salones-wa.
 */
export function isSessionRegistered(sessionDir: string): boolean {
  try {
    const raw = readFileSync(join(sessionDir, "creds.json"), "utf8");
    return JSON.parse(raw)?.registered === true;
  } catch {
    return false; // no creds / unreadable → not yet linked
  }
}
