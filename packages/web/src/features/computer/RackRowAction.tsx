import { useIntl } from "react-intl";
import { CircleArrowUp, Terminal, TriangleAlert } from "lucide-react";
import { Button, Popover, PopoverContent, PopoverTrigger, Spinner } from "@botiverse/raft-ui";
import type { Machine } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import { getComputerCommands } from "../../utils/computerSetupCommand";
import { getServerUrl } from "../../utils/server";
import { ComputerManualInstall } from "../../components/machine/ComputerManualInstall";
import { ComputerUpgradeFailureHintText } from "../../components/machine/ComputerUpgradeFailureHint";
import type { RackVariant, UpgradeCard, RestartState } from "./computersRackTypes";
import { RackCommand } from "./RackCommand";

/**
 * The row's one next step, from the Computer page's own logic: offline, the
 * recovery restart command; online, Upgrade to v… (one click), the manual
 * install for a Computer the web can't upgrade, or the restart in progress.
 * Only for whoever may manage the computer; nothing otherwise.
 */
export function RackRowAction({ machine, canManage, variant, upgrade, restart, thisDevice = false }: {
  machine: Machine;
  canManage: boolean;
  variant: RackVariant;
  upgrade: UpgradeCard;
  restart: RestartState;
  /** The machine Raft Desktop runs on: managed with its page's buttons, never a command. */
  thisDevice?: boolean;
}) {
  const { formatMessage } = useIntl();
  const serverSlug = useServerStore((s) => s.current?.slug);
  const { cardState, upgradeReconnecting, startUpgrade, recommendRepair, upgradeFailureHint } = upgrade;
  const { progress } = restart;
  if (!canManage || machine.isComputer !== true) return null;
  const windows = machine.os?.toLowerCase().startsWith("win") ?? false;
  const deploymentEnv = import.meta.env?.VITE_DEPLOYMENT_ENV;
  if (machine.status !== "online") {
    // This device comes back with Start on its page (ThisDeviceSections), not a command.
    if (upgradeReconnecting || thisDevice) return null;
    const commands = getComputerCommands(serverSlug, deploymentEnv, getServerUrl(), windows ? { platform: "windows" } : {});
    if (!commands?.restart) return null;
    return (
      // Wraps: where the label leaves the command too little room (a card,
      // about 300px), the command takes its own line rather than shrinking
      // to a couple of letters.
      <div className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1" data-testid={`rack-offline-recovery-${machine.id}`}>
        {variant === "desktop" ? (
          <span className="shrink-0 text-footnote text-foreground-muted">
            {formatMessage({ id: "machine.detail.bringComputerOnline" })}
          </span>
        ) : null}
        <RackCommand command={commands.restart} testId={`rack-restart-command-${machine.id}`} className="min-w-48 flex-1" />
      </div>
    );
  }
  if (progress) {
    const text = progress.done
      ? progress.error
        ? (progress.error === "restart_failed" ? formatMessage({ id: "machine.restartFailed" }) : progress.error)
        : formatMessage({ id: "machine.detail.restarted" })
      : progress.message ?? formatMessage({ id: "machine.detail.restarting" });
    return (
      <span className={`font-mono text-mono-meta ${progress.error ? "text-warning-strong" : "text-foreground-muted"}`} data-testid={`rack-restart-progress-${machine.id}`}>
        {text}
      </span>
    );
  }
  if (cardState.kind === "oneClick") {
    const label = formatMessage({ id: "machine.detail.upgradeToVersion" }, { version: cardState.version });
    const upgradeButton = (
      <Button size="md" variant="outline" onClick={startUpgrade} data-testid={`rack-upgrade-${machine.id}`}>
        <CircleArrowUp size={16} />
        {label}
      </Button>
    );
    if (!recommendRepair && !upgradeFailureHint) return upgradeButton;
    // Advisory, beside Upgrade, which stays: the last web upgrade failed on
    // the machine's systemd unit (its own steps), or (#proj-raft-computer task
    // #34) the installer state needs a repair run. One set of steps and one
    // install command: the failure's steps when both apply, since they include
    // running the install command, which is also the repair.
    const hintKind = upgradeFailureHint ? "upgrade-failure-hint" : "repair-hint";
    const hintLabel = formatMessage({ id: upgradeFailureHint ? "machine.detail.upgradeFailureHint.label" : "machine.detail.installerRepairHintLabel" });
    const commands = getComputerCommands(serverSlug, deploymentEnv, getServerUrl(), { platform: windows ? "windows" : "mac-linux" });
    return (
      <div className="flex items-center gap-2">
        <Popover>
          <PopoverTrigger
            render={<Button size="md" variant="ghost" aria-label={hintLabel} data-testid={`rack-${hintKind}-${machine.id}`} />}
          >
            <TriangleAlert size={16} className="text-warning-strong" />
          </PopoverTrigger>
          <PopoverContent side="bottom" align="end" className="w-[420px] max-w-[calc(100vw-2rem)] p-4" data-testid={`rack-${hintKind}-popover`}>
            <p className="text-footnote text-foreground-muted">
              {upgradeFailureHint
                ? <ComputerUpgradeFailureHintText hint={upgradeFailureHint} />
                : formatMessage({ id: "machine.detail.upgradeStatus.installerRepairHint" }, { version: cardState.version })}
            </p>
            <ComputerManualInstall
              platform={windows ? "windows" : "mac-linux"}
              commands={commands}
              testId={`rack-${hintKind}-commands-${machine.id}`}
            />
          </PopoverContent>
        </Popover>
        {upgradeButton}
      </div>
    );
  }
  if (cardState.kind === "upgrading") {
    return (
      <Button size="md" variant="outline" disabled data-testid={`rack-upgrading-${machine.id}`}>
        <Spinner size="xs" aria-hidden="true" />
        {cardState.waitingAgents
          ? formatMessage({ id: "machine.detail.upgradeV2.draining" }, { count: cardState.waitingAgents })
          : formatMessage({ id: "machine.detail.upgradeV2.inProgress" })}
      </Button>
    );
  }
  // useComputerUpgradeCard already says managedByDesktop for this device; the
  // terminal popover must never be its next step, whatever the server says.
  if (cardState.kind === "manualUpgrade" && !thisDevice) {
    const commands = getComputerCommands(serverSlug, deploymentEnv, getServerUrl(), { platform: windows ? "windows" : "mac-linux" });
    return (
      <Popover>
        <PopoverTrigger
          render={<Button size="md" variant="outline" data-testid={`rack-manual-upgrade-${machine.id}`} />}
        >
          {/* ▶ is the one-click upgrade that runs now; this one opens the
              command to run on that machine, so it carries the terminal mark. */}
          <Terminal size={16} />
          {formatMessage({ id: "machine.detail.upgradeToVersion" }, { version: cardState.version })}
        </PopoverTrigger>
        <PopoverContent side="bottom" align="end" className="w-[420px] max-w-[calc(100vw-2rem)] p-4" data-testid="rack-manual-upgrade-popover">
          <p className="text-footnote text-foreground-muted">
            {formatMessage({ id: "machine.detail.upgradeStatus.manualUpgrade" }, { version: cardState.version })}
          </p>
          <ComputerManualInstall
            platform={windows ? "windows" : "mac-linux"}
            commands={commands}
            testId={`rack-manual-upgrade-commands-${machine.id}`}
          />
        </PopoverContent>
      </Popover>
    );
  }
  if (cardState.kind === "managedByDesktop") {
    return (
      <span className="text-footnote text-foreground-muted" data-testid={`rack-managed-by-desktop-${machine.id}`}>
        {formatMessage({ id: "machine.detail.upgradeStatus.managedByDesktop" })}
      </span>
    );
  }
  return null;
}
