import { describe, it, expect } from "vitest";
import { OUTREACH_MESSAGE, renderMessage } from "../src/sender/copy.js";
import { classifyInbound } from "../src/bot/classify.js";

describe("outreach copy", () => {
  it("identifies the sender + brand and carries the opt-out instruction", () => {
    expect(OUTREACH_MESSAGE).toContain("Bibi");
    expect(OUTREACH_MESSAGE).toContain("Gilda.mx");
    expect(OUTREACH_MESSAGE).toMatch(/responde BAJA/);
  });

  it("renderMessage returns the constant body for any prospect", () => {
    expect(renderMessage({ colonia: "SAN PABLO" })).toBe(OUTREACH_MESSAGE);
    expect(renderMessage({ colonia: null })).toBe(OUTREACH_MESSAGE);
  });

  // The integration lock: the opt-out keyword we tell prospects to use MUST be
  // recognized by the receiver's classifier, or an opt-out wouldn't suppress.
  it("the BAJA opt-out keyword is honored by the classifier", () => {
    expect(classifyInbound("BAJA")).toBe("opt_out");
    expect(classifyInbound("baja")).toBe("opt_out");
    expect(classifyInbound("Baja por favor")).toBe("opt_out");
  });
});
