import type Database from "better-sqlite3";

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
