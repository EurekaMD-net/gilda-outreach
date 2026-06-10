import { describe, it, expect, beforeEach } from "vitest";
import {
  recordSessionState,
  markHalted,
  getSessionState,
  isHalted,
  resetSessionState,
  evaluateSessionHealth,
  planOutreachWatchdogTick,
  type WatchdogMemory,
} from "../src/bot/session-state.js";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

describe("session-state registry", () => {
  beforeEach(() => resetSessionState());

  it("records a transition and preserves `since` on a repeat of the same state", () => {
    recordSessionState("connecting", T0);
    recordSessionState("connecting", T0 + 5000);
    expect(getSessionState()).toMatchObject({ state: "connecting", since: T0 });
  });

  it("advances `since` on a state change", () => {
    recordSessionState("connecting", T0);
    recordSessionState("reconnecting", T0 + 1000);
    expect(getSessionState()).toMatchObject({
      state: "reconnecting",
      since: T0 + 1000,
    });
  });

  it("stamps lastConnectedAt only on connected", () => {
    recordSessionState("connecting", T0);
    expect(getSessionState()?.lastConnectedAt).toBeNull();
    recordSessionState("connected", T0 + 1000);
    expect(getSessionState()?.lastConnectedAt).toBe(T0 + 1000);
    // a later non-connected state preserves the last connected stamp
    recordSessionState("reconnecting", T0 + 2000);
    expect(getSessionState()?.lastConnectedAt).toBe(T0 + 1000);
  });

  it("markHalted latches halted + logged_out, sticky until a real reconnect", () => {
    recordSessionState("connected", T0);
    markHalted("probable ban", T0 + 1000);
    expect(isHalted()).toBe(true);
    expect(getSessionState()).toMatchObject({
      state: "logged_out",
      halted: true,
      haltReason: "probable ban",
    });
    // a non-connected transition keeps the latch
    recordSessionState("connecting", T0 + 2000);
    expect(isHalted()).toBe(true);
    // reaching connected clears it (recovered via manual re-link)
    recordSessionState("connected", T0 + 3000);
    expect(isHalted()).toBe(false);
    expect(getSessionState()?.haltReason).toBeNull();
  });

  it("isHalted() is false with no record", () => {
    expect(isHalted()).toBe(false);
  });
});

describe("evaluateSessionHealth", () => {
  beforeEach(() => resetSessionState());

  it("is 'unknown' + down-since-boot when no record exists", () => {
    const h = evaluateSessionHealth(null, {
      nowMs: T0,
      thresholdMs: 3_600_000,
      bootMs: T0 - 1000,
    });
    expect(h.state).toBe("unknown");
    expect(h.up).toBe(false);
    expect(h.downForSeconds).toBe(1);
  });

  it("is up with null downForSeconds while connected", () => {
    recordSessionState("connected", T0);
    const h = evaluateSessionHealth(getSessionState(), {
      nowMs: T0 + 5000,
      thresholdMs: 3_600_000,
      bootMs: T0,
    });
    expect(h.up).toBe(true);
    expect(h.downForSeconds).toBeNull();
    expect(h.stale).toBe(false);
  });

  it("measures down-time from last connection and flags stale past threshold", () => {
    recordSessionState("connected", T0);
    recordSessionState("reconnecting", T0 + 1000);
    const h = evaluateSessionHealth(getSessionState(), {
      nowMs: T0 + 2 * 3_600_000,
      thresholdMs: 3_600_000,
      bootMs: T0,
    });
    expect(h.up).toBe(false);
    expect(h.stale).toBe(true); // down measured from lastConnectedAt (T0)
  });

  it("surfaces the halt reason in the verdict", () => {
    markHalted("WA 401", T0);
    const h = evaluateSessionHealth(getSessionState(), {
      nowMs: T0,
      thresholdMs: 3_600_000,
      bootMs: T0,
    });
    expect(h.halted).toBe(true);
    expect(h.haltReason).toBe("WA 401");
  });
});

