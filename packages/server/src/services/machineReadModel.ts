import type { AgentOrchestrator } from "./agentOrchestrator.js";
import type {
  ComputerSourceFactProvenance,
} from "./computerBroadcastPolicyService.js";

type MachineReadModelInput = {
  id: string;
  serverId: string;
  userId: string;
  name: string;
  description: string | null;
  apiKeyPrefix: string | null;
  runtimes: string[] | null;
  hostname: string | null;
  os: string | null;
  daemonVersion: string | null;
  lastHeartbeat: Date | null;
  createdAt: Date;
};

export type MachineReadModel = MachineReadModelInput & {
  status: "online" | "offline";
  statusVersion: number;
  runtimes: string[];
  runtimeVersions: Record<string, string>;
  daemonVersion: string | null;
  // Managed-Computer bundle version (`@botiverse/raft-computer`), live from the
  // connection's `ready`. Null for raw daemons / when not reported.
  computerVersion: string | null;
  // Freshness/provenance travel with the version so source-aware policy never
  // admits from a value-only fact. These are internal route inputs; the
  // machines route projects the closed policy decision instead.
  computerVersionObservedAt: string | null;
  computerVersionProvenance: ComputerSourceFactProvenance | null;
  // Run-kind: true when this machine row is presented by an attached
  // managed Computer (an active `computers` row links to it via
  // `computers.machineId`); false for a raw `@slock-ai/daemon` machine.
  // Derived server-side from the existing computers↔machines link — no
  // new daemon-reported field. Drives the web detail page's
  // Computer/Daemon label, computer-only setup command, and (later)
  // remote restart/upgrade controls.
  isComputer: boolean;
  // True when the current requester is the user who attached the backing
  // Computer row. Raw daemons expose false. Web Add Computer uses this to
  // avoid pivoting one user's setup wizard onto another user's Computer.
  computerAttachedByCurrentUser: boolean;
  // Number of active agents assigned to this machine. This is the user-visible
  // identity signal for Computer recovery flows: if a freshly attached
  // Computer has zero agents while another locally-known machine has agents,
  // the latter is probably the user's real Computer.
  agentCount: number;
};

export async function buildMachineReadModel(
  machine: MachineReadModelInput,
  agentOrchestrator: Pick<
    AgentOrchestrator,
    "getMachineStatus" | "getMachineStatusVersion" | "getMachineDaemonVersion"
  > & Partial<Pick<AgentOrchestrator, "getMachineComputerVersion" | "getMachineComputerVersionFact" | "getMachineRuntimeVersions">>,
  opts?: { isComputer?: boolean; computerAttachedByCurrentUser?: boolean; agentCount?: number },
): Promise<MachineReadModel> {
  const liveDaemonVersion = agentOrchestrator.getMachineDaemonVersion(machine.id);
  // Optional-chained so a caller whose orchestrator predates this method
  // (e.g. partial test stubs) degrades to null rather than throwing. The
  // call is now async so cross-replica REST reads can fall back to the
  // Redis meta mirror when this replica doesn't own the machine connection
  // (#wg-raft-computer task #95).
  const liveComputerFactPromise = agentOrchestrator.getMachineComputerVersionFact
    ? agentOrchestrator.getMachineComputerVersionFact(machine.id)
    : agentOrchestrator.getMachineComputerVersion
      ? agentOrchestrator.getMachineComputerVersion(machine.id).then((version) => ({
        version,
        observedAt: null,
        provenance: null,
      }))
      : Promise.resolve(null);
  const runtimeVersionsPromise = agentOrchestrator.getMachineRuntimeVersions
    ? agentOrchestrator.getMachineRuntimeVersions(machine.id)
    : Promise.resolve({});
  const [status, statusVersion, liveComputerFact, runtimeVersions] = await Promise.all([
    agentOrchestrator.getMachineStatus(machine.id),
    agentOrchestrator.getMachineStatusVersion(machine.id),
    liveComputerFactPromise,
    runtimeVersionsPromise,
  ]);
  return {
    ...machine,
    status,
    statusVersion,
    runtimes: machine.runtimes || [],
    runtimeVersions,
    hostname: machine.hostname ?? null,
    os: machine.os ?? null,
    lastHeartbeat: machine.lastHeartbeat ?? null,
    daemonVersion: liveDaemonVersion ?? machine.daemonVersion ?? null,
    computerVersion: liveComputerFact?.version ?? null,
    computerVersionObservedAt: liveComputerFact?.observedAt ?? null,
    computerVersionProvenance: liveComputerFact?.provenance ?? null,
    isComputer: opts?.isComputer ?? false,
    computerAttachedByCurrentUser: opts?.computerAttachedByCurrentUser ?? false,
    agentCount: opts?.agentCount ?? 0,
  };
}
