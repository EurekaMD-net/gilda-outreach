import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { initDb, resetDbSingleton } from "../src/db/database.js";
import {
  upsertProspect,
  setProspectStatus,
  getProspectByJid,
  getDailySent,
  getPriorSendDayCount,
  recordOutboundSend,
  getMessagesForProspect,
  type ProspectStatus,
} from "../src/db/models.js";
import { resetSessionState, markHalted } from "../src/bot/session-state.js";
import {
  loadMode,
  decideTick,
  nextGapMs,
  selectNextProspect,
  runTick,
  planToday,
  type SenderCtx,
} from "../src/sender/sender.js";
import { OUTREACH_MESSAGE } from "../src/sender/copy.js";
import { mxDayKey } from "../src/util/time.js";

const ALWAYS_OPEN = {
  startHour: 0,
  endHour: 24,
  days: [0, 1, 2, 3, 4, 5, 6],
} as const;

function seed(
  db: Database.Database,
  wa_jid: string,
  over: {
    colonia?: string | null;
    status?: ProspectStatus;
    phone_raw?: string;
  } = {},
): string {
  upsertProspect(db, {
    id: randomUUID(),
    name: "Negocio",
    colonia: over.colonia ?? "SAN PABLO",
    phone_raw: over.phone_raw ?? "5512345678",
    wa_jid,
    source: "test",
  });
  const p = getProspectByJid(db, wa_jid)!;
  if (over.status) setProspectStatus(db, p.id, over.status);
  return p.id;
}

function ctx(over: Partial<SenderCtx> = {}): SenderCtx {
  return {
    mode: "live",
    windowCfg: { ...ALWAYS_OPEN },
    ramp: [5],
    blocklist: new Set<string>(),
    day: mxDayKey(),
    lastSentAt: null,
    currentGapMs: 60_000,
    shadowCount: 0,
    shadowSentIds: new Set<string>(),
    inFlight: false,
    ...over,
  };
}

describe("loadMode", () => {
  it("defaults to off and only accepts shadow/live", () => {
    expect(loadMode({})).toBe("off");
    expect(loadMode({ OUTREACH_MODE: "shadow" } as NodeJS.ProcessEnv)).toBe(
      "shadow",
    );
    expect(loadMode({ OUTREACH_MODE: "LIVE" } as NodeJS.ProcessEnv)).toBe(
      "live",
    );
    expect(loadMode({ OUTREACH_MODE: "on" } as NodeJS.ProcessEnv)).toBe("off");
  });
});

describe("decideTick", () => {
  const base = {
    mode: "live" as const,
    windowOpen: true,
    halted: false,
    todaySent: 0,
    todayCap: 5,
    now: 1_000_000,
    lastSentAt: null,
    minGapMs: 60_000,
  };
  it("sends when every gate is open", () => {
    expect(decideTick(base)).toEqual({ send: true });
  });
  it("never sends in mode=off", () => {
    expect(decideTick({ ...base, mode: "off" })).toMatchObject({ send: false });
  });
  it("never sends while halted (anti-ban)", () => {
    expect(decideTick({ ...base, halted: true })).toMatchObject({
      send: false,
      reason: expect.stringMatching(/halt/i),
    });
  });
  it("respects the send window", () => {
    expect(decideTick({ ...base, windowOpen: false })).toMatchObject({
      send: false,
    });
  });
  it("stops at the daily cap", () => {
    expect(decideTick({ ...base, todaySent: 5, todayCap: 5 })).toMatchObject({
      send: false,
      reason: expect.stringMatching(/cap/i),
    });
  });
  it("enforces the min gap since the last send", () => {
    expect(
      decideTick({ ...base, lastSentAt: 1_000_000 - 30_000, minGapMs: 60_000 }),
    ).toMatchObject({ send: false, reason: expect.stringMatching(/gap/i) });
  });
});

describe("nextGapMs", () => {
  it("stays within [90s, 30min] and spreads by cap", () => {
    const windowMs = 8 * 3_600_000;
    for (const rand of [0, 0.5, 1]) {
      const g = nextGapMs(40, windowMs, () => rand);
      expect(g).toBeGreaterThanOrEqual(90_000);
      expect(g).toBeLessThanOrEqual(30 * 60_000);
    }
    // a tiny cap would space far apart → clamped to the 30min ceiling
    expect(nextGapMs(1, windowMs, () => 1)).toBe(30 * 60_000);
  });
});

