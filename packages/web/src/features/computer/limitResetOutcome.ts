import type { RuntimeAccountUsageSnapshot, RuntimeLimitResetResult } from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages/en";
import { runtimeAuthRequestError } from "../../utils/runtimeAuthClient";

/**
 * What a confirmed limit-reset click learned. `result` null: the request
 * itself failed (timeout, offline, refused), so nothing is known about the
 * account. The card re-reads usage after any of them instead of assuming the
 * limits recovered.
 */
export interface RuntimeLimitResetOutcome {
  result: RuntimeLimitResetResult | null;
  snapshot: RuntimeAccountUsageSnapshot | null;
}

/** The outcomes that end the attempt for good: the next click is a new attempt with a new key. */
export function limitResetOutcomeIsSettled(result: RuntimeLimitResetResult | null): boolean {
  return result !== null && result.kind !== "unknown";
}

/** What the card says after an outcome the dialog closes on. */
export function limitResetNoteMessageId(result: RuntimeLimitResetResult): MessageId | null {
  switch (result.kind) {
    case "reset": return "machine.runtimeUsage.limitReset.done";
    case "nothing_to_reset": return "machine.runtimeUsage.limitReset.nothingToReset";
    case "no_reset": return "machine.runtimeUsage.limitReset.noReset";
    case "already_redeemed": return "machine.runtimeUsage.limitReset.alreadyRedeemed";
    default: return null;
  }
}

/** What the dialog says, staying open, after an outcome the person has to act on. */
export function limitResetFailureMessageId(result: RuntimeLimitResetResult): MessageId | null {
  switch (result.kind) {
    case "reauth_required": return "machine.runtimeUsage.limitReset.reauth";
    case "unsupported":
      return result.reason === "not_installed" ? "machine.runtimeAuth.error.notInstalled" : "machine.runtimeUsage.limitReset.unsupported";
    case "unknown": return "machine.runtimeUsage.limitReset.unknown";
    default: return null;
  }
}

/** Why a limit-reset request itself failed (Codex and Claude). */
export function limitResetRequestErrorMessageId(error: unknown): MessageId {
  const { status, code } = runtimeAuthRequestError(error);
  if (code === "claude_limit_reset_owner_only") return "machine.runtimeUsage.claudeReset.ownerOnly";
  if (status === 403) return "machine.runtimeUsage.limitReset.forbidden";
  if (code === "computer_offline") return "machine.runtimeAuth.error.computerOffline";
  if (code === "computer_upgrade_required") return "machine.runtimeUsage.limitReset.upgradeRequired";
  if (code === "computer_not_attached") return "machine.runtimeAuth.notAttached";
  // The server refused before sending anything to the Computer: nothing was used.
  if (status === 429) return "machine.runtimeUsage.limitReset.rateLimited";
  if (code === "claude_limit_reset_disabled") return "machine.runtimeUsage.claudeReset.disabled";
  if (status !== null && status >= 400 && status < 500 && status !== 408) return "machine.runtimeUsage.limitReset.refused";
  // A timeout, a server error or a dropped connection: the reset may or may not have been spent.
  return "machine.runtimeUsage.limitReset.unknown";
}

/** Whether a failed limit-reset request may have reached the Computer: a timeout, a server error, no answer at all. */
export function limitResetRequestOutcomeUnknown(error: unknown): boolean {
  const { status } = runtimeAuthRequestError(error);
  return status === null || status === 408 || status >= 500;
}
