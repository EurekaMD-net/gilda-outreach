# gilda-outreach

Cold-outreach **sender** for the Gilda.mx pilot — a ban-safe WhatsApp campaign
run from a **dedicated** number, deliberately isolated from the `salones-wa`
product bot. Full design: [`docs/OUTREACH-SENDER-SPEC.md`](../salones-wa/docs/OUTREACH-SENDER-SPEC.md)
(lives in the salones-wa repo).

> **Why a separate service?** The outreach number is the most ban-prone thing in
> the stack. A flag/logout/ban on the outreach socket must never touch the
> booking bot's event loop, session map, or restart lifecycle. Different number =
> different Baileys session = no dual-socket conflict.

## Status — P0–P2 ✅ · P1 **LIVE** (number linked) · P3 sender **SHADOW** (`OUTREACH_MODE=shadow`, nothing sends)

The number is linked and connected; **296 prospects imported** (`pending`). The
P3 sender is running in **shadow** — it logs would-sends (selection + pacing +
ramp + window) but **never touches WhatsApp**. Going live additionally requires
`OUTREACH_MODE=live` **and** `OUTREACH_ENABLED=true` (a second lock), flipped only
after the shadow day is reviewed. 177 tests, all green (`npm test`).

| Phase  | Deliverable                                                     | State                                                             |
| ------ | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| **P0** | Scaffold + DB schema + import validated prospects (dedupe jid)  | **done** (296 imported)                                           |
| **P1** | Baileys session + pairing link + `/health` + `/metrics`         | **LIVE** — number linked + connected, daemon installed            |
| **P2** | Receiver: inbound capture, opt-out, interested flag, drop-queue | **done** (wired to the live socket)                               |
| **P3** | Sender: cron + ramp + cap + jitter + window + kill switch       | **SHADOW** (logs would-sends); live gated on review + double lock |
| P4     | Status page + daily summary + mc-prometheus scrape/alert        | pending                                                           |
| P5     | End-to-end shadow → warm SIM 3–5 days → ramp live               | pending                                                           |

### Sender (P3) — how it's controlled

`OUTREACH_MODE` = `off` (default, no sender) · `shadow` (logs would-sends, never
sends) · `live` (sends — **and** requires `OUTREACH_ENABLED=true`, a second lock).
Every send is gated by: the mode, the **send window** (Mon–Fri 10–18 MX), the
**daily ramp cap** (`5,8,12,15,20,25,30,35,40`, advances per active send-day), a
**jittered min-gap** (never bursty), the session **not being halted** (probable
ban), and a **send-time blocklist re-check**. Sends are **at-most-once**: an
uncertain send (error/timeout) marks the prospect `failed` and is never retried.

Preview today's batch without sending (read-only, window-independent):

```bash
npm run shadow-plan        # cap, recipients, rendered message, projection
```

To run for real, in order: (1) warm the number; (2) `OUTREACH_MODE=shadow` →
review a day of would-sends; (3) `OUTREACH_MODE=live` + `OUTREACH_ENABLED=true`.

### P1 runtime — what's new

- **`src/bot/baileys-manager.ts`** — single outreach session. Pairing-code link,
  generation fence, **inverted** recovery: a transient drop reconnects, but a WA
  `logout`/401 is a **probable ban → latch HALTED + alert, never auto-reconnect**.
  The `messages.upsert` handler feeds the receiver and **never auto-replies** to a
  cold lead.
- **`src/bot/session-state.ts`** — single-session conn-state registry + pure
  health + the inverted watchdog planner (recovers a stuck _transient_ socket;
  never touches a `logged_out`/halted one; gives up + halts after the strike cap).
- **`src/alert/channel.ts`** — operator alerts (interested-lead + session-halted).
  Always logs to journald; **also** pushes to Telegram if `OUTREACH_ALERT_TELEGRAM_*`
  are set in `.env` (open decision #3 — a pure env flip, no code change).
- **`src/web/{auth,observability}.ts`** — public `GET /health` (no PII) + token-gated
  `GET /metrics`, `GET /health/session` (session + funnel + day), and `GET /leads`
  (warm-lead triage feed, PII), bound to **127.0.0.1:8087**. `/leads` +
  `/health/session` are the durable read path for the operator / Jarvis: a WAL DB's
  `-wal`/`-shm` files are recreated at mode `600` each restart, so a `chmod` on the
  file can't be shared durably — the loopback HTTP seam can.

### P1 — link + run (operator)

```bash
cd /root/claude/projects/gilda-outreach
# 1. .env: set OUTREACH_NUMBER (the SIM's full intl number, digits only),
#    ADMIN_TOKEN (≥16 random chars), OUTREACH_BLOCKLIST (personal line).
#    Keep OUTREACH_ENABLED=false. (See env.example.)
# 2. Install + start the daemon:
sudo cp gilda-outreach.service /etc/systemd/system/
sudo useradd -r -s /usr/sbin/nologin gilda-outreach   # if absent
sudo systemctl daemon-reload && sudo systemctl enable --now gilda-outreach
# 3. Read the pairing code from the log and enter it on the SIM's phone:
journalctl -u gilda-outreach -f      # → "⇣ PAIRING CODE: XXXX-XXXX"
#    WhatsApp → Dispositivos vinculados → Vincular con número de teléfono.
# 4. Confirm linked + healthy:
curl -s localhost:8087/health                                 # {"ok":true,"up":true,...}
curl -s "localhost:8087/metrics?token=$ADMIN_TOKEN" | grep session_up
# 5. Import the validated prospects (read-only vs the sheet; see below).
```

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
    baileys-manager.ts  single outreach session: pairing link, gen fence,
                     inverted close-handler, messages.upsert -> receiver (P1)
    session-state.ts conn-state registry + health + inverted watchdog plan (P1)
  alert/
    channel.ts       operator alerts: journald always + env-gated Telegram (P1)
  web/
    auth.ts          ADMIN_TOKEN: timing-safe compare + per-IP rate limiter (P1)
    observability.ts public /health + token-gated /metrics + /health/session (P1)
  util/
    phone.ts         MX number normalization + jid helpers (tail10)
    time.ts          mxDayKey: MX-local 'YYYY-MM-DD' (daily_sends key) (P1)
  index.ts           P1 daemon: DB + web surface + session + watchdog + SIGTERM
scripts/
  import-prospects.ts  CLI: fetch sheet (googleapis) -> parse -> load
tests/                 phone, prospects-import, models, classify, receiver,
                       session-state, baileys-helpers, baileys-manager-guard,
                       alert-channel, observability, time  (130 tests)
gilda-outreach.service systemd unit (install at P1 — see runbook above)
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
