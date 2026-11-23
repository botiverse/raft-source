import { runtimeAuthRuntimeFor } from "@botiverse/raft-shared";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { RuntimeUpgradeButton } from "../../features/computer/RuntimeUpgradeButton";
import { RuntimeUpgradeOutcome } from "../../features/computer/RuntimeUpgradeOutcome";
import { useOfferedRuntimeUpgrade } from "../../features/computer/useRuntimeUpgrade";
import type { RuntimeUpgradeTarget } from "../../features/computer/runtimeUpgradeTarget";
import { runtimeAuthClient } from "../../utils/runtimeAuthClient";
import { useRuntimeAuthView } from "../machine/useRuntimeAuthView";

/**
 * The model-source status line's `runtime_outdated` (the runtime's CLI on the
 * Computer is too old to list the options): where Upgrade is offered for this
 * runtime (`runtimeUpgradeOffered`), the line says so without "Update it
 * there." and the button follows, then what the press learned. Elsewhere the
 * line is `children`, as before. `suffix`: the fallback sentence, if any;
 * `retry`: the line's own Retry (after an upgrade it lists the options
 * again), kept beside Upgrade.
 */
export function RuntimeFormV2OutdatedUpgrade({ target, suffix, retry, children }: { target: RuntimeUpgradeTarget; suffix: string | null; retry: ReactNode; children: ReactNode }) {
  const { formatMessage } = useIntl();
  const client = target.client ?? runtimeAuthClient;
  const runtime = runtimeAuthRuntimeFor(target.runtimeId);
  const { view } = useRuntimeAuthView(client, target.serverId, target.machineId, runtime !== null);
  const upgrade = useOfferedRuntimeUpgrade(client, target.serverId, target.machineId, runtime, view);
  if (!upgrade) return children;
  return (
    <div className="stack-y-1.5">
      <p>
        {formatMessage({ id: "agent.runtimeFormV2.sourceStatus.runtimeOutdatedUpgrade" })}
        {suffix ? <span className="ms-1">{suffix}</span> : null}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <RuntimeUpgradeButton state={upgrade.state} onUpgrade={upgrade.onUpgrade} />
        {retry}
      </div>
      <RuntimeUpgradeOutcome runtimeId={target.runtimeId} state={upgrade.state} />
    </div>
  );
}
