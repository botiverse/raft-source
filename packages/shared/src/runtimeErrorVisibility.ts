import type { RuntimeErrorClass, RuntimeErrorRequiredAction } from "./index";

/**
 * #wg-rbac:#57 — what of an agent's runtime error each viewer may read.
 *
 * - The text: scrubbed (credentials, emails, URL queries, home paths) and
 *   capped at MAX_VISIBLE_RUNTIME_ERROR_DETAIL_CHARS. The server scrubs it where
 *   it enters (the daemon's `agent:activity` frame) and again on every read, so
 *   rows stored before this rule are covered too. Only the agent's managers
 *   (its human creator and users with `editAgents`; a personal assistant's
 *   owner) receive it.
 * - The code: a closed list for the common cases (RUNTIME_ERROR_CODES), next to
 *   the text. Every viewer receives it. A member (no `editAgents`, not the
 *   creator) receives the code's fixed sentence as the text, or
 *   GENERIC_RUNTIME_ERROR_MESSAGE when no code applies; never the error's text.
 */

// Env/field-assignment redaction (§#688 load-bearing): a value assigned to a
// secret-shaped key (ANTHROPIC_API_KEY, AWS_SECRET_ACCESS_KEY, *_TOKEN, etc.) is
// a credential leak vector if it reaches a user-visible surface. Redact only the
// assigned value; keep the key label for diagnostics. The KEY names that match are
// restricted to explicit secret-signal words so we do not over-redact benign
// assignments (e.g. `NODE_ENV=production` must survive).
//
// Linear by construction (the server runs this on text a Computer sends): the
// key is read from the start of its run of key characters only (the
// lookbehind), and the lookahead finds the secret word inside that run before
// anything is consumed. The earlier form, `\b[A-Za-z0-9._-]*(?:WORD)[A-Za-z0-9._-]*`,
// retried every word boundary and every split of a long run with no assignment
// after it (`TOKEN-TOKEN-...`): cubic, seconds for 10 KB.
const SECRET_ASSIGNMENT_KEY_PATTERN =
  /(?<![A-Za-z0-9._-])(?=[A-Za-z0-9._-]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|PRIVKEY|CREDENTIAL))([A-Za-z0-9._-]+)\s*(?:=|:)\s*("[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s;,"'<>]+)/gi;
// The value: quoted, bare, or an opening quote with no closing one, which
// runs to the end of the text (a cut text can end inside a quoted secret, and
// the bare form excludes quotes, so `password: "correct horse` would match
// nothing and be shown).
//
// An address, its local part read from the start of its run only (as above:
// `\b` retried every dot of `a.a.a...`, quadratic).
const EMAIL_PATTERN = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// GitHub token family (ghp/gho/ghs/ghu/ghr), bare and not caught by the URL/
// path redactors. Also npx/npm-style auth tokens and the common `github_pat_`
// personal-access-token prefix, all of which are credential-shaped bare text.
const GITHUB_TOKEN_FAMILY_PATTERN =
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+\b/g;
// What the pattern above leaves: a bare value starting with a character it
// excludes (`password: <hunter2>`). The key and separator are kept, the value
// goes (an earlier form kept the value and dropped the key).
const GENERIC_CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b((?:password|passwd|secret|token)\s*[:=]\s*)("[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s;,]+)/gi;

function redactUrlQuery(value: string): string {
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

/** Redact credentials, emails, URL queries and home-directory paths from runtime error text. Idempotent. */
export function scrubRuntimeErrorText(value: string): string {
  let scrubbed = String(value ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/\b(?:sk|sk-ant|sk-proj|xox[baprs]?)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(EMAIL_PATTERN, "[REDACTED_EMAIL]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrlQuery(url))
    .replace(/\/Users\/[^\s"'<>:]+(?:\/[^\s"'<>:]+)*/g, "[REDACTED_PATH]")
    .replace(/\/home\/[^\s"'<>:]+(?:\/[^\s"'<>:]+)*/g, "[REDACTED_PATH]")
    .replace(/[A-Za-z]:\\Users\\[^\s"'<>:]+(?:\\[^\s"'<>:]+)*/g, "[REDACTED_PATH]");
  // Env/field assignments with a secret-shaped key: keep the key label, redact value.
  scrubbed = scrubbed.replace(SECRET_ASSIGNMENT_KEY_PATTERN, (_match, key: string) => `${String(key).trim()}=[REDACTED_TOKEN]`);
  // Generic credential assignment (password/secret/token = value): redact value.
  scrubbed = scrubbed.replace(GENERIC_CREDENTIAL_ASSIGNMENT_PATTERN, (_m, prefix: string) => `${prefix}[REDACTED_TOKEN]`);
  // GitHub token family + github_pat_.
  return scrubbed.replace(GITHUB_TOKEN_FAMILY_PATTERN, "[REDACTED_TOKEN]");
}

/** #688 bounded-diagnostic half: the most characters of runtime error text any user-visible surface carries. */
export const MAX_VISIBLE_RUNTIME_ERROR_DETAIL_CHARS = 512;

/**
 * The most characters of raw runtime error text the scrubber reads. A Computer
 * sends this text and its length is the sender's, so it is cut before any
 * pattern runs; 4096 is far more than scrubbing can shrink to the 512 shown.
 */
export const MAX_SCRUBBED_RUNTIME_ERROR_INPUT_CHARS = 4096;

/**
 * `raw` cut to MAX_SCRUBBED_RUNTIME_ERROR_INPUT_CHARS. The cut can fall inside
 * a credential and leave a piece too short for a pattern to recognise, so the
 * last, cut-off word goes too (unless the text is one unbroken word).
 */
function scrubberInput(raw: string): string {
  const text = String(raw ?? "");
  if (text.length <= MAX_SCRUBBED_RUNTIME_ERROR_INPUT_CHARS) return text;
  let end = MAX_SCRUBBED_RUNTIME_ERROR_INPUT_CHARS;
  while (end > 0 && !/\s/.test(text[end - 1]!)) end -= 1;
  return end > 0 ? text.slice(0, end) : text.slice(0, MAX_SCRUBBED_RUNTIME_ERROR_INPUT_CHARS);
}

/** Scrubbed and capped: the only form of runtime error text a user-visible surface may carry. */
export function boundedRuntimeErrorDetail(raw: string): string {
  const scrubbed = scrubRuntimeErrorText(scrubberInput(raw));
  return scrubbed.length <= MAX_VISIBLE_RUNTIME_ERROR_DETAIL_CHARS ? scrubbed : scrubbed.slice(0, MAX_VISIBLE_RUNTIME_ERROR_DETAIL_CHARS);
}

/**
 * The closed list of runtime error codes, for the common cases. Read by every
 * viewer; the web renders its own copy per code (RUNTIME_ERROR_CODE_SENTENCES
 * is the English the server sends members as the text).
 *
 * - `usage_limit`: the account's usage quota is used up ("usage limit",
 *   "quota exceeded", ...). Waiting for the reset, or another account/model.
 * - `billing`: the provider's billing/credit balance is exhausted (typed
 *   `BillingError`, HTTP 402).
 * - `model_unavailable`: the plan does not include the model, or the model is
 *   not supported (`ModelConfigError`, requiredAction `user_model_access`).
 * - `auth_required`: the runtime is not signed in or its key was rejected
 *   (`AuthError`, requiredAction `user_reauth`).
 * - `network_timeout`: the provider could not be reached or timed out
 *   (`TimeoutError`, `ProviderConnectionError`).
 * - `input_too_large`: the prompt/context is larger than the model accepts
 *   (`InputTooLargeError`).
 * - `message_too_large`: one message is longer than the runtime takes at
 *   once and was not delivered (`MessageTooLargeError`; Antigravity's input
 *   bound, OAR `input_too_large` on a refused prompt). Shorten or split it.
 */
export const RUNTIME_ERROR_CODES = [
  "usage_limit",
  "billing",
  "model_unavailable",
  "auth_required",
  "network_timeout",
  "input_too_large",
  "message_too_large",
] as const;
export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

export function isRuntimeErrorCode(value: unknown): value is RuntimeErrorCode {
  return typeof value === "string" && (RUNTIME_ERROR_CODES as readonly string[]).includes(value);
}

/** What a member reads in place of an uncoded runtime error's text. */
export const GENERIC_RUNTIME_ERROR_MESSAGE = "Agent encountered an error";

/** The fixed sentence per code, with the next step. Contains nothing from the error itself. */
export const RUNTIME_ERROR_CODE_SENTENCES: Readonly<Record<RuntimeErrorCode, string>> = {
  usage_limit: "The agent's model provider usage limit has been reached. Wait for the limit to reset, or ask the agent's owner to switch it to another model or account.",
  billing: "The agent's model provider billing or credit balance is exhausted. Ask the agent's owner to add credits or switch it to another model or provider.",
  model_unavailable: "The agent's configured model is not available to its provider account. Ask the agent's owner to choose another model or change the plan.",
  auth_required: "The agent's runtime is not signed in, or its provider credential was rejected. Ask the agent's owner to sign in again or update the credential.",
  network_timeout: "The agent could not reach its model provider, or the request timed out. Try again later; if it keeps happening, ask the agent's owner to check the computer's network.",
  input_too_large: "The agent's input is larger than its model accepts. Ask the agent's owner to reset the session or reduce the startup context.",
  message_too_large: "A message to the agent was too long for its runtime to take at once, so it was not delivered. Shorten it, or split it into several messages.",
};

// Wording of a used-up usage quota: the daemon's isRuntimeUsageLimitText phrases.
const USAGE_LIMIT_PATTERN = /\busage limit\b|\bquota (?:exceeded|limit)\b|\bbudget limit exceeded\b/i;
// The daemon's fixed rewrites and the plain provider wording, for an error
// stored without a typed class (older daemons, older rows).
const BILLING_PATTERN = /\bpayment required\b|\bbilling or credit balance is exhausted\b|\binsufficient\s+(?:balance|credits?|funds)\b|\b(?:usage|credit|account)\s+balance\b[^.]*\b(?:exhausted|depleted)\b/i;
const MODEL_UNAVAILABLE_PATTERN = /\bdoes not include access to the configured model\b|\busage not included in your plan\b|\bmodel\b[^.\n]{0,80}\b(?:not supported|not available)\b|\bunsupported\b[^.\n]{0,40}\bmodel\b/i;
const AUTH_REQUIRED_PATTERN = /\bis not logged in\b|\bnot signed in\b|\blogin required\b|\bplease log in\b|\bauthentication failed\b|\binvalid api key\b|\bmodel provider rejected the (?:api key|request)\b|\baccess token could not be refreshed\b/i;
// The daemon's fixed sentence for a message refused for its length (formatRuntimeMessageTooLargeMessage).
const MESSAGE_TOO_LARGE_PATTERN = /\bis too long for [^.\n]{1,40} to take in one message\b/i;
const INPUT_TOO_LARGE_PATTERN = /\binput that is too large\b|\binput too large\b|\bINPUT_TOO_LARGE\b|\bmaximum context length is [\d,]+ tokens?\b/i;
const NETWORK_TIMEOUT_PATTERN = /\bETIMEDOUT\b|\btimed out\b|\bECONNRESET\b|\bECONNREFUSED\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bUnable to connect to API\b|\berror sending request for url\b/i;

/**
 * The code of one runtime error, or null (no code: members get the generic
 * message). The daemon's typed class and required action decide when present;
 * a usage-limit wording wins over a generic class (a quota is often reported
 * as a 429 / RateLimitError). Text patterns decide only for an error without a
 * class that names a code (older daemons, older rows, untyped classes).
 */
export function classifyRuntimeErrorCode(input: {
  message?: string | null;
  errorClass?: RuntimeErrorClass | string | null;
  requiredAction?: RuntimeErrorRequiredAction | string | null;
}): RuntimeErrorCode | null {
  const message = typeof input.message === "string" ? input.message : "";
  if (input.errorClass === "BillingError") return "billing";
  if (input.requiredAction === "user_reauth") return "auth_required";
  if (input.requiredAction === "user_model_access") return "model_unavailable";
  switch (input.errorClass) {
    case "AuthError": return "auth_required";
    case "ModelConfigError": return "model_unavailable";
    case "InputTooLargeError": return "input_too_large";
    case "MessageTooLargeError": return "message_too_large";
    case "TimeoutError":
    case "ProviderConnectionError":
      return "network_timeout";
    default:
      break;
  }
  if (USAGE_LIMIT_PATTERN.test(message)) return "usage_limit";
  if (BILLING_PATTERN.test(message)) return "billing";
  if (MODEL_UNAVAILABLE_PATTERN.test(message)) return "model_unavailable";
  if (AUTH_REQUIRED_PATTERN.test(message)) return "auth_required";
  if (MESSAGE_TOO_LARGE_PATTERN.test(message)) return "message_too_large";
  if (INPUT_TOO_LARGE_PATTERN.test(message)) return "input_too_large";
  if (NETWORK_TIMEOUT_PATTERN.test(message)) return "network_timeout";
  return null;
}

/** The text a member reads for a runtime error: the code's fixed sentence, or the generic message. */
export function memberRuntimeErrorMessage(code: RuntimeErrorCode | null | undefined): string {
  return code ? RUNTIME_ERROR_CODE_SENTENCES[code] : GENERIC_RUNTIME_ERROR_MESSAGE;
}

/** The activity detail kinds whose detail is a runtime error's text, whatever the activity. */
export const RUNTIME_ERROR_DETAIL_KINDS = ["runtime_error", "runtime_crashed"] as const;

/**
 * #wg-rbac:#57: whether an activity's detail is a runtime error's text: an
 * `error` activity, or a runtime-error / crash detail kind on any activity
 * (a crash can be reported as `offline`). The one predicate the server's
 * ingest scrub and every per-viewer projection use.
 */
export function isRuntimeErrorDetailActivity(input: { activity?: string | null; detailKind?: string | null }): boolean {
  return input.activity === "error"
    || (typeof input.detailKind === "string" && (RUNTIME_ERROR_DETAIL_KINDS as readonly string[]).includes(input.detailKind));
}
