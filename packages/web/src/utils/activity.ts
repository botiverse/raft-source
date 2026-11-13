import { currentTimeMs, GENERIC_RUNTIME_ERROR_MESSAGE, getModelLabel, getRuntimeDisplayName } from "@botiverse/raft-shared";
import type { AgentActivity, AgentActivityDetailKind, AgentRuntimeErrorState, RuntimeErrorCode, CredentialHoldActivityDiagnostic, CredentialHoldReason, SpawnFailureActivityDiagnostic, SpawnFailureReason } from "@botiverse/raft-shared";
import { createIntl, createIntlCache } from "react-intl";
import type { Presence } from "@botiverse/raft-ui";
import type { IntlShape } from "react-intl";
import type { MessageId } from "../i18n/messages";
import { enFallbackMessages } from "../i18n/messages/enFallback";
import { formatRelativeTime } from "./relativeTime";
import { calendarDayKey, formatClock, formatShortDateTime } from "./timeFormatting";
import type { TimeFormatOptions } from "./timeFormatting";
import type { AgentBlockedState } from "./agentBlockedState";
import { classifyRuntimeErrorCode, RUNTIME_ERROR_CODE_MESSAGE_ID } from "./classifyRuntimeError";

export type ActivityMessageValues = Record<string, string | number>;

export interface ActivityMessageDescriptor {
  id: MessageId;
  values?: ActivityMessageValues;
}

export interface ActivityTextDescriptor {
  primary: ActivityMessageDescriptor | { raw: string };
}

/**
 * The daemon's English titles for an action it held until the agent reads
 * newer messages (shared `projectApmHeldFreshnessActivity`). That is the
 * normal flow, so the web says what the agent is doing instead (xxchan).
 */
const FRESHNESS_HOLD_LABELS: Record<string, MessageId> = {
  "Send held by freshness check": "activity.log.freshnessHold.send",
  "Task claim held by freshness check": "activity.log.freshnessHold.taskClaim",
  "Task amendment held by freshness check": "activity.log.freshnessHold.taskAmend",
  "Task update held by freshness check": "activity.log.freshnessHold.taskUpdate",
};

/**
 * The hold's body as the daemon writes it ("target: #x", "new messages: 3
 * newer messages", ...) read back as the count and the target, so the log can
 * say "3 new messages in #x". Null when it does not read as one.
 */
export function parseFreshnessHoldText(text: string): { count: number; target: string } | null {
  const target = text.match(/^target: (.+)$/m)?.[1]?.trim();
  const count = text.match(/^new messages: (\d+) newer/m)?.[1] ?? text.match(/^unreviewed synced context for this target: (\d+)/m)?.[1];
  return target && count !== undefined ? { count: Number(count), target } : null;
}

/** The label for a freshness hold's title, or null for any other text. */
export function freshnessHoldLabelId(title: string | undefined): MessageId | null {
  return title ? FRESHNESS_HOLD_LABELS[title.trim()] ?? null : null;
}

const enActivityIntl = createIntl(
  { locale: "en", defaultLocale: "en", messages: enFallbackMessages },
  createIntlCache(),
);

/**
 * The Raft Design System presence light an agent activity shows (raft-ui
 * `Presence`, drawn by raft-ui `Status presence`): thinking and working are
 * busy yellow, error orange, online lime, offline stone.
 *
 * Static: an ambient state never loops (task #136). An infinite pulse kept
 * the compositor producing frames at display refresh rate for as long as any
 * agent worked — measured 144 fps / 80% GPU with a modal open vs 2 fps / 3%
 * with the dots paused. Busy yellow alone distinguishes it.
 */
export function activityPresence(activity: AgentActivity): Presence {
  switch (activity) {
    case "online":
      return "online";
    case "thinking":
    case "working":
      return "busy";
    case "error":
      return "error";
    case "offline":
    default:
      return "offline";
  }
}

function extractErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message.trim();
  }
  if (typeof record.error_description === "string" && record.error_description.trim()) {
    return record.error_description.trim();
  }
  if (typeof record.error === "string" && record.error.trim()) {
    return record.error.trim();
  }
  const nested = extractErrorMessage(record.error);
  if (nested) return nested;
  if (Array.isArray(record.errors)) {
    for (const item of record.errors) {
      const message = extractErrorMessage(item);
      if (message) return message;
    }
  }
  return null;
}