describe("planOutreachWatchdogTick — INVERTED self-heal", () => {
  beforeEach(() => resetSessionState());

  const opts = (
    over: Partial<Parameters<typeof planOutreachWatchdogTick>[2]> = {},
  ) => ({
    nowMs: T0 + 10 * MIN,
    stuckMs: 5 * MIN,
    cooldownMs: 5 * MIN,
    bootMs: T0,
    maxStrikes: 3,
    isRegistered: () => true,
    ...over,
  });

  it("never reinits a connected session and resets the strike memory", () => {
    recordSessionState("connected", T0);
    const mem: WatchdogMemory = { strikes: 2, lastHealAt: T0 };
    const r = planOutreachWatchdogTick(getSessionState(), mem, opts());
    expect(r).toEqual({ reinit: false, gaveUp: false });
    expect(mem).toEqual({ strikes: 0, lastHealAt: 0 });
  });

  it("THE INVERSION: never reinits a logged_out (probable-ban) session", () => {
    markHalted("ban", T0);
    const mem: WatchdogMemory = { strikes: 0, lastHealAt: 0 };
    const r = planOutreachWatchdogTick(
      getSessionState(),
      mem,
      opts({ nowMs: T0 + 100 * MIN }),
    );
    expect(r).toEqual({ reinit: false, gaveUp: false });
    expect(mem.strikes).toBe(0);
  });

  it("reinits a session stuck reconnecting past stuckMs", () => {
    recordSessionState("reconnecting", T0);
    const mem: WatchdogMemory = { strikes: 0, lastHealAt: 0 };
    const r = planOutreachWatchdogTick(
      getSessionState(),
      mem,
      opts({ nowMs: T0 + 6 * MIN }),
    );
    expect(r.reinit).toBe(true);
    expect(mem.strikes).toBe(1);
    expect(mem.lastHealAt).toBe(T0 + 6 * MIN);
  });

  it("does not reinit before stuckMs elapses", () => {
    recordSessionState("connecting", T0);
    const mem: WatchdogMemory = { strikes: 0, lastHealAt: 0 };
    const r = planOutreachWatchdogTick(
      getSessionState(),
      mem,
      opts({ nowMs: T0 + 1 * MIN }),
    );
    expect(r.reinit).toBe(false);
  });

  it("honors the post-heal cooldown", () => {
    recordSessionState("reconnecting", T0);
    const mem: WatchdogMemory = { strikes: 1, lastHealAt: T0 + 5 * MIN };
    const r = planOutreachWatchdogTick(
      getSessionState(),
      mem,
      opts({ nowMs: T0 + 6 * MIN }), // only 1 min since last heal < 5 min cooldown
    );
    expect(r.reinit).toBe(false);
  });

  it("never reinits an unregistered (mid-pairing) session — would burn the code", () => {
    recordSessionState("connecting", T0);
    const mem: WatchdogMemory = { strikes: 0, lastHealAt: 0 };
    const r = planOutreachWatchdogTick(
      getSessionState(),
      mem,
      opts({ nowMs: T0 + 6 * MIN, isRegistered: () => false }),
    );
    expect(r.reinit).toBe(false);
    expect(mem.strikes).toBe(0);
  });

  it("treats a no-record (never-connected) session as stuck-since-boot", () => {
    const mem: WatchdogMemory = { strikes: 0, lastHealAt: 0 };
    const r = planOutreachWatchdogTick(
      null,
      mem,
      opts({ nowMs: T0 + 6 * MIN }),
    );
    expect(r.reinit).toBe(true);
  });

  it("gives up + halts after maxStrikes reinit attempts, then stays quiet", () => {
    recordSessionState("reconnecting", T0);
    const mem: WatchdogMemory = { strikes: 0, lastHealAt: 0 };
    let now = T0 + 6 * MIN;
    for (let i = 1; i <= 3; i++) {
      const r = planOutreachWatchdogTick(
        getSessionState(),
        mem,
        opts({ nowMs: now }),
      );
      expect(r).toEqual({ reinit: true, gaveUp: false });
      expect(mem.strikes).toBe(i);
      now += 6 * MIN; // advance past cooldown
    }
    // budget spent → next eligible tick gives up (no extra reinit)
    const g = planOutreachWatchdogTick(
      getSessionState(),
      mem,
      opts({ nowMs: now }),
    );
    expect(g).toEqual({ reinit: false, gaveUp: true });
    expect(mem.strikes).toBe(3); // not incremented further
  });
});
