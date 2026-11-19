// Shared best-effort redaction for diagnostic text that leaves a machine:
// runtime session transcripts (daemon), runner log tails (daemon feedback tier
// 2, Computer diagnostics push), the agent context view (daemon, counted
// mode below), runtime error text (`scrubRuntimeErrorText`: the telemetry
// excerpt and what managers see) and `raft-computer logs` / `doctor`. One rule
// set, consumed by every producer, so a gap found on one surface is closed on
// all of them at once (task #272; the daemon transcript path previously had its
// own four-rule list that let a bare JWT through, and the runtime error
// scrubber let JSON-quoted keys, Basic auth, JWTs and cloud keys through).
//
// Three output modes over the SAME rules:
// - `redactDiagnosticText`: every hit becomes `***REDACTED***`, plus identity
//   masking (emails, home paths) and URL handling per `urls`. Feedback surfaces.
// - `redactDiagnosticSecrets`: every hit becomes a `«redacted:<kind>»` marker and
//   is counted per kind; URL queries and URL credentials are masked, identity
//   (paths, emails) is left alone. The agent context view (agentContextView.ts).
// - `redactDiagnosticCredentials`: the secret rules alone with the caller's
//   mask, for surfaces that format URLs and identity their own way.
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
  /**
   * The rule's first capture group is a label to keep (`"api_key": "`,
   * `Authorization: Basic `, `--token `); only the rest of the match is
   * replaced, so the text around a secret stays readable.
   */
  keepLabel?: true;
  /**
   * The rule reads layout (a URL's `user:pw@host`, a YAML key line and the
   * indentation under it) that a surface's own formatting passes rewrite: the
   * runtime error scrubber turns `key: v` into `key=[…]` and `pw@host.tld` into
   * an email mask. Such a surface applies these rules first
   * (`structuralOnly`), then the whole catalogue. `"only"`: applied by that
   * first pass alone, because the full catalogue leaves the shape to each
   * surface's own URL handling (http(s) URLs).
   */
  structural?: true | "only";
  /**
   * The rule may span lines (a complete PEM block, a YAML block); a surface
   * that redacts line by line applies these over the joined lines first
   * (`redactDiagnosticCredentialLines`).
   */
  multiline?: true;
}

// Where a shape may start: not inside a word, but right after a literal
// escape (`\n`, `\r`, `\t` in JSON-escaped text) or a URL escape (`%3D`) —
// there `\b` sees `n`/`D` as part of the word and would let the key through.
const LEFT = String.raw`(?:(?<![A-Za-z0-9_])|(?<=\\[nrt])|(?<=%[0-9A-Fa-f]{2}))`;

// Linear by construction, because the server runs these on text it is sent
// (agent context view search, runtime error text): a secret-shaped NAME is read
// from the start of its run of name characters only (the lookbehind), and the
// lookahead finds the secret word inside that run before anything is consumed.
// The earlier `\b[A-Za-z0-9_.-]*(?:WORD)[A-Za-z0-9_.-]*` retried every word
// boundary and every split of a run with no assignment after it: cubic.
// A bare `token` counts only at the END of the name (`id_token`), so
// `max_tokens: 4096` / `token_count = 12` stay readable (`access_token…`,
// `refresh_token…`, `auth_token…` count anywhere, as they always have); `auth` only as a
// quoted key or before `=` (`"auth": "…"`, `HTTP_AUTH=…`), so prose like
// `auth: login required` / `oauth: refresh failed` stays readable.
const SECRET_NAME =
  String.raw`(?<![A-Za-z0-9_.-])(?=[A-Za-z0-9_.-]*?(?:api[_-]?key|access[_-]?key|private[_-]?key|secret|password|passwd|passphrase|credentials?|(?:access|refresh|auth)[_-]?token|token(?=[\\"']*\s*[:=])|auth(?=\\*["']\s*:|\s*=)))[A-Za-z0-9_.-]+`;
// `--api-key <v>`, `--token=<v>`, `--client-secret "<v>"`: the flag word must
// END the flag (`--tokens`, `--auth-type`, `--secret-file` are not secrets).
const SECRET_FLAG =
  String.raw`(?:(?<![A-Za-z0-9_-])|(?<=\\[nrt])|(?<=%[0-9A-Fa-f]{2}))--(?:[A-Za-z0-9]+[-_])*(?:api[-_]?key|access[-_]?key|private[-_]?key|token|password|passwd|passphrase|secret|auth|credentials?)`;
