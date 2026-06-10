import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { initDb, resetDbSingleton } from "../src/db/database.js";
import {
  upsertProspect,
  setProspectStatus,
  insertMessage,
  getProspectByJid,
  type ProspectStatus,
} from "../src/db/models.js";
import {
  recordSessionState,
  markHalted,
  resetSessionState,
} from "../src/bot/session-state.js";
import {
  computeOutreachSnapshot,
  renderMetrics,
  createObservabilityRoutes,
} from "../src/web/observability.js";
import { mxDayKey } from "../src/util/time.js";

describe("outreach observability", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = initDb(":memory:");
    resetSessionState();
  });
  afterEach(() => {
    resetDbSingleton();
    resetSessionState();
  });

  function seed(
    wa_jid: string,
    status?: ProspectStatus,
    contacted = false,
  ): string {
    upsertProspect(db, {
      id: randomUUID(),
      name: "X",
      colonia: null,
      phone_raw: "5512345678",
      wa_jid,
      source: "test",
    });
    const p = getProspectByJid(db, wa_jid)!;
    if (status) setProspectStatus(db, p.id, status);
    if (contacted)
      db.prepare(
        "UPDATE prospects SET contacted_at = unixepoch() WHERE id = ?",
      ).run(p.id);
    return p.id;
  }

  it("renders session_up=1 / halted=0 and the state enum when connected", () => {
    recordSessionState("connected");
    const out = renderMetrics(computeOutreachSnapshot(db));
    expect(out).toMatch(/^outreach_session_up 1$/m);
    expect(out).toMatch(/^outreach_session_halted 0$/m);
    expect(out).toMatch(/outreach_session_state\{state="connected"\} 1/);
    expect(out).toMatch(/outreach_session_state\{state="logged_out"\} 0/);
  });

  it("renders session_up=0 / halted=1 after a halt", () => {
    markHalted("ban");
    const out = renderMetrics(computeOutreachSnapshot(db));
    expect(out).toMatch(/^outreach_session_up 0$/m);
    expect(out).toMatch(/^outreach_session_halted 1$/m);
    expect(out).toMatch(/outreach_session_state\{state="logged_out"\} 1/);
  });

  it("counts sent / replies / opted_out / failed and the funnel labels", () => {
    seed("a@s.whatsapp.net", "sent", true);
    const pid = seed("b@s.whatsapp.net", "opted_out", true);
    seed("c@s.whatsapp.net", "failed", false);
    insertMessage(db, { prospect_id: pid, direction: "in", body: "no" });
    insertMessage(db, { prospect_id: pid, direction: "out", body: "hola" });

    const snap = computeOutreachSnapshot(db);
    expect(snap.sentTotal).toBe(2); // a + b have contacted_at
    expect(snap.messagesOut).toBe(1);
    expect(snap.repliesTotal).toBe(1);

    const out = renderMetrics(snap);
    expect(out).toMatch(/^outreach_sent_total 2$/m);
    expect(out).toMatch(/^outreach_messages_out_total 1$/m);
    expect(out).toMatch(/^outreach_replies_total 1$/m);
    expect(out).toMatch(/^outreach_opted_out_total 1$/m);
    expect(out).toMatch(/^outreach_failed_total 1$/m);
    expect(out).toMatch(/outreach_prospects\{status="opted_out"\} 1/);
    expect(out).toMatch(/outreach_prospects\{status="failed"\} 1/);
    expect(out).toMatch(/^outreach_prospects_total 3$/m);
  });

  it("reflects today's MX daily_sends counter in outreach_daily_sent", () => {
    db.prepare("INSERT INTO daily_sends (day, sent_count) VALUES (?, 7)").run(
      mxDayKey(),
    );
    const out = renderMetrics(computeOutreachSnapshot(db));
    expect(out).toMatch(/^outreach_daily_sent 7$/m);
  });

  it("emits a well-formed exposition (trailing newline, no empty metric lines)", () => {
    recordSessionState("connecting");
    const out = renderMetrics(computeOutreachSnapshot(db));
    expect(out.endsWith("\n")).toBe(true);
    for (const line of out.split("\n")) {
      if (line === "" || line.startsWith("#")) continue;
      // every metric line is `name value` or `name{labels} value`
      expect(line).toMatch(/^[a-z_]+(\{[^}]*\})? -?\d+$/);
    }
  });
});

describe("outreach /leads + /health/session routes", () => {
  // ≥16 chars (auth.ts requires it); fake — never the real ADMIN_TOKEN.
  const TOKEN = "test-admin-token-0123456789";
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
    resetSessionState();
    process.env.ADMIN_TOKEN = TOKEN;
  });
  afterEach(() => {
    resetDbSingleton();
    resetSessionState();
    delete process.env.ADMIN_TOKEN;
  });

  function seedLead(
    wa_jid: string,
    name: string,
    status: ProspectStatus,
    inbound?: string,
  ): string {
    upsertProspect(db, {
      id: randomUUID(),
      name,
      colonia: "SAN PABLO",
      phone_raw: "5512345678",
      wa_jid,
      source: "test",
    });
    const p = getProspectByJid(db, wa_jid)!;
    setProspectStatus(db, p.id, status);
    if (inbound) {
      db.prepare(
        "UPDATE prospects SET reply_count = 1, first_reply_at = unixepoch() WHERE id = ?",
      ).run(p.id);
      insertMessage(db, { prospect_id: p.id, direction: "in", body: inbound });
    }
    return p.id;
  }

  it("/leads requires the admin token", async () => {
    const app = createObservabilityRoutes(db);
    const res = await app.request("/leads");
    expect(res.status).toBe(401);
  });

  it("/leads returns interested + replied with latest inbound + ISO times; never pending", async () => {
    seedLead("i@s.whatsapp.net", "Salon Uno", "interested", "sí me interesa");
    seedLead("r@s.whatsapp.net", "Salon Dos", "replied", "quién es?");
    seedLead("p@s.whatsapp.net", "Salon Tres", "pending"); // must be excluded

    const app = createObservabilityRoutes(db);
    const res = await app.request(`/leads?token=${TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      count: number;
      leads: Array<Record<string, unknown>>;
    };

    expect(body.count).toBe(2);
    expect(body.leads.map((l) => l.waJid).sort()).toEqual([
      "i@s.whatsapp.net",
      "r@s.whatsapp.net",
    ]);
    expect(body.leads.some((l) => l.status === "pending")).toBe(false);

    const interested = body.leads.find((l) => l.status === "interested")!;
    expect(interested.name).toBe("Salon Uno");
    expect(interested.lastInboundBody).toBe("sí me interesa");
    expect(String(interested.firstReplyAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(String(interested.lastInboundAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("/leads clamps ?limit", async () => {
    seedLead("a@s.whatsapp.net", "A", "interested", "hola");
    seedLead("b@s.whatsapp.net", "B", "interested", "hey");
    const app = createObservabilityRoutes(db);
    const res = await app.request(`/leads?token=${TOKEN}&limit=1`);
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(1);
  });

  it("/health/session is token-gated and carries the MX day + dailySent", async () => {
    db.prepare("INSERT INTO daily_sends (day, sent_count) VALUES (?, 3)").run(
      mxDayKey(),
    );
    const app = createObservabilityRoutes(db);

    expect((await app.request("/health/session")).status).toBe(401);

    const res = await app.request(`/health/session?token=${TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { day: string; dailySent: number };
    expect(body.day).toBe(mxDayKey());
    expect(body.dailySent).toBe(3);
  });
});
