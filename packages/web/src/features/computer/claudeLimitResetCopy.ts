import type { RuntimeLimitResetKind, RuntimeLimitResetKindStatus, RuntimeLimitResetResult, RuntimeLimitResetsReadResult } from "@botiverse/raft-shared";
import type { IntlShape } from "react-intl";
import type { MessageId } from "../../i18n/messages/en";

// What the Claude limit-reset dialogs and the card say (ClaudeLimitResetsDialog).

export const CLAUDE_LIMIT_RESET_KIND_MESSAGE: Record<RuntimeLimitResetKind, MessageId> = {
  five_hour: "machine.runtimeUsage.claudeReset.kind.five_hour",
  weekly: "machine.runtimeUsage.claudeReset.kind.weekly",
  fable: "machine.runtimeUsage.claudeReset.kind.fable",
  full: "machine.runtimeUsage.claudeReset.kind.full",
};

export function claudeKindName(formatMessage: IntlShape["formatMessage"], kind: RuntimeLimitResetKind): string {
  return formatMessage({ id: CLAUDE_LIMIT_RESET_KIND_MESSAGE[kind] });
}

/**
 * What the card says once a Claude redeem has an answer the dialog closes on.
 * Null: the dialog stays open and says why nothing was used.
 */
export function claudeLimitResetNote(
  formatMessage: IntlShape["formatMessage"],
  kind: RuntimeLimitResetKind,
  result: RuntimeLimitResetResult,
): string | null {
  const name = claudeKindName(formatMessage, kind);
  switch (result.kind) {
    case "reset": return formatMessage({ id: "machine.runtimeUsage.claudeReset.done" }, { kind: name });
    case "nothing_to_reset": return formatMessage({ id: "machine.runtimeUsage.limitReset.nothingToReset" });
    case "no_reset": return formatMessage({ id: "machine.runtimeUsage.claudeReset.noReset" }, { kind: name });
    case "already_redeemed": return formatMessage({ id: "machine.runtimeUsage.limitReset.alreadyRedeemed" });
    // Never retried for the person: Claude Code's own /usage says what happened.
    case "unknown": return result.fiveHourSpent
      ? formatMessage({ id: "machine.runtimeUsage.claudeReset.fiveHourSpent" }, { kind: name })
      : formatMessage({ id: "machine.runtimeUsage.claudeReset.unknown" });
    default: return null;
  }
}

/**
 * The Computer answered that Claude limit resets cannot run there at all (OAR:
 * macOS is `unsupported_platform`, a Claude Code without the command
 * `endpoint_unavailable`, an installation or version it cannot drive): the
 * card stops offering them and says "not supported on this Computer", never
 * "upgrade" (that is only for a Computer without the capability). Not for
 * nothing-was-attempted, a missing Claude Code, the consent step, or
 * `capability_unavailable` (a kind this account cannot use here yet: Claude
 * Code's flags do not show the newer reset program).
 */
export function claudeLimitResetsNotSupportedHere(result: RuntimeLimitResetResult | RuntimeLimitResetsReadResult): boolean {
  if (result.kind !== "unsupported") return false;
  switch (result.reason) {
    case "not_attempted":
    case "not_installed":
    case "consent_required":
    case "capability_unavailable":
      return false;
    default:
      return true;
  }
}

/** Why nothing was used, for an answer the confirm stays open on. */
export function claudeLimitResetRefusal(
  formatMessage: IntlShape["formatMessage"],
  kind: RuntimeLimitResetKind,
  result: RuntimeLimitResetResult,
  atFiveHourLimit: boolean,
): string {
  const name = claudeKindName(formatMessage, kind);
  if (result.kind === "reauth_required") return formatMessage({ id: "machine.runtimeUsage.limitReset.reauth" }, { runtime: "Claude Code" });
  if (result.kind === "unsupported") {
    switch (result.reason) {
      case "not_attempted":
        // At the 5-hour limit the Computer types only a 5-hour command (Claude's older program would spend it).
        return atFiveHourLimit && kind !== "five_hour"
          ? formatMessage({ id: "machine.runtimeUsage.claudeReset.notAttemptedAtLimit" }, { kind: name })
          : formatMessage({ id: "machine.runtimeUsage.claudeReset.notAttempted" });
      case "not_installed": return formatMessage({ id: "machine.runtimeAuth.error.notInstalled" }, { runtime: "Claude Code" });
      // The Computer typed nothing: Claude Code does not show this account the newer reset program yet.
      case "capability_unavailable": return formatMessage({ id: "machine.runtimeUsage.claudeReset.notAvailableYet" }, { kind: name });
      default: return formatMessage({ id: "machine.runtimeUsage.claudeReset.notSupportedHere" });
    }
  }
  return formatMessage({ id: "machine.runtimeUsage.claudeReset.unknown" });
}

export function claudeKindMeta(formatMessage: IntlShape["formatMessage"], status: RuntimeLimitResetKindStatus): string {
  switch (status.state) {
    case "available": {
      const parts: string[] = [];
      if (status.resetsLeft !== undefined) parts.push(formatMessage({ id: "machine.runtimeUsage.claudeReset.state.left" }, { count: status.resetsLeft }));
      else parts.push(formatMessage({ id: "machine.runtimeUsage.claudeReset.state.available" }));
      if (status.expiresText) parts.push(formatMessage({ id: "machine.runtimeUsage.claudeReset.state.useBy" }, { date: status.expiresText }));
      return parts.join(" · ");
    }
    case "none": return formatMessage({ id: "machine.runtimeUsage.claudeReset.state.none" });
    case "not_checked": return formatMessage({ id: "machine.runtimeUsage.claudeReset.state.notChecked" });
    case "not_offered": return formatMessage({ id: "machine.runtimeUsage.claudeReset.state.notOffered" });
    default: return formatMessage({ id: "machine.runtimeUsage.claudeReset.state.unknown" });
  }
}
