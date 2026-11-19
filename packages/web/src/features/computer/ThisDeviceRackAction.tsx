import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";
import type { MessageId } from "../../i18n/messages";
import { useServerStore } from "../../store/serverStore";
import { useLocalComputerHost } from "../../components/machine/localComputer/useLocalComputerHost";
import type { LocalComputerHost } from "../../components/machine/localComputer/useLocalComputerHost";
import { primaryThisDeviceAction } from "../../components/machine/localComputer/thisDeviceLogic";
import type { ThisDeviceActionId } from "../../components/machine/localComputer/thisDeviceLogic";
import { thisDeviceCanAdd, thisDevicePlanFor } from "../../components/machine/localComputer/thisDevicePlan";

/** The page's first steps that run in one click from the row; any other opens the page. */
const INLINE: Partial<Record<ThisDeviceActionId, { labelId: MessageId; run: (host: LocalComputerHost) => (() => Promise<unknown>) | null }>> = {
  "start": { labelId: "computerHost.start", run: (host) => () => host.start() },
  "install": { labelId: "computerHost.thisDevice.install", run: (host) => host.updateComputer },
  "finish-move": { labelId: "computerHost.thisDevice.finishMove", run: (host) => host.updateComputer },
  "repair": { labelId: "computerHost.thisDevice.repair", run: (host) => host.updateComputer },
  "update": { labelId: "computerHost.thisDevice.update", run: (host) => host.updateComputer },
  "retry-read": { labelId: "computerHost.thisDevice.tryAgain", run: (host) => host.retryRead },
  "retry-migration": { labelId: "computerHost.thisDevice.tryAgain", run: (host) => host.retryMigration },
};

/**
 * This device's row while the server sees it offline (design: no dead end):
 * the page's first step when it runs in one click (Start, Install, Try
 * again, …), else "Open This device". Never a command.
 */
export function ThisDeviceRackAction({ machineId, onOpen }: { machineId: string; onOpen: () => void }) {
  const { formatMessage } = useIntl();
  const host = useLocalComputerHost();
  const server = useServerStore((s) => s.current);
  const [busy, setBusy] = useState(false);
  const plan = host?.ready ? thisDevicePlanFor(host, "embedded", { canAdd: thisDeviceCanAdd(host, server) }) : null;
  const primary = plan ? primaryThisDeviceAction(plan) : null;
  const inline = primary ? INLINE[primary.id] : undefined;
  const action = inline && host ? inline.run(host) : null;
  const runPrimary = useCallback(() => {
    if (!action) return;
    setBusy(true);
    // A failure shows on the page (the state it leaves): open it.
    void action().catch(onOpen).finally(() => setBusy(false));
  }, [action, onOpen]);
  if (inline && action) {
    const label = formatMessage({ id: inline.labelId });
    return (
      <Button size="md" variant="outline" onClick={runPrimary} loading={busy} disabled={busy} loadingLabel={label} data-testid={`rack-this-device-action-${machineId}`} data-computer-op={primary!.id}>
        {label}
      </Button>
    );
  }
  return (
    <Button size="md" variant="outline" onClick={onOpen} data-testid={`rack-this-device-open-${machineId}`}>
      {formatMessage({ id: "computerHost.thisDevice.openThisDevice" })}
    </Button>
  );
}
