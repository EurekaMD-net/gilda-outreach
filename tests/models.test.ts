import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { initDb, resetDbSingleton } from "../src/db/database.js";
import {
  upsertProspect,
  getProspectByJid,
  getFunnelCounts,
  listProspectsByStatus,
  type ProspectImport,
} from "../src/db/models.js";

function mkImport(over: Partial<ProspectImport> = {}): ProspectImport {
  return {
    id: randomUUID(),
    name: "Estética Bella",
    colonia: "Santa Martha",
    phone_raw: "5512345678",
    wa_jid: "525512345678@s.whatsapp.net",
    source: "denue-iztapalapa-2026-06",
    ...over,
  };
}

describe("prospect models", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = initDb(":memory:");
  });
  afterEach(() => {
    resetDbSingleton();
  });

  it("inserts a new prospect with default status 'pending'", () => {
    expect(upsertProspect(db, mkImport())).toBe("inserted");
    const p = getProspectByJid(db, "525512345678@s.whatsapp.net");
    expect(p?.name).toBe("Estética Bella");
    expect(p?.status).toBe("pending");
    expect(p?.reply_count).toBe(0);
    expect(p?.attempts).toBe(0);
  });

  it("updates (not duplicates) on the same wa_jid", () => {
    upsertProspect(db, mkImport({ name: "Old Name" }));
    expect(upsertProspect(db, mkImport({ name: "New Name" }))).toBe("updated");
    expect(getFunnelCounts(db).total).toBe(1);
    expect(getProspectByJid(db, "525512345678@s.whatsapp.net")?.name).toBe(
      "New Name",
    );
  });

  it("never blanks an existing name when the re-import has a null name", () => {
    upsertProspect(db, mkImport({ name: "Keep Me" }));
    upsertProspect(db, mkImport({ name: null }));
    expect(getProspectByJid(db, "525512345678@s.whatsapp.net")?.name).toBe(
      "Keep Me",
    );
  });

  it("does not reset campaign progress on re-import", () => {
    upsertProspect(db, mkImport());
    db.prepare(
      "UPDATE prospects SET status='sent', attempts=2, contacted_at=123 WHERE wa_jid=?",
    ).run("525512345678@s.whatsapp.net");
    upsertProspect(db, mkImport({ name: "Refreshed" }));
    const p = getProspectByJid(db, "525512345678@s.whatsapp.net");
    expect(p?.status).toBe("sent");
    expect(p?.attempts).toBe(2);
    expect(p?.contacted_at).toBe(123);
    expect(p?.name).toBe("Refreshed");
  });

  it("counts the funnel by status", () => {
    upsertProspect(db, mkImport({ wa_jid: "a@s.whatsapp.net" }));
    upsertProspect(db, mkImport({ wa_jid: "b@s.whatsapp.net" }));
    upsertProspect(db, mkImport({ wa_jid: "c@s.whatsapp.net" }));
    db.prepare("UPDATE prospects SET status='replied' WHERE wa_jid=?").run(
      "b@s.whatsapp.net",
    );
    db.prepare("UPDATE prospects SET status='opted_out' WHERE wa_jid=?").run(
      "c@s.whatsapp.net",
    );
    const f = getFunnelCounts(db);
    expect(f.total).toBe(3);
    expect(f.pending).toBe(1);
    expect(f.replied).toBe(1);
    expect(f.opted_out).toBe(1);
  });

  it("lists by status, oldest first, honoring the limit", () => {
    for (let i = 0; i < 5; i++) {
      upsertProspect(db, mkImport({ wa_jid: `p${i}@s.whatsapp.net` }));
    }
    const pending = listProspectsByStatus(db, "pending", 3);
    expect(pending).toHaveLength(3);
    expect(pending.every((p) => p.status === "pending")).toBe(true);
  });
});

describe("schema integrity", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = initDb(":memory:");
  });
  afterEach(() => {
    resetDbSingleton();
  });

  it("enforces UNIQUE(wa_jid) at the SQL layer", () => {
    db.prepare(
      "INSERT INTO prospects (id, phone_raw, wa_jid) VALUES (?, ?, ?)",
    ).run(randomUUID(), "5512345678", "dup@s.whatsapp.net");
    expect(() =>
      db
        .prepare(
          "INSERT INTO prospects (id, phone_raw, wa_jid) VALUES (?, ?, ?)",
        )
        .run(randomUUID(), "5599999999", "dup@s.whatsapp.net"),
    ).toThrow(/UNIQUE/);
  });

  it("cascades message deletion when a prospect is removed (foreign_keys ON)", () => {
    const pid = randomUUID();
    db.prepare(
      "INSERT INTO prospects (id, phone_raw, wa_jid) VALUES (?, ?, ?)",
    ).run(pid, "5512345678", "casc@s.whatsapp.net");
    db.prepare(
      "INSERT INTO messages (id, prospect_id, direction, body) VALUES (?, ?, 'out', 'hola')",
    ).run(randomUUID(), pid);

    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number })
        .n,
    ).toBe(1);

    db.prepare("DELETE FROM prospects WHERE id = ?").run(pid);

    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number })
        .n,
    ).toBe(0);
  });

  it("rejects an invalid status via the CHECK constraint", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO prospects (id, phone_raw, wa_jid, status) VALUES (?, ?, ?, 'bogus')",
        )
        .run(randomUUID(), "5512345678", "chk@s.whatsapp.net"),
    ).toThrow(/CHECK/);
  });
});
