import { Spinner, TextLink } from "@botiverse/raft-ui";
import { getRuntimeDisplayName } from "@botiverse/raft-shared";
import type { RuntimeAccountUsageProvider } from "@botiverse/raft-shared";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { runtimeUpdateCheckCopy, runtimeUpgradeButtonShown, runtimeUpgradeCopy } from "../../features/computer/runtimeUpgradeOutcomeCopy";
import type { RuntimeUpgradeState } from "../../features/computer/runtimeUpgradeOutcomeCopy";
import type { SurfaceAuth } from "./RuntimeUsageSurface";

/** Versions in the update-check line, in the bare version line's mono style. */
function monoValues(values: Record<string, string> | undefined): Record<string, ReactNode> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [
    name,
    <span key={name} className="font-mono text-mono-meta">{value}</span>,
  ]));
}

/**
 * Whether Upgrade is offered again after an outcome: only after a failure a
 * second press may fix (the request failed, the Computer was offline, an
 * error other than one already running). Never after it upgraded or found
 * the latest (xxchan: an outcome leaves no button), nor where pressing again
 * would not help: the request timed out (it may still finish there), too many
 * upgrades (wait), a Computer too old for it, an installation it can't
 * upgrade, or a run that failed or left the version unchanged (its sentence
 * says to update it on the Computer).
 */
function upgradeAgainAfter(state: RuntimeUpgradeState): boolean {
  if (state.kind === "refused") return state.reason === "failed" || state.reason === "computer_offline";
  if (state.kind !== "done") return false;
  const { result } = state;
  return result.kind === "error" && result.code !== "in_progress";
}

/**
 * The version line, for a runtime the Computer can upgrade: the Computer's
 * update check (or the bare version), then Upgrade as a text link in the same
 * sentence (xxchan: an exception to Button, it reads with the version;
 * Raft DS TextLink `strong`, a link in a sentence: ink, underlined on hover, Kirby) where
 * the check found a newer version (or reported no check: an older Computer).
 * Once a press has an outcome, the outcome takes the line; the link comes
 * back only after a failure another press may fix (`upgradeAgainAfter`).
 * While it runs the link stays the same element, busy, so focus stays on it.
 */
export function RuntimeVersionLine({ runtimeId, provider, version, auth }: { runtimeId: string; provider: RuntimeAccountUsageProvider | null; version: string | null; auth: SurfaceAuth | null }) {
  const { formatMessage } = useIntl();
  const upgrade = auth?.upgrade ?? null;
  const updateCopy = upgrade ? runtimeUpdateCheckCopy(auth?.update ?? null, version) : null;
  const outcome = upgrade ? runtimeUpgradeCopy(upgrade.state) : null;
  const tooOld = auth?.status?.kind === "unavailable" && auth.status.reason === "version_unsupported";
  const running = upgrade?.state.kind === "running";
  const offerUpgrade = upgrade !== null && (outcome
    ? upgradeAgainAfter(upgrade.state)
    : runtimeUpgradeButtonShown(auth?.update ?? null, upgrade.state, tooOld));
  const text = outcome ? (
    <span className={outcome.tone === "success" ? "text-foreground" : "text-warning-strong"} data-testid="runtime-upgrade-outcome">
      {formatMessage({ id: outcome.id }, { runtime: getRuntimeDisplayName(runtimeId), ...outcome.values })}
    </span>
  ) : updateCopy ? (
    <span data-testid="runtime-update-check">{formatMessage({ id: updateCopy.id }, monoValues(updateCopy.values))}</span>
  ) : version ? (
    <span data-testid={`runtime-version-${provider ?? runtimeId}`} className="font-mono text-mono-meta">{version}</span>
  ) : null;
  if (!text && !offerUpgrade) return null;
  return (
    // Polite live region: "Upgrading…" and the outcome are announced as the line changes.
    <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-caption text-foreground-hint" aria-live="polite">
      {text}
      {offerUpgrade && upgrade ? (
        <TextLink
          nativeButton={false}
          variant="strong"
          // Busy, not unavailable: ink with a progress cursor, not the greyed disabled look.
          className="inline-flex items-center gap-1 aria-disabled:cursor-progress aria-disabled:text-foreground aria-disabled:hover:no-underline"
          onClick={running ? undefined : upgrade.onUpgrade}
          aria-disabled={running || undefined}
          data-testid="runtime-upgrade-action"
        >
          {running ? <Spinner size="xs" aria-hidden="true" /> : null}
          {formatMessage({ id: running ? "machine.runtimeUpgrade.running" : "machine.runtimeUpgrade.action" })}
        </TextLink>
      ) : null}
    </div>
  );
}
