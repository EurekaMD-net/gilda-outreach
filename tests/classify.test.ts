import { describe, it, expect } from "vitest";
import { classifyInbound } from "../src/bot/classify.js";

describe("classifyInbound", () => {
  it.each([
    "no me interesa",
    "No me interesa, gracias",
    "no gracias",
    "no, gracias",
    "STOP",
    "denme de baja",
    "no quiero mensajes",
    "quién eres?",
    "quien habla",
    "cómo conseguiste mi número",
    "déjame en paz",
  ])("treats %j as opt_out", (msg) => {
    expect(classifyInbound(msg)).toBe("opt_out");
  });

  it.each([
    "¿cuánto cuesta?",
    "cuanto es",
    "cómo funciona",
    "sí me interesa",
    "me interesa",
    "quiero más información",
    "cuéntame",
    "¿qué precio tiene?",
    "tienes algo para salones?", // ends with ?
  ])("treats %j as interested", (msg) => {
    expect(classifyInbound(msg)).toBe("interested");
  });

  it.each(["hola", "ok", "gracias", "buenos días", "va", "sale pues"])(
    "treats %j as neutral",
    (msg) => {
      expect(classifyInbound(msg)).toBe("neutral");
    },
  );

  it("gives opt_out precedence over an interested signal in the same message", () => {
    // contains 'cuánto' (interested) but also 'no me interesa' (opt-out)
    expect(classifyInbound("no me interesa, ni aunque me digas cuánto")).toBe(
      "opt_out",
    );
  });

  it("treats a bare 'no' as neutral (not opt-out)", () => {
    expect(classifyInbound("no")).toBe("neutral");
  });

  it.each(["", "   ", "\n"])("treats blank %j as neutral", (msg) => {
    expect(classifyInbound(msg)).toBe("neutral");
  });

  // Regression: JS `\b` is ASCII-only, so accented verb conjugations used to
  // slip past `\binteresa\b`. Pin the loosened-stem behavior.
  it("catches accented conjugations of 'interesa' (ascii-\\b trap)", () => {
    expect(classifyInbound("no me interesaría")).toBe("opt_out");
    expect(classifyInbound("la verdad no me interesará")).toBe("opt_out");
    expect(classifyInbound("me interesaría saber más")).toBe("interested");
  });
});
