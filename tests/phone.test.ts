import { describe, it, expect } from "vitest";
import { normalizeToWA, jidToNumber } from "../src/util/phone.js";

describe("normalizeToWA", () => {
  it.each([
    ["55 1234 5678", "525512345678"],
    ["(55) 1234-5678", "525512345678"],
    ["+52 55 1234 5678", "525512345678"],
    ["525512345678", "525512345678"],
    ["5215512345678", "5215512345678"],
  ])("normalizes %s -> %s", (input, expected) => {
    expect(normalizeToWA(input)).toBe(expected);
  });

  it.each([["12345"], [""], ["abcdefghij"], ["5512"]])(
    "rejects invalid %s",
    (input) => {
      expect(normalizeToWA(input)).toBeNull();
    },
  );
});

describe("jidToNumber", () => {
  it("strips the @s.whatsapp.net suffix", () => {
    expect(jidToNumber("525512345678@s.whatsapp.net")).toBe("525512345678");
  });
  it("returns a bare number unchanged", () => {
    expect(jidToNumber("525512345678")).toBe("525512345678");
  });
  it("trims surrounding whitespace", () => {
    expect(jidToNumber("  525512345678@s.whatsapp.net  ")).toBe("525512345678");
  });
});
