import { AlertTriangle } from "lucide-react";
import { useIntl } from "react-intl";
import ConfirmDialog from "../ConfirmDialog";
import type { useComputerRestart, useComputerUpgradeCard } from "./useComputerUpgradeCard";

/**
 * The confirmations Restart and Upgrade open, wherever they are offered (the
 * Computer page, the Computers overview row). Both restart the Computer, so
 * every agent on it disconnects until it is back: a side effect that
 * interrupts others, confirmed with a named button (Raft DS › Forms, "When a
 * change takes effect"; Feedback, "Confirming"). Orange: disruptive, and the
 * agents come back on their own.
 */
export function ComputerActionConfirms({ name, agentCount, upgrade, restart }: {
  name: string;
  /** The agents on this Computer, which it disconnects. */
  agentCount: number;
  upgrade: Pick<ReturnType<typeof useComputerUpgradeCard>, "confirmingUpgradeVersion" | "confirmUpgrade" | "cancelUpgrade">;
  restart: Pick<ReturnType<typeof useComputerRestart>, "confirmingRestart" | "confirmRestart" | "cancelRestart">;
}) {
  const { formatMessage } = useIntl();
  const version = upgrade.confirmingUpgradeVersion;
  return (
    <>
      {restart.confirmingRestart ? (
        <ConfirmDialog
          title={formatMessage({ id: "machine.detail.restartConfirmTitle" })}
          message={formatMessage({ id: "machine.detail.restartConfirmMessage" }, { name, count: agentCount })}
          confirmLabel={formatMessage({ id: "machine.detail.restart" })}
          confirmIcon={<AlertTriangle size={14} />}
          confirmVariant="warning"
          confirmTestId="computer-restart-confirm"
          analyticsDialog="computer_restart"
          onConfirm={restart.confirmRestart}
          onClose={restart.cancelRestart}
        />
      ) : null}
      {version !== null ? (
        <ConfirmDialog
          title={formatMessage({ id: "machine.detail.upgradeToVersion" }, { version })}
          message={formatMessage({ id: "machine.detail.upgradeConfirmMessage" }, { name, version, count: agentCount })}
          confirmLabel={formatMessage({ id: "machine.detail.upgradeConfirm" })}
          confirmIcon={<AlertTriangle size={14} />}
          confirmVariant="warning"
          confirmTestId="computer-upgrade-confirm"
          analyticsDialog="computer_upgrade"
          onConfirm={upgrade.confirmUpgrade}
          onClose={upgrade.cancelUpgrade}
        />
      ) : null}
    </>
  );
}