export function getActivityErrorDisplayDetail(detail?: string): string {
  const trimmed = detail?.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const message = extractErrorMessage(JSON.parse(trimmed));
      if (message) return message;
    } catch {
      // Fall through to the raw detail below.
    }
  }
  return trimmed;
}

export function getActivityTextDescriptor(
  activity: AgentActivity,
  detail?: string,
  detailKind?: AgentActivityDetailKind,
  /** #wg-rbac:#57: the error's code (`errorCode` / `activityErrorCode`), read only for an error. */
  errorCode?: RuntimeErrorCode | null,
): ActivityTextDescriptor {
  if (detailKind === "claude_root_privileges") {
    return { primary: { id: "agent.runtimeError.rootPrivileges" } };
  }
  // task #1116: the daemon observed deliveries it wrote that the runtime never
  // consumed. Dedicated copy regardless of the carried activity kind, so the
  // reader sees the observation rather than a misleading "Idle".
  if (detailKind === "delivery_unconsumed") {
    return { primary: { id: "activity.status.deliveryUnconsumed" } };
  }
  if (detailKind === "freshness_hold") {
    return { primary: { id: freshnessHoldLabelId(detail) ?? "activity.log.freshnessHold.send" } };
  }
  // task #1119: the server paused automatic wakes after consecutive early
  // exits; only a manual start lifts it, so say that instead of "Offline".
  if (detailKind === "wake_crash_loop_blocked") {
    return { primary: { id: "activity.status.wakeCrashLoopBlocked" } };
  }
  // RFC 071 §9: the terminal-failure breaker stopped automatic wakes. The
  // server's detail says until when (or that a manual start is needed) and
  // why; without it, the generic copy.
  if (detailKind === "terminal_failure_paused") {
    return { primary: detail ? { raw: detail } : { id: "activity.status.terminalFailurePaused" } };
  }
  switch (activity) {
    case "online":
      return { primary: { id: "activity.status.online" } };
    case "thinking":
      return { primary: { id: "activity.status.thinkingEllipsis" } };
    case "working":
      if (detailKind === "starting" || detailKind === "runtime_starting") {
        return { primary: { id: "activity.status.startingEllipsis" } };
      }
      if (detailKind === "compacting_context") {
        return { primary: { id: "activity.status.compactingContextEllipsis" } };
      }
      return { primary: detail ? { raw: detail } : { id: "activity.status.workingEllipsis" } };
    case "error": {
      // #wg-rbac:#57: a coded error reads as its title for every viewer (the
      // managers' detail is in the agent's banner). An uncoded error a member
      // reads arrives as the server's fixed generic line: shown as the catalog's.
      const code = classifyRuntimeErrorCode(errorCode);
      if (code) return { primary: { id: RUNTIME_ERROR_CODE_MESSAGE_ID[code].title } };
      const errorDetail = getActivityErrorDisplayDetail(detail);
      if (errorDetail === GENERIC_RUNTIME_ERROR_MESSAGE) return { primary: { id: "activity.status.agentErrorFallback" } };
      return {
        primary: errorDetail
          ? { id: "activity.status.errorWithDetail", values: { detail: errorDetail } }
          : { id: "activity.status.error" },
      };
    }
    case "offline":
      // task #1123: a failed start is reported as offline + runtime_unavailable
      // with a human detail chosen by the daemon's typed reason. The activity
      // log must show that detail, not collapse it into a bare "Offline".
      if (detailKind === "runtime_unavailable" && detail) {
        return { primary: { raw: detail } };
      }
      return {
        primary: {
          id: detailKind === "stopped"
            ? "activity.status.stoppedUnavailable"
            : "activity.status.offline",
        },
      };
    default:
      return { primary: { raw: activity } };
  }
}

export function formatActivityTextDescriptor(
  formatMessage: IntlShape["formatMessage"],
  descriptor: ActivityTextDescriptor,
): string {
  const { primary } = descriptor;
  if ("raw" in primary) return primary.raw;
  return String(formatMessage({ id: primary.id }, primary.values));
}

export function formatActivityText(
  formatMessage: IntlShape["formatMessage"],
  activity: AgentActivity,
  detail?: string,
  detailKind?: AgentActivityDetailKind,
  errorCode?: RuntimeErrorCode | null,
): string {
  return formatActivityTextDescriptor(
    formatMessage,
    getActivityTextDescriptor(activity, detail, detailKind, errorCode),
  );
}

