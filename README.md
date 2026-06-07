# gilda-outreach

Cold-outreach **sender** for the Gilda.mx pilot — a ban-safe WhatsApp campaign
run from a **dedicated** number, deliberately isolated from the `salones-wa`
product bot. Full design: [`docs/OUTREACH-SENDER-SPEC.md`](../salones-wa/docs/OUTREACH-SENDER-SPEC.md)
(lives in the salones-wa repo).

> **Why a separate service?** The outreach number is the most ban-prone thing in
> the stack. A flag/logout/ban on the outreach socket must never touch the
> booking bot's event loop, session map, or restart lifecycle. Different number =
> different Baileys session = no dual-socket conflict.

## Status — P0 (scaffold) ✅

This repo currently implements **Phase 0** only: project scaffold, the SQLite
schema, the prospect models, and the (operator-run) import of the validated
prospect list. **No Baileys session, no web server, and no sender exist yet** —
nothing can message anyone. `OUTREACH_ENABLED` defaults to `false`. 36 tests,
all green (`npm test`).

| Phase  | Deliverable                                                     | State               |
| ------ | --------------------------------------------------------------- | ------------------- |
| **P0** | Scaffold + DB schema + import validated prospects (dedupe jid)  | **done**            |
| P1     | Baileys session + pairing link + `/health` + `/metrics`         | pending (needs SIM) |
| P2     | Receiver: inbound capture, opt-out, interested flag, drop-queue | pending             |
| P3     | Sender: cron + ramp + cap + jitter + window + kill switch       | pending             |
| P4     | Status page + daily summary + mc-prometheus scrape/alert        | pending             |
| P5     | End-to-end dry-run → warm SIM 3–5 days → ramp live              | pending             |

## Layout

```
src/
  db/
    schema.ts        SQLite DDL (prospects, messages, daily_sends)
    database.ts      getDb / initDb / resetDbSingleton singleton
    models.ts        prospect upsert (jid-deduped), funnel counts, queries
  import/
    prospects-import.ts  pure parse (header detect, filter, dedupe) + load
  util/
    phone.ts         MX number normalization + jid helpers
  index.ts           P0 bootstrap: open DB, print funnel, exit
scripts/
  import-prospects.ts  CLI: fetch sheet (googleapis) -> parse -> load
tests/                 phone, prospects-import, models + schema integrity
gilda-outreach.service systemd unit (NOT installed until P1)
```

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
- The personal number `5530331051` and the product/bot number `5640501088` are
  **never** used for outreach. This is **enforced in code**, not just policy:
  the import (`isForbiddenNumber`, the sole P0 ingress) drops any row resolving
  to either number — prefix-agnostic, checked against both the JID and the raw
  phone column. This service targets a separate, dedicated SIM.
- Cold outreach is unsolicited — keep volume low, personalized, business-hours,
  always with an opt-out line, and honor opt-outs permanently.
