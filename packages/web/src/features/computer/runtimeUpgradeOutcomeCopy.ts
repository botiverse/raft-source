import { RUNTIME_UPDATE_CHECK_MANAGED_ELSEWHERE_REASONS } from "@botiverse/raft-shared";
import type { RuntimeUpdateCheck, RuntimeUpgradeResult } from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages/en";

/**
 * Upgrade on the web (docs/contracts/runtime-auth.md, "Upgrade"): what one
 * press of Upgrade has learned so far. `refused`: the request itself did not
 * get an outcome from the Computer (too old for it, offline, no answer in
 * time, too many upgrades by this person on this Computer, or another failure).
 */
export type RuntimeUpgradeState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: RuntimeUpgradeResult }
  | { kind: "refused"; reason: "computer_upgrade_required" | "computer_offline" | "computer_timeout" | "rate_limited" | "failed" };

/** The sentence an outcome reads as, with its values (`runtime` is added by the caller), and its tone. */
export interface RuntimeUpgradeCopy {
  id: MessageId;
  values?: Record<string, string>;
  tone: "success" | "warning";
}

/** One plain sentence per outcome; null while nothing is known yet (idle or running). */
export function runtimeUpgradeCopy(state: RuntimeUpgradeState): RuntimeUpgradeCopy | null {
  if (state.kind === "idle" || state.kind === "running") return null;
  if (state.kind === "refused") {
    switch (state.reason) {
      case "computer_upgrade_required": return { id: "machine.runtimeUpgrade.computerTooOld", tone: "warning" };
      case "computer_offline": return { id: "machine.runtimeUpgrade.computerOffline", tone: "warning" };
      case "computer_timeout": return { id: "machine.runtimeUpgrade.timeout", tone: "warning" };
      // Pressing again won't help for a while, so this is not "try again".
      case "rate_limited": return { id: "machine.runtimeAuth.provider.error.rateLimited", tone: "warning" };
      case "failed": return { id: "machine.runtimeUpgrade.error", tone: "warning" };
    }
  }
  const result = state.result;
  switch (result.kind) {
    case "upgraded":
      return result.from && result.to
        ? { id: "machine.runtimeUpgrade.upgradedFromTo", values: { from: result.from, to: result.to }, tone: "success" }
        : { id: "machine.runtimeUpgrade.upgraded", tone: "success" };
    case "current":
      return result.version
        ? { id: "machine.runtimeUpgrade.currentVersion", values: { version: result.version }, tone: "success" }
        : { id: "machine.runtimeUpgrade.current", tone: "success" };
    case "unchanged": return { id: "machine.runtimeUpgrade.unchanged", tone: "warning" };
    case "failed": return { id: "machine.runtimeUpgrade.failed", tone: "warning" };
    case "unsupported":
      return { id: result.reason === "requires_terminal" ? "machine.runtimeUpgrade.requiresTerminal" : "machine.runtimeUpgrade.unsupportedInstallation", tone: "warning" };
    case "not_installed": return { id: "machine.runtimeAuth.error.notInstalled", tone: "warning" };
    case "error": return { id: result.code === "in_progress" ? "machine.runtimeUpgrade.inProgress" : "machine.runtimeUpgrade.error", tone: "warning" };
  }
}

/**
 * The request's own failure, by the server's code: what the person is told.
 * Only the server's 504 `computer_timeout` says the upgrade may still finish;
 * its 429 `rate_limited` (runtimeAuthRoutes.ts: upgrades per person and
 * Computer) says to wait rather than press again.
 */
export function runtimeUpgradeRefusal(code: string | null): Extract<RuntimeUpgradeState, { kind: "refused" }>["reason"] {
  return code === "computer_upgrade_required" || code === "computer_offline" || code === "computer_timeout" || code === "rate_limited" ? code : "failed";
}

/**
 * The card's line for the Computer's update check (docs/contracts/runtime-auth.md
 * §6d), in place of the bare version: "1.5.10 → 1.5.11 available", "1.5.11 ·
 * Latest", that its updates are managed outside Raft (a package manager,
 * updates turned off), or that it could not check. Null with no check (an older Computer
 * or server): the card shows the bare version as before.
 */
export function runtimeUpdateCheckCopy(update: RuntimeUpdateCheck | null, version: string | null): { id: MessageId; values?: Record<string, string> } | null {
  if (!update) return null;
  if (update.kind === "ok") {
    return update.updateAvailable
      ? { id: "machine.runtimeUpgrade.updateAvailable", values: { installed: update.installed, latest: update.latest } }
      : { id: "machine.runtimeUpgrade.latest", values: { version: update.installed } };
  }
  // A deliberate choice (a package manager, updates turned off): not a failure to check.
  if ((RUNTIME_UPDATE_CHECK_MANAGED_ELSEWHERE_REASONS as readonly string[]).includes(update.reason)) {
    return version ? { id: "machine.runtimeUpgrade.managedElsewhereVersion", values: { version } } : { id: "machine.runtimeUpgrade.managedElsewhere" };
  }
  return version ? { id: "machine.runtimeUpgrade.checkUnavailableVersion", values: { version } } : { id: "machine.runtimeUpgrade.checkUnavailable" };
}

/**
 * Whether the card shows Upgrade where it is offered: when the Computer found
 * a newer version, or said nothing (an older Computer or server: as before);
 * not when it is the latest or the check failed. Always while one runs, and
 * for a CLI too old to sign in (known outdated, as on the sign-in notice).
 */
export function runtimeUpgradeButtonShown(update: RuntimeUpdateCheck | null, state: RuntimeUpgradeState, tooOld: boolean): boolean {
  if (state.kind === "running" || tooOld || !update) return true;
  return update.kind === "ok" && update.updateAvailable;
}
