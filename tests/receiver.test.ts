import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { initDb, resetDbSingleton } from "../src/db/database.js";
import {
  upsertProspect,
  setProspectStatus,
  getProspectByJid,
  getMessagesForProspect,
  type ProspectStatus,
} from "../src/db/models.js";
import { handleInboundMessage } from "../src/bot/receiver.js";

const JID = "525512345678@s.whatsapp.net";

function seed(
  db: Database.Database,
  over: { wa_jid?: string; status?: ProspectStatus; name?: string | null } = {},
): string {
  const wa_jid = over.wa_jid ?? JID;
  upsertProspect(db, {
    id: randomUUID(),
    name: over.name ?? "Estética Bella",
    colonia: "Santa Martha",
    phone_raw: "5512345678",
    wa_jid,
    source: "test",
  });
  const p = getProspectByJid(db, wa_jid)!;
  if (over.status) setProspectStatus(db, p.id, over.status);
  return p.id;
}

describe("handleInboundMessage", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = initDb(":memory:");
  });
  afterEach(() => {
    resetDbSingleton();
  });

  it("ignores a message from an unknown number (no DB writes)", () => {
    seed(db);
    const res = handleInboundMessage(db, {
      jid: "525500009999@s.whatsapp.net",
      body: "hola",
    });
    expect(res.matched).toBe(false);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number })
        .n,
    ).toBe(0);
  });

  it("logs a neutral first reply and drops the prospect from the queue", () => {
    const id = seed(db, { status: "sent" });
    const res = handleInboundMessage(db, { jid: JID, body: "ok gracias" });
    expect(res).toMatchObject({
      matched: true,
      classification: "neutral",
      status: "replied",
    });
    const p = getProspectByJid(db, JID)!;
    expect(p.status).toBe("replied"); // no longer 'pending'/'sent' -> off queue
    expect(p.reply_count).toBe(1);
    expect(p.first_reply_at).not.toBeNull();
    const msgs = getMessagesForProspect(db, id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direction: "in", body: "ok gracias" });
  });

  it("flags an interested lead and raises exactly one operator alert", () => {
    seed(db, { status: "sent", name: "Salón Glamour" });
    const alerts: unknown[] = [];
    const res = handleInboundMessage(
      db,
      { jid: JID, body: "¿cuánto cuesta?" },
      { onAlert: (a) => alerts.push(a) },
    );
    expect(res.status).toBe("interested");
    expect(res.alert).toMatchObject({ name: "Salón Glamour", jid: JID });
    expect(alerts).toHaveLength(1);
    expect(getProspectByJid(db, JID)!.status).toBe("interested");
  });

  it("opts a prospect out on opt-out phrasing", () => {
    seed(db, { status: "sent" });
    const res = handleInboundMessage(db, { jid: JID, body: "no me interesa" });
    expect(res.status).toBe("opted_out");
    expect(getProspectByJid(db, JID)!.status).toBe("opted_out");
  });

  it("keeps an opted-out prospect opted out (permanent), but still logs", () => {
    const id = seed(db, { status: "opted_out" });
    const alerts: unknown[] = [];
    const res = handleInboundMessage(
      db,
      { jid: JID, body: "bueno y cuánto cuesta?" },
      { onAlert: (a) => alerts.push(a) },
    );
    expect(res.status).toBe("opted_out"); // not upgraded to interested
    expect(res.alert).toBeUndefined();
    expect(alerts).toHaveLength(0);
    expect(getProspectByJid(db, JID)!.reply_count).toBe(1); // still counted
    expect(getMessagesForProspect(db, id)).toHaveLength(1);
  });

  it("does not downgrade an interested prospect on a later neutral reply", () => {
    seed(db, { status: "interested" });
    const res = handleInboundMessage(db, { jid: JID, body: "va, perfecto" });
    expect(res.status).toBe("interested");
    expect(res.alert).toBeUndefined(); // no new alert; was already interested
  });

  it("matches an inbound JID by 10-digit tail across 52/521 prefixes", () => {
    seed(db, { wa_jid: "525512345678@s.whatsapp.net" });
    const res = handleInboundMessage(db, {
      jid: "5215512345678@s.whatsapp.net", // 521-prefixed variant
      body: "hola",
    });
    expect(res.matched).toBe(true);
    expect(getProspectByJid(db, "525512345678@s.whatsapp.net")!.status).toBe(
      "replied",
    );
  });

  it("counts multiple replies and keeps the first_reply_at stamp", () => {
    seed(db, { status: "sent" });
    handleInboundMessage(db, { jid: JID, body: "hola" });
    const after1 = getProspectByJid(db, JID)!;
    handleInboundMessage(db, { jid: JID, body: "sigues ahí?" });
    const after2 = getProspectByJid(db, JID)!;
    expect(after2.reply_count).toBe(2);
    expect(after2.first_reply_at).toBe(after1.first_reply_at);
  });

  it.each(["pending", "queued"] as const)(
    "drops a %s prospect from the queue on any reply",
    (status) => {
      seed(db, { status });
      const res = handleInboundMessage(db, { jid: JID, body: "hola" });
      expect(res.status).toBe("replied");
      expect(getProspectByJid(db, JID)!.status).toBe("replied");
    },
  );

  it("lets opt-out override a prior 'interested' status", () => {
    seed(db, { status: "interested" });
    const res = handleInboundMessage(db, {
      jid: JID,
      body: "ya no me interesa, bájame",
    });
    expect(res.status).toBe("opted_out");
    expect(getProspectByJid(db, JID)!.status).toBe("opted_out");
  });

  it("raises no new alert when an already-interested prospect asks again", () => {
    seed(db, { status: "interested" });
    const alerts: unknown[] = [];
    const res = handleInboundMessage(
      db,
      { jid: JID, body: "¿y cuánto cuesta?" },
      { onAlert: (a) => alerts.push(a) },
    );
    expect(res.status).toBe("interested");
    expect(res.alert).toBeUndefined();
    expect(alerts).toHaveLength(0);
  });

  it("ignores group / broadcast JIDs (never matches a prospect by tail)", () => {
    // group local part ends in the same 10 digits as the seeded prospect
    seed(db, { wa_jid: "525512345678@s.whatsapp.net" });
    for (const jid of [
      "120363025512345678@g.us",
      "525512345678@broadcast",
      "status@broadcast",
    ]) {
      expect(handleInboundMessage(db, { jid, body: "hola" }).matched).toBe(
        false,
      );
    }
    // prospect untouched
    expect(getProspectByJid(db, "525512345678@s.whatsapp.net")!.status).toBe(
      "pending",
    );
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number })
        .n,
    ).toBe(0);
  });
});
