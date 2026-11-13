// An app's error text, safe to show a model: bounded, control characters
// stripped, and anything credential-shaped redacted (same patterns as the
// `raft` CLI). Only a JSON object's `error`/`code` and `hint`/`message`/`detail`
// are kept; HTML and other bodies stay out.

export function redactAppText(value: string, sensitiveValues: readonly string[] = []): string {
  let redacted = value;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) redacted = redacted.replaceAll(sensitiveValue, "<redacted>");
  }
  return redacted
    .replace(/\b(sk_(?:agent|machine|computer|daemon)_)[A-Za-z0-9._-]+/g, "$1<redacted>")
    .replace(/\b(sap_)[A-Za-z0-9._-]+/g, "$1<redacted>")
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+)\b/g, "<redacted>")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "<redacted>")
    .replace(/\b(authorization\s*[:=]\s*)[^\r\n,;]+/gi, "$1<redacted>")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted>")
    .replace(/\b((?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, "$1<redacted>");
}

export interface AppErrorNote {
  code?: string;
  hint?: string;
}

/** The app's own error code and hint from a JSON error body, or null. */
export function appErrorNote(body: unknown, sensitiveValues: readonly string[] = []): AppErrorNote | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const clean = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const printable = redactAppText(value.replace(/[\p{Cc}\p{Cf}]+/gu, ""), sensitiveValues).trim().slice(0, 300);
    return printable.length > 0 ? printable : undefined;
  };
  const code = clean(record.error) ?? clean(record.code);
  const hint = clean(record.hint) ?? clean(record.message) ?? clean(record.detail);
  if (!code && !hint) return null;
  return { code, hint };
}
