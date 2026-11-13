// Shared best-effort redaction for diagnostic text that leaves a machine:
// runtime session transcripts (daemon), runner log tails (daemon feedback tier
// 2, Computer diagnostics push), and the agent context view (daemon, counted
// mode below). One rule set, consumed by every producer, so a gap found on one
// surface is closed on all of them at once (task #272; the daemon transcript
// path previously had its own four-rule list that let a bare JWT through).
//
// Two output modes over the SAME rules:
// - `redactDiagnosticText`: every hit becomes `***REDACTED***`, plus identity
//   masking (emails, home paths) and URL handling per `urls`. Feedback surfaces.
// - `redactDiagnosticSecrets`: every hit becomes a `«redacted:<kind>»` marker and
//   is counted per kind; URL queries and URL credentials are masked, identity
//   (paths, emails) is left alone. The agent context view (agentContextView.ts).
//
// This is a SCRUBBER, not a guarantee. It masks the credential shapes we know
// about; callers must still gate any new upload surface on the machine owner's
// explicit opt-in and say so in the consent copy.
import { makeIsMember } from "./typeGuards";

export interface DiagnosticRedactionOptions {
  /**
   * `query` (default) keeps the URL origin/path and masks query, user and
   * password — enough to debug routing. `drop` replaces the whole URL with
   * `[url]`, which the transcript path has always done.
   */
  urls?: "query" | "drop";
}

const MASK = "***REDACTED***";

/**
 * What a rule caught, as counted by `redactDiagnosticSecrets`. Additive only:
 * a new rule may add a kind, a kind is never renamed or removed, because
 * counts keyed by it cross the wire (the agent context view's `redactions`).
 */
export const DIAGNOSTIC_REDACTION_KINDS = [
  "private_key",
  "raft_key",
  "bearer",
  "authorization",
  "vendor_key",
  "github_token",
  "aws_key",
  "google_api_key",
  "xai_key",
  "jwt",
  "secret_assignment",
  "hex_blob",
  "url_query",
  "url_credentials",
] as const;
export type DiagnosticRedactionKind = (typeof DIAGNOSTIC_REDACTION_KINDS)[number];
export const isDiagnosticRedactionKind = makeIsMember(DIAGNOSTIC_REDACTION_KINDS);

/** Per-kind counts of what was replaced; a kind with no hit is absent. */
export type DiagnosticRedactionCounts = Partial<Record<DiagnosticRedactionKind, number>>;

/** The text that replaces one caught secret in counted mode: `«redacted:<kind>»`. */
export function diagnosticRedactionMarker(kind: DiagnosticRedactionKind): string {
  return `«redacted:${kind}»`;
}

// Any marker, for moving a count when a later rule swallows an earlier marker.
const MARKER_PATTERN = /«redacted:([a-z_]+)»/g;

interface SecretRule {
  kind: DiagnosticRedactionKind;
  re: RegExp;
}

