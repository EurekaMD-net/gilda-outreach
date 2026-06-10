/**
 * Off-number alert delivery for the outreach pilot.
 *
 * Two alert kinds flow through ONE channel:
 *  - interested-lead — a cold prospect signalled interest. A HUMAN takes over by
 *    hand; we never auto-pitch from the bot.
 *  - session-halted — the outreach session went logged_out/401 (probable ban) or
 *    the watchdog gave up. The operator must check and (maybe) manually re-link.
 *
 * The channel ALWAYS writes a loud line to stderr/journald — the durable audit
 * trail you watch during link + warm-up. If BOTH
 * OUTREACH_ALERT_TELEGRAM_BOT_TOKEN and OUTREACH_ALERT_TELEGRAM_CHAT_ID are set
 * in .env it ALSO pushes to Telegram, the off-console ping for live operation.
 * Switching the real channel on is therefore a pure env flip — no code change
 * (open-decision #3, deferrable to warm / P5).
 *
 * CRITICAL: an alert is delivered to the OPERATOR, never back to the outreach
 * number. There is NO path in this module that replies to a prospect.
 *
 * Delivery is best-effort and NON-THROWING by contract: a failed Telegram push
 * must never crash the inbound handler or the connection watchdog that called
 * it. Failures are logged and swallowed; journald still has the record.
 */

export type OutreachAlertEvent =
  | {
      kind: "interested-lead";
      prospectId: string;
      name: string | null;
      jid: string;
      body: string;
    }
  | { kind: "session-halted"; reason: string };

export interface AlertChannel {
  /** Deliver an alert to the operator. Never throws. */
  send(event: OutreachAlertEvent): Promise<void>;
}

/** Cap the echoed prospect body so a long inbound can't bloat the alert. */
function clip(s: string, max = 500): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Render an alert as a plain-text title + body (no markup → no escaping traps). */
export function formatAlert(event: OutreachAlertEvent): {
  title: string;
  body: string;
} {
  if (event.kind === "interested-lead") {
    return {
      title: "🔥 OUTREACH: prospecto interesado",
      body: [
        `Prospecto: ${event.name ?? "(sin nombre)"}`,
        `JID: ${event.jid}`,
        `Mensaje: ${clip(event.body)}`,
        "",
        "Acción: contesta TÚ a mano. El bot NO responde leads en frío.",
      ].join("\n"),
    };
  }
  return {
    title: "⛔ OUTREACH: sesión DETENIDA (posible bloqueo)",
    body: [
      `Motivo: ${event.reason}`,
      "",
      "La sesión de outreach se detuvo y NO se reconecta sola (anti-ban).",
      "Revisa los logs y re-vincula a mano sólo si procede.",
    ].join("\n"),
  };
}

/** Loud journald line. interested-lead → log; session-halted → error. */
function logToConsole(event: OutreachAlertEvent): void {
  const { title, body } = formatAlert(event);
  const line = `[ALERT] ${title}\n${body}`;
  if (event.kind === "session-halted") console.error(line);
  else console.log(line);
}

/** POST to Telegram sendMessage. Returns false (never throws) on any failure. */
async function sendTelegram(
  botToken: string,
  chatId: string,
  event: OutreachAlertEvent,
): Promise<boolean> {
  const { title, body } = formatAlert(event);
  const text = `${title}\n\n${body}`;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      },
    );
    if (!res.ok) {
      console.error(
        `[alert] Telegram push failed: HTTP ${res.status} ${res.statusText}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[alert] Telegram push error: ${(err as Error)?.message ?? String(err)}`,
    );
    return false;
  }
}

/**
 * Build the operator alert channel from the environment.
 *
 * Always logs to journald. If both Telegram env vars are present, also pushes to
 * Telegram (and logs whether that push succeeded). Returns a channel whose
 * `send` never throws.
 */
export function createAlertChannel(
  env: NodeJS.ProcessEnv = process.env,
): AlertChannel {
  const botToken = env["OUTREACH_ALERT_TELEGRAM_BOT_TOKEN"]?.trim();
  const chatId = env["OUTREACH_ALERT_TELEGRAM_CHAT_ID"]?.trim();
  const telegramOn = Boolean(botToken && chatId);

  if (telegramOn) {
    console.log("[alert] operator channel: journald + Telegram");
  } else {
    console.log(
      "[alert] operator channel: journald only " +
        "(set OUTREACH_ALERT_TELEGRAM_BOT_TOKEN + _CHAT_ID to add Telegram)",
    );
  }

  return {
    async send(event: OutreachAlertEvent): Promise<void> {
      // Journald first — the durable record exists even if Telegram is down.
      logToConsole(event);
      if (telegramOn) {
        await sendTelegram(botToken!, chatId!, event);
      }
    },
  };
}
