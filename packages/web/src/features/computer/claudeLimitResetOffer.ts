import type { RuntimeAccountUsageProvider, RuntimeAuthStatus } from "@botiverse/raft-shared";
import type { RuntimeAuthView } from "../../utils/runtimeAuthClient";

/**
 * What the usage card offers this viewer about Claude limit resets
 * (claude_limit_reset_v2; docs/contracts/runtime-account-usage.md). Null: the
 * card shows nothing about them.
 *
 * Whoever may act on the Computer's runtimes (the person who connected it, or
 * a server owner or admin) can use its Claude resets, as its Codex resets:
 * the server sends `claudeLimitResetAccess.canUse` true to all of them. An
 * older server sent it false to an owner or admin who did not connect the
 * Computer; for that viewer the card still answers `view_only` ("View
 * available resets" and a list with nothing to press) below the 5-hour
 * limit, and no entry at it, where the read needs a consent that can spend
 * the 5-hour reset. `canUse` alone decides it; `canConsent` is never read, so
 * a person who cannot use a reset never sends a read with consent. A server
 * that does not send the field: offered as usable, and its routes decide.
 *
 * A Computer whose daemon lacks the capability (`computer_upgrade_required`)
 * is offered to no one: the card has nothing to draw for it.
 */
export type ClaudeLimitResetOffer = "ok" | "view_only";

export function claudeLimitResetOffer({
  provider,
  flagOn,
  canActOnRuntimes,
  authStatus,
  authView,
  atFiveHourLimit,
  notSupportedHere,
}: {
  provider: RuntimeAccountUsageProvider | null;
  flagOn: boolean;
  canActOnRuntimes: boolean;
  authStatus: Pick<RuntimeAuthStatus, "kind"> | null;
  authView: Pick<RuntimeAuthView, "claudeLimitResets" | "claudeLimitResetAccess"> | null;
  /** The card's usage shows the account at its 5-hour limit: a read there needs the viewer's consent. */
  atFiveHourLimit: boolean;
  /** This Computer answered that Claude limit resets cannot run there (macOS). */
  notSupportedHere: boolean;
}): ClaudeLimitResetOffer | null {
  if (provider !== "claude" || !flagOn || !canActOnRuntimes || authStatus?.kind === "logged_out") return null;
  if (authView?.claudeLimitResets !== "ok" || notSupportedHere) return null;
  if (authView.claudeLimitResetAccess?.canUse !== false) return "ok";
  return atFiveHourLimit ? null : "view_only";
}
