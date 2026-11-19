import type { RuntimeAccountUsageProvider, RuntimeAuthStatus } from "@botiverse/raft-shared";
import type { RuntimeAuthView } from "../../utils/runtimeAuthClient";

/**
 * What the usage card offers this viewer about Claude limit resets
 * (claude_limit_reset; docs/contracts/runtime-account-usage.md). Null: the
 * card shows nothing about them.
 *
 * Only the person who connected the Computer can use its Claude resets
 * (`claudeLimitResetAccess.canUse`). An owner or admin who did not connect it
 * may still read the list where the server lets them, so they get
 * `view_only`: "View available resets" and a list with nothing to press.
 * At the 5-hour limit the read needs a consent that can spend the 5-hour
 * reset, which is the connecting person's alone to give: there they get no
 * entry, rather than a button beside a sentence explaining why it leads
 * nowhere. `canUse` alone decides it; `canConsent` is never read, so a
 * person who cannot use a reset is never offered the consent step. An older
 * server does not send the field: offered as usable, and its routes still
 * decide (a refused attempt answers `claude_limit_reset_owner_only`).
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
  /** The card's usage shows the account at its 5-hour limit: a read there needs the connecting person's consent. */
  atFiveHourLimit: boolean;
  /** This Computer answered that Claude limit resets cannot run there (macOS). */
  notSupportedHere: boolean;
}): ClaudeLimitResetOffer | null {
  if (provider !== "claude" || !flagOn || !canActOnRuntimes || authStatus?.kind === "logged_out") return null;
  if (authView?.claudeLimitResets !== "ok" || notSupportedHere) return null;
  if (authView.claudeLimitResetAccess?.canUse !== false) return "ok";
  return atFiveHourLimit ? null : "view_only";
}
