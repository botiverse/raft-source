import {
  Badge,
  Button,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
  TextLink,
} from "@botiverse/raft-ui";
import { getMachineRuntimeDisplayOptions, getRuntimeDisplayName, getRuntimeInfo, runtimeAuthRuntimeFor, runtimeAvailabilitySuffix } from "@botiverse/raft-shared";
import type { RuntimeAuthRuntime, RuntimeInfo, ServerRuntimeCatalog } from "@botiverse/raft-shared";
import type { BadgeProps } from "@botiverse/raft-ui";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { formatRuntimeAvailabilitySuffix, formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import { runtimeAuthClient as defaultRuntimeAuthClient, runtimeInstallOffered } from "../../utils/runtimeAuthClient";
import type { RuntimeAuthClient } from "../../utils/runtimeAuthClient";
import { RuntimeInstallDialog } from "../../features/computer/RuntimeInstallDialog";
import { RuntimeInstallOutcome } from "../../features/computer/RuntimeInstallOutcome";
import { useComputerName } from "../../features/computer/useComputerName";
import { useRuntimeInstall } from "../../features/computer/useRuntimeInstall";
import type { RuntimeInstallState } from "../../features/computer/runtimeInstallCopy";
import { RuntimeAccountUsageGateChip } from "./RuntimeAccountUsageChip";
import { useRuntimeAuthView } from "./useRuntimeAuthView";
import { useServerRuntimeCatalog } from "../../hooks/useServerRuntimeCatalog";

/** The Computer's own Upgrade, when the page that shows the chips already offers one. */
export interface MachineRuntimeChipsUpgradeAction {
  label: string;
  onClick: () => void;
}

/** Where each catalog runtime stands on this computer, from what it reports alone. */
export interface MachineRuntimeChipGroups {
  /** Reported by the computer: the runtime chips with their usage / sign-in card. */
  detected: RuntimeInfo[];
  /** In-process runtimes this computer does not report: the computer predates them. */
  updateComputer: RuntimeInfo[];
  /** Local CLIs this computer did not detect. Shown only on request. */
  notInstalled: RuntimeInfo[];
}

/**
 * The runtimes this server offers, from its catalog (`catalog`): one it
 * deprecated stays hidden. Without a catalog (loading, or a server too old to serve one) the
 * bundled catalog's non-deprecated runtimes. Named from the bundled catalog.
 */
function serverDisplayRuntimes(catalog: ServerRuntimeCatalog | null): RuntimeInfo[] {
  if (!catalog) return getMachineRuntimeDisplayOptions();
  return catalog.runtimes.flatMap((entry) => {
    const runtime = entry.supported && !entry.deprecated ? getRuntimeInfo(entry.id) : undefined;
    return runtime?.supported ? [runtime] : [];
  });
}

export function machineRuntimeChipGroups(
  machineRuntimeIds: readonly string[],
  catalog: ServerRuntimeCatalog | null = null,
): MachineRuntimeChipGroups {
  const groups: MachineRuntimeChipGroups = { detected: [], updateComputer: [], notInstalled: [] };
  for (const runtime of serverDisplayRuntimes(catalog)) {
    const suffix = runtimeAvailabilitySuffix(runtime, machineRuntimeIds);
    if (suffix.kind === "none") groups.detected.push(runtime);
    else if (suffix.kind === "updateComputer") groups.updateComputer.push(runtime);
    else if (suffix.kind === "notInstalled") groups.notInstalled.push(runtime);
  }
  return groups;
}

/**
 * A runtime chip with something to say beyond its label: a Badge drawn as a
 * button that opens a small Raft DS Popover (300px, 16px padding). Warning
 * for an in-process runtime this computer predates (it needs a newer Raft
 * Computer); muted for a runtime it can install from here.
 */
function RuntimeInfoChip({
  runtime,
  label,
  testId,
  variant = "warning",
  children,
}: {
  runtime: RuntimeInfo;
  label: string;
  testId: string;
  variant?: Extract<BadgeProps["variant"], "warning" | "muted">;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={200}
        data-testid={testId}
        render={<Badge render={<button type="button" />} appearance="soft" variant={variant} className="inline-flex items-center outline-none focus-visible:shadow-focus" />}
      >
        {label}
      </PopoverTrigger>
      <PopoverContent className="grid w-[300px] max-w-[calc(100vw-16px)] gap-2 p-4" data-testid={`${testId}-card`}>
        <PopoverTitle>{getRuntimeDisplayName(runtime.id)}</PopoverTitle>
        {children}
      </PopoverContent>
    </Popover>
  );
}

function UpdateComputerCard({ runtime, upgradeAction }: { runtime: RuntimeInfo; upgradeAction?: MachineRuntimeChipsUpgradeAction | null }) {
  const { formatMessage } = useIntl();
  return (
    <>
      <PopoverDescription>
        {formatMessage({ id: "runtime.availability.needsNewerComputer" }, { runtime: getRuntimeDisplayName(runtime.id) })}
      </PopoverDescription>
      {upgradeAction ? (
        <div>
          {/* A popover confirms with an ink-border button, never a pink one (Raft DS Popover). */}
          <Button type="button" size="md" variant="outline" onClick={upgradeAction.onClick} data-testid={`machine-runtime-upgrade-${runtime.id}`}>
            {upgradeAction.label}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/**
 * A runtime this Computer does not have and can install from here
 * (docs/contracts/runtime-auth.md §6e): its card says so and offers Install,
 * which first shows what would run. Raft DS Popover: the action is an
 * ink-border button, never pink; busy while the plan is read or the installer runs.
 */
function InstallCard({
  runtime,
  installAs,
  state,
  onInstall,
}: {
  runtime: RuntimeInfo;
  /** The runtime's sign-in id, which the install names. */
  installAs: RuntimeAuthRuntime;
  state: RuntimeInstallState;
  onInstall: (runtime: RuntimeAuthRuntime) => void;
}) {
  const { formatMessage } = useIntl();
  const handleInstall = useCallback(() => onInstall(installAs), [onInstall, installAs]);
  const busy = state.kind === "planning" || state.kind === "running";
  const mine = "runtime" in state && state.runtime === runtimeAuthRuntimeFor(runtime.id);
  const label = formatMessage({ id: mine && state.kind === "running" ? "machine.runtimeInstall.running" : "machine.runtimeInstall.action" });
  return (
    <>
      <PopoverDescription>
        {formatMessage({ id: "machine.runtimeInstall.notInstalled" }, { runtime: getRuntimeDisplayName(runtime.id) })}
      </PopoverDescription>
      <div>
        <Button
          type="button"
          size="md"
          variant="outline"
          onClick={handleInstall}
          loading={busy && mine}
          loadingLabel={label}
          disabled={busy && !mine}
          data-testid={`machine-runtime-install-${runtime.id}`}
        >
          {label}
        </Button>
      </div>
    </>
  );
}

/**
 * Detected Runtimes, shared by the Computer page and Add Computer: what this
 * computer can run right now, from what it reports. Detected runtimes keep
 * their usage / sign-in card (an orange chip that says so when it is signed
 * out); an in-process runtime the computer predates is a warning chip with a
 * card saying it needs a newer Raft Computer. Runtimes it did not detect stay
 * out of the way until "Show All Supported" brings them in as muted chips; one
 * the Computer can install from here (behind
 * runtime_install_button, for the people who may Upgrade) opens a card with
 * Install.
 */
export default function MachineRuntimeChips({
  machineId,
  machineRuntimeIds,
  runtimeVersions,
  serverId,
  canViewRuntimeAccountUsage,
  upgradeAction,
  testId,
  runtimeAuthClient = defaultRuntimeAuthClient,
}: {
  machineId: string;
  machineRuntimeIds: readonly string[];
  runtimeVersions?: Record<string, string> | null;
  serverId: string | null;
  canViewRuntimeAccountUsage: boolean;
  upgradeAction?: MachineRuntimeChipsUpgradeAction | null;
  testId?: string;
  /** Test seam; the app's runtime-auth client when absent. */
  runtimeAuthClient?: RuntimeAuthClient;
}) {
  const { formatMessage } = useIntl();
  const [showAll, setShowAll] = useState(false);
  const toggleShowAll = useCallback(() => setShowAll((value) => !value), []);
  const catalog = useServerRuntimeCatalog(serverId);
  const groups = machineRuntimeChipGroups(machineRuntimeIds, catalog);
  // Install is offered by the runtime-auth read; read only once the not-installed chips are shown.
  const { view } = useRuntimeAuthView(runtimeAuthClient, serverId ?? "", machineId, canViewRuntimeAccountUsage && serverId !== null && showAll && groups.notInstalled.length > 0);
  const install = useRuntimeInstall(runtimeAuthClient, serverId, machineId);
  const machineName = useComputerName(machineId) ?? formatMessage({ id: "machine.runtimeAuth.thisComputer" });
  const installableAs = (runtime: RuntimeInfo): RuntimeAuthRuntime | null => {
    const authRuntime = runtimeAuthRuntimeFor(runtime.id);
    return runtimeInstallOffered(view, authRuntime) ? authRuntime : null;
  };
  const installState = install.state;
  // Every listed runtime is not deprecated on this server: no "(deprecated)" suffix.
  const runtimeLabel = (runtime: RuntimeInfo) =>
    formatRuntimeLabelWithStatus(runtime.id, formatMessage, false);
  const statusLabel = (runtime: RuntimeInfo) =>
    runtimeLabel(runtime)
    + formatRuntimeAvailabilitySuffix(runtimeAvailabilitySuffix(runtime, machineRuntimeIds), formatMessage);
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={testId}>
      {groups.detected.map((runtime) => (
        <RuntimeAccountUsageGateChip
          key={runtime.id}
          enabled={canViewRuntimeAccountUsage}
          runtimeId={runtime.id}
          runtimeVersion={runtimeVersions?.[runtime.id]}
          serverId={serverId}
          machineId={machineId}
          appearance="soft"
          variant="information"
        >
          {runtimeLabel(runtime)}
        </RuntimeAccountUsageGateChip>
      ))}
      {groups.updateComputer.map((runtime) => (
        <RuntimeInfoChip key={runtime.id} runtime={runtime} label={statusLabel(runtime)} testId={`machine-runtime-chip-${runtime.id}`}>
          <UpdateComputerCard runtime={runtime} upgradeAction={upgradeAction} />
        </RuntimeInfoChip>
      ))}
      {/* The label already says it is not installed; Install where the Computer can run the runtime's installer. */}
      {showAll && groups.notInstalled.map((runtime) => {
        const installable = installableAs(runtime);
        return installable ? (
          <RuntimeInfoChip key={runtime.id} runtime={runtime} label={statusLabel(runtime)} testId={`machine-runtime-chip-${runtime.id}`} variant="muted">
            <InstallCard runtime={runtime} installAs={installable} state={installState} onInstall={install.start} />
          </RuntimeInfoChip>
        ) : (
          <Badge key={runtime.id} appearance="soft" variant="muted" data-testid={`machine-runtime-chip-${runtime.id}`}>
            {statusLabel(runtime)}
          </Badge>
        );
      })}
      {groups.notInstalled.length > 0 ? (
        <span className="text-footnote">
          <TextLink onClick={toggleShowAll} aria-expanded={showAll} data-testid="machine-runtime-show-all">
            {formatMessage({ id: showAll ? "runtime.availability.showInstalledOnly" : "runtime.availability.showAllSupported" })}
          </TextLink>
        </span>
      ) : null}
      {/* Named by the sign-in id the install ran for: the Raft runtime id of every installable one (Kimi Code's is not). */}
      <RuntimeInstallOutcome state={installState} />
      {installState.kind === "confirm" || installState.kind === "manual" ? (
        <RuntimeInstallDialog
          runtimeId={installState.runtime}
          machineName={machineName}
          plan={installState.plan}
          onConfirm={install.confirm}
          onClose={install.cancel}
        />
      ) : null}
    </div>
  );
}

