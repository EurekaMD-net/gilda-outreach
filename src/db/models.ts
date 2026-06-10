import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { jidToNumber, tail10 } from "../util/phone.js";

export type ProspectStatus =
  | "pending"
  | "queued"
  | "sent"
  | "replied"
  | "interested"
  | "not_interested"
  | "opted_out"
  | "failed"
  | "invalid"
  | "converted";

export interface Prospect {
  id: string;
  name: string | null;
  colonia: string | null;
  phone_raw: string;
  wa_jid: string;
  source: string;
  number_id: string | null;
  status: ProspectStatus;
  template_variant: string | null;
  contacted_at: number | null;
  last_out_at: number | null;
  first_reply_at: number | null;
  reply_count: number;
  attempts: number;
  last_error: string | null;
  imported_at: number;
}

/** Shape required to import/upsert a prospect (the import-time fields). */
export interface ProspectImport {
  id: string;
  name: string | null;
  colonia: string | null;
  phone_raw: string;
  wa_jid: string;
  source: string;
}

export interface FunnelCounts {
  total: number;
  pending: number;
  queued: number;
  sent: number;
  replied: number;
  interested: number;
  not_interested: number;
  opted_out: number;
  failed: number;
  invalid: number;
  converted: number;
}

export function getProspectByJid(
  db: Database.Database,
  wa_jid: string,
): Prospect | undefined {
  return db.prepare("SELECT * FROM prospects WHERE wa_jid = ?").get(wa_jid) as
    | Prospect
    | undefined;
}

/**
 * Insert a prospect, or refresh its descriptive fields if the wa_jid already
 * exists. Idempotent — re-running an import never duplicates a number and never
 * resets campaign progress (status / attempts / contacted_at are left intact on
 * conflict). Returns whether the row was newly inserted or updated in place.
 */
