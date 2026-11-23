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
 * nothing-was-attempted, a missing Claude Code, `consent_required`,
 * `capability_unavailable` (a kind this account cannot use here yet: Claude
 * Code's flags do not show the newer reset program), or
 * `onboarding_required` (Claude Code's first-run setup is unfinished there).
 */
export function claudeLimitResetsNotSupportedHere(result: RuntimeLimitResetResult | RuntimeLimitResetsReadResult): boolean {
  if (result.kind !== "unsupported") return false;
  switch (result.reason) {
    case "not_attempted":
    case "onboarding_required":
    case "not_installed":
    case "consent_required":
    case "capability_unavailable":
      return false;
    default:
      return true;
  }
}

/**
 * The "cannot run here" sentence for an answer claudeLimitResetsNotSupportedHere
 * accepts. `endpoint_unavailable` is Claude Code answering "Unknown command:
 * /limit-reset": the command is not on for this account in the terminal yet,
 * while claude.ai, Desktop and mobile have "Reset for free" (#otter-lounge:#1).
 */
export function claudeLimitResetsNotSupportedMessageId(result: RuntimeLimitResetResult | RuntimeLimitResetsReadResult): MessageId {
  return result.kind === "unsupported" && result.reason === "endpoint_unavailable"
    ? "machine.runtimeUsage.claudeReset.notEnabledForAccount"
    : "machine.runtimeUsage.claudeReset.notSupportedHere";
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
      // Claude Code stopped at a first-run page the Computer does not answer for the person.
      case "onboarding_required": return formatMessage({ id: "machine.runtimeUsage.claudeReset.onboardingRequired" });
      // The Computer typed nothing: Claude Code does not show this account the newer reset program yet.
      case "capability_unavailable": return formatMessage({ id: "machine.runtimeUsage.claudeReset.notAvailableYet" }, { kind: name });
      default: return formatMessage({ id: claudeLimitResetsNotSupportedMessageId(result) });
    }
  }
  return formatMessage({ id: "machine.runtimeUsage.claudeReset.unknown" });
}

/**
 * What Claude Code showed for one kind, its own way: "2 left · use by Nov 19,
 * 4:59pm" under a confirm (`useBy`), "2 left · until Nov 19, 4:59pm" on a row
 * of the list (`until`). Only what the read said; no date is made up.
 */
export function claudeKindMeta(
  formatMessage: IntlShape["formatMessage"],
  status: RuntimeLimitResetKindStatus,
  deadline: "useBy" | "until" = "useBy",
): string {
  switch (status.state) {
    case "available": {
      const parts: string[] = [];
      if (status.resetsLeft !== undefined) parts.push(formatMessage({ id: "machine.runtimeUsage.claudeReset.state.left" }, { count: status.resetsLeft }));
      else parts.push(formatMessage({ id: "machine.runtimeUsage.claudeReset.state.available" }));
      if (status.expiresText) {
        parts.push(formatMessage({ id: deadline === "until" ? "machine.runtimeUsage.claudeReset.state.until" : "machine.runtimeUsage.claudeReset.state.useBy" }, { date: status.expiresText }));
      }
      return parts.join(" · ");
    }
    case "none": return formatMessage({ id: "machine.runtimeUsage.claudeReset.state.none" });
    case "not_checked": return formatMessage({ id: "machine.runtimeUsage.claudeReset.state.notChecked" });
    case "not_offered": return formatMessage({ id: "machine.runtimeUsage.claudeReset.state.notOffered" });
    default: return formatMessage({ id: "machine.runtimeUsage.claudeReset.state.unknown" });
  }
}

/** "Kept your weekly reset · nothing was used · use by …": the person said "No, keep it" before anything was sent. */
export function claudeLimitResetKeptNote(
  formatMessage: IntlShape["formatMessage"],
  kind: RuntimeLimitResetKind,
  status: RuntimeLimitResetKindStatus | null,
): string {
  const kept = formatMessage({ id: "machine.runtimeUsage.claudeReset.kept" }, { kind: claudeKindName(formatMessage, kind) });
  return status?.state === "available" && status.expiresText
    ? `${kept} · ${formatMessage({ id: "machine.runtimeUsage.claudeReset.state.useBy" }, { date: status.expiresText })}`
    : kept;
}

export type ClaudeLimitResetAvailable = Extract<RuntimeLimitResetKindStatus, { state: "available" }>;

/**
 * What comes after a read, as Claude Code's bare `/limit-reset` goes on
 * (docs/contracts/runtime-account-usage.md, "Limit resets (Claude, server and
 * web)"): on Claude's older program the read itself was the command, so it
 * ends with a line (`fiveHourSpent`: it used the 5-hour reset); on the newer
 * one, one usable kind goes straight to its confirm, several to the choice,
 * none ends with a line. At the 5-hour limit only a 5-hour reset is usable from
 * here (the Computer types no other command there); the line says where the
 * others are.
 */
export type ClaudeLimitResetReadStep =
  | { step: "note"; messageId: MessageId; usageChanged: boolean }
  | { step: "confirm"; status: ClaudeLimitResetAvailable }
  | { step: "choose"; usable: ClaudeLimitResetAvailable[] };

export function claudeLimitResetReadStep(
  result: Extract<RuntimeLimitResetsReadResult, { kind: "read" }>,
  atFiveHourLimit: boolean,
): ClaudeLimitResetReadStep {
  if (result.fiveHourSpent) return { step: "note", messageId: "machine.runtimeUsage.claudeReset.legacyReset", usageChanged: true };
  if (result.program === "legacy") {
    const fiveHour = result.resets.find((reset) => reset.kind === "five_hour");
    // Only what the read shows: a 5-hour reset still held below the limit was kept; at the
    // limit, opening the command is the spend, so anything but "none" is unconfirmed.
    const messageId: MessageId = fiveHour?.state === "none"
      ? "machine.runtimeUsage.claudeReset.legacyUsed"
      : fiveHour?.state === "available" && !atFiveHourLimit
        ? "machine.runtimeUsage.claudeReset.legacyKept"
        : "machine.runtimeUsage.claudeReset.legacyUnconfirmed";
    return { step: "note", messageId, usageChanged: messageId === "machine.runtimeUsage.claudeReset.legacyUnconfirmed" };
  }
  const available = result.resets.filter((reset): reset is ClaudeLimitResetAvailable => reset.state === "available");
  const usable = available.filter((reset) => !atFiveHourLimit || reset.kind === "five_hour");
  if (usable.length === 1) return { step: "confirm", status: usable[0]! };
  if (usable.length > 1) return { step: "choose", usable };
  const fiveHourUnread = result.resets.some((reset) => reset.kind === "five_hour" && reset.state === "unknown");
  if (available.length > 0 && !fiveHourUnread) return { step: "note", messageId: "machine.runtimeUsage.claudeReset.noneAtLimit", usageChanged: false };
  if (result.resets.some((reset) => reset.state === "unknown")) return { step: "note", messageId: "machine.runtimeUsage.claudeReset.readFailed", usageChanged: false };
  return { step: "note", messageId: "machine.runtimeUsage.claudeReset.noneToUse", usageChanged: false };
}
