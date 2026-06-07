/**
 * SQLite schema for gilda-outreach — cold-outreach sender (pilot).
 * Applied once at startup via getDb(). See docs/OUTREACH-SENDER-SPEC.md §3.
 *
 * PRAGMA foreign_keys=ON must live HERE (inside the connection's exec) so it is
 * active for every connection — `messages.prospect_id ... ON DELETE CASCADE`
 * only cascades when foreign keys are enabled on the live connection.
 */
export const SCHEMA_SQL = /* sql */ `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- One row per prospect (imported from the validated Google Sheet).
-- wa_jid is the canonical JID from onWhatsApp() and is the dedupe key: a number
-- must never appear twice, or it could be messaged twice.
CREATE TABLE IF NOT EXISTS prospects (
  id            TEXT PRIMARY KEY,         -- uuid
  name          TEXT,                     -- nombre del negocio / dueña
  colonia       TEXT,
  phone_raw     TEXT NOT NULL,            -- as it appeared in the sheet
  wa_jid        TEXT NOT NULL,            -- canonical JID from onWhatsApp()
  source        TEXT NOT NULL DEFAULT 'denue-iztapalapa-2026-06',
  number_id     TEXT,                     -- which outreach number handled it (rotation-ready)
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','queued','sent','replied',
                                   'interested','not_interested','opted_out',
                                   'failed','invalid','converted')),
  template_variant TEXT,                  -- which copy variant was sent
  contacted_at  INTEGER,                  -- first outbound send (unixepoch)
  last_out_at   INTEGER,
  first_reply_at INTEGER,
  reply_count   INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  imported_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(wa_jid)                          -- dedupe: never two rows for one number
);
CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(status);

-- Full conversation log (audit + conversion analysis + reply UI feed).
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  prospect_id TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  direction   TEXT NOT NULL CHECK(direction IN ('out','in')),
  body        TEXT,
  wa_msg_id   TEXT,                       -- Baileys message id (for receipts)
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_messages_prospect ON messages(prospect_id, created_at);

-- Daily send counter — enforces ramp + cap, survives restart.
CREATE TABLE IF NOT EXISTS daily_sends (
  day         TEXT PRIMARY KEY,           -- 'YYYY-MM-DD' in MX time
  sent_count  INTEGER NOT NULL DEFAULT 0
);
`;
