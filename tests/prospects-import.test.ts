import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initDb, resetDbSingleton } from "../src/db/database.js";
import { getFunnelCounts } from "../src/db/models.js";
import {
  detectMapping,
  parseSheetRows,
  loadProspects,
  isForbiddenNumber,
} from "../src/import/prospects-import.js";

const JID_A = "525512345678@s.whatsapp.net";
const JID_B = "525598765432@s.whatsapp.net";

// header row + data rows, with a WA_VALIDO column present
const SHEET_WITH_VALIDO: string[][] = [
  ["nom_estab", "colonia", "telefono", "WA_VALIDO", "WA_JID"],
  ["Estética Bella", "Santa Martha", "5512345678", "SI", JID_A],
  ["Salón Glamour", "San Lorenzo", "5598765432", "SI", JID_B],
  ["No Tiene WA", "X", "5511112222", "NO", "525511112222@s.whatsapp.net"],
  ["Sin Jid", "Y", "5500001111", "SI", ""],
  ["Duplicado", "Santa Martha", "5512345678", "SI", JID_A],
];

describe("detectMapping", () => {
  it("locates name/colonia/phone/wa_jid/wa_valido by header", () => {
    const m = detectMapping(SHEET_WITH_VALIDO[0]);
    expect(m).toEqual({ name: 0, colonia: 1, phone: 2, waValido: 3, waJid: 4 });
  });

  it("reports -1 for an absent column", () => {
    const m = detectMapping(["foo", "bar", "WA_JID"]);
    expect(m.waJid).toBe(2);
    expect(m.colonia).toBe(-1);
    expect(m.waValido).toBe(-1);
  });
});

describe("parseSheetRows", () => {
  it("keeps only SI rows, drops no-jid and in-batch duplicates", () => {
    const { prospects, skipped } = parseSheetRows(SHEET_WITH_VALIDO);
    expect(prospects.map((p) => p.wa_jid)).toEqual([JID_A, JID_B]);
    // NO + sin-jid + duplicado = 3 skips
    expect(skipped).toHaveLength(3);
    expect(skipped.map((s) => s.reason)).toEqual([
      expect.stringContaining("WA_VALIDO"),
      expect.stringContaining("sin WA_JID"),
      expect.stringContaining("duplicado"),
    ]);
  });

  it("populates descriptive fields and a generated id", () => {
    const { prospects } = parseSheetRows(SHEET_WITH_VALIDO);
    const bella = prospects[0];
    expect(bella.name).toBe("Estética Bella");
    expect(bella.colonia).toBe("Santa Martha");
    expect(bella.phone_raw).toBe("5512345678");
    expect(bella.source).toBe("denue-iztapalapa-2026-06");
    expect(bella.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps all jid rows when no WA_VALIDO column exists", () => {
    const sheet: string[][] = [
      ["nom_estab", "colonia", "telefono", "WA_JID"],
      ["A", "c1", "5512345678", JID_A],
      ["B", "c2", "5598765432", JID_B],
    ];
    const { prospects } = parseSheetRows(sheet);
    expect(prospects).toHaveLength(2);
  });

  it("falls back to wa_jid for phone_raw when phone cell is empty", () => {
    const sheet: string[][] = [
      ["nom_estab", "colonia", "WA_JID"],
      ["A", "c1", JID_A],
    ];
    const { prospects } = parseSheetRows(sheet);
    expect(prospects[0].phone_raw).toBe(JID_A);
  });

  it("throws when there is no WA_JID column", () => {
    expect(() =>
      parseSheetRows([
        ["nombre", "telefono"],
        ["A", "55"],
      ]),
    ).toThrow(/WA_JID/);
  });

  it("throws on an empty sheet", () => {
    expect(() => parseSheetRows([])).toThrow();
    expect(() => parseSheetRows([["only", "headers"]])).toThrow();
  });
});

describe("forbidden-number guardrail", () => {
  const PERSONAL = "5530331051"; // operator personal — ban-catastrophic
  const BOT = "5640501088"; // salones-wa product/bot — never outreach

  it.each([
    [`52${PERSONAL}@s.whatsapp.net`, "525511112222"],
    [`521${PERSONAL}@s.whatsapp.net`, "5500001111"],
    [`52${BOT}@s.whatsapp.net`, "5512345678"],
  ])("flags %s as forbidden via the jid", (jid, phone) => {
    expect(isForbiddenNumber(jid, phone)).toBe(true);
  });

  it("flags a protected number that only appears in the phone column", () => {
    expect(
      isForbiddenNumber("525599998888@s.whatsapp.net", `55 ${BOT.slice(2)}`),
    ).toBe(false); // sanity: a different number is allowed
    expect(isForbiddenNumber("525599998888@s.whatsapp.net", PERSONAL)).toBe(
      true,
    );
  });

  it("allows an ordinary prospect number", () => {
    expect(isForbiddenNumber(JID_A, "5512345678")).toBe(false);
  });

  it("drops protected rows from a parsed sheet (never imported)", () => {
    const sheet: string[][] = [
      ["nom_estab", "colonia", "telefono", "WA_VALIDO", "WA_JID"],
      ["Cliente OK", "Santa Martha", "5512345678", "SI", JID_A],
      ["Mi Personal", "X", PERSONAL, "SI", `52${PERSONAL}@s.whatsapp.net`],
      ["Bot Gilda", "Y", BOT, "SI", `52${BOT}@s.whatsapp.net`],
    ];
    const { prospects, skipped } = parseSheetRows(sheet);
    expect(prospects.map((p) => p.wa_jid)).toEqual([JID_A]);
    expect(skipped.filter((s) => s.reason.includes("protegido"))).toHaveLength(
      2,
    );
  });
});

describe("loadProspects (idempotency)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = initDb(":memory:");
  });
  afterEach(() => {
    resetDbSingleton();
  });

  it("inserts on first load, updates on re-load — never duplicates", () => {
    const { prospects } = parseSheetRows(SHEET_WITH_VALIDO);

    const first = loadProspects(db, prospects);
    expect(first).toEqual({ inserted: 2, updated: 0 });

    const second = loadProspects(db, prospects);
    expect(second).toEqual({ inserted: 0, updated: 2 });

    expect(getFunnelCounts(db).total).toBe(2);
  });
});
