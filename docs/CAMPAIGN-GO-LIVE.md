# Campaign go-live runbook — first outreach campaign

> **⛔ OUTCOME 2026-06-17 — CAMPAIGN PAUSED. Gate-3 FAILED.** The same-IP 5-send canary
> sent **one** live cold message (18:05:50, ACADEMIA BYU); within 2s the session fell
> into a sustained `403 Connection Failure` loop and the phone showed **"Esta cuenta no
> puede usar WhatsApp"** — **permanent account ban**. Number `+522205847098` is dead.
> One cold send killed it. **Verdict:** proxy is necessary-but-NOT-sufficient — the
> trigger is plausibly behavioral (cold-messaging strangers), which a proxy doesn't fix
> (confounder: this number was pre-flagged Jun 11). **Operator decision: pause + reassess**
> (likely pivot first-touch off cold-WA). Do NOT re-run the gates below on this number or
> a fresh one without that reassessment. Full write-up: `LEARNINGS.md §7` +
> memory `outreach-fingerprint-tempban`. The gate runbook below is preserved as the
> historical plan that produced this result.

**Status 2026-06-17:** number `+522205847098` connected since 2026-06-14 00:08 UTC.
**Gate-0 (stability soak) PASSED** — ~3.5 days up, 17 transient drops / 17 clean
reconnects, **zero permanent-logout signals** (no conflict/device_removed/401),
well past the ~3h the Jun-11 sweep hit. **Gate-1 (send-logic) PASSED + banked**
(`LEARNINGS.md §6`). Shadow campaign running clean (double-locked, zero sends). Now
at the **Gate-2 egress fork** (same-IP canary vs proxy-first), with two safety-floor
items to arm first (see below).

## The crux

The 2026-06-11 restriction fired at the **connection fingerprint** (Baileys + VPS
IP), before a single message left. So this is two stacked plans: an **egress-risk**
plan and a **send-logic** plan — content discipline operates a layer _above_ where
detection happened. Counter-signal: the salones-wa **product bot has held a
same-VPS-IP session for days**, so same-IP _can_ hold a connection; the open
question is specifically whether cold-**sending** re-triggers a sweep — cheaply
testable with a tiny canary.

## Gates (each is a go/no-go; a failure is itself decisive data)

### Gate 0 — Stability soak (passive)

Hold `shadow` + double-locked, zero sends, through the window the last sweep hit
(~3h in; clearing 24h = strong signal).

- **Holds** → proceed.
- **Re-swept during a zero-send soak** → decisive: the VPS fingerprint is the wall,
  proxy is **mandatory** before any campaign (learned for free).

### Gate 1 — Send-logic — ✅ DONE / PASS (banked, see `LEARNINGS.md §6`)

Audience (296 salon/barber/nail ICP), copy (variant B, generic, opt-out + sender ID
baked in, accents fixed), at-most-once, daily cap, send window, blocklist, opt-out
classifier — all verified at code+data level. One cosmetic data flag (`NADIA NAILS`
jid) left as-is.

### Gate 2 — Egress decision (operator fork)

**DECIDED 2026-06-17 → Same-IP canary first.** Rationale: Gate-0 proved the VPS IP
holds a connection for days (so the fingerprint/IP is not, by itself, the wall); the
only untested variable is whether cold-_sending_ re-trips a sweep — cheapest to learn
with 5 sends. A sweep here would itself be decisive ("proxy mandatory, learned for
free"); the number is near-expendable. Proxy stays the scale-up hedge, added later.

| Option                   | Trade                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Same-IP canary first** | Cheapest evidence; risks a near-expendable number. If it survives + converts → ramp on VPS IP, add proxy later for scale. If swept → proxy mandatory. |
| **Proxy-first**          | Stand up residential/mobile egress before any live send; addresses the actual detected signal; higher setup cost/time, low risk to the number.        |

Meta WhatsApp Business Cloud API is **HARD-RULED-OUT** (per-conversation pricing
kills unit economics — operator, firm).

### Gate 3 — Live canary (smallest possible)

Flip live at **5 sends**, tightest pacing, business hours (Mon–Fri 10–18 MX), all
guards armed. Operator `.env` (via `!`), then `systemctl restart gilda-outreach`:

```
OUTREACH_MODE=live
OUTREACH_ENABLED=true
```

**True double-lock — only these two.** Rate-limiting in gilda-outreach is
**unconditional / always-on** (code constants `MIN_GAP_MS=90s`, `MAX_GAP_MS=30min`,
the Mon–Fri 10–18 MX window in `window.ts`, and the daily ramp cap in `ramp.ts`,
default `[5,8,12,15,20,25,30,35,40]`). That is exactly why the 30-min shadow
cadence already runs without any extra flag. There is **no `RATE_LIMIT_ENABLED`**
read anywhere in this repo — that var belongs to the separate `salones-wa`
anti-abuse plan; setting it here is a harmless no-op. (Corrected 2026-06-17 after
tracing the live env + source — the earlier "triple-lock" instruction was wrong.)

Watch: deliverability, replies, blocks/reports, **and session survival**.

### Gate 4 — Phased ramp

Only if the canary survives **and** converts acceptably → ramp **5→40 per
active-send-day**, re-checking ban-watch + reply-rate + block/report at each step;
back off on any adverse signal.

## Safety floor

**Always-on (code-verified 2026-06-17):**

- **halt-gate** — a WA logout/401 _on an already-registered session_ →
  `markHalted()`, **no auto-reconnect**, and the sender reads `isHalted()` so all
  sends stop permanently (`baileys-manager.ts` `decideClose`/`markHalted`;
  `sender.ts:197`). A 401 during a _first link_ does **not** false-halt.
- **liveness watchdog** — on by default (`OUTREACH_WATCHDOG_ENABLED !== "false"`).
- **opt-out gate** — `BAJA` → permanent `opted_out` (classifier).
- **at-most-once** — status transitions never re-pick a `sent`/terminal row.

**MUST be armed before the live canary (NOT live as of 2026-06-17):**

- **Ban-watch detector.** The directive `jarvis-kb/directives/gilda-outreach-monitor.md`
  is only the _spec_; **no `scheduled_tasks` job exists yet** — the vigía-ban
  (`GET /health` every ~30 min, alert on `halted:true` / `up:false`) was never
  scheduled. Arm it via Jarvis trigger phrase **"prepara tu rol de gilda-outreach"**
  (Jarvis schedules vigía-ban + daily summary + triage), then confirm a
  `scheduled_tasks` row exists. `/health` needs **no token**.
- **Native HALT push (recommended, independent of Jarvis).** The in-process alert
  is **journald-only** unless `OUTREACH_ALERT_TELEGRAM_BOT_TOKEN` +
  `OUTREACH_ALERT_TELEGRAM_CHAT_ID` are set in gilda-outreach `.env` (operator via
  `!`, then restart). Without these, a HALT is durably logged but nothing pushes to
  a phone. The number is the most ban-prone asset in the stack — arm a direct push.

## Cleanup when the new session is trusted stable

The dead pre-relink session is preserved at `data/sessions.dead-20260613-relink`
(gitignored) for rollback — delete it once the re-linked session has held a clean
stretch.
