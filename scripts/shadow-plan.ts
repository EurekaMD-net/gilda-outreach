/**
 * Shadow plan — what the sender WOULD do today (window-independent), for review
 * before going live. Read-only: opens the DB read-only so it's safe to run while
 * the daemon holds it and never touches file ownership.
 *
 *   npm run shadow-plan        (or: tsx scripts/shadow-plan.ts)
 */
import Database from "better-sqlite3";
import { planToday } from "../src/sender/sender.js";
import { loadRamp } from "../src/sender/ramp.js";
import { loadWindowCfg } from "../src/sender/window.js";
import { getFunnelCounts } from "../src/db/models.js";
import { jidToNumber, tail10 } from "../src/util/phone.js";

const DB_PATH = process.env["DB_PATH"] ?? "./data/outreach.db";
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const plan = planToday(db);
const funnel = getFunnelCounts(db);
const ramp = loadRamp();
const win = loadWindowCfg();

console.log("═══════════ Outreach shadow plan ═══════════");
console.log(`Mode:        ${plan.mode}`);
console.log(`MX day:      ${plan.day}`);
console.log(
  `Window:      Mon–Fri ${win.startHour}:00–${win.endHour}:00 (America/Mexico_City)`,
);
console.log(`Ramp:        [${ramp.join(", ")}] (holds last)`);
console.log(
  `Today:       prior send-days=${plan.priorSendDays} ⇒ cap=${plan.cap}, sent=${plan.sentToday}, remaining=${plan.remaining}`,
);
console.log(`Queue:       ${funnel.pending} pending / ${funnel.total} total`);

// Rough projection: business-days to clear the pending queue at this ramp.
let left = funnel.pending;
let days = 0;
let idx = plan.priorSendDays;
while (left > 0 && days < 400) {
  left -= ramp[Math.min(idx, ramp.length - 1)]!;
  days++;
  idx++;
}
console.log(`Projection:  ~${days} send-days (Mon–Fri) to clear the queue.`);

console.log("\n─────────── Message that would be sent ───────────");
console.log(plan.message);

console.log(
  `\n─────────── Today's ${plan.batch.length} recipients ───────────`,
);
plan.batch.forEach((p, i) => {
  const num = tail10(jidToNumber(p.wa_jid));
  const colonia = p.colonia ?? "(sin colonia)";
  const name = p.name ?? "";
  console.log(
    `${String(i + 1).padStart(3)}. ${num}  ${colonia}  ${name}`.trimEnd(),
  );
});

if (plan.mode === "off") {
  console.log(
    "\nNote: OUTREACH_MODE=off — the daemon's sender is dormant. This is just the plan.",
  );
}

db.close();