export function upsertProspect(
  db: Database.Database,
  p: ProspectImport,
): "inserted" | "updated" {
  const existing = getProspectByJid(db, p.wa_jid);
  if (existing) {
    // Refresh descriptive fields only — COALESCE keeps an existing value when
    // the incoming row's field is null, so a sparser re-import never blanks data.
    db.prepare(
      `UPDATE prospects
         SET name      = COALESCE(?, name),
             colonia   = COALESCE(?, colonia),
             phone_raw = ?,
             source    = ?
       WHERE wa_jid = ?`,
    ).run(p.name, p.colonia, p.phone_raw, p.source, p.wa_jid);
    return "updated";
  }
  db.prepare(
    `INSERT INTO prospects (id, name, colonia, phone_raw, wa_jid, source)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(p.id, p.name, p.colonia, p.phone_raw, p.wa_jid, p.source);
  return "inserted";
}

export function getFunnelCounts(db: Database.Database): FunnelCounts {
  const rows = db
    .prepare("SELECT status, COUNT(*) AS n FROM prospects GROUP BY status")
    .all() as Array<{ status: ProspectStatus; n: number }>;

  const counts: FunnelCounts = {
    total: 0,
    pending: 0,
    queued: 0,
    sent: 0,
    replied: 0,
    interested: 0,
    not_interested: 0,
    opted_out: 0,
    failed: 0,
    invalid: 0,
    converted: 0,
  };
  for (const r of rows) {
    counts[r.status] = r.n;
    counts.total += r.n;
  }
  return counts;
}

export function listProspectsByStatus(
  db: Database.Database,
  status: ProspectStatus,
  limit = 100,
): Prospect[] {
  return db
    .prepare(
      "SELECT * FROM prospects WHERE status = ? ORDER BY imported_at ASC LIMIT ?",
    )
    .all(status, limit) as Prospect[];
}

export function setProspectStatus(
  db: Database.Database,
  prospectId: string,
  status: ProspectStatus,
): void {
  db.prepare("UPDATE prospects SET status = ? WHERE id = ?").run(
    status,
    prospectId,
  );
}

/**
 * Find the prospect an inbound JID belongs to: exact wa_jid first, then by the
 * 10-digit tail (so a `521…` inbound matches a `52…` import and vice-versa).
 * The tail fallback is a full table scan — fine at pilot scale (~hundreds of
 * rows); revisit with a normalized column if the table ever grows large.
 */
export function findProspectForInbound(
  db: Database.Database,
  jid: string,
): Prospect | undefined {
  const exact = getProspectByJid(db, jid);
  if (exact) return exact;
  const wanted = tail10(jidToNumber(jid));
  // Require a full 10-digit tail; never partial-match on a short/garbage number.
  if (wanted.length < 10) return undefined;
  const all = db.prepare("SELECT * FROM prospects").all() as Prospect[];
  return all.find((p) => tail10(jidToNumber(p.wa_jid)) === wanted);
}

/**
 * Record that a prospect replied: bump reply_count and stamp first_reply_at on
 * the first inbound only (COALESCE keeps the earliest). Status transitions are
 * the receiver's job — this only touches the reply bookkeeping.
 */
export function recordInboundReply(
  db: Database.Database,
  prospectId: string,
): void {
  db.prepare(
    `UPDATE prospects
       SET reply_count = reply_count + 1,
           first_reply_at = COALESCE(first_reply_at, unixepoch())
     WHERE id = ?`,
  ).run(prospectId);
}

export type MessageDirection = "in" | "out";

export interface Message {
  id: string;
  prospect_id: string;
  direction: MessageDirection;
  body: string | null;
  wa_msg_id: string | null;
  created_at: number;
}

export function insertMessage(
  db: Database.Database,
  m: {
    prospect_id: string;
    direction: MessageDirection;
    body?: string | null;
    wa_msg_id?: string | null;
  },
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO messages (id, prospect_id, direction, body, wa_msg_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, m.prospect_id, m.direction, m.body ?? null, m.wa_msg_id ?? null);
  return id;
}

export function getMessagesForProspect(
  db: Database.Database,
  prospectId: string,
): Message[] {
  return db
    .prepare(
      "SELECT * FROM messages WHERE prospect_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .all(prospectId) as Message[];
}

// ─── Metric helpers (P1 /metrics) ───────────────────────────────────────────

/** Count of outbound messages logged (≈ total sends, incl. retries). */
export function getOutboundMessageCount(db: Database.Database): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out'")
      .get() as {
      n: number;
    }
  ).n;
}

/** Count of inbound messages logged (total replies received). */
export function getInboundMessageCount(db: Database.Database): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in'")
      .get() as {
      n: number;
    }
  ).n;
}

/** Count of prospects contacted at least once (`contacted_at` stamped). */
export function getContactedCount(db: Database.Database): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM prospects WHERE contacted_at IS NOT NULL",
      )
      .get() as { n: number }
  ).n;
}

/** Sends recorded for a given MX day key ('YYYY-MM-DD'); 0 if none. */
export function getDailySent(db: Database.Database, day: string): number {
  const row = db
    .prepare("SELECT sent_count FROM daily_sends WHERE day = ?")
    .get(day) as { sent_count: number } | undefined;
  return row?.sent_count ?? 0;
}

// ─── Sender (P3) ────────────────────────────────────────────────────────────

/**
 * Count of PRIOR days that had at least one send (day < today). This is the
 * ramp index: schedule day N = this count, so the ramp advances per active
 * send-day, not per calendar day (a weekend gap doesn't skip a step).
 */
export function getPriorSendDayCount(
  db: Database.Database,
  todayKey: string,
): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM daily_sends WHERE sent_count > 0 AND day < ?",
      )
      .get(todayKey) as { n: number }
  ).n;
}

/**
 * Atomically record one outbound send: flip the prospect to `sent` (only if
 * still `pending`/`queued` — never clobber a status the receiver changed in the
 * meantime), stamp contacted_at (first only) + last_out_at, bump attempts, log
 * the outbound message, and increment the day's send counter. Returns whether
 * the prospect row was actually transitioned (false = it had already left the
 * queue, e.g. replied between selection and send — caller should treat as a
 * no-op the next tick won't repeat).
 */
export function recordOutboundSend(
  db: Database.Database,
  prospectId: string,
  body: string,
  waMsgId: string | null,
  day: string,
): boolean {
  const tx = db.transaction(() => {
    const res = db
      .prepare(
        `UPDATE prospects
           SET status = 'sent',
               contacted_at = COALESCE(contacted_at, unixepoch()),
               last_out_at = unixepoch(),
               attempts = attempts + 1
         WHERE id = ? AND status IN ('pending', 'queued')`,
      )
      .run(prospectId);
    if (res.changes === 0) return false; // already left the queue — no-op
    db.prepare(
      `INSERT INTO messages (id, prospect_id, direction, body, wa_msg_id)
       VALUES (?, ?, 'out', ?, ?)`,
    ).run(randomUUID(), prospectId, body, waMsgId);
    db.prepare(
      `INSERT INTO daily_sends (day, sent_count) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET sent_count = sent_count + 1`,
    ).run(day);
    return true;
  });
  return tx() as boolean;
}

/**
 * Mark a prospect's send as FAILED (uncertain outcome — error or timeout). Only
 * transitions out of `pending`/`queued`, so it never clobbers a status the
 * receiver set. At-most-once: a `failed` prospect is not re-selected, so we never
 * risk double-messaging a number whose first send may already have landed. The
 * operator can deliberately requeue `failed` rows later.
 */
export function markProspectFailed(
  db: Database.Database,
  prospectId: string,
  error: string,
): void {
  db.prepare(
    `UPDATE prospects
       SET status = 'failed', last_error = ?, attempts = attempts + 1
     WHERE id = ? AND status IN ('pending', 'queued')`,
  ).run(error, prospectId);
}