describe("selectNextProspect", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = initDb(":memory:");
  });
  afterEach(() => resetDbSingleton());

  it("returns the oldest pending prospect", () => {
    const first = seed(db, "a@s.whatsapp.net");
    seed(db, "b@s.whatsapp.net");
    const p = selectNextProspect(db, new Set(), new Set(), "live");
    expect(p?.id).toBe(first);
  });

  it("skips a blocklisted number at send time (defense-in-depth)", () => {
    seed(db, "5215500000000@s.whatsapp.net"); // a blocklisted tail (fake)
    const keep = seed(db, "5215512345678@s.whatsapp.net");
    const blocklist = new Set(["5500000000"]);
    const p = selectNextProspect(db, new Set(), blocklist, "live");
    expect(p?.id).toBe(keep);
  });

  it("in shadow, skips already-virtually-sent ids", () => {
    const a = seed(db, "a@s.whatsapp.net");
    const b = seed(db, "b@s.whatsapp.net");
    const p = selectNextProspect(db, new Set([a]), new Set(), "shadow");
    expect(p?.id).toBe(b);
  });

  it("returns null when the pending queue is empty", () => {
    seed(db, "a@s.whatsapp.net", { status: "replied" });
    expect(selectNextProspect(db, new Set(), new Set(), "live")).toBeNull();
  });
});

describe("models — getPriorSendDayCount + recordOutboundSend", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = initDb(":memory:");
  });
  afterEach(() => resetDbSingleton());

  it("counts only prior days with sends", () => {
    db.prepare(
      "INSERT INTO daily_sends (day, sent_count) VALUES ('2026-06-08', 5)",
    ).run();
    db.prepare(
      "INSERT INTO daily_sends (day, sent_count) VALUES ('2026-06-09', 3)",
    ).run();
    db.prepare(
      "INSERT INTO daily_sends (day, sent_count) VALUES ('2026-06-10', 1)",
    ).run();
    expect(getPriorSendDayCount(db, "2026-06-10")).toBe(2); // 08 + 09, not today
  });

  it("transitions pending→sent, stamps, logs the message, bumps the daily counter", () => {
    const id = seed(db, "a@s.whatsapp.net");
    const ok = recordOutboundSend(db, id, "hola", null, "2026-06-10");
    expect(ok).toBe(true);
    const p = getProspectByJid(db, "a@s.whatsapp.net")!;
    expect(p.status).toBe("sent");
    expect(p.contacted_at).not.toBeNull();
    expect(p.last_out_at).not.toBeNull();
    expect(p.attempts).toBe(1);
    expect(getDailySent(db, "2026-06-10")).toBe(1);
    const msgs = getMessagesForProspect(db, id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direction: "out", body: "hola" });
  });

  it("is a no-op if the prospect already left the queue (e.g. replied)", () => {
    const id = seed(db, "a@s.whatsapp.net", { status: "replied" });
    const ok = recordOutboundSend(db, id, "hola", null, "2026-06-10");
    expect(ok).toBe(false);
    expect(getProspectByJid(db, "a@s.whatsapp.net")!.status).toBe("replied");
    expect(getDailySent(db, "2026-06-10")).toBe(0);
  });
});

