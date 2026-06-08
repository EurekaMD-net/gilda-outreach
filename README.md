# gilda-outreach

Cold-outreach **sender** for the Gilda.mx pilot — a ban-safe WhatsApp campaign
run from a **dedicated** number, deliberately isolated from the `salones-wa`
product bot. Full design: [`docs/OUTREACH-SENDER-SPEC.md`](../salones-wa/docs/OUTREACH-SENDER-SPEC.md)
(lives in the salones-wa repo).

> **Why a separate service?** The outreach number is the most ban-prone thing in
> the stack. A flag/logout/ban on the outreach socket must never touch the
> booking bot's event loop, session map, or restart lifecycle. Different number =
> different Baileys session = no dual-socket conflict.

## Status — P0–P2 done ✅ · P1 next (needs SIM → [`docs/P1-KICKOFF.md`](docs/P1-KICKOFF.md))

This repo implements **Phases 0–2**: project scaffold, the SQLite schema, the
prospect models, the (operator-run) import of the validated prospect list, and
the **receiver** (inbound reply handling — classification, status transitions,
drop-from-queue, operator alert). **There is still NO Baileys session, no web
server, and no sender** — nothing can message anyone, and the receiver's pure
handler is not yet wired to a live socket (that's P1). `OUTREACH_ENABLED`
defaults to `false`. 85 tests, all green (`npm test`).

| Phase  | Deliverable                                                     | State                                                             |
| ------ | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| **P0** | Scaffold + DB schema + import validated prospects (dedupe jid)  | **done**                                                          |
| P1     | Baileys session + pairing link + `/health` + `/metrics`         | **next** — [`docs/P1-KICKOFF.md`](docs/P1-KICKOFF.md) (needs SIM) |
| **P2** | Receiver: inbound capture, opt-out, interested flag, drop-queue | **done** (logic; socket waits on P1)                              |
| P3     | Sender: cron + ramp + cap + jitter + window + kill switch       | pending                                                           |
| P4     | Status page + daily summary + mc-prometheus scrape/alert        | pending                                                           |
| P5     | End-to-end dry-run → warm SIM 3–5 days → ramp live              | pending                                                           |

## Layout

```
src/
  db/
    schema.ts        SQLite DDL (prospects, messages, daily_sends)
    database.ts      getDb / initDb / resetDbSingleton singleton
    models.ts        prospect upsert (jid-deduped), funnel, messages, status,
                     inbound-reply bookkeeping, jid->prospect matching
  import/
    prospects-import.ts  pure parse (header detect, filter, dedupe, blocklist) + load
  bot/
    classify.ts      pure opt-out / interested regex heuristics (no LLM)
    receiver.ts      handleInboundMessage: socket-free reply handler (P2)
  util/
    phone.ts         MX number normalization + jid helpers (tail10)
  index.ts           P0 bootstrap: open DB, print funnel, exit
scripts/
  import-prospects.ts  CLI: fetch sheet (googleapis) -> parse -> load
tests/                 phone, prospects-import, models, classify, receiver
gilda-outreach.service systemd unit (NOT installed until P1)
```

## Receiver (P2) — how inbound replies are handled

`handleInboundMessage(db, { jid, body, waMsgId? }, { onAlert? })` is a **pure,
socket-free** handler. The P1 Baileys `messages.upsert` listener will call it per
inbound message; until then it is exercised entirely by unit tests. Contract:

- Only individual-user JIDs (`@s.whatsapp.net`) are handled — groups/broadcasts
  are ignored (a group's last 10 digits could otherwise tail-match a prospect).
- Unknown number → ignored, no writes. Known prospect → inbound logged,
  `reply_count++`, `first_reply_at` stamped once.
- **Any** reply drops the prospect from the send queue. Opt-out phrasing →
  `opted_out` (permanent). Interested signal → `interested` + **one** operator
  alert (delivered off-number by P1/P4; never an auto-pitch). Else → `replied`.

## Data model (SQLite, `data/outreach.db`)

- **prospects** — one row per number, `UNIQUE(wa_jid)` dedupe key, status state
  machine (`pending → queued → sent → replied → {interested|…|converted}`).
- **messages** — full in/out conversation log, `ON DELETE CASCADE` from prospect.
- **daily_sends** — per-day (MX time) send counter; enforces ramp + cap, survives
  restart.

## Importing the validated prospects (operator-run)

The validated list lives in a Google Sheet. The import is **read-only** against
Google (it only reads the sheet); the only writes are to the local SQLite DB, so
a bad run is reversible (`rm data/outreach.db`). It dedupes on `wa_jid`, so it is
**idempotent** — safe to re-run.

Credentials are sourced from mission-control's `.env` at run time (never stored
in this repo):

```bash
cd /root/claude/projects/gilda-outreach
npm install

# Dry run first — prints the detected column mapping + counts, writes nothing:
env $(grep -E 'GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GOOGLE_REFRESH_TOKEN' \
  /root/claude/mission-control/.env | xargs) npm run import-prospects -- --dry-run

# Live import:
env $(grep -E 'GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GOOGLE_REFRESH_TOKEN' \
  /root/claude/mission-control/.env | xargs) npm run import-prospects
```

Source sheet: `PROSPECTS_SHEET_ID` (default = the Gilda validated-prospects
export, `1o3jjUyGIlpvlB1waINnUs7nFeBR3k3fworPH_xF550Y`).

## Develop

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest run
npm start             # P0 bootstrap: opens DB, prints funnel summary
```

## Guardrails (carried from the spec)

- **`OUTREACH_ENABLED=false` by default.** No send path even exists yet.
- Protected numbers are **never** messaged — **enforced in code**, not just
  policy: the import (`isForbiddenNumber`, the sole ingress) drops any row
  resolving to a blocked number (prefix-agnostic, checked against both the JID
  and the raw phone column). The product/bot line `5640501088` is blocked by
  default; the operator's **personal line is supplied via `OUTREACH_BLOCKLIST`
  in the gitignored `.env`** — deliberately never in committed source. This
  service targets a separate, dedicated SIM.
- Cold outreach is unsolicited — keep volume low, personalized, business-hours,
  always with an opt-out line, and honor opt-outs permanently.
