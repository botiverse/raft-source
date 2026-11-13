import type { IntlShape } from "react-intl";
import type { ServerCapabilities } from "@botiverse/raft-shared";

import type { Machine } from "../../store/machineStore";
import {
  earliestVersionDeadline,
  machinesNeedingReinstallAnyStatus,
  machinesNeedingUpgradeByDeadlineAnyStatus,
  reinstallDismissalKey,
  reinstallNoticeKind,
  REINSTALL_DISMISSAL_PREFIX,
  UPGRADE_DEADLINE_DISMISSAL_PREFIX,
} from "../../utils/computersNeedingReinstall";
import type { NotificationEntry } from "./useSystemNotifications";

/**
 * The Notification Center's Computer version entries (useSystemNotifications):
 * `computer-reinstall` and, while the version floor has a deadline that has
 * not taken effect, `computer-upgrade-deadline` (#proj-o11y:#19).
 */
export function computerVersionNotificationEntries({
  machines,
  reinstallMachines,
  upgradeByDeadline,
  currentUserId,
  capabilities,
  dismissedNotificationKeys,
  formatMessage,
  formatDate,
  toComputer,
}: {
  machines: Machine[];
  /** machinesNeedingReinstall: online, managed, needing a reinstall or migration. */
  reinstallMachines: Machine[];
  /** machinesNeedingUpgradeByDeadline: online, managed, upgradable before a deadline. */
  upgradeByDeadline: Machine[];
  currentUserId: string | null;
  capabilities: ServerCapabilities;
  dismissedNotificationKeys: ReadonlySet<string>;
  formatMessage: IntlShape["formatMessage"];
  formatDate: IntlShape["formatDate"];
  toComputer: (machineId: string) => void;
}): NotificationEntry[] {
  const out: NotificationEntry[] = [];
  // Machines the user manages that the web cannot update: a Computer too
  // old for a one-click upgrade (reinstall), or a legacy daemon (migrate to
  // Raft Computer). Both surfaces. Where first, then what (Raft Design
  // System › NotificationCenter): the machine's name when there is one,
  // else a count. The Computers attention filter lists only offline
  // Computers and offered upgrades (never a legacy daemon), so the action
  // opens the first one's page, which has the commands.
  if (reinstallMachines.length > 0) {
    const reinstallDeadline = earliestVersionDeadline(reinstallMachines);
    const first = reinstallMachines[0]!;
    const count = reinstallMachines.length;
    const need = reinstallNoticeKind(reinstallMachines);
    out.push({
      id: "computer-reinstall",
      kind: "warning",
      // No icon of its own: the tile draws raft-ui's warning glyph for
      // status="warning" (NotificationCenterItemIcon).
      // Fingerprint = every managed machine that needs it, online or not:
      // a connectivity flap or a fixed machine keeps a dismissal, only a
      // machine no dismissal covered resurfaces it.
      // With a deadline the date joins the fingerprint, so people who
      // dismissed the undated entry see it again once a date is set.
      dismissalKey: reinstallDismissalKey(
        machinesNeedingReinstallAnyStatus(machines, currentUserId, capabilities),
        dismissedNotificationKeys,
        reinstallDeadline ? `${REINSTALL_DISMISSAL_PREFIX}${reinstallDeadline}:` : undefined,
      ),
      title: count === 1
        ? formatMessage({ id: "layout.systemNotifications.computerReinstallTitleOne" }, { need, name: first.name })
        : formatMessage({ id: "layout.systemNotifications.computerReinstallTitleMany" }, { need, count }),
      body: (
        <span className="text-foreground-muted">
          {reinstallDeadline
            ? formatMessage(
              { id: "layout.systemNotifications.computerReinstallBodyScheduled" },
              { date: formatDate(reinstallDeadline, { year: "numeric", month: "short", day: "numeric" }) },
            )
            : formatMessage({ id: "layout.systemNotifications.computerReinstallBody" })}
        </span>
      ),
      action: {
        label: formatMessage({ id: "layout.systemNotifications.view" }),
        onClick: () => toComputer(first.id),
        variant: "primary",
      },
    });
  }

  const upgradeDeadline = earliestVersionDeadline(upgradeByDeadline);
  if (upgradeByDeadline.length > 0 && upgradeDeadline) {
    const first = upgradeByDeadline[0]!;
    const count = upgradeByDeadline.length;
    const date = formatDate(upgradeDeadline, { year: "numeric", month: "short", day: "numeric" });
    out.push({
      id: "computer-upgrade-deadline",
      kind: "warning",
      // The deadline is part of the fingerprint: a new floor with a new
      // date brings a dismissed entry back.
      dismissalKey: reinstallDismissalKey(
        machinesNeedingUpgradeByDeadlineAnyStatus(machines, currentUserId, capabilities),
        dismissedNotificationKeys,
        `${UPGRADE_DEADLINE_DISMISSAL_PREFIX}${upgradeDeadline}:`,
      ),
      title: count === 1
        ? formatMessage({ id: "layout.systemNotifications.computerUpgradeDeadlineTitleOne" }, { name: first.name, date })
        : formatMessage({ id: "layout.systemNotifications.computerUpgradeDeadlineTitleMany" }, { count, date }),
      body: (
        <span className="text-foreground-muted">
          {formatMessage({ id: "layout.systemNotifications.computerUpgradeDeadlineBody" }, { date })}
        </span>
      ),
      action: {
        label: formatMessage({ id: "layout.systemNotifications.view" }),
        onClick: () => toComputer(first.id),
        variant: "primary",
      },
    });
  }

  return out;
}
