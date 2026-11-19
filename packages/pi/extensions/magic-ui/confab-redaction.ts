/** Short cloud credential names need separator boundaries (do not match task/mask). */
export const cloudCredentialField = /^(?:[\w.-]{1,128}[_.-])?(?:ak|sk)$/i;

const cloudCredentialAssignment = /(\b(?:[\w.-]{1,128}[_.-])?(?:ak|sk)["']?\s*[:=]\s*)(?:"[^"\\]*(?:\\.[^"\\]*)*(?:"|$)|'[^']*(?:'|$)|`[^`]*(?:`|$)|[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)/gi;

/** Shared rules: keep local scrubbing and cross-block detection in sync. */
const rules: readonly (readonly [RegExp, string])[] = [
  [/\b(?:authorization|proxy-authorization)\s*[:=]\s*[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gi, "[REDACTED AUTH]"],
  [/(\b[\w.-]{0,128}(?:password|passwd|secret|token|key|auth)[\w.-]{0,128}["']?\s*[:=]\s*)(?:"[^"\\]*(?:\\.[^"\\]*)*(?:"|$)|'[^']*(?:'|$)|`[^`]*(?:`|$)|[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)/gi, "$1[REDACTED]"],
  [cloudCredentialAssignment, "$1[REDACTED]"],
  [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=~-]+/gi, "[REDACTED AUTH]"],
  [/\b(?:sk-[A-Za-z0-9_-]{8,}|cfb_[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16}|LTAI[A-Za-z0-9]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[REDACTED TOKEN]"],
];

/** Collect AK/SK assignment values so repeated positional CLI arguments are scrubbed too. */
export function cloudCredentialValues(text: string): string[] {
  const values = new Set<string>();
  for (const match of text.matchAll(cloudCredentialAssignment)) {
    const raw = match[0].slice(match[1].length).trim();
    const quote = raw[0];
    const value = /["'`]/.test(quote ?? "")
      ? raw.slice(1, raw.endsWith(quote) ? -1 : undefined)
      : raw.split(/[\s;|&]/, 1)[0];
    if (value && !value.startsWith("[REDACTED")) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

export function redactCredentialCopies(text: string, values: readonly string[]): string {
  for (const value of values) text = text.split(value).join("[REDACTED CREDENTIAL]");
  return text;
}

/** PEM delimiters are public. Consume payload lines, not arbitrary transcript text
 * until END/EOF. Support ordinary and JSON-escaped line breaks in tool output. */
export function visitPemBody(text: string, visit: (start: number, end: number) => void) {
  const begin = /-----BEGIN [A-Z0-9][A-Z0-9 -]*-----[ \t]*(?:\r?\n|\\r\\n|\\n)/g;
  const line = /[ \t]*(?!---)(?:[A-Za-z0-9+/=_-]+|(?:Proc-Type|DEK-Info):[^\r\n\\]*)?[ \t]*(?=\r?\n|\\r\\n|\\n|-----END |$)/y;
  const newline = /(?:\r?\n|\\r\\n|\\n)/y;
  for (const marker of text.matchAll(begin)) {
    let pos = marker.index! + marker[0].length;
    while (pos < text.length) {
      line.lastIndex = pos;
      const hit = line.exec(text);
      if (!hit) break;
      if (hit[0].trim()) visit(pos, line.lastIndex);
      newline.lastIndex = line.lastIndex;
      if (!newline.exec(text)) break;
      pos = newline.lastIndex;
    }
  }
}

/** Heuristics, NOT an assurance that all secrets or personal data are removed. */
export function redact(text: string): string {
  const values = cloudCredentialValues(text);
  let offset = 0;
  const parts: string[] = [];
  visitPemBody(text, (start, end) => {
    parts.push(text.slice(offset, start), "[REDACTED PEM]"); offset = end;
  });
  if (parts.length) text = parts.join("") + text.slice(offset);
  for (const [pattern, replacement] of rules) text = text.replace(pattern, replacement);
  return redactCredentialCopies(text, values);
}

/** Report original-input offsets, never offsets in replacement text.
 * Scan every rule independently: overlaps are deliberately conservative.
 */
export function visitSecretSpans(text: string, visit: (start: number, end: number) => void) {
  for (const [pattern] of rules) {
    for (const match of text.matchAll(pattern)) visit(match.index!, match.index! + match[0].length);
  }
}