// Case-insensitive spelling for a regex that must stay case-sensitive elsewhere.
const anyCase = (word: string): string => [...word].map((c) => `[${c.toUpperCase()}${c.toLowerCase()}]`).join("");
const AUTH_SCHEME = String.raw`(?:${["Basic", "Bearer", "Digest", "Token", "Negotiate", "NTLM", "Bot"].map(anyCase).join("|")})\s+`;
const AUTHORIZATION = anyCase("Authorization");
// A double/single-quoted value up to its closing UNESCAPED quote: `\"`, `\\`,
// `\/`, `\u0022` and the other quote kind are part of the value, and so is a
// stray quote that cannot close it (followed by a letter or digit, as in
// `"xxxxx"SECRET"`).
const DQ_VALUE = String.raw`(?:\\.|[^"\\\r\n]|"(?=[A-Za-z0-9]))+`;
const SQ_VALUE = String.raw`(?:\\.|[^'\\\r\n]|'(?=[A-Za-z0-9]))+`;
// The same inside text that is itself a JSON string (`{\"password\":\"p\\\"ass\"}`):
// a `\\` pair is one backslash of the inner text, `\"` closes the value.
const ESCAPED_DQ_VALUE = String.raw`(?:\\\\(?:\\.|[^\\\r\n])|\\[^"\\\r\n]|\\"(?=[A-Za-z0-9])|[^"\\\r\n])+`;
// A bare value that is not a JSON literal (`"secret": true`, `"api_key": null`).
// Numbers stay masked: `"password": 1234` is a secret.
const NOT_LITERAL = String.raw`(?!\s)(?!(?:true|false|null)(?![^\s"',;\\}\]]))`;

// Where a URL scheme may start: its own run (no `.`/`+`/`-` before it, so a
// dotted run is read once), or right after a literal escape.
const URL_START = String.raw`(?:(?<![A-Za-z0-9+.-])|(?<=\\[nrt])|(?<=%[0-9A-Fa-f]{2}))`;
// The user of a URL and its `:`. Not a `«` marker: a URL whose userinfo a
// surface already replaced (`git+https://«redacted:url_credentials»@host`) is
// not read again as `user «redacted` with password `url_credentials»`.
const URL_USER = String.raw`[^\s:/?#@"'<>«]*:`;
// The scheme, user and `:` of a non-HTTP connection string, kept as a label;
// http(s) URLs (also right after a literal `\n`) are left to the URL handling
// of each surface.
const CONNECTION_STRING_USER = String.raw`(${URL_START}(?![nrt]?https?:\/\/)[A-Za-z][A-Za-z0-9+.-]*:\/\/${URL_USER})`;
// A URL password that may hold an unencoded `/` or `@`: it ends at the last
// `@` of the authority. Before its first `@` it may hold `/`; after an `@`, a
// `/` ends the authority (`u:pw@db/x?to=alice@corp` is password `pw`, host
// `db`). `?`, `#`, whitespace, a quote and `://` end it too (the authority
// cannot hold them), so each start reads only up to the next `://` and a run
// of `a://a:` stays linear. Followed by `(?=@)` where used.
const URL_PASSWORD_HEAD = String.raw`(?:[^\s@?#"'<>:]|:(?!\/\/))`;
const URL_PASSWORD_TAIL = String.raw`(?:@(?:[^\s@/?#"'<>:]|:(?!\/\/))*)*`;
// The same, holding a `/` before its first `@`: the shape a URL parser
// misreads (`https://u:ab/cd@host` parses as host `u`, port `ab`).
const URL_PASSWORD_WITH_SLASH = String.raw`(?:[^\s@?#"'<>:/]|:(?!\/\/))*\/${URL_PASSWORD_HEAD}*${URL_PASSWORD_TAIL}`;
const HTTP_SLASH_PASSWORD_SOURCE = String.raw`(${URL_START}https?:\/\/${URL_USER})${URL_PASSWORD_WITH_SLASH}(?=@)`;

