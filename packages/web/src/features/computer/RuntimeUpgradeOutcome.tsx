import { getRuntimeDisplayName } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import { runtimeUpgradeCopy } from "./runtimeUpgradeOutcomeCopy";
import type { RuntimeUpgradeState } from "./runtimeUpgradeOutcomeCopy";

/**
 * What the last Upgrade learned, one plain sentence (`runtimeUpgradeCopy`);
 * nothing while idle or running. Ink once it helped, orange-strong when the
 * person has something to do (Raft DS: a problem is orange, never red).
 */
export function RuntimeUpgradeOutcome({ runtimeId, state }: { runtimeId: string; state: RuntimeUpgradeState }) {
  const { formatMessage } = useIntl();
  const copy = runtimeUpgradeCopy(state);
  if (!copy) return null;
  return (
    <p
      className={copy.tone === "success" ? "w-full text-caption text-foreground" : "w-full text-caption text-warning-strong"}
      role="status"
      data-testid="runtime-upgrade-outcome"
    >
      {formatMessage({ id: copy.id }, { runtime: getRuntimeDisplayName(runtimeId), ...copy.values })}
    </p>
  );
}
