import {
  MACHINE_SYSTEM_NOTIFICATION_SCHEMA_VERSION,
  SERVER_SYSTEM_NOTIFICATIONS_CONTRACT_VERSION,
  isDaemonOutdated,
  type MachineSystemNotification,
  type ServerSystemNotificationsResponse,
} from "@botiverse/raft-shared";

export interface MachineNotificationReadModel {
  id: string;
  name: string;
  status: "online" | "offline";
  daemonVersion: string | null;
  /** Managed Computers have a separate aggregate attention contract. */
  isComputer: boolean;
}

export interface ProjectMachineSystemNotificationsInput {
  machines: MachineNotificationReadModel[];
  activeAgentCountByMachine: ReadonlyMap<string, number>;
  latestDaemonVersion: string | null;
  evaluatedAt: Date;
}

function evaluationAt(evaluatedAt: Date) {
  return {
    clock: "server" as const,
    evaluatedAt: evaluatedAt.toISOString(),
    // Canonical machine status already incorporates heartbeat timeout and
    // disconnect projection grace. Notification projection adds no second,
    // client-owned wall-clock threshold.
    offlineAfterMs: 0 as const,
    statusAuthority: "canonical_machine_read_model" as const,
    runKind: "raw_daemon" as const,
    versionAuthority: "latest_daemon_release" as const,
  };
}

function activeAgentCount(
  machines: MachineNotificationReadModel[],
  activeAgentCountByMachine: ReadonlyMap<string, number>,
): number {
  return machines.reduce(
    (total, machine) => total + (activeAgentCountByMachine.get(machine.id) ?? 0),
    0,
  );
}

function machineRefs(machines: MachineNotificationReadModel[]) {
  return machines.map(({ id, name }) => ({ id, name }));
}

function machineSetIdentity(machines: MachineNotificationReadModel[]): string {
  return machines.map((machine) => machine.id).join(",");
}

function canonicalMachineOrder(
  machines: MachineNotificationReadModel[],
): MachineNotificationReadModel[] {
  return [...machines].sort((left, right) => left.id.localeCompare(right.id));
}

export function projectMachineSystemNotifications({
  machines,
  activeAgentCountByMachine,
  latestDaemonVersion,
  evaluatedAt,
}: ProjectMachineSystemNotificationsInput): MachineSystemNotification[] {
  const notifications: MachineSystemNotification[] = [];
  // Product contract: these two named notifications are the legacy/raw daemon
  // surface. Managed Computers use their source-aware broadcast decision and
  // anonymous aggregate attention UI; daemonVersion must never make one leak
  // back into this feed.
  const rawDaemonMachines = machines.filter((machine) => !machine.isComputer);
  const offlineMachines = canonicalMachineOrder(
    rawDaemonMachines.filter((machine) => machine.status === "offline"),
  );

  if (offlineMachines.length > 0) {
    const activeCount = activeAgentCount(offlineMachines, activeAgentCountByMachine);
    const names = offlineMachines.map((machine) => machine.name).join(", ");
    const singular = offlineMachines.length === 1;
    const title = `${names} ${singular ? "is" : "are"} offline`;
    const body = activeCount > 0
      ? `${activeCount} ${activeCount === 1 ? "agent is" : "agents are"} active on ${singular ? "this computer" : "these computers"} and can't run until ${singular ? "it reconnects" : "they reconnect"}.`
      : `No agents are active on ${singular ? "this computer" : "these computers"} right now — reconnect when you need ${singular ? "it" : "them"} next.`;

    notifications.push({
      id: `machine-offline:${machineSetIdentity(offlineMachines)}`,
      type: "machine.offline",
      schemaVersion: MACHINE_SYSTEM_NOTIFICATION_SCHEMA_VERSION,
      state: "active",
      kind: activeCount > 0 ? "error" : "warning",
      title,
      body,
      copy: {
        titleKey: singular ? "machine.offline.title.one" : "machine.offline.title.many",
        bodyKey: activeCount > 0
          ? singular ? "machine.offline.body.active.one" : "machine.offline.body.active.many"
          : singular ? "machine.offline.body.idle.one" : "machine.offline.body.idle.many",
        actionLabelKey: "common.view",
        params: {
          machineNames: names,
          machineCount: offlineMachines.length,
          activeAgentCount: activeCount,
          targetDaemonVersion: null,
        },
      },
      action: {
        label: "View",
        targetType: "machine",
        targetId: offlineMachines[0]!.id,
      },
      payload: {
        machines: machineRefs(offlineMachines),
        activeAgentCount: activeCount,
        targetDaemonVersion: null,
        evaluation: evaluationAt(evaluatedAt),
      },
    });
  }

  const outdatedMachines = canonicalMachineOrder(
    rawDaemonMachines.filter(
      (machine) => machine.status === "online"
        && isDaemonOutdated(machine.daemonVersion, latestDaemonVersion),
    ),
  );

  if (outdatedMachines.length > 0 && latestDaemonVersion) {
    const names = outdatedMachines.map((machine) => machine.name).join(", ");
    const singular = outdatedMachines.length === 1;
    const activeCount = activeAgentCount(outdatedMachines, activeAgentCountByMachine);
    notifications.push({
      id: `machine-outdated:${latestDaemonVersion}:${machineSetIdentity(outdatedMachines)}`,
      type: "machine.outdated",
      schemaVersion: MACHINE_SYSTEM_NOTIFICATION_SCHEMA_VERSION,
      state: "active",
      kind: "warning",
      title: `${names} ${singular ? "is running an outdated daemon" : "are running outdated daemons"}`,
      body: "Stop the daemon and reconnect to update.",
      copy: {
        titleKey: singular ? "machine.outdated.title.one" : "machine.outdated.title.many",
        bodyKey: "machine.outdated.body",
        actionLabelKey: "common.view",
        params: {
          machineNames: names,
          machineCount: outdatedMachines.length,
          activeAgentCount: activeCount,
          targetDaemonVersion: latestDaemonVersion,
        },
      },
      action: {
        label: "View",
        targetType: "machine",
        targetId: outdatedMachines[0]!.id,
      },
      payload: {
        machines: machineRefs(outdatedMachines),
        activeAgentCount: activeCount,
        targetDaemonVersion: latestDaemonVersion,
        evaluation: evaluationAt(evaluatedAt),
      },
    });
  }

  return notifications;
}

export function buildServerSystemNotificationsResponse(
  generatedAt: Date,
  notifications: MachineSystemNotification[],
): ServerSystemNotificationsResponse {
  return {
    contractVersion: SERVER_SYSTEM_NOTIFICATIONS_CONTRACT_VERSION,
    generatedAt: generatedAt.toISOString(),
    snapshotMode: "replace",
    clientState: {
      read: "none",
      dismiss: "local_by_notification_id",
    },
    notifications,
  };
}
