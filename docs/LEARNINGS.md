# gilda-outreach — operational doctrine & learnings

Non-obvious decisions a future reader/agent needs. Status lives in the README;
this file is the _why_. Last updated 2026-06-17.

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

## 6. Re-linking after a restriction / fingerprint sweep (2026-06-14)

A linked-device `conflict`/`device_removed`/401 — plain logout **or** a temporary
account restriction — is **recoverable, and the recovery variable is TIME, not
infrastructure**. The outreach number +522205847098 was restricted 2026-06-11
(5h timer + "cuenta restringida") _during a ZERO-send shadow run_ — detection was
the connection fingerprint (Baileys + VPS IP), not content. ~3 days later it
**re-linked on the FIRST attempt, same VPS IP, no proxy** (the temp restriction
had simply lapsed). The product bot recovered identically.

- **2 failures ≠ a permanent wall when the hidden variable is a cooldown.** Don't
  declare an architectural block from a short retry burst; space attempts ~15–20
  min (mirrors the global `transient-vs-permanent-failure` rule).
- **Proxy/aged-number is a HEDGE against re-sweep, NOT a prerequisite to re-link.**
  Linking from the VPS is proven for both numbers. The open risk after a re-link
  is **STABILITY** (could be re-swept over hours/days), not recovery. Meta Cloud
  API stays HARD-RULED-OUT (unit economics).
- **Clean-slate re-link procedure (makes it one-shot):**
  1. Move the dead session aside (`data/sessions/` → `data/sessions.dead-<date>`)
     so Baileys can't resume invalidated creds (→ instant 401); pre-create an
     empty `data/sessions` owned by the service user at `0700` so start can't trip
     on perms.
  2. `systemctl reset-failed` (the halt leaves the unit `failed`).
  3. Set/confirm the double lock (`OUTREACH_MODE` off|shadow + `OUTREACH_ENABLED`
     off) BEFORE start — the boot echo `sender mode=… (nothing leaves)` is the
     verification that nothing can send during the fragile window.
  4. `systemctl start` → on a fresh (unregistered) session Baileys auto-requests
     the pairing code (`⇣ PAIRING CODE: <code>`, rotates ~50s). Pre-stage the
     phone on the code-entry screen, fetch the **latest** code, enter in-window.
  5. Verify `connected ✅ (<number>)` + `creds.json` written (post-pair 515 is
     normal). Watch ~hours for a re-sweep (the 2026-06-11 sweep hit ~3h in); the
     halt-gate + watchdog fail safe.
- **Re-link ≠ go-live.** Recovery links in `shadow`/locked to prove the session
  SURVIVES before any outbound; going live is a separate, later decision (see
  `CAMPAIGN-GO-LIVE.md`).

### Gate-1 send-logic audit (2026-06-14) — VERIFIED, banked

Full code+data audit of the send path PASSED: `isHalted()` is the first send gate;
at-most-once selects only `pending` (a real send advances status, `opted_out`
excluded); daily cap (`rampCapForDay`) + send window + jittered gap are enforced,
not just logged; blocklist is a **runtime** send-time `isForbiddenNumber` re-check
vs `OUTREACH_BLOCKLIST` (env, captured at boot → restart to change it); the opt-out
classifier deliberately handles the JS `\b`-ASCII-accent bug. Data: 296 `pending`,
0 duplicate phones/jids, all 10-digit. **One known data flag, LEFT AS-IS by operator
decision:** `NADIA NAILS` wa_jid `525613268054` is `52`-prefixed (missing the mobile
`1`) vs the other 295 `521…` — self-limiting (bounces to `last_error`, no ban),
1/296.

## 7. Canary RESULT (2026-06-17) — one cold send → PERMANENT ban. Pilot paused.

The same-IP 5-send canary ran. **Gate-0 passed** (number held the session 3.5 days,
17/17 clean reconnects, zero logout). Flipped live 18:04 UTC; **first LIVE send**
(18:05:50, ACADEMIA BYU) went out — and **within 2 seconds** the session fell into a
sustained `code=403 Connection Failure` reconnect loop (6+ in 2 min, 0 recovery,
`up:false`), a signature never seen in 3.5 days of soak. The phone then showed
**"Esta cuenta no puede usar WhatsApp"** — a **permanent account ban**. The number is
dead. **One cold message killed it.**

**What it means for this codebase:**

- The send-side discipline (ban-averse halt, ramp, window, at-most-once, humanized
  cadence — §1–§6) is **correct but operates a layer above where the ban happened**.
  WA banned the _account_ on (probably) the **cold-send behavior** itself, not just the
  egress fingerprint. **A proxy is necessary-but-not-sufficient** — it fixes IP, not
  "you messaged a stranger." (Caveat: this number was pre-flagged Jun 11, so it's a
  confounded read; a fresh number + proxy _might_ last longer — but burns numbers.)
- **Bug to fix before any retry:** `classifyDisconnect` (`baileys-manager.ts`) latches
  HALT only on **401**. A sustained **403 "Connection Failure"** is treated as
  `reconnect` → infinite 5s storm against a banned number (worst possible anti-ban
  behavior; had to `systemctl stop` to end it). Treat repeated 403-in-a-window as a
  probable block → hard backoff / HALT.
- **Operator decision: PAUSE + reassess** (not "get a proxy and retry"). Likely pivot if
  outreach continues: **first touch off cold-WhatsApp** (SMS/email/IG/call), WA only
  after the prospect opts in — i.e. make it inbound, like the salones-wa product bot,
  which never gets banned. Meta Cloud API stays ruled out (unit economics).
