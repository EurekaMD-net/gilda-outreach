# Campaign go-live runbook — first outreach campaign

**Status 2026-06-14:** number `+522205847098` **RE-LINKED** (shadow, double-locked,
zero sends). **Gate-1 audit PASSED + banked** (see `LEARNINGS.md §6`). Egress
decision **DEFERRED** — operator chose shadow-only this round. Resume at the Gate-0
result → egress fork.

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
RATE_LIMIT_ENABLED=true   # currently DORMANT — MUST enable for live
```

Watch: deliverability, replies, blocks/reports, **and session survival**.

### Gate 4 — Phased ramp

Only if the canary survives **and** converts acceptably → ramp **5→40 per
active-send-day**, re-checking ban-watch + reply-rate + block/report at each step;
back off on any adverse signal.

## Safety floor (always on)

halt-gate (`logged_out → HALT, no retry`), liveness watchdog, opt-out gate
(permanent `opted_out`), at-most-once, Jarvis ban-watch on `127.0.0.1:8087`.

## Cleanup when the new session is trusted stable

The dead pre-relink session is preserved at `data/sessions.dead-20260613-relink`
(gitignored) for rollback — delete it once the re-linked session has held a clean
stretch.