/** Status text for an agent held from running (`AgentDisplayState.blocked`). */
export function formatAgentBlockedText(
  formatMessage: IntlShape["formatMessage"],
  blocked: AgentBlockedState,
): string {
  switch (blocked) {
    case "computer_too_old":
      return String(formatMessage({ id: "agent.status.computerTooOld" }));
    case "computer_access_revoked":
      return String(formatMessage({ id: "agent.status.computerAccessRevoked" }));
    case "computer_offline":
      return String(formatMessage({ id: "agent.status.computerOffline" }));
  }
}

/** The display-state fields `formatAgentDisplayStateText` reads. */
export interface AgentDisplayTextInput {
  /** No state yet, guessed from `status: "active"` (agentStore resolveAgentDisplayState). */
  likelyOnline?: true;
  activity: AgentActivity;
  activityDetail: string;
  activityDetailKind: AgentActivityDetailKind;
  isOnline: boolean;
  isExternal?: boolean;
  lastSeenAt?: string | null;
  blocked?: AgentBlockedState;
  paused?: true;
  /** #wg-rbac:#57: the error's code, while the activity is an error. */
  activityErrorCode?: RuntimeErrorCode;
}

/**
 * Localized status text for an agent display state. Same as
 * `formatActivityText`, except an external agent that is not online but was
 * seen before reads "Last active <time ago>".
 * `withDetail: false` withholds the activity detail (public projections).
 */
export function formatAgentDisplayStateText(
  intl: Pick<IntlShape, "formatMessage" | "locale">,
  state: AgentDisplayTextInput,
  options: { withDetail?: boolean } = {},
): string {
  if (state.blocked) return formatAgentBlockedText(intl.formatMessage, state.blocked);
  if (state.likelyOnline) return String(intl.formatMessage({ id: "activity.status.likelyOnline" }));
  if (state.paused) return intl.formatMessage({ id: "assistant.paused.chip" });
  if (state.isExternal && !state.isOnline && state.lastSeenAt) {
    const time = formatRelativeTime(state.lastSeenAt, intl.locale);
    if (time) return String(intl.formatMessage({ id: "activity.status.lastActive" }, { time }));
  }
  return options.withDetail === false
    ? formatActivityText(intl.formatMessage, state.activity, "")
    : formatActivityText(intl.formatMessage, state.activity, state.activityDetail, state.activityDetailKind, state.activityErrorCode);
}

/**
 * Maps agent activity state → full display text (always returns a string).
 * When detail is provided and applicable, shows the granular label.
 *
 * Prefer `getActivityTextDescriptor` at user-visible call sites. This fallback
 * formats through the English catalog so non-React/store consumers stay free of
 * app-locale wiring without reintroducing return-prose literals.
 */
export function getActivityText(activity: AgentActivity, detail?: string, detailKind?: AgentActivityDetailKind, errorCode?: RuntimeErrorCode | null): string {
  return formatActivityText(enActivityIntl.formatMessage, activity, detail, detailKind, errorCode);
}

/**
 * task #1123: the text of a failed start, chosen by its typed reason (never by
 * parsing the daemon's detail). model_not_found has catalog copy; other reasons
 * keep the daemon's user message. While the server has paused automatic
 * restarts, say so and how to lift it. Null when there is nothing to replace.
 */
