/**
 * import-prospects.ts
 *
 * Loads the validated WA prospects from the Google Sheet into outreach.db.
 * Read-only against Google (only reads the sheet); the only writes are to the
 * LOCAL SQLite DB, so a bad run is reversible (delete data/outreach.db).
 *
 * Idempotent: dedupes on wa_jid, so re-running never duplicates a number and
 * never resets campaign progress. Safe to run repeatedly.
 *
 * Credentials are sourced from mission-control's .env at run time (never stored
 * in this repo). Usage:
 *
 *   env $(grep -E 'GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GOOGLE_REFRESH_TOKEN' \
 *     /root/claude/mission-control/.env | xargs) npm run import-prospects
 *
 *   ... import-prospects -- --dry-run     # fetch + parse + print, no DB writes
 *   ... import-prospects -- --limit=10    # only the first N parsed prospects
 */
import { google } from "googleapis";
import { getDb } from "../src/db/database.js";
import { getFunnelCounts } from "../src/db/models.js";
import {
  parseSheetRows,
  loadProspects,
  loadBlocklist,
} from "../src/import/prospects-import.js";

const SHEET_ID =
  process.env["PROSPECTS_SHEET_ID"] ??
  "1o3jjUyGIlpvlB1waINnUs7nFeBR3k3fworPH_xF550Y";
const SHEET_NAME = process.env["PROSPECTS_SHEET_NAME"] ?? "Sheet1";
const DB_PATH = process.env["DB_PATH"] ?? "./data/outreach.db";

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT_ARG = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = LIMIT_ARG ? Number.parseInt(LIMIT_ARG.split("=")[1]!, 10) : null;
if (LIMIT !== null && (!Number.isFinite(LIMIT) || LIMIT <= 0)) {
  console.error(
    `--limit inválido: "${LIMIT_ARG}". Debe ser un entero positivo (p.ej. --limit=10).`,
  );
  process.exit(1);
}

async function fetchSheetValues(): Promise<string[][]> {
  const clientId = process.env["GOOGLE_CLIENT_ID"];
  const clientSecret = process.env["GOOGLE_CLIENT_SECRET"];
  const refreshToken = process.env["GOOGLE_REFRESH_TOKEN"];
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Faltan credenciales Google. Ejecuta con:\n" +
        "  env $(grep -E 'GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GOOGLE_REFRESH_TOKEN' " +
        "/root/claude/mission-control/.env | xargs) npm run import-prospects",
    );
  }
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:Z`,
  });
  return (res.data.values ?? []) as string[][];
}

async function main(): Promise<void> {
  console.log(`\n📥 Import de prospectos → gilda-outreach`);
  console.log(`   Sheet: ${SHEET_ID} (${SHEET_NAME})`);
  console.log(`   Modo:  ${DRY_RUN ? "DRY RUN (sin escribir DB)" : "LIVE"}`);
  if (LIMIT) console.log(`   Limit: primeros ${LIMIT}`);

  const blocklist = loadBlocklist();
  console.log(`   Blocklist activa: ${blocklist.size} número(s) protegido(s).`);
  if (!process.env["OUTREACH_BLOCKLIST"]) {
    console.warn(
      "   ⚠️  OUTREACH_BLOCKLIST no está en el entorno — solo el número bot " +
        "por defecto está protegido. Añade tu línea personal en .env.",
    );
  }

  const values = await fetchSheetValues();
  const { mapping, prospects, skipped } = parseSheetRows(
    values,
    undefined,
    blocklist,
  );

  console.log(`\n   Mapping de columnas detectado:`);
  console.log(
    `     name=${mapping.name} colonia=${mapping.colonia} ` +
      `phone=${mapping.phone} wa_jid=${mapping.waJid} wa_valido=${mapping.waValido}`,
  );
  console.log(`   Prospectos parseados: ${prospects.length}`);
  console.log(`   Filas saltadas:       ${skipped.length}`);
  if (prospects[0]) {
    const s = prospects[0];
    console.log(
      `   Muestra: ${s.name ?? "(sin nombre)"} | ${s.colonia ?? "-"} | ${s.wa_jid}`,
    );
  }

  const toLoad = LIMIT ? prospects.slice(0, LIMIT) : prospects;

  if (DRY_RUN) {
    console.log(
      `\n   (DRY RUN — nada se escribió. ${toLoad.length} listos para importar.)`,
    );
    return;
  }

  const db = getDb(DB_PATH);
  const { inserted, updated } = loadProspects(db, toLoad);
  const funnel = getFunnelCounts(db);

  console.log(
    `\n   ✅ Importados: ${inserted} nuevos, ${updated} actualizados`,
  );
  console.log(`   📊 Total en DB: ${funnel.total} (pending=${funnel.pending})`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
