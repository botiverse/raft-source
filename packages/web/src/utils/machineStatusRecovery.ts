import { failpoints } from "@botiverse/raft-shared";

export interface MachineStatusRecoveryEvent {
  machineId: string;
  status: "online" | "offline";
  statusVersion?: number;
}

export interface MachineStatusRecoveryDependencies {
  /**
   * Apply the machine status (version-gated merge). Returns whether the event
   * was ACCEPTED (i.e. it is the newest status for the machine); a stale event
   * whose statusVersion is older than the current one is rejected and returns
   * false.
   */
  updateMachineStatus: (machineId: string, status: "online" | "offline", statusVersion?: number) => boolean;
  reloadMachines: () => void;
  reloadAgents: () => void;
}

/**
 * Keep machine status handling symmetric on the web client.
 *
 * Machine status events are suspicion signals for agent liveness. The server is
 * the only authority that can emit agent-level offline/working status, so both
 * online and offline machine transitions converge by reloading machine + agent
 * truth instead of locally asserting per-agent status.
 *
 * Multi-replica socket fanout can deliver status events out of order: after a
 * restart, the reconnect's `online(vN+1)` may arrive before the disconnect's
 * `offline(vN)`. The version-gated merge correctly keeps the machine online for
 * such a stale offline, so stale events must not trigger recovery churn.
 */
export async function handleMachineStatusRecoveryEvent(
  event: MachineStatusRecoveryEvent,
  deps: MachineStatusRecoveryDependencies,
): Promise<void> {
  const accepted = deps.updateMachineStatus(event.machineId, event.status, event.statusVersion);

  if (!accepted) return;

  if (!failpoints.enabled) {
    deps.reloadMachines();
    deps.reloadAgents();
    return;
  }

  await failpoints.hit(
    "web.machineStatusRecovery.onlineAuthoritativeReload",
    { machineId: event.machineId, statusVersion: event.statusVersion ?? null },
    async () => {
      deps.reloadMachines();
      deps.reloadAgents();
    },
  );
}
