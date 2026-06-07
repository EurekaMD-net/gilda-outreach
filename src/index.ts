/**
 * gilda-outreach — service entry point.
 *
 * P0 scope (current): open the DB, apply the schema, report the funnel, exit.
 * There is NO Baileys session, NO web server, and NO sender yet — those arrive
 * in later phases (see docs/OUTREACH-SENDER-SPEC.md §9):
 *   P1 = Baileys session + pairing link + /health + /metrics
 *   P2 = receiver (inbound capture, opt-out, drop-from-queue)
 *   P3 = sender (cron + ramp + cap + jitter + kill switch)
 *
 * Because this is not yet a long-running daemon, the systemd unit
 * (gilda-outreach.service) is intentionally NOT installed until P1.
 */
import { getDb } from "./db/database.js";
import { getFunnelCounts } from "./db/models.js";

const DB_PATH = process.env["DB_PATH"] ?? "./data/outreach.db";
const OUTREACH_ENABLED = process.env["OUTREACH_ENABLED"] === "true";

function main(): void {
  const db = getDb(DB_PATH);
  const f = getFunnelCounts(db);

  console.log("[gilda-outreach] DB ready:", DB_PATH);
  console.log(
    `[gilda-outreach] funnel: total=${f.total} pending=${f.pending} ` +
      `sent=${f.sent} replied=${f.replied} interested=${f.interested} ` +
      `opted_out=${f.opted_out} failed=${f.failed}`,
  );

  if (f.total === 0) {
    console.log(
      "[gilda-outreach] no prospects yet — run: npm run import-prospects " +
        "(see env.example for credential sourcing).",
    );
  }

  // Loud reminder: the kill switch can be flipped on, but no sender exists yet.
  if (OUTREACH_ENABLED) {
    console.warn(
      "[gilda-outreach] WARNING: OUTREACH_ENABLED=true but the sender is not " +
        "built yet (P3). No messages will be sent.",
    );
  }

  console.log("[gilda-outreach] P0 scaffold ok. Sender phases pending.");
}

main();
