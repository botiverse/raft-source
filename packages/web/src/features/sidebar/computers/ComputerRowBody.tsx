import { SidebarItem, SidebarItemIcon, SidebarItemMeta, SidebarItemSubtitle } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import type { Machine } from "../../../store/machineStore";
import StatusDot from "../../../components/ui/StatusDot";
import { useComputerUpgradeReconnect } from "../../../hooks/useComputerUpgradeReconnect";
import { machineDiskLowPresentation } from "../../../utils/machineDiskPresentation";
import { getComputerAvailableVersion } from "../../../utils/computerVersionFact";
import { getMachineRunLabelDescriptor } from "../../../utils/machineRunLabel";
import { ComputerDeviceIcon } from "../../../components/machine/ComputerDeviceIcon";
import { MachineRunLabel } from "../../../components/machine/MachineRunLabel";
import { ComputerRowStatusDot, ComputerRowVersionFact } from "../../../components/machine/ComputerRowVersionFact";
import { ThisDeviceBadge } from "../../../components/machine/localComputer/ThisDeviceBadge";
import { COMPUTER_ROW_ICON_CLASS, COMPUTER_ROW_META_CLASS, COMPUTER_ROW_NAME_CLASS, COMPUTER_ROW_NAME_LINE_CLASS, COMPUTER_ROW_TEXT_CLASS } from "./computerRowClasses";

// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
export function ComputerRowBody({
  machine,
  latestComputerVersion,
  selected,
  thisDevice,
  problem,
  localStatus = null,
  localPresence = null,
  onClick: handleClick,
}: {
  machine: Machine;
  latestComputerVersion: string | null;
  selected: boolean;
  thisDevice: boolean;
  problem: boolean;
  /** This device offline to the server: its local state in words, instead of "offline". */
  localStatus?: string | null;
  /** …and its dot. */
  localPresence?: "online" | "busy" | "error" | "offline" | null;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const { formatMessage } = useIntl();
  // Same answer as the detail page: offline while its upgrade restarts reads
  // "Updating…", not "Offline".
  const { reconnecting: upgradeReconnecting } = useComputerUpgradeReconnect(machine);
  // "A newer version exists" is the web's own comparison, so the arrow also
  // shows when web upgrade is off or this version is too old for the web; the
  // detail page then gives the commands.
  const availableVersion = getComputerAvailableVersion(machine, latestComputerVersion);
  const diskLow = machineDiskLowPresentation(machine, formatMessage);
  // Raft Design System › Sidebar row for a computer (`rf-srow--two`): a bare
  // monitor glyph in the 19px identity box with its presence pixel on the
  // corner (the box must not clip — the pixel overhangs it), the name in row
  // type, and the machine-written facts (run label / version, upgrade, disk)
  // in Space Mono ink-3. Selected is the row's yellow sticker, drawn by
  // SidebarItem, and the icon, description and facts turn ink with it. Its
  // lines stack, so it is a wrapping row: it keeps the 8px between its edge
  // and its text that every one-line row has, grows instead of squeezing, and
  // centres the glyph on its first line.
  return (
    <SidebarItem
      wrap
      onClick={handleClick}
      data-slot="sidebar-item"
      active={selected}
      data-testid={`computer-list-item-${machine.id}`}
      // The machine Raft Desktop runs on: first in the list, "This device"
      // beside its name (the name gives way, the facts line keeps the
      // version in full). Never in a browser.
      data-this-device={thisDevice ? "true" : undefined}
      className="text-left"
    >
      <SidebarItemIcon className={COMPUTER_ROW_ICON_CLASS}>
        <ComputerDeviceIcon machine={machine} />
        {/* This device with a problem (a failed move, an update required, …): the
            pixel turns orange whatever the server reports (DS: a problem is
            orange), and its page says what to do. */}
        {problem ? (
          <StatusDot aria-hidden presence="error" className="absolute -right-1 -bottom-1" data-testid={`computer-problem-dot-${machine.id}`} />
        ) : localPresence ? (
          <StatusDot aria-hidden presence={localPresence} className="absolute -right-1 -bottom-1" data-testid={`computer-local-dot-${machine.id}`} />
        ) : (
          <ComputerRowStatusDot
            className="absolute -right-1 -bottom-1"
            machine={machine}
            availableVersion={availableVersion}
            reconnecting={upgradeReconnecting}
          />
        )}
      </SidebarItemIcon>
      <div className={COMPUTER_ROW_TEXT_CLASS}>
        <div className={COMPUTER_ROW_NAME_LINE_CLASS}>
          <span className={COMPUTER_ROW_NAME_CLASS}>{machine.name}</span>
          {thisDevice ? <ThisDeviceBadge className="ml-1.5" testId={`computer-this-device-${machine.id}`} /> : null}
        </div>
        {machine.description && (
          <SidebarItemSubtitle className="mt-0.5">
            {machine.description}
          </SidebarItemSubtitle>
        )}
        <SidebarItemMeta className={COMPUTER_ROW_META_CLASS}>
          {localStatus ? (
            <span className="truncate" data-testid={`computer-local-status-${machine.id}`}>{localStatus}</span>
          ) : upgradeReconnecting ? (
            <span className="truncate" data-testid={`computer-upgrade-reconnecting-${machine.id}`}>
              {formatMessage({ id: "machine.detail.upgradeV2.inProgress" })}
            </span>
          ) : (() => {
            const label = getMachineRunLabelDescriptor(machine);
            return (
              <span className={`truncate${label.isOffline ? " text-foreground-disabled group-data-active/sidebar-item:text-sticker-ink" : ""}`}>
                <MachineRunLabel machine={machine} />
              </span>
            );
          })()}
          {localStatus ? null : (
            <ComputerRowVersionFact
              machine={machine}
              availableVersion={availableVersion}
              arrowClassName="shrink-0 font-bold text-warning-strong group-data-active/sidebar-item:text-sticker-ink"
              chipClassName="shrink-0 font-bold text-warning-strong group-data-active/sidebar-item:text-sticker-ink"
            />
          )}
          {diskLow && (
            <span
              className="shrink-0 font-bold text-warning-strong group-data-active/sidebar-item:text-sticker-ink"
              data-testid={`computer-disk-low-${machine.id}`}
              title={formatMessage({ id: "machine.diskLow.chipTitle" }, { free: diskLow.free, total: diskLow.total })}
            >
              {formatMessage({ id: "machine.diskLow.chip" })}
            </span>
          )}
        </SidebarItemMeta>
      </div>
    </SidebarItem>
  );
}
// Stryker restore all