// A YAML block scalar under a secret name (`private_key: |`, `password: >-`):
// the key line is kept with the indentation of the first content line, and
// every more-indented line after it (blank lines inside included) becomes one
// mask, up to the first line indented no deeper than the key. `nl` is the line
// break, `ch` one character of a line; `start` is where a key line may begin.
// Each line is read once: a blank line and a content line cannot both match
// (a content line has a non-blank character after its indentation).
// `sequenceItem`: the key starts a sequence item (`- password: |`), so its
// column is two past the dash's indentation and the block's lines are indented
// at least three past it. A tag or anchor may come before the indicator
// (`password: !!binary |`, `password: &pw |`).
function yamlBlockRule(start: string, nl: string, ch: string, first: string, space: string, sequenceItem = false): RegExp {
  const word = String.raw`[^\s|>\\"]`;
  const header = String.raw`[\\"']*${space}*:${space}*(?:[!&]${word}*${space}+){0,2}[|>](?:[+-][1-9]?|[1-9][+-]?)?${space}*(?:#${ch}*)?`;
  const item = sequenceItem ? String.raw`-${space}(?!${space})` : "";
  const deeper = sequenceItem ? String.raw`\2${space}{3,}` : String.raw`\2${space}+`;
  return new RegExp(
    String.raw`(${start}(${space}*)${item}["']?${SECRET_NAME}${header}${nl}(?:${space}*${nl})*${deeper})${first}${ch}*(?:(?:${nl}${space}*(?=${nl}))*${nl}${deeper}${first}${ch}*)*`,
    "gim",
  );
}
const YAML_RAW = [String.raw`\r?\n`, String.raw`[^\r\n]`, String.raw`[^ \t\r\n]`, String.raw`[ \t]`] as const;
const YAML_ESCAPED = [String.raw`(?:\\r)?\\n`, String.raw`(?:[^\\"\r\n]|\\[^nr\r\n])`, String.raw`(?:[^ \\"\r\n]|\\[^nr\r\n])`, " "] as const;
const YAML_ESCAPED_START = String.raw`(?<=\\n|"|^)`;

// `Cookie:` / `Set-Cookie:` (any case). The whole value goes, cookie names
// with it: one rule masks every value whatever its quoting, and a per-cookie
// form would need either a quadratic lookbehind or a value grammar that a
// quoted `a="x;y"` breaks.
const COOKIE = String.raw`${LEFT}(?:set-)?cookie[\\"']*\s*:\s*`;
// A list of quoted values (`"set-cookie": ["a=b; Path=/", "c=d"]`, Node's
// `'set-cookie': [ 'a=b' ]`), each closed by its own quote; a bare scalar
// after the first value (`42`, `null`) does not end the list. The first must be
// quoted, so a masked `cookie: [REDACTED_TOKEN]` is not read as a list.
const quotedList = (quote: string, value: string): string => {
  const quoted = String.raw`${quote}(?:${value})?${quote}`;
  return String.raw`${quoted}(?:\s*,\s*(?:${quoted}|[A-Za-z0-9_.+-]+))*`;
};

