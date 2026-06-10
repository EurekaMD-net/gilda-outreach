import { describe, it, expect } from "vitest";
import {
  classifyDisconnect,
  decideClose,
  extractInboundText,
  pickMatchJid,
  WA_LOGGED_OUT,
} from "../src/bot/baileys-manager.js";

describe("classifyDisconnect — ban-averse policy", () => {
  it("HALTS on a WA logout / 401 (probable ban)", () => {
    expect(classifyDisconnect(WA_LOGGED_OUT)).toBe("halt");
    expect(classifyDisconnect(401)).toBe("halt");
  });

  it("reconnects on transient codes and an undefined code", () => {
    for (const code of [428, 515, 500, 408, 503, undefined]) {
      expect(classifyDisconnect(code)).toBe("reconnect");
    }
  });
});

describe("decideClose — onboarding 401 must NOT ban-halt", () => {
  it("ban-halts ONLY a 401 on an already-registered session", () => {
    expect(decideClose(WA_LOGGED_OUT, true)).toBe("ban-halt");
    expect(decideClose(401, true)).toBe("ban-halt");
  });

  it("retries (does NOT halt) a 401 while still unregistered — pairing not done", () => {
    // The bug that false-halted the very first link attempt.
    expect(decideClose(WA_LOGGED_OUT, false)).toBe("retry");
    expect(decideClose(401, false)).toBe("retry");
  });

  it("retries every transient code regardless of registration", () => {
    for (const reg of [true, false]) {
      for (const code of [408, 515, 503, undefined]) {
        expect(decideClose(code, reg)).toBe("retry");
      }
    }
  });
});

describe("extractInboundText", () => {
  it("reads a plain conversation", () => {
    expect(extractInboundText({ conversation: "hola" })).toBe("hola");
  });

  it("falls back to extendedTextMessage.text", () => {
    expect(extractInboundText({ extendedTextMessage: { text: "mundo" } })).toBe(
      "mundo",
    );
  });

  it("returns empty string for null / undefined / empty / media-only", () => {
    expect(extractInboundText(null)).toBe("");
    expect(extractInboundText(undefined)).toBe("");
    expect(extractInboundText({})).toBe("");
    expect(extractInboundText({ extendedTextMessage: { text: null } })).toBe(
      "",
    );
  });
});

describe("pickMatchJid — LID handling", () => {
  it("prefers a phone-format remoteJidAlt over an @lid remoteJid", () => {
    expect(pickMatchJid("12345@lid", "525512345678@s.whatsapp.net")).toBe(
      "525512345678@s.whatsapp.net",
    );
  });

  it("keeps remoteJid when the alt is absent or not phone-format", () => {
    expect(pickMatchJid("525512345678@s.whatsapp.net", undefined)).toBe(
      "525512345678@s.whatsapp.net",
    );
    expect(pickMatchJid("525512345678@s.whatsapp.net", null)).toBe(
      "525512345678@s.whatsapp.net",
    );
    expect(pickMatchJid("525512345678@s.whatsapp.net", "99999@lid")).toBe(
      "525512345678@s.whatsapp.net",
    );
  });
});
