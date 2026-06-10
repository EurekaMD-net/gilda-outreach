# gilda-outreach — operational doctrine & learnings

Non-obvious decisions a future reader/agent needs. Status lives in the README;
this file is the _why_. Last updated 2026-06-10 (`ebb312a`).

## 1. Ban-averse inversion — the core philosophy (spec §6)

This service is the **inverse** of the salones-wa product bot. salones-wa
aggressively self-heals a stuck socket (staying connected is the goal).
gilda-outreach sends cold messages from a dedicated, **ban-prone** SIM, so a WA
`logout`/401 is a **probable ban → latch HALTED + alert the operator, NEVER
auto-reconnect**. Only transient/network drops (428/515/connection-lost)
reconnect.

- **Invert at EVERY reconnect seam, gate at the chokepoint.** Three seams each
  honor the inversion — (1) close-handler verdict (`classifyDisconnect`), (2)
  watchdog planner (`planOutreachWatchdogTick`), (3) the orphaned reconnect
  `setTimeout` (generation-fenced) — and all funnel through a single
  `if (isHalted()) throw` at the top of `initOutreachSession`. When N paths can
  trigger a dangerous action, gate the shared sink, not the N sources.
- **Onboarding carve-out:** a 401 is a ban ONLY for an already-**registered**
  session. During initial pairing (unregistered) a 401 just means "not linked
  yet" → keep cycling pairing codes. `decideClose(statusCode, registered)` gates
  the halt on `creds.registered`. A "X = danger → stop" rule must carve out the
  bootstrap state where X is normal.

## 2. Shadow → live cadence + the double lock

`OUTREACH_MODE` = `off` | `shadow` | `live`. **`live` additionally requires
`OUTREACH_ENABLED=true`** — two independent flags, so a single misconfig can't
message anyone. Cadence: warm the number → `shadow` (review a day of would-sends)
→ `live`. Day-1 ramp cap is intentionally low (5); ramp `5,8,12,…,40` advances
per **active send-day**, not per calendar day.

- **At-most-once sends.** An uncertain send (error or 30s timeout — we can't know
  if WA delivered) marks the prospect `failed` and is **never retried**.
  Under-sending one stranger is fine; double-messaging is a ban trigger.
- **Reentrancy latch.** The tick loop (`setInterval` → `await sendMessage`) guards
  with `ctx.inFlight`; a stalled send must not let the next tick re-select the
  same still-`pending` prospect and double-send. Advance the pacing clock BEFORE
  the await.
- **Opt-out is load-bearing.** The copy instructs "responde BAJA"; a test locks
  that the receiver's classifier maps `BAJA → opt_out`, or opt-outs would
  silently stop suppressing.

## 3. Sharing data with Jarvis — HTTP endpoint, NOT a file ACL

Jarvis (monitor/analyst) needs the funnel + warm-lead detail. **Do not `chmod`
the DB file.** Two reasons:

1. **WAL sidecar churn.** `outreach.db` is WAL-mode; a reader needs `-wal` and
   `-shm` too, and the daemon **recreates those at mode 600 on every
   restart/checkpoint** — any `chmod o+r` reverts. A file-ACL grant on a
   live-writer WAL DB is not durable.
2. **PII + least privilege.** The file holds prospect names + numbers.

Instead, the data is published on the existing token-gated, loopback
observability surface (`127.0.0.1:8087`): **`GET /leads`** (warm-lead triage feed)
and **`GET /health/session`** (session + funnel + day + dailySent). DB stays
`600`; works regardless of the caller's uid/sandbox; survives restarts. General
rule: to share a live-writer SQLite DB across a service/privilege boundary, add a
read-only HTTP endpoint, not a file ACL.

## 4. Jarvis is the analyst, NOT the hands

Separate the autonomous brain from the ban-prone hands: the **deterministic
machine pulls the trigger** (the sender); Jarvis is monitor + drafter + downstream
owner. Jarvis is read-only on outreach (public `/health` for the ban-watch — his
single most valuable job; token-gated `/leads` + `/health/session` for detail),
**never operates the send/socket/`.env`, never auto-replies to a cold lead, never
sends from the outreach number.** Role directive:
`jarvis-kb/directives/gilda-outreach-monitor.md`.

- **Token delivery:** the `ADMIN_TOKEN` reaches Jarvis as the env var
  `OUTREACH_ADMIN_TOKEN` in mission-control's `.env` (loaded on restart) — the
  box's cross-service convention. **Never paste a token into a jarvis_file** (the
  KB mirrors to Drive + pgvector = leak); the directive uses `$OUTREACH_ADMIN_TOKEN`
  literally.

## 5. Ops gotchas (this VPS)

- **Claude can't touch `.env`** (secret-guard blocks the Write tool + Bash reads).
  The operator runs `.env` setters via the `!` prefix.
- **`grep` is aliased to `ugrep`** here — multi-line pasted commands mangle. Put
  logic in a script file; use `awk` for `.env` existence checks/readbacks.
- **Never `pkill -f` a generic pattern** (e.g. `tsx src/index.ts`) — it
  substring-matches sibling tsx prod services on the shared box. Use
  `systemctl restart gilda-outreach` (unit-scoped) or a unique token/PID.
- A `systemctl restart` flaps the WA socket, but a **registered** session
  reconnects cleanly (515 → connected) — that is a transient drop, NOT a ban.
  Still: avoid needless restarts on a freshly-warmed number.
