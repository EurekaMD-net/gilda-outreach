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
