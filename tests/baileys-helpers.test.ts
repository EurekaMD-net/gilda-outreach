import { describe, it, expect } from "vitest";
import {
  classifyDisconnect,
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