export function formatSpawnFailureDetail(
  formatMessage: IntlShape["formatMessage"],
  spawnFailure: SpawnFailureActivityDiagnostic | undefined,
  daemonDetail: string,
  /** The viewer's locale, time zone and 12h/24h choice (`useTimeFormatter().options`), for the next try's time. */
  timeOptions: TimeFormatOptions = {},
): string | null {
  if (!spawnFailure) return null;
  // A pause that retries by itself says when, once the server sends the time.
  const retryTime = formatPauseRetryTime(spawnFailure.pauseRetryAtMs, timeOptions);
  // task #10: restarting resumes the same stuck session, so the generic paused
  // copy ("…or restart the agent") would send people the wrong way. Also
  // reported when a new session the daemon started by itself failed the same
  // way (reconciler step 12, row C8), so the copy holds for both.
  if (spawnFailure.reason === "session_needs_reset") {
    return String(formatMessage({ id: "activity.status.sessionNeedsReset" }));
  }
  // task #1307: the fix is the same paused or not (paste the key again), so
  // the reason's own copy replaces the daemon's English text in every locale.
  if (spawnFailure.reason === "provider_api_key_invalid") {
    return String(formatMessage({ id: "activity.status.providerApiKeyInvalid" }));
  }
  // Reconciler step 12: the runtime started and said it cannot use the
  // agent's model (unknown, not turned on, or not in the plan). Only a person
  // gets out of it (another model, a sign-in or plan that has it, or a
  // manual start), so the copy says what to do and nothing about retrying.
  if (spawnFailure.reason === "model_unsupported") {
    return spawnFailure.model
      ? String(formatMessage({ id: "activity.status.modelUnsupported" }, { model: spawnFailure.model }))
      : String(formatMessage({ id: "activity.status.modelUnsupportedDefault" }));
  }
  // Reconciler step 12: the runtime started and kept failing the same way;
  // the server pauses at the first report and tries again by itself after a
  // cooldown (it tells no one, so this status is the only place it shows).
  // The daemon's detail is its own English diagnostic, kept in the log.
  if (spawnFailure.reason === "runtime_repeated_failure") {
    return retryTime
      ? String(formatMessage({ id: "activity.status.repeatedFailurePausedAt" }, { time: retryTime }))
      : String(formatMessage({ id: "activity.status.repeatedFailurePaused" }));
  }
  const detail = spawnFailure.reason === "model_not_found"
    ? String(formatMessage({ id: "activity.status.modelNotFound" }, { model: spawnFailure.model ?? "?" }))
    : daemonDetail;
  if (!spawnFailure.autoRestartPaused) return spawnFailure.reason === "model_not_found" ? detail : null;
  // The computer does not have the runtime: changing the model or restarting
  // will not help, getting the runtime there or switching runtime will.
  if (spawnFailure.reason === "runtime_not_found") {
    return String(formatMessage({ id: "activity.status.runtimeUnavailablePaused" }, { detail }));
  }
  // The server tries a start-timeout pause again by itself after a cooldown.
  if (spawnFailure.reason === "runtime_start_timeout") {
    return retryTime
      ? String(formatMessage({ id: "activity.status.startTimeoutPausedAt" }, { detail, time: retryTime }))
      : String(formatMessage({ id: "activity.status.startTimeoutPaused" }, { detail }));
  }
  return String(formatMessage({ id: "activity.status.autoRestartPaused" }, { detail }));
}

/**
 * When a paused agent's next automatic try starts (`pauseRetryAtMs`): the
 * clock if that is today, otherwise the date and the clock, in the viewer's
 * time zone and 12h/24h choice. Null when there is no time, or it has passed
 * (the try is due; the copy says "later" until the server reports it).
 */
export function formatPauseRetryTime(atMs: number | undefined, options: TimeFormatOptions = {}): string | null {
  if (typeof atMs !== "number" || !Number.isFinite(atMs)) return null;
  const now = options.now ?? new Date(currentTimeMs());
  if (atMs <= now.getTime()) return null;
  const at = new Date(atMs);
  return calendarDayKey(at, options) === calendarDayKey(now, options)
    ? formatClock(at, options)
    : formatShortDateTime(at, options);
}

/**
 * #proj-raft-computer:#48 (reconciler step 4b): why an agent cannot run until
 * someone fixes its provider credential, from typed data only (never the
 * text): its sign-in needs renewing, its plan does not include its model, or
 * the provider balance is exhausted. The daemon holds its deliveries; a
 * manual restart (Retry) tries again.
 *
 * - Its own error: the stored runtime error, while the live activity is that
 *   error (the same message: a stored record describes the error shown, not
 *   an older one). `requiredAction` first; an error stored before that field
 *   (or from an older daemon) falls back to its class: AuthError is a
 *   rejected sign-in, BillingError an exhausted balance.
 * - Held for another agent's error on the same sign-in: the idle status
 *   carries `credentialHold`. An older daemon sends none: Online, as before.
 */
export function credentialInvalidReasonOf(input: {
  activity: AgentActivity;
  activityDetail: string;
  activityDetailKind: AgentActivityDetailKind;
  credentialHold?: CredentialHoldActivityDiagnostic;
  lastRuntimeError?: Pick<AgentRuntimeErrorState, "message" | "errorClass" | "requiredAction"> | null;
}): CredentialHoldReason | null {
  if (input.activity === "online" && input.activityDetailKind === "idle" && input.credentialHold) {
    return input.credentialHold.reason;
  }
  const error = input.lastRuntimeError;
  if (input.activity !== "error" || !error || error.message !== input.activityDetail) return null;
  if (error.requiredAction) return error.requiredAction;
  if (error.errorClass === "AuthError") return "user_reauth";
  if (error.errorClass === "BillingError") return "billing";
  return null;
}

/**
 * Detail kinds of an agent that stays down until someone starts it by hand,
 * though its chip is not the error light (the server projects them offline).
 */
