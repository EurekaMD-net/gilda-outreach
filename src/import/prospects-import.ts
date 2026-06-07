import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { upsertProspect, type ProspectImport } from "../db/models.js";
import { jidToNumber } from "../util/phone.js";

export const DEFAULT_SOURCE = "denue-iztapalapa-2026-06";

/** Last 10 digits of a number, ignoring 52/521 prefixes and any formatting. */
function tail10(num: string): string {
  const digits = num.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * Numbers that must NEVER enter the outreach pipeline. The product/bot line
 * (`5640501088`, a public business number) is a hardcoded baseline so the guard
 * is never accidentally empty. The operator's PERSONAL line is deliberately NOT
 * in source — add it (and any others) via the `OUTREACH_BLOCKLIST` env var
 * (comma-separated), which lives only in the gitignored `.env`. The import is
 * the sole ingress, so the invariant is enforced here. See OUTREACH-SENDER-SPEC §1.
 */
const DEFAULT_BLOCKLIST = ["5640501088"];

/** Build the active blocklist (10-digit tails) from the default + env. */
export function loadBlocklist(
  env: Record<string, string | undefined> = process.env,
): ReadonlySet<string> {
  const extra = (env["OUTREACH_BLOCKLIST"] ?? "")
    .split(",")
    .map((s) => tail10(s))
    .filter((s) => s.length > 0);
  return new Set([...DEFAULT_BLOCKLIST.map(tail10), ...extra]);
}

/** True if either the JID or the raw phone resolves to a blocked number. */
export function isForbiddenNumber(
  wa_jid: string,
  phone_raw: string,
  blocklist: ReadonlySet<string>,
): boolean {
  return [jidToNumber(wa_jid), phone_raw].some((v) => blocklist.has(tail10(v)));
}

/** Result of mapping the sheet headers to the columns we care about. */
export interface HeaderMapping {
  name: number;
  colonia: number;
  phone: number;
  waJid: number;
  waValido: number;
}

export interface ParseResult {
  mapping: HeaderMapping;
  prospects: ProspectImport[];
  skipped: Array<{ rowIndex: number; reason: string }>;
}

const COL_PATTERNS = {
  name: /nombre|negocio|estab|raz[oó]n|due[ñn]|propietari|titular|nom_estab/i,
  colonia: /colonia|asenta|barrio|nom_asent/i,
  phone: /tel[eé]fono|phone|celular|m[oó]vil|movil|cel\b|whatsapp(?!_)/i,
  waJid: /wa_jid|whatsapp_jid/i,
  waValido: /wa_valido|wa_valid|whatsapp_valido/i,
} as const;

function findCol(headers: string[], re: RegExp): number {
  return headers.findIndex((h) => re.test((h ?? "").toString()));
}

export function detectMapping(headers: string[]): HeaderMapping {
  return {
    name: findCol(headers, COL_PATTERNS.name),
    colonia: findCol(headers, COL_PATTERNS.colonia),
    phone: findCol(headers, COL_PATTERNS.phone),
    waJid: findCol(headers, COL_PATTERNS.waJid),
    waValido: findCol(headers, COL_PATTERNS.waValido),
  };
}

const cell = (row: string[], idx: number): string =>
  idx >= 0 ? (row[idx] ?? "").toString().trim() : "";

/**
 * Turn raw sheet values (row 0 = headers) into importable prospects.
 *
 * Rules:
 *  - A row needs a non-empty wa_jid (the dedupe + send key). No jid -> skipped.
 *  - If a WA_VALIDO column exists, only rows marked "SI" are kept (the sheet may
 *    be the source sheet rather than the pre-filtered export). If the column is
 *    absent we assume the sheet is already the validated export and keep all.
 *  - In-batch duplicate wa_jids are collapsed to the first occurrence.
 *
 * Pure: no DB, no network — unit-testable with fixture values. The blocklist
 * defaults to the env-derived set (`loadBlocklist()`); tests pass an explicit one.
 */
export function parseSheetRows(
  values: string[][],
  source: string = DEFAULT_SOURCE,
  blocklist: ReadonlySet<string> = loadBlocklist(),
): ParseResult {
  if (!values || values.length < 2) {
    throw new Error("Sheet vacío o sin filas de datos");
  }
  const headers = values[0].map((h) => (h ?? "").toString());
  const mapping = detectMapping(headers);

  if (mapping.waJid < 0) {
    throw new Error(
      `No se encontró columna WA_JID. Headers: ${headers.join(", ")}`,
    );
  }

  const prospects: ProspectImport[] = [];
  const skipped: Array<{ rowIndex: number; reason: string }> = [];
  const seenJids = new Set<string>();

  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const rowIndex = i + 1; // 1-based sheet row (header = row 1)

    if (mapping.waValido >= 0) {
      const valid = cell(row, mapping.waValido).toUpperCase();
      if (valid !== "SI") {
        skipped.push({ rowIndex, reason: `WA_VALIDO != SI ("${valid}")` });
        continue;
      }
    }

    const wa_jid = cell(row, mapping.waJid);
    if (!wa_jid) {
      skipped.push({ rowIndex, reason: "sin WA_JID" });
      continue;
    }

    const phone_raw = cell(row, mapping.phone);
    if (isForbiddenNumber(wa_jid, phone_raw, blocklist)) {
      skipped.push({ rowIndex, reason: "número protegido (no-outreach)" });
      continue;
    }

    if (seenJids.has(wa_jid)) {
      skipped.push({ rowIndex, reason: `duplicado en lote (${wa_jid})` });
      continue;
    }
    seenJids.add(wa_jid);

    prospects.push({
      id: randomUUID(),
      name: cell(row, mapping.name) || null,
      colonia: cell(row, mapping.colonia) || null,
      phone_raw: phone_raw || wa_jid,
      wa_jid,
      source,
    });
  }

  return { mapping, prospects, skipped };
}

export interface LoadResult {
  inserted: number;
  updated: number;
}

/**
 * Upsert parsed prospects into the DB inside a single transaction. Idempotent
 * via upsertProspect's wa_jid dedupe. Pure DB I/O — no network.
 */
export function loadProspects(
  db: Database.Database,
  prospects: ProspectImport[],
): LoadResult {
  let inserted = 0;
  let updated = 0;
  const run = db.transaction((rows: ProspectImport[]) => {
    for (const p of rows) {
      if (upsertProspect(db, p) === "inserted") inserted++;
      else updated++;
    }
  });
  run(prospects);
  return { inserted, updated };
}