describe("runTick", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = initDb(":memory:");
    resetSessionState();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    resetDbSingleton();
    resetSessionState();
    vi.restoreAllMocks();
  });

  const fakeSession = () => ({
    outreachNumber: "522205847098",
    sendMessage: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  });

  it("LIVE: sends the message, marks sent, counts the send", async () => {
    const id = seed(db, "5215512345678@s.whatsapp.net");
    const session = fakeSession();
    const out = await runTick(db, () => session, ctx({ mode: "live" }));
    expect(out).toMatchObject({ sent: true, prospectId: id });
    expect(session.sendMessage).toHaveBeenCalledWith(
      "5215512345678@s.whatsapp.net",
      OUTREACH_MESSAGE,
    );
    expect(getProspectByJid(db, "5215512345678@s.whatsapp.net")!.status).toBe(
      "sent",
    );
    expect(getDailySent(db, mxDayKey())).toBe(1);
  });

  it("SHADOW: logs would-send but never sends or mutates state", async () => {
    seed(db, "a@s.whatsapp.net");
    const session = fakeSession();
    const c = ctx({ mode: "shadow" });
    const out = await runTick(db, () => session, c);
    expect(out).toMatchObject({ sent: true, shadow: true });
    expect(session.sendMessage).not.toHaveBeenCalled();
    expect(getProspectByJid(db, "a@s.whatsapp.net")!.status).toBe("pending");
    expect(getDailySent(db, mxDayKey())).toBe(0);
    expect(c.shadowCount).toBe(1);
  });

  it("never sends while halted (the inversion reaches the sender)", async () => {
    seed(db, "a@s.whatsapp.net");
    markHalted("probable ban");
    const session = fakeSession();
    const out = await runTick(db, () => session, ctx({ mode: "live" }));
    expect(out).toMatchObject({ sent: false });
    expect(session.sendMessage).not.toHaveBeenCalled();
  });

  it("does not send outside the window", async () => {
    seed(db, "a@s.whatsapp.net");
    const session = fakeSession();
    const closed = ctx({
      mode: "live",
      windowCfg: { startHour: 10, endHour: 18, days: [] },
    });
    const out = await runTick(db, () => session, closed);
    expect(out).toMatchObject({ sent: false });
    expect(session.sendMessage).not.toHaveBeenCalled();
  });

  it("LIVE with no socket does not send", async () => {
    seed(db, "a@s.whatsapp.net");
    const out = await runTick(db, () => null, ctx({ mode: "live" }));
    expect(out).toMatchObject({
      sent: false,
      reason: expect.stringMatching(/socket/i),
    });
  });

  it("qa-C1: does not run a second tick while one is in flight (no double-send)", async () => {
    seed(db, "5215512345678@s.whatsapp.net");
    let release!: () => void;
    const session = {
      outreachNumber: "x",
      disconnect: vi.fn(async () => {}),
      sendMessage: vi.fn(
        () =>
          new Promise<void>((r) => {
            release = r;
          }),
      ),
    };
    const c = ctx({ mode: "live" });
    const p1 = runTick(db, () => session, c); // suspends inside sendMessage
    const r2 = await runTick(db, () => session, c); // concurrent → must no-op
    expect(r2).toMatchObject({
      sent: false,
      reason: expect.stringMatching(/in flight/i),
    });
    release();
    await p1;
    expect(session.sendMessage).toHaveBeenCalledTimes(1); // only ONE send
  });

  it("marks a prospect FAILED on send error and never retries it (at-most-once)", async () => {
    seed(db, "5215512345678@s.whatsapp.net");
    const session = {
      outreachNumber: "x",
      disconnect: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const c = ctx({ mode: "live" });
    const out = await runTick(db, () => session, c);
    expect(out).toMatchObject({
      sent: false,
      reason: expect.stringMatching(/failed/i),
    });
    expect(getProspectByJid(db, "5215512345678@s.whatsapp.net")!.status).toBe(
      "failed",
    );
    // Next eligible tick: the failed prospect is no longer `pending` → not
    // re-selected, so the same number is never messaged twice.
    c.lastSentAt = null;
    const out2 = await runTick(db, () => session, c);
    expect(out2).toMatchObject({
      sent: false,
      reason: expect.stringMatching(/queue empty/i),
    });
    expect(session.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("stops at the daily cap (real counter)", async () => {
    seed(db, "a@s.whatsapp.net");
    seed(db, "b@s.whatsapp.net");
    db.prepare("INSERT INTO daily_sends (day, sent_count) VALUES (?, 5)").run(
      mxDayKey(),
    );
    const session = fakeSession();
    const out = await runTick(
      db,
      () => session,
      ctx({ mode: "live", ramp: [5] }),
    );
    expect(out).toMatchObject({
      sent: false,
      reason: expect.stringMatching(/cap/i),
    });
  });
});

describe("planToday", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = initDb(":memory:");
  });
  afterEach(() => resetDbSingleton());

  it("returns today's cap, queue batch, and the message (window-independent)", () => {
    for (let i = 0; i < 10; i++) seed(db, `p${i}@s.whatsapp.net`);
    const plan = planToday(db, { OUTREACH_RAMP: "3" } as NodeJS.ProcessEnv);
    expect(plan.cap).toBe(3);
    expect(plan.remaining).toBe(3);
    expect(plan.batch).toHaveLength(3);
    expect(plan.message).toBe(OUTREACH_MESSAGE);
  });

  it("excludes blocklisted numbers from the batch", () => {
    seed(db, "5215500000000@s.whatsapp.net"); // a blocklisted tail (fake)
    seed(db, "5215512345678@s.whatsapp.net");
    const plan = planToday(db, {
      OUTREACH_RAMP: "5",
      OUTREACH_BLOCKLIST: "5500000000",
    } as NodeJS.ProcessEnv);
    expect(plan.batch.every((p) => !p.wa_jid.includes("5500000000"))).toBe(
      true,
    );
  });
});