const MANUAL_START_DETAIL_KINDS: ReadonlySet<AgentActivityDetailKind> = new Set<AgentActivityDetailKind>([
  // task #1123: a failed start. The daemon gave up starting it (after
  // repeated runtime_spawn_failed it hands the agent back and the server
  // pauses automatic restarts); a manual restart tries again.
  "runtime_unavailable",
  // task #1119: the wake crash-loop breaker paused automatic wakes after
  // consecutive early exits; only a human start lifts it.
  "wake_crash_loop_blocked",
  // RFC 071 §9: the terminal-failure breaker paused automatic wakes after
  // repeated terminal runtime failures; a manual start lifts it.
  "terminal_failure_paused",
]);

/**
 * Failed starts a restart cannot get out of: it resumes the same session,
 * which fails again. Only Reset Session does (the status copy says so).
 */
const RESTART_CANNOT_FIX_SPAWN_FAILURES: ReadonlySet<SpawnFailureReason> = new Set<SpawnFailureReason>([
  "session_needs_reset",
  "session_runtime_mismatch",
]);

/**
 * Whether the agent cannot run until someone restarts it, so its status
 * badge offers Retry (the menu's Restart) to whoever may restart it:
 *
 * - an invalid credential (`credentialInvalidReasonOf`): held until a restart;
 * - the error light: a runtime error, a stall, or stalled recovery that gave
 *   up (the daemon reports that as `runtime_error`, "restart it to retry").
 *   The daemon does not yet say which errors need a restart, so every error
 *   but a rate limit gets Retry; a turn-end error the next message would also
 *   clear gets it too (a restart there is harmless, only not needed). A rate
 *   limit or quota error never does: a restart cannot lift it and only sends
 *   more requests into the limit;
 * - an offline agent whose automatic starts stopped (MANUAL_START_DETAIL_KINDS):
 *   for a failed start, only once the server has paused automatic restarts
 *   (`autoRestartPaused`, the server's own verdict). Before that the server is
 *   still retrying, and a click would race its start.
 *
 * Never for an agent that is simply offline or stopped (it wakes on its next
 * message), one online or at work, one only guessed online, an external
 * agent (its runtime is not Raft's to restart), or one whose Computer is
 * offline or too old (a restart cannot reach it).
 */
export function agentNeedsManualRestart(input: {
  activity: AgentActivity;
  activityDetailKind: AgentActivityDetailKind;
  credentialReason?: CredentialHoldReason | null;
  spawnFailureReason?: SpawnFailureReason;
  /** The server paused automatic restarts after this failed start (`SpawnFailureActivityDiagnostic.autoRestartPaused`). */
  spawnFailurePaused?: boolean;
  /** The shown runtime error's class (`lastRuntimeError.errorClass`). */
  runtimeErrorClass?: string | null;
  isExternal?: boolean;
  blocked?: AgentBlockedState | null;
  likelyOnline?: true;
}): boolean {
  if (input.isExternal || input.blocked || input.likelyOnline) return false;
  if (input.credentialReason) return true;
  if (input.activity === "error") return input.runtimeErrorClass !== "RateLimitError";
  if (!MANUAL_START_DETAIL_KINDS.has(input.activityDetailKind)) return false;
  if (!input.spawnFailureReason) return true;
  // The other failure reasons (runtime missing, bad config, ...): a restart is
  // still the last step once the cause is fixed, so Retry stays for them.
  return input.spawnFailurePaused === true && !RESTART_CANNOT_FIX_SPAWN_FAILURES.has(input.spawnFailureReason);
}

/** The status text for `credentialInvalidReasonOf`'s reason, naming the agent's runtime or model. */
export function formatCredentialInvalidText(
  formatMessage: IntlShape["formatMessage"],
  reason: CredentialHoldReason,
  agent: { runtime: string; model?: string | null },
): string {
  switch (reason) {
    case "user_reauth":
      return String(formatMessage({ id: "agent.status.credentialInvalid.signIn" }, { runtime: getRuntimeDisplayName(agent.runtime) }));
    case "user_model_access": {
      const model = agent.model?.trim();
      return model
        ? String(formatMessage({ id: "agent.status.credentialInvalid.planModel" }, { model: getModelLabel(agent.runtime, model) }))
        : String(formatMessage({ id: "agent.status.credentialInvalid.planDefaultModel" }));
    }
    case "billing":
      return String(formatMessage({ id: "agent.status.credentialInvalid.billing" }));
  }
}
