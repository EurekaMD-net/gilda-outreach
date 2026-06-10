import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initDb, resetDbSingleton } from "../src/db/database.js";
import {
  initOutreachSession,
  reinitOutreachSession,
  getSession,
  resetSessionForTest,
  type OutreachSessionOptions,
} from "../src/bot/baileys-manager.js";
import {
  markHalted,
  isHalted,
  resetSessionState,
} from "../src/bot/session-state.js";

/**
 * qa-C1 regression: the init chokepoint must refuse to (re)connect a HALTED
 * (probable-ban) session. This is the seam where an orphaned reconnect timer
 * could otherwise reconnect a banned number. Exercised in OUTREACH_ENV=test so
 * no real socket is built — the isHalted() gate runs ahead of the test stub.
 */
describe("ban-averse init chokepoint (qa-C1)", () => {
  let db: Database.Database;

  beforeEach(() => {
    process.env["OUTREACH_ENV"] = "test";
    db = initDb(":memory:");
    resetSessionState();
    resetSessionForTest();
  });
  afterEach(() => {
    resetDbSingleton();
    resetSessionState();
    resetSessionForTest();
    delete process.env["OUTREACH_ENV"];
  });

  const opts = (): OutreachSessionOptions => ({
    sessionDir: "/tmp/gilda-outreach-test-noop",
    outreachNumber: "5215512345678",
    db,
  });

  it("inits a stub session in test mode when not halted", async () => {
    const s = await initOutreachSession(opts());
    expect(s.outreachNumber).toBe("5215512345678");
    expect(getSession()).not.toBeNull();
  });

  it("REFUSES to init once the session is HALTED (no banned reconnect)", async () => {
    markHalted("WA logout/401 — probable ban");
    expect(isHalted()).toBe(true);
    await expect(initOutreachSession(opts())).rejects.toThrow(/HALTED/i);
  });

  it("REFUSES reinit once the session is HALTED", async () => {
    markHalted("ban");
    await expect(reinitOutreachSession(opts())).rejects.toThrow(/HALTED/i);
  });

  it("does NOT create a session object when init is refused", async () => {
    markHalted("ban");
    await expect(initOutreachSession(opts())).rejects.toThrow();
    expect(getSession()).toBeNull();
  });

  it("allows init again only after the halt clears (manual re-link → connected)", async () => {
    markHalted("ban");
    await expect(initOutreachSession(opts())).rejects.toThrow();
    // A successful re-link reaches "connected", which clears the latch.
    resetSessionState();
    const s = await initOutreachSession(opts());
    expect(s).toBeTruthy();
    expect(isHalted()).toBe(false);
  });
});
