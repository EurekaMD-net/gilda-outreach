/**
 * Phone / WhatsApp-JID helpers. Kept identical in spirit to the salones-wa
 * validation script's normalizer so the imported numbers match the JIDs that
 * were validated there.
 */

/**
 * Normalize a Mexican phone string to a bare WA number (country code + 10
 * digits), or null if it doesn't look like a valid MX mobile.
 *
 *   "55 1234 5678"   -> "525512345678"
 *   "+52 55 ..."     -> "525512345678"
 *   "521 55 ..."     -> "5215512345678" (kept as-is; some lines carry the 1)
 *   "12345"          -> null
 */
export function normalizeToWA(phone: string): string | null {
  const clean = phone.replace(/[\s\-()+]/g, "");
  if (/^52\d{10}$/.test(clean)) return clean;
  if (/^521\d{10}$/.test(clean)) return clean;
  if (/^\d{10}$/.test(clean)) return "52" + clean;
  return null;
}

/**
 * Strip a WhatsApp JID down to its bare number.
 *   "525512345678@s.whatsapp.net" -> "525512345678"
 * Returns the trimmed input unchanged if it has no "@".
 */
export function jidToNumber(jid: string): string {
  const at = jid.indexOf("@");
  return (at === -1 ? jid : jid.slice(0, at)).trim();
}