// Order matters only where a later rule could match the replacement text;
// none of these match `***REDACTED***`, `[url]` or a `«redacted:<kind>»`
// marker on its own. A later rule may still swallow an earlier replacement
// inside a larger match (an Authorization header whose Bearer value was
// already masked); counted mode then moves the count to the later kind, so the
// counts always equal the markers left in the text.
const SECRET_RULES: readonly SecretRule[] = [
  // PEM private key blocks (multi-line), before any single-line rule could eat
  // a fragment of them.
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // Orphan PEM markers, fail-closed (XX, task #263). A complete block is masked
  // by the rule above, so anything still carrying a marker is unpaired: the file
  // was mid-write when it was read, or rotation/truncation cut the block. Either
  // way the base64 body is live key material and must not survive.
  // BEGIN with no END: mask to the end of the text.
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g },
  // END with no BEGIN: mask from the start of the text to that marker.
  { kind: "private_key", re: /^[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // Raft-issued keys.
  { kind: "raft_key", re: /sk_[a-z]+_[A-Za-z0-9._-]+/g },
  { kind: "raft_key", re: /sap_[A-Za-z0-9_-]+/g },
  // Bearer tokens and any Authorization header value, with or without a scheme.
  { kind: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { kind: "authorization", re: /\bAuthorization\s*[:=]\s*["']?[^\s"',;]+/gi },
  // Common vendor key shapes.
  { kind: "vendor_key", re: /\b(?:sk|sk-ant|sk-proj|xox[baprs]?)-[A-Za-z0-9_-]{8,}\b/g },
  // GitHub tokens (classic ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_).
  { kind: "github_token", re: /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g },
  { kind: "github_token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  // AWS access key ids and any *secret*/*token*/*password*/*key* assignment,
  // including snake_case names such as aws_secret_access_key.
  // IAM AccessKeyId: the public API contract allows 16–128 chars; issued ids
  // are usually 20 today, but the rule must not encode "usually". Covers the
  // documented unique-id prefixes for access keys and STS temporary keys.
  { kind: "aws_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{12,124}\b/g },
  // Google API keys: documented shape is "AIza" + 35 URL-safe chars (39 total).
  // Trailing lookahead instead of \b: the last char may be `-` or `_`, and a
  // `-` before a space is not a word boundary (XX, #7792 review).
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  // xAI API keys: "xai-" prefix; exact length is not published, so this is a
  // lower bound on the shape (Kabi, #263 R6: shape unverified against a spec).
  { kind: "xai_key", re: /\bxai-[A-Za-z0-9]{20,}\b/g },
  // Bare JWT / JWS (base64url header, no Bearer prefix).
  { kind: "jwt", re: /\beyJ[A-Za-z0-9._-]{20,}/g },
  // key=value style secrets in logs and config echoes.
  // Quotes may be JSON-escaped (`\"`) when the text is itself embedded in a
  // JSON transcript record, so the quote run tolerates backslashes.
  { kind: "secret_assignment", re: /\b[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password|passwd)[A-Za-z0-9_.-]*[\\"']*\s*[:=]\s*[\\"']*[^\s"',;\\]{4,}/gi },
  // Environment-style names ending in _TOKEN or _KEY (HF_TOKEN=, STRIPE_KEY=),
  // which the rule above misses unless the name also says api/access/auth.
  // Upper case only: lower-case `sort_key: name` / `cache_key = id` are data.
  { kind: "secret_assignment", re: /\b[A-Z][A-Z0-9_]*_(?:TOKEN|KEY)\b[\\"']*\s*[:=]\s*[\\"']*[^\s"',;\\]{4,}/g },
  // Long hex blobs (hashes, raw keys).
  { kind: "hex_blob", re: /\b[A-Fa-f0-9]{40,}\b/g },
];

// Applied after the secret rules so a masked value inside a path stays masked.
const IDENTITY_PATTERNS: readonly RegExp[] = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\/Users\/[^\s"'<>:]+(?:\/[^\s"'<>:]+)*/g,
  /\/home\/[^\s"'<>:]+(?:\/[^\s"'<>:]+)*/g,
  /[A-Za-z]:\\Users\\[^\s"'<>:]+(?:\\[^\s"'<>:]+)*/g,
];

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.search) url.search = "?[REDACTED_QUERY]";
    if (url.username) url.username = "[REDACTED_USER]";
    if (url.password) url.password = "[REDACTED_PASSWORD]";
    return url.toString();
  } catch {
    return value.replace(/\?.*$/, "?[REDACTED_QUERY]");
  }
}

export function redactDiagnosticText(text: string, options: DiagnosticRedactionOptions = {}): string {
  const urls = options.urls ?? "query";
  let out = text.replace(URL_PATTERN, (url) => (urls === "drop" ? "[url]" : redactUrl(url)));
  for (const rule of SECRET_RULES) out = out.replace(rule.re, MASK);
  for (const re of IDENTITY_PATTERNS) out = out.replace(re, MASK);
  return out;
}

export interface DiagnosticSecretRedaction {
  text: string;
  /** Markers left in `text`, per kind. Empty when nothing was caught. */
  counts: DiagnosticRedactionCounts;
}

/**
 * Counted mode: the same secret rules as `redactDiagnosticText`, each hit
 * replaced by `diagnosticRedactionMarker(kind)` and counted. A URL keeps its
 * origin and path; its query becomes `?«redacted:url_query»` and any user or
 * password `«redacted:url_credentials»@`. Paths and emails are NOT masked
 * (the context view needs file paths to be readable). Callers redacting many
 * strings sum the counts with `addDiagnosticRedactionCounts`.
 */
export function redactDiagnosticSecrets(text: string): DiagnosticSecretRedaction {
  const counts: DiagnosticRedactionCounts = {};
  const hit = (kind: DiagnosticRedactionKind, swallowed: string): string => {
    for (const inner of swallowed.matchAll(MARKER_PATTERN)) {
      const innerKind = inner[1];
      if (!isDiagnosticRedactionKind(innerKind)) continue;
      const current = counts[innerKind] ?? 0;
      if (current <= 1) delete counts[innerKind];
      else counts[innerKind] = current - 1;
    }
    counts[kind] = (counts[kind] ?? 0) + 1;
    return diagnosticRedactionMarker(kind);
  };
  let out = text.replace(URL_PATTERN, (value) => redactUrlCounted(value, (kind) => hit(kind, "")));
  for (const rule of SECRET_RULES) out = out.replace(rule.re, (match) => hit(rule.kind, match));
  return { text: out, counts };
}

function redactUrlCounted(value: string, hit: (kind: DiagnosticRedactionKind) => string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    const queryAt = value.indexOf("?");
    return queryAt < 0 ? value : `${value.slice(0, queryAt)}?${hit("url_query")}`;
  }
  const hasCredentials = Boolean(url.username || url.password);
  if (!hasCredentials && !url.search) return value;
  const userinfo = hasCredentials ? `${hit("url_credentials")}@` : "";
  const query = url.search ? `?${hit("url_query")}` : "";
  return `${url.protocol}//${userinfo}${url.host}${url.pathname}${query}${url.hash}`;
}

/** `into` plus `more`, per kind; neither argument is changed. */
export function addDiagnosticRedactionCounts(
  into: DiagnosticRedactionCounts,
  more: DiagnosticRedactionCounts,
): DiagnosticRedactionCounts {
  const sum: DiagnosticRedactionCounts = { ...into };
  for (const kind of DIAGNOSTIC_REDACTION_KINDS) {
    const add = more[kind];
    if (add) sum[kind] = (sum[kind] ?? 0) + add;
  }
  return sum;
}
