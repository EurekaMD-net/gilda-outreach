# P1 — Kickoff (START HERE next session)

> **Gate: P1 needs a physical SIM in a phone to link the Baileys session.** Do
> not start until the operator has the dedicated outreach SIM ready to scan a
> pairing code. Everything below is buildable once that's in hand.

**Repo state at P1 entry:** `EurekaMD-net/gilda-outreach`, `origin/main` `5ecd4e8`,
85 tests green, `OUTREACH_ENABLED=false`. P0 (scaffold + schema + import) and P2
(receiver logic) are **done and tested**; P1 only adds the live socket + web
surface and wires the already-built, already-tested receiver to it.

**Full design:** `OUTREACH-SENDER-SPEC.md` — lives in the **salones-wa** repo at
`docs/OUTREACH-SENDER-SPEC.md` (commit `8527798`). §4 = receiver contract, §6 =
watchdog policy.

**Why this service is isolated (do not collapse into salones-wa):** the outreach
number is the most ban-prone thing in the stack. A flag/logout/ban on its socket
must never touch the booking bot's event loop or session map. Different number →
different Baileys session → no dual-socket conflict.

---

## The build (in order)

### 1. Wire the integration seam (already built — just connect it)

The receiver is done: `src/bot/receiver.ts` exports
`handleInboundMessage(db, inbound, opts)` where
`inbound: { jid, body, waMsgId? }` and `opts: { onAlert? }`. The Baileys
`messages.upsert` listener must:

- extract text from `message.conversation ?? message.extendedTextMessage?.text ?? ""`,
- build `{ jid, body, waMsgId }`,
- call `handleInboundMessage(db, { jid, body, waMsgId }, { onAlert })`.

`onAlert(alert)` delivers the **interested-lead** alert (`{ prospectId, name,
jid, body }`) to the **operator** channel — personal WA via the salones-wa bot,
or Telegram — **never** back to the outreach number. (See Open Decision #3.)

### 2. Reuse from salones-wa (copy, do not reinvent)

- `src/bot/baileys-manager.ts` — pairing-code link + connection-generation guard
  - liveness watchdog.
- `src/web/auth.ts` — timing-safe token compare + per-IP rate limiter + clientIp.
- `src/web/observability.ts` — `GET /health` + `GET /metrics` (ADMIN_TOKEN-gated).
- Bind **127.0.0.1:8087** (`PORT` in `env.example`). Do not open a firewall port.

### 3. Watchdog INVERSION (spec §6) — the critical difference

salones-wa's watchdog aggressively self-heals a stuck socket. **Outreach does the
opposite:** a session that goes `logged_out` / 401 is a **probable ban** →
**HALT + alert the operator loudly, do NOT auto-reconnect** (reconnecting a
banned number digs the hole deeper). Reconnect only on transient/network drops.

### 4. `/metrics` to expose (token-gated, Prometheus)

`outreach_session_up`, `outreach_sent_total`, `outreach_replies_total`,
`outreach_opted_out_total`, `outreach_failed_total`, `outreach_daily_sent`.

### 5. Install the daemon

`gilda-outreach.service` is in the repo (mirrors salones-wa.service: tsx,
`User=gilda-outreach`, `EnvironmentFile=.env`, port 8087, `Restart=always`).
It is **not installed at P0** because `src/index.ts` exits immediately (would
crash-loop). Install only once the socket makes it a real long-running daemon:

```
sudo cp gilda-outreach.service /etc/systemd/system/
sudo useradd -r -s /usr/sbin/nologin gilda-outreach   # if absent
sudo systemctl daemon-reload && sudo systemctl enable --now gilda-outreach
```

Keep `OUTREACH_ENABLED=false` and set `OUTREACH_BLOCKLIST=<personal line>` in
`.env` (gitignored — never in committed source). The product/bot line
`5640501088` is already blocked by default in code.

### 6. Run the live prospect import (operator, pre-warm)

Once before warming, import the 277 validated prospects (read-only against the
sheet; only writes are local SQLite, so a bad run is reversible via
`rm data/outreach.db`). Dry-run first:

```
env $(grep -E 'GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GOOGLE_REFRESH_TOKEN' \
  /root/claude/mission-control/.env | xargs) npm run import-prospects -- --dry-run
```

---

## Open decisions — confirm with operator before warming

1. **Brand WA profile name** for the outreach number.
2. **Landing CTA** → confirm it points to the brand/product number, not the
   outreach number.
3. **Reply-alert channel** for `onAlert` — personal WA via the salones-wa bot, or
   Telegram. (Drives step 1's wiring.)

Repo visibility is **RESOLVED** (public, 2026-06-07).

---

## After P1

P3 sender (cron + ramp + cap + jitter + business-hours window + kill switch) →
P4 status page + daily summary + mc-prometheus scrape/alert → P5 end-to-end
dry-run → warm SIM 3–5 days → ramp live. **Never flip `OUTREACH_ENABLED=true`
before the SIM is warmed (P5).**
