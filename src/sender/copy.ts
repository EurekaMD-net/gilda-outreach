/**
 * The approved cold-outreach message (variant B — "Bibi, de Gilda.mx").
 *
 * Kept as a single constant so a copy edit is one place. The body is constant —
 * "en tu colonia" is generic, not a per-prospect token — so renderMessage()
 * ignores the prospect for now; the parameter is the seam for future
 * personalization (e.g. by colonia/giro) without touching call sites.
 *
 * INVARIANT: the opt-out instruction ("responde BAJA") must stay. The receiver's
 * classifier (bot/classify.ts) maps a "baja" reply to `opt_out`, which suppresses
 * the prospect permanently — locked by a test. Cold outreach is unsolicited, so
 * every message must carry a working opt-out and identify the sender.
 *
 * Text is the operator's approved copy (2026-06-10), with two accent corrections
 * applied before go-live: "tu colonia" (possessive determiner, no accent) and
 * "mientras tú estás" (subject pronoun, accented).
 */
export const OUTREACH_MESSAGE =
  "Hola 👋 Te escribo de Gilda.mx, soy Bibi, mucho gusto! Estamos ayudando a " +
  "algunos salones en tu colonia a organizar mejor su agenda con un asistente " +
  "que contesta y agenda citas por WhatsApp mientras tú estás atendiendo a tus " +
  "clientas. ¿Te gustaría que te cuente rápido cómo funciona? Si prefieres que " +
  "no te escriba, responde BAJA. ¡Nos encantará ayudarte!";

/** Render the outbound message for a prospect. Constant today; seam for later. */
export function renderMessage(_prospect: { colonia: string | null }): string {
  return OUTREACH_MESSAGE;
}
