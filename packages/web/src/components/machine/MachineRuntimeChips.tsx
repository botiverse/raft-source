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
import { getMachineRuntimeDisplayOptions, getRuntimeDisplayName, getRuntimeInfo, runtimeAvailabilitySuffix } from "@botiverse/raft-shared";
import type { RuntimeInfo, ServerRuntimeCatalog } from "@botiverse/raft-shared";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { formatRuntimeAvailabilitySuffix, formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import { RuntimeAccountUsageGateChip } from "./RuntimeAccountUsageChip";
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
 * deprecated stays hidden, one it offers again (Antigravity with its OAR flag
 * on) shows. Without a catalog (loading, or a server too old to serve one) the
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
 * An in-process runtime this computer predates: a warning Badge drawn as a
 * button that opens a small Raft DS Popover (300px, 16px padding) saying it
 * needs a newer Raft Computer.
 */
function RuntimeInfoChip({
  runtime,
  label,
  testId,
  children,
}: {
  runtime: RuntimeInfo;
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={200}
        data-testid={testId}
        render={<Badge render={<button type="button" />} appearance="soft" variant="warning" className="inline-flex items-center outline-none focus-visible:shadow-focus" />}
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
 * Detected Runtimes, shared by the Computer page and Add Computer: what this
 * computer can run right now, from what it reports. Detected runtimes keep
 * their usage / sign-in card (an orange chip that says so when it is signed
 * out); an in-process runtime the computer predates is a warning chip with a
 * card saying it needs a newer Raft Computer. An experimental runtime says so
 * in its chip's text: a separate Experimental badge in a row of chips reads
 * as one more runtime. Runtimes it did
 * not detect stay out of the way until "Show All Supported" brings them in as
 * muted chips.
 */
export default function MachineRuntimeChips({
  machineId,
  machineRuntimeIds,
  runtimeVersions,
  serverId,
  canViewRuntimeAccountUsage,
  upgradeAction,
  testId,
}: {
  machineId: string;
  machineRuntimeIds: readonly string[];
  runtimeVersions?: Record<string, string> | null;
  serverId: string | null;
  canViewRuntimeAccountUsage: boolean;
  upgradeAction?: MachineRuntimeChipsUpgradeAction | null;
  testId?: string;
}) {
  const { formatMessage } = useIntl();
  const [showAll, setShowAll] = useState(false);
  const toggleShowAll = useCallback(() => setShowAll((value) => !value), []);
  const catalog = useServerRuntimeCatalog(serverId);
  const groups = machineRuntimeChipGroups(machineRuntimeIds, catalog);
  // Every listed runtime is not deprecated on this server: no "(deprecated)" suffix.
  const statusLabel = (runtime: RuntimeInfo) =>
    formatRuntimeLabelWithStatus(runtime.id, formatMessage, false)
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
          {formatRuntimeLabelWithStatus(runtime.id, formatMessage, false)}
        </RuntimeAccountUsageGateChip>
      ))}
      {groups.updateComputer.map((runtime) => (
        <RuntimeInfoChip key={runtime.id} runtime={runtime} label={statusLabel(runtime)} testId={`machine-runtime-chip-${runtime.id}`}>
          <UpdateComputerCard runtime={runtime} upgradeAction={upgradeAction} />
        </RuntimeInfoChip>
      ))}
      {/* The label already says it is not installed; no install advice until Raft can install it. */}
      {showAll && groups.notInstalled.map((runtime) => (
        <Badge key={runtime.id} appearance="soft" variant="muted" data-testid={`machine-runtime-chip-${runtime.id}`}>
          {statusLabel(runtime)}
        </Badge>
      ))}
      {groups.notInstalled.length > 0 ? (
        <span className="text-footnote">
          <TextLink onClick={toggleShowAll} aria-expanded={showAll} data-testid="machine-runtime-show-all">
            {formatMessage({ id: showAll ? "runtime.availability.showInstalledOnly" : "runtime.availability.showAllSupported" })}
          </TextLink>
        </span>
      ) : null}
    </div>
  );
}
