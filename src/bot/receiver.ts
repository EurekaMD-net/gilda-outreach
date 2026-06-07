/**
 * Outreach receiver — the inbound side of the pilot. Builds NO socket: this is
 * the pure handler that the P1 Baileys `messages.upsert` listener will call for
 * each inbound message. Keeping it socket-free makes the whole reply-handling
 * contract unit-testable before a SIM is ever linked.
 *
 * Contract (OUTREACH-SENDER-SPEC §4):
 *  - Match the inbound JID to a prospect; ignore messages from unknown numbers.
 *  - Log every inbound to `messages`, bump reply_count, stamp first_reply_at.
 *  - ANY reply drops the prospect from the send queue (status leaves 'pending').
 *  - Opt-out phrasing  -> status 'opted_out' (permanent, never re-messaged).
 *  - Interested signal -> status 'interested' + an operator alert (NO auto-reply;
 *    a human takes over). We never pitch a cold lead from the bot.
 *  - Anything else     -> status 'replied' (needs-attention feed).
 */
import type Database from "better-sqlite3";
import {
  findProspectForInbound,
  insertMessage,
  recordInboundReply,
  setProspectStatus,
  type ProspectStatus,
} from "../db/models.js";
import { classifyInbound, type InboundClass } from "./classify.js";

/** Individual-user WhatsApp JIDs only (not @g.us groups, broadcast, or status). */
const INDIVIDUAL_JID = /@s\.whatsapp\.net$/i;

export interface InboundMessage {
  jid: string;
  body: string;
  waMsgId?: string;
}

/** Raised when a prospect looks interested — delivered to the operator (NOT to
 * the outreach number) by the P1/P4 wiring. */
export interface OutreachAlert {
  prospectId: string;
  name: string | null;
  jid: string;
  body: string;
}

export interface ReceiverResult {
  matched: boolean;
  prospectId?: string;
  classification?: InboundClass;
  /** The prospect's status AFTER handling. */
  status?: ProspectStatus;
  alert?: OutreachAlert;
}

export interface ReceiverOptions {
  /** Called when an interested lead is detected, so the operator can jump in. */
  onAlert?: (alert: OutreachAlert) => void;
}

/**
 * Decide the post-reply status. Opt-out is permanent and wins over everything;
 * an existing opt-out is never upgraded. Interested never downgrades to replied.
 */
function nextStatus(
  current: ProspectStatus,
  cls: InboundClass,
): ProspectStatus {
  if (current === "opted_out") return "opted_out"; // permanent suppression
  if (cls === "opt_out") return "opted_out";
  if (cls === "interested") return "interested";
  // neutral reply: drop from queue, but don't clobber a prior 'interested'.
  return current === "interested" ? "interested" : "replied";
}

export function handleInboundMessage(
  db: Database.Database,
  inbound: InboundMessage,
  opts: ReceiverOptions = {},
): ReceiverResult {
  // Only handle individual-user messages. Groups (@g.us), broadcasts, and
  // status JIDs must never reach prospect matching: a group JID's last 10
  // digits could otherwise tail-match a real prospect and corrupt their state.
  if (!INDIVIDUAL_JID.test(inbound.jid)) return { matched: false };

  const prospect = findProspectForInbound(db, inbound.jid);
  if (!prospect) return { matched: false };

  // Always log + count the inbound, even for an already-opted-out prospect.
  insertMessage(db, {
    prospect_id: prospect.id,
    direction: "in",
    body: inbound.body,
    wa_msg_id: inbound.waMsgId ?? null,
  });
  recordInboundReply(db, prospect.id);

  const classification = classifyInbound(inbound.body);
  const status = nextStatus(prospect.status, classification);
  if (status !== prospect.status) setProspectStatus(db, prospect.id, status);

  let alert: OutreachAlert | undefined;
  // Alert only on a genuine transition INTO interested (not on repeat messages
  // from an already-interested prospect).
  if (status === "interested" && prospect.status !== "interested") {
    alert = {
      prospectId: prospect.id,
      name: prospect.name,
      jid: prospect.wa_jid,
      body: inbound.body,
    };
    opts.onAlert?.(alert);
  }

  return {
    matched: true,
    prospectId: prospect.id,
    classification,
    status,
    alert,
  };
}
