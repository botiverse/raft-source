import { isRuntimeErrorCode } from "@botiverse/raft-shared";
import type { RuntimeErrorCode } from "@botiverse/raft-shared";

import type { MessageId } from "../i18n/messages";

// Runtime-error classification (@Wug boundary 2026-08-04): only enumerable,
// stable patterns are recognized and mapped to catalog copy; anything else
// stays null so the caller falls back to the generic message (or the raw
// diagnostic in the creator debug view). We never substring-translate
// arbitrary server English.

// `toolArgsInvalid` (task #1127) is reachable only from the daemon's typed
// carrier, never from `classifyRuntimeError` below: the upstream sentence is
// matched once in the daemon, and the web must not grow a second text matcher
// for the same fact.
// `billingExhausted` (task #1351) is typed-only for the same reason: the
// daemon classifies the provider's 402 / insufficient-balance reply into
// `BillingError` / `billing_exhausted`; the web never reads the 402 text.
export type RuntimeErrorKind = "notLoggedIn" | "notInstalled" | "authFailed" | "toolArgsInvalid" | "rootPrivileges" | "billingExhausted";

const PATTERNS: readonly { kind: RuntimeErrorKind; re: RegExp }[] = [
  { kind: "notLoggedIn", re: /is not logged in/i },
  { kind: "notInstalled", re: /not installed/i },
  { kind: "authFailed", re: /(?:auth(?:entication|orization)? (?:failed|error|invalid)|invalid api key|unauthorized)/i },
];

/**
 * Text patterns, for a viewer the server sends the error text to (the agent's
 * managers) and only when the error has no code (#wg-rbac:#57): members get
 * no text, and a code always wins.
 */
export function classifyRuntimeError(message: string): RuntimeErrorKind | null {
  for (const { kind, re } of PATTERNS) {
    if (re.test(message)) return kind;
  }
  return null;
}

/** Prefer the persisted diagnostic over text matching; unknown carriers fall back. */
export function classifyTypedRuntimeError(
  error: { errorReason?: string; errorClass?: string } | null,
): RuntimeErrorKind | null {
  if (!error) return null;
  if (error.errorReason === "root_privileges") return "rootPrivileges";
  if (error.errorReason === "auth_failed" || error.errorClass === "AuthError") return "authFailed";
  if (error.errorReason === "model_tool_args_invalid" || error.errorClass === "ToolArgumentParseError") return "toolArgsInvalid";
  if (error.errorReason === "billing_exhausted" || error.errorClass === "BillingError") return "billingExhausted";
  return null;
}

// #wg-rbac:#57: the server sends every viewer the error's code (a closed list,
// RUNTIME_ERROR_CODES) and sends members no error text at all, so the code is
// what classifies. Copy comes from the catalog per code: a short title (status
// rows), the sentence a member reads, and the sentence the agent's managers
// (creator, editAgents) read above the scrubbed detail. An unknown code (a
// newer server) is no code: the generic fallback.
export function classifyRuntimeErrorCode(code: unknown): RuntimeErrorCode | null {
  return isRuntimeErrorCode(code) ? code : null;
}

export const RUNTIME_ERROR_CODE_MESSAGE_ID: Record<RuntimeErrorCode, { title: MessageId; member: MessageId; manager: MessageId }> = {
  usage_limit: { title: "agent.runtimeError.code.usageLimit.title", member: "agent.runtimeError.code.usageLimit.member", manager: "agent.runtimeError.code.usageLimit.manager" },
  billing: { title: "agent.runtimeError.code.billing.title", member: "agent.runtimeError.code.billing.member", manager: "agent.runtimeError.code.billing.manager" },
  model_unavailable: { title: "agent.runtimeError.code.modelUnavailable.title", member: "agent.runtimeError.code.modelUnavailable.member", manager: "agent.runtimeError.code.modelUnavailable.manager" },
  auth_required: { title: "agent.runtimeError.code.authRequired.title", member: "agent.runtimeError.code.authRequired.member", manager: "agent.runtimeError.code.authRequired.manager" },
  network_timeout: { title: "agent.runtimeError.code.networkTimeout.title", member: "agent.runtimeError.code.networkTimeout.member", manager: "agent.runtimeError.code.networkTimeout.manager" },
  input_too_large: { title: "agent.runtimeError.code.inputTooLarge.title", member: "agent.runtimeError.code.inputTooLarge.member", manager: "agent.runtimeError.code.inputTooLarge.manager" },
  message_too_large: { title: "agent.runtimeError.code.messageTooLarge.title", member: "agent.runtimeError.code.messageTooLarge.member", manager: "agent.runtimeError.code.messageTooLarge.manager" },
};

export const RUNTIME_ERROR_LABEL_ID: Record<RuntimeErrorKind, MessageId> = {
  rootPrivileges: "agent.runtimeError.rootPrivileges",
  notLoggedIn: "agent.runtimeError.notLoggedIn",
  notInstalled: "agent.runtimeError.notInstalled",
  authFailed: "agent.runtimeError.authFailed",
  toolArgsInvalid: "agent.runtimeError.toolArgsInvalid",
  // The billing banner's title; the panel adds its body and one action.
  billingExhausted: "agent.runtimeError.billingExhausted",
};

// task #735 — a runtime lookup failure (`runtime_not_found`) now discriminates
// WHY the lookup missed, on both the detect side (`unavailableReason`:
// not_installed/probe_timeout/probe_failed/permission_denied) and the launch
// side (`WindowsLaunchFailureReason`: not_on_path/lookup_timed_out/
// lookup_permission_denied/lookup_failed). Only a confirmed miss may keep the
// install-guidance copy; timeouts, permission denials and unresolved failures
// each get their own arm, and an absent reason (old daemon) is unresolved too
// — uncertainty never collapses into "install it".
export type RuntimeLookupDisplay = "confirmed_missing" | "timeout" | "permission_denied" | "unconfirmed";

export function runtimeLookupDisplayForReason(reason: string | null | undefined): RuntimeLookupDisplay {
  switch (reason) {
    // Detect: probe found no executable. Launch: the locator answered
    // CommandNotFoundException (exit 3) — a genuine miss, not a failed check.
    case "not_installed":
    case "not_on_path":
      return "confirmed_missing";
    case "probe_timeout":
    case "lookup_timed_out":
      return "timeout";
    case "permission_denied":
    case "lookup_permission_denied":
      return "permission_denied";
    // probe_failed / lookup_failed / absent (old daemon) / unknown value.
    default:
      return "unconfirmed";
  }
}

/** Catalog ids for the agent page's banner, each with a `{runtimeName}`. */
export const RUNTIME_LOOKUP_DISPLAY_MESSAGE_ID: Record<RuntimeLookupDisplay, MessageId> = {
  // #proj-runtime:#32: a confirmed miss names the runtime and the ways out, as the owner's notice does.
  confirmed_missing: "agent.runtimeError.notInstalledNamed",
  timeout: "agent.runtimeModels.runtimeLookupTimeout",
  permission_denied: "agent.runtimeModels.runtimeLookupPermissionDenied",
  unconfirmed: "agent.runtimeModels.runtimeLookupUnresolved",
};
