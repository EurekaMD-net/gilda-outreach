/**
 * Inbound-reply classification for cold outreach. Pure regex heuristics — no
 * LLM. The receiver uses this to decide a prospect's status and whether to
 * raise an operator alert. We never auto-reply to a cold lead (a human takes
 * over), so this only needs to be good enough to (a) honor opt-outs and (b)
 * surface clearly-interested leads fast.
 */

export type InboundClass = "opt_out" | "interested" | "neutral";

/**
 * Opt-out / "leave me alone" phrasing. Base set lifted from salones-wa's
 * OPT_OUT_PATTERNS, extended per OUTREACH-SENDER-SPEC §4 for cold outreach
 * ("no me interesa", "no gracias", "quién eres", "cómo conseguiste mi número").
 * Bare "quitar"/"no" are deliberately excluded — too common in ordinary replies.
 */
// NOTE: JS `\b` is ASCII-only, so a trailing `\b` after a stem that can take an
// accented suffix mis-anchors (e.g. `\binteresa\b` fails to match "interesaría").
// Where a Spanish verb stem can conjugate, we omit the trailing boundary so the
// suffix ("-ría", "-rá") still matches. Per the ascii-word-boundary-accents rule.
const OPT_OUT_PATTERNS: RegExp[] = [
  /\b(no me mandes|no me env[ií]es|stop|baja|darme de baja|no quiero mensajes|quitar de la lista|quitarme los mensajes)\b/i,
  /\bno\s+me\s+interesa/i, // matches "interesa", "interesaría", "interesará"
  /\bno,?\s+gracias\b/i,
  /\bqui[eé]n\s+(eres|es|habla)\b/i,
  /\bc[oó]mo\s+(conseguiste|obtuviste|sacaste|tienes)\s+mi\s+n[uú]mero\b/i,
  /\bd[eé]jame\s+en\s+paz\b/i,
  /\bno\s+escrib[ae]s?\b/i,
];

/**
 * Light "interested" signal: a price/how-it-works question or an explicit yes.
 * Opt-out is checked first, so "no me interesa" never reaches here.
 */
const INTERESTED_PATTERNS: RegExp[] = [
  /\bcu[aá]nto\b/i, // cuánto cuesta / cuánto es
  /\bcu[aá]nto\s+cuesta\b/i,
  /\bc[oó]mo\s+funciona/i,
  /\b(s[ií])\s+me\s+interesa/i, // "sí me interesaría"
  /\bme\s+interesa/i, // "me interesa", "me interesaría"
  /\b(m[aá]s\s+)?informaci[oó]n\b/i,
  /\bcu[eé]ntame\b/i,
  /\bprecio\b/i,
  /\?\s*$/, // ends in a question mark
];

const matchAny = (text: string, patterns: RegExp[]): boolean =>
  patterns.some((re) => re.test(text));

/**
 * Classify an inbound message body. Opt-out has precedence over interested,
 * which has precedence over neutral. Empty/blank -> neutral.
 */
export function classifyInbound(body: string): InboundClass {
  const t = (body ?? "").trim();
  if (!t) return "neutral";
  if (matchAny(t, OPT_OUT_PATTERNS)) return "opt_out";
  if (matchAny(t, INTERESTED_PATTERNS)) return "interested";
  return "neutral";
}