// Order matters only where a later rule could match the replacement text;
// none of these match `***REDACTED***`, `[url]` or a `«redacted:<kind>»`
// marker on its own. A later rule may still swallow an earlier replacement
// inside a larger match (an Authorization header whose Bearer value was
// already masked); counted mode then moves the count to the later kind, so the
// counts always equal the markers left in the text. A `keepLabel` rule that
// meets an already-masked value replaces it with the same mask, so every mode
// is idempotent.
const SECRET_RULES: readonly SecretRule[] = [
  // PEM private key blocks (multi-line), before any single-line rule could eat
  // a fragment of them.
  // A block does not run across another BEGIN: with many BEGINs and no END
  // each one read to the end of the text (quadratic). A BEGIN cut off before
  // the next one is then caught by the orphan rule below.
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?!-----BEGIN )[\s\S])*?-----END [A-Z ]*PRIVATE KEY-----/g, multiline: true },
  // Orphan PEM markers, fail-closed (XX, task #263). A complete block is masked
  // by the rule above, so anything still carrying a marker is unpaired: the file
  // was mid-write when it was read, or rotation/truncation cut the block. Either
  // way the base64 body is live key material and must not survive.
  // BEGIN with no END: mask to the end of the text.
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g },
  // END with no BEGIN: mask from the start of the text to that marker.
  { kind: "private_key", re: /^[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // The password in a non-HTTP connection string (`postgres://app:pw@db`,
  // `redis://:pw@host`, `mongodb+srv://u:p@cluster`): scheme, user, `:` and `@`
  // kept, the host shown. An unencoded `/` or `@` may be part of the password
  // (`postgres://u:ab/cd@host`, `u:p@ss@host`): it runs to the last `@` of the
  // authority (URL_PASSWORD_TAIL). The second form, which stops at the first
  // `/` or `@` but reads `?` and `#`, keeps a password such as `SEC?RET`
  // masked as before.
  {
    kind: "url_credentials",
    re: new RegExp(String.raw`${CONNECTION_STRING_USER}${URL_PASSWORD_HEAD}+${URL_PASSWORD_TAIL}(?=@)`, "gi"),
    keepLabel: true,
    structural: true,
  },
  {
    kind: "url_credentials",
    re: new RegExp(String.raw`${CONNECTION_STRING_USER}[^\s/@"'<>]+(?=@)`, "gi"),
    keepLabel: true,
    structural: true,
  },
  // An http(s) URL whose password holds a `/`, for a surface whose own passes
  // would split it before its URL handling sees it (runtime error text reads
  // `cd@host.tld` as an email). The other surfaces mask it in their URL
  // handling (`redactUrl`); `raft-computer logs` / `doctor` show URL
  // credentials by design, so the full catalogue leaves it alone.
  { kind: "url_credentials", re: new RegExp(HTTP_SLASH_PASSWORD_SOURCE, "gi"), keepLabel: true, structural: "only" },
  // A YAML block scalar under a secret name, in plain text and inside a JSON
  // string (literal `\n` line breaks; a key line starts after one, after the
  // opening quote or at the start of the text).
  { kind: "secret_assignment", re: yamlBlockRule("^", ...YAML_RAW), keepLabel: true, structural: true, multiline: true },
  { kind: "secret_assignment", re: yamlBlockRule("^", ...YAML_RAW, true), keepLabel: true, structural: true, multiline: true },
  { kind: "secret_assignment", re: yamlBlockRule(YAML_ESCAPED_START, ...YAML_ESCAPED), keepLabel: true, structural: true },
  { kind: "secret_assignment", re: yamlBlockRule(YAML_ESCAPED_START, ...YAML_ESCAPED, true), keepLabel: true, structural: true },
  // Raft-issued keys: at a word start (after an escape included), or anywhere
  // when the tail looks issued (8+ chars with a digit within the first 64),
  // so `disk_usage_bytes` is not read as `sk_usage_bytes`.
  { kind: "raft_key", re: new RegExp(String.raw`${LEFT}sk_[a-z]+_[A-Za-z0-9._-]+`, "g") },
  { kind: "raft_key", re: /sk_[a-z]+_(?=[A-Za-z0-9._-]{0,63}[0-9])(?=[A-Za-z0-9._-]{8})[A-Za-z0-9._-]+/g },
  { kind: "raft_key", re: new RegExp(String.raw`${LEFT}sap_[A-Za-z0-9_-]+`, "g") },
  { kind: "raft_key", re: /sap_(?=[A-Za-z0-9_-]{0,63}[0-9])(?=[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g },
  // Bearer tokens and any Authorization header value, with or without a scheme
  // (`Basic <base64>` included); the header name and scheme stay readable.
  { kind: "bearer", re: new RegExp(String.raw`${LEFT}Bearer\s+[A-Za-z0-9._~+/=-]{8,}`, "gi") },
  // Google OAuth access tokens and refresh tokens, bare (they are Bearer values
  // or exchange for one).
  { kind: "bearer", re: new RegExp(String.raw`${LEFT}ya29\.[0-9A-Za-z._-]{20,}`, "g") },
  { kind: "bearer", re: /(?<![A-Za-z0-9/])1\/\/0[0-9A-Za-z_-]{30,}/g },
  // An Authorization value: a scheme and its value, or one value that looks
  // like a credential (a digit or symbol, a capital after the first letter, or
  // 20+ chars), so `Authorization: required` / `=none` stay readable.
  {
    kind: "authorization",
    re: new RegExp(String.raw`(${LEFT}${AUTHORIZATION}[\\"']*\s*[:=]\s*[\\"']*${AUTH_SCHEME})[^\s"',;\\]+|(${LEFT}${AUTHORIZATION}[\\"']*\s*[:=]\s*[\\"']*)(?=[^\s"',;\\]{20}|[^\s"',;\\]*[0-9_\-./+=:~*\[«]|[^\s"',;\\]+[A-Z])[^\s"',;\\]+`, "g"),
    keepLabel: true,
  },
  // `Basic <base64>` outside a header (curl -v, a client's error echo). The
  // value must look encoded (a digit, `+`, `/` or `=`, or a capital after the
  // first letter) so "Basic Authentication failed" stays readable.
  {
    kind: "authorization",
    re: new RegExp(String.raw`(${LEFT}Basic\s+)(?=[A-Za-z0-9+/]{8,})(?=[A-Za-z0-9+/]*[0-9+/=]|[A-Za-z0-9+/]+[A-Z])[A-Za-z0-9+/]+={0,2}`, "g"),
    keepLabel: true,
  },
  // Cookie headers: a quoted value (JSON, a Python/Node dump, JSON-escaped),
  // a list of quoted values, or a header line, whose value runs to the end of
  // the line (or a literal `\n`) and must start with `name=` (a cookie name
  // is a token: no `:`, `/`, `@`, …), so prose such as `Set-Cookie: header
  // missing` stays readable.
  { kind: "authorization", re: new RegExp(String.raw`(${COOKIE}")${DQ_VALUE}`, "gi"), keepLabel: true },
  { kind: "authorization", re: new RegExp(String.raw`(${COOKIE}')${SQ_VALUE}`, "gi"), keepLabel: true },
  { kind: "authorization", re: new RegExp(String.raw`(${COOKIE}\\")${ESCAPED_DQ_VALUE}`, "gi"), keepLabel: true },
  // Deeper (`\\\"…\\\"`), as for secret names.
  { kind: "authorization", re: new RegExp(String.raw`(${COOKIE}(\\{2,})")(?:[^\\"\r\n]|(?!\2")\\+[^\\\r\n])+`, "gi"), keepLabel: true },
  { kind: "authorization", re: new RegExp(String.raw`(${COOKIE}\[\s*)${quotedList('"', DQ_VALUE)}`, "gi"), keepLabel: true },
  { kind: "authorization", re: new RegExp(String.raw`(${COOKIE}\[\s*)${quotedList("'", SQ_VALUE)}`, "gi"), keepLabel: true },
  { kind: "authorization", re: new RegExp(String.raw`(${COOKIE}\[\s*)${quotedList(String.raw`\\"`, ESCAPED_DQ_VALUE)}`, "gi"), keepLabel: true },
  {
    kind: "authorization",
    re: new RegExp(String.raw`(${LEFT}(?:set-)?cookie[ \t]*:[ \t]*)(?=[^\s=;,:"'\\()<>@/[\]?{}]{1,256}=)(?:[^\r\n\\]|\\(?![nr]))+`, "gi"),
    keepLabel: true,
  },
  // Common vendor key shapes; Google OAuth client secrets.
  { kind: "vendor_key", re: new RegExp(String.raw`${LEFT}(?:sk|sk-ant|sk-proj|xox[baprs]?)-[A-Za-z0-9_-]{8,}\b`, "g") },
  { kind: "vendor_key", re: new RegExp(String.raw`${LEFT}GOCSPX-[A-Za-z0-9_-]{20,}`, "g") },
  // Hugging Face (`hf_` + 34), npm (`npm_` + 36), GitLab tokens (`glpat-`,
  // `gldt-`, `glrt-`, `glptt-`, … + 20, newer ones with `.`-separated parts;
  // the tail must hold a digit or capital in its first 20, so a kebab-case
  // word such as `global-settings-for-the-app` stays readable) and Stripe
  // restricted keys (`rk_live_` / `rk_test_` + 24 or more). Each needs a long
  // tail of the token's own alphabet, so `hf_hub_download`, `npm_config_cache`
  // and a bare `rk_test` stay readable.
  {
    kind: "vendor_key",
    re: new RegExp(String.raw`${LEFT}(?:hf_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{30,}|gl[a-z]{2,6}-(?=[A-Za-z0-9_-]{0,19}[0-9A-Z])[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*|rk_(?:live|test)_[A-Za-z0-9]{20,})`, "g"),
  },
  // GitHub tokens (classic ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_).
  { kind: "github_token", re: new RegExp(String.raw`${LEFT}gh[oprsu]_[A-Za-z0-9]{20,}\b`, "g") },
  { kind: "github_token", re: new RegExp(String.raw`${LEFT}github_pat_[A-Za-z0-9_]{20,}\b`, "g") },
  // AWS access key ids. IAM AccessKeyId: the public API contract allows
  // 16–128 chars; issued ids are usually 20 today, but the rule must not encode
  // "usually". Covers the documented unique-id prefixes for access keys and
  // STS temporary keys. Secret access keys have no shape of their own; they
  // are caught by name (`aws_secret_access_key = …`, `"SecretAccessKey": "…"`).
  { kind: "aws_key", re: new RegExp(String.raw`${LEFT}(?:AKIA|ASIA)[0-9A-Z]{12,124}\b`, "g") },
  // Google API keys: documented shape is "AIza" + 35 URL-safe chars (39 total).
  // Trailing lookahead instead of \b: the last char may be `-` or `_`, and a
  // `-` before a space is not a word boundary (XX, #7792 review).
  { kind: "google_api_key", re: new RegExp(String.raw`${LEFT}AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])`, "g") },
  // xAI API keys: "xai-" prefix; exact length is not published, so this is a
  // lower bound on the shape (Kabi, #263 R6: shape unverified against a spec).
  { kind: "xai_key", re: new RegExp(String.raw`${LEFT}xai-[A-Za-z0-9]{20,}\b`, "g") },
  // Bare JWT / JWS (base64url header, no Bearer prefix).
  { kind: "jwt", re: new RegExp(String.raw`${LEFT}eyJ[A-Za-z0-9._-]{20,}`, "g") },
  // Secret-named assignments in logs, config echoes and JSON bodies, the name
  // kept: `api_key=v`, `"client_secret": "v"`, `{"token":"v"}`. Quoted: the
  // whole value up to its closing unescaped quote (or the end of the line when
  // the text was cut inside it). Quotes may be JSON-escaped when the text is
  // embedded in a JSON record (`\"`, `\\\"`, …), each depth to its own closing quote.
  { kind: "secret_assignment", re: new RegExp(String.raw`(${SECRET_NAME}[\\"']*\s*[:=]\s*")${DQ_VALUE}`, "gi"), keepLabel: true },
  { kind: "secret_assignment", re: new RegExp(String.raw`(${SECRET_NAME}[\\"']*\s*[:=]\s*')${SQ_VALUE}`, "gi"), keepLabel: true },
  { kind: "secret_assignment", re: new RegExp(String.raw`(${SECRET_NAME}[\\"']*\s*[:=]\s*\\")${ESCAPED_DQ_VALUE}`, "gi"), keepLabel: true },
  // Deeper (`\\\"…\\\"`): the value runs to the same backslash run + quote; a
  // longer run is an escaped quote inside the value.
  { kind: "secret_assignment", re: new RegExp(String.raw`(${SECRET_NAME}[\\"']*\s*[:=]\s*(\\{2,})")(?:[^\\"\r\n]|(?!\2")\\+[^\\\r\n])+`, "gi"), keepLabel: true },
  { kind: "secret_assignment", re: new RegExp(String.raw`(${SECRET_NAME}[\\"']*\s*[:=]\s*\\{2,}')[^'\\\r\n]+`, "gi"), keepLabel: true },
  { kind: "secret_assignment", re: new RegExp(String.raw`(${SECRET_NAME}[\\"']*\s*[:=]\s*\\')[^'\\\r\n]+`, "gi"), keepLabel: true },
  // Bare: one word of at least 4 characters that is not a JSON literal (a
  // literal `\n` escape in front of it goes with it).
  { kind: "secret_assignment", re: new RegExp(String.raw`(${SECRET_NAME}[\\"']*\s*[:=]\s*)(?:\\+[nrt])*(?![\\"'])${NOT_LITERAL}[^\s"',;\\]{4,}`, "gi"), keepLabel: true },
  // PINs: a name ending in `pin` (`pin`, `user_pin`, `"PIN"`) and 4–12 digits.
  // Digits only, so a version pin (`pin: 3.11`) stays readable.
  { kind: "secret_assignment", re: /((?<![A-Za-z0-9])(?:[A-Za-z0-9]+[_.-])?pin[\\"']*\s*[:=]\s*[\\"']*)\d{4,12}(?![\w.])/gi, keepLabel: true },
  // Environment-style names ending in _TOKEN or _KEY (HF_TOKEN=, STRIPE_KEY=),
  // which the rules above miss unless the name also says api/access/secret.
  // Upper case only: lower-case `sort_key: name` / `cache_key = id` are data.
  { kind: "secret_assignment", re: new RegExp(String.raw`(${LEFT}[A-Z][A-Z0-9_]*_(?:TOKEN|KEY)\b[\\"']*\s*[:=]\s*[\\"']*)${NOT_LITERAL}[^\s"',;\\]{4,}`, "g"), keepLabel: true },
  // Command-line flags. `--token=v` / `--password "a b"` (quotes possibly
  // JSON-escaped): any value. `--api-key v`: a value that looks like one (8+
  // chars, or a digit or one of `_-./+=:`), so `missing --token flag` and
  // `use --api-key or …` stay readable; a value starting with `-` is the next
  // flag.
  {
    kind: "secret_assignment",
    re: new RegExp(String.raw`(${SECRET_FLAG}(?:=|[ \t]+))(?:\\*"[^"\\\r\n]*(?:\\*")?|\\*'[^'\\\r\n]*(?:\\*')?)|(${SECRET_FLAG}=)[^\s"'\\]+|(${SECRET_FLAG}[ \t]+)(?!-)(?=[^\s"'\\]{8}|[^\s"'\\]*[0-9_\-./+=:])[^\s"'\\]+`, "gi"),
    keepLabel: true,
  },
  // Long hex blobs (hashes, raw keys).
  { kind: "hex_blob", re: /\b[A-Fa-f0-9]{40,}\b/g },
];

export interface DiagnosticCredentialRedactionOptions {
  /** What replaces each caught secret (`***REDACTED***`, `[REDACTED_TOKEN]`). */
  mask: string;
  /**
   * Mask runs of 40+ hex characters (default true). Runtime error text turns
   * this off: there a 40-hex run is far more often a commit or request id
   * than a key, and that text never masked them.
   */
  hexBlobs?: boolean;
  /**
   * Apply only the rules that read layout a surface's own formatting would
   * rewrite (connection-string passwords, YAML block values). Runtime error
   * text applies these before its own passes, then the whole catalogue.
   */
  structuralOnly?: boolean;
}

function applySecretRules(
  text: string,
  replace: (kind: DiagnosticRedactionKind, swallowed: string) => string,
  hexBlobs: boolean,
  structuralOnly = false,
): string {
  let out = text;
  for (const rule of SECRET_RULES) {
    if (!hexBlobs && rule.kind === "hex_blob") continue;
    if (structuralOnly ? !rule.structural : rule.structural === "only") continue;
    out = out.replace(rule.re, (match: string, ...groups: unknown[]) => {
      // Alternations put their label in different groups: the first one set.
      const label = rule.keepLabel ? String(groups.find((g) => typeof g === "string") ?? "") : "";
      return label + replace(rule.kind, match.slice(label.length));
    });
  }
  return out;
}

/**
 * The secret rules alone (no URL or identity handling), each hit replaced by
 * `mask`. The one credential catalogue for surfaces with their own URL/identity
 * format: runtime error text (`scrubRuntimeErrorText`) and `raft-computer
 * logs` / `doctor` (`redactSecrets`).
 */
export function redactDiagnosticCredentials(text: string, options: DiagnosticCredentialRedactionOptions): string {
  return applySecretRules(text, () => options.mask, options.hexBlobs ?? true, options.structuralOnly ?? false);
}

/**
 * Lines redacted one at a time, so an orphan PEM marker masks only its own line
 * and never the rest (or the start) of the text, after the rules that may span
 * lines (a complete PEM block, a YAML block) ran over the joined lines. Each
 * line such a span covered becomes `mask` (a YAML block keeps its key line and
 * each line's indentation), so the result has exactly as many lines as `lines`.
 * For line-oriented output: `raft-computer logs`.
 */
export function redactDiagnosticCredentialLines(lines: readonly string[], options: DiagnosticCredentialRedactionOptions): string[] {
  if (lines.length === 0) return [];
  let joined = lines.join("\n");
  for (const rule of SECRET_RULES) {
    if (!rule.multiline) continue;
    joined = joined.replace(rule.re, (match: string, ...groups: unknown[]) => {
      const label = rule.keepLabel ? String(groups.find((g) => typeof g === "string") ?? "") : "";
      const covered = match.slice(label.length).split("\n");
      return label + covered.map((line, i) => (i === 0 ? "" : /^[ \t]*/.exec(line)![0]) + options.mask).join("\n");
    });
  }
  return joined.split("\n").map((line) => redactDiagnosticCredentials(line, { ...options, structuralOnly: false }));
}

// Applied after the secret rules so a masked value inside a path stays masked.
// The address's local part is read from the start of its run only: `\b`
// retried every `-`/`.` of a long run with no `@` (quadratic; same fix as
// runtimeErrorVisibility's EMAIL_PATTERN).
const IDENTITY_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\/Users\/[^\s"'<>:]+(?:\/[^\s"'<>:]+)*/g,
  /\/home\/[^\s"'<>:]+(?:\/[^\s"'<>:]+)*/g,
  /[A-Za-z]:\\Users\\[^\s"'<>:]+(?:\\[^\s"'<>:]+)*/g,
];

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

// An http(s) URL whose password holds a `/`, at the start of a URL the
// surfaces' URL pattern found. A URL parser reads `https://u:ab/cd@host` as
// host `u`, port `ab`, and fails or keeps the password in the path, so the
// password is swapped for a placeholder before parsing; the URL then comes out
// in the shape a well-formed one has.
const HTTP_SLASH_PASSWORD_AT_START = new RegExp(String.raw`^${HTTP_SLASH_PASSWORD_SOURCE}`, "i");

/** `value` with a slash password replaced by `password`, or null when it has none. */
function replaceHttpSlashPassword(value: string, password: string): string | null {
  const slash = HTTP_SLASH_PASSWORD_AT_START.exec(value);
  return slash ? `${slash[1]}${password}${value.slice(slash[0].length)}` : null;
}

function redactUrl(value: string): string {
  const placeheld = replaceHttpSlashPassword(value, "x");
  try {
    const url = new URL(placeheld ?? value);
    if (url.search) url.search = "?[REDACTED_QUERY]";
    if (url.username) url.username = "[REDACTED_USER]";
    if (url.password) url.password = "[REDACTED_PASSWORD]";
    return url.toString();
  } catch {
    return (replaceHttpSlashPassword(value, "[REDACTED_PASSWORD]") ?? value).replace(/\?.*$/, "?[REDACTED_QUERY]");
  }
}

export function redactDiagnosticText(text: string, options: DiagnosticRedactionOptions = {}): string {
  const urls = options.urls ?? "query";
  let out = text.replace(URL_PATTERN, (url) => (urls === "drop" ? "[url]" : redactUrl(url)));
  out = redactDiagnosticCredentials(out, { mask: MASK });
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
  out = applySecretRules(out, hit, true);
  return { text: out, counts };
}

function redactUrlCounted(value: string, hit: (kind: DiagnosticRedactionKind) => string): string {
  const placeheld = replaceHttpSlashPassword(value, "x");
  let url: URL;
  try {
    url = new URL(placeheld ?? value);
  } catch {
    const masked = placeheld === null ? value : (replaceHttpSlashPassword(value, hit("url_credentials")) ?? value);
    const queryAt = masked.indexOf("?");
    return queryAt < 0 ? masked : `${masked.slice(0, queryAt)}?${hit("url_query")}`;
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
