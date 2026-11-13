import { isDeviceClass, isHostProvider, normalizeOsId, normalizeOsIdLike, normalizeOsRelease, type MachineDiskStatus, type MachineMemoryStatus } from "@botiverse/raft-shared";
import type { AgentOrchestrator } from "./agentOrchestrator";
import type {
  ComputerSourceFactProvenance,
} from "./computerBroadcastPolicyService";

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
  // Coarse machine kind for the icon; null = unknown (older daemon or undetected).
  deviceClass?: string | null;
  // Cloud / VM platform id and OS release ("Ubuntu 26.04"); null = unknown.
  hostProvider?: string | null;
  osRelease?: string | null;
  // os-release ID / ID_LIKE for the distribution icon; null = unknown.
  osId?: string | null;
  osIdLike?: string[] | null;
  // How the daemon runs (shared DAEMON_INSTALL_KINDS), from its latest
  // `ready`; null = unknown. Upgrade-policy input, not projected by the list.
  installKind?: string | null;
  daemonVersion: string | null;
  lastHeartbeat: Date | null;
  createdAt: Date;
  // Last Computer version this machine reported, persisted on `ready`.
  computerVersion?: string | null;
  computerVersionReportedAt?: Date | null;
  // #proj-raft-computer task #38: owner-only, see `credentialExposureFoundAt` below.
  credentialExposureFoundAt?: Date | null;
  legacyKeyMigratedAt?: Date | null;
  // Computer owner v1 (#wg-rbac:#32): who Raft records as the owner; null = Public.
  ownerUserId?: string | null;
};

export type MachineReadModel = Omit<MachineReadModelInput, "credentialExposureFoundAt" | "legacyKeyMigratedAt"> & {
  /** #proj-raft-computer task #38: when an agent may have read this machine's current key (ISO); the owner only, else null. */
  credentialExposureFoundAt: string | null;
  status: "online" | "offline";
  statusVersion: number;
  runtimes: string[];
  runtimeVersions: Record<string, string>;
  /**
   * task #1268: the daemon's runtime detection state. `pending` / `incomplete`
   * mean `runtimes` is the last confirmed list (unconfirmed, not unavailable);
   * null for synchronous daemons and offline machines.
   */
  runtimeDetection: { status: "pending" | "complete" | "incomplete"; unfinishedRuntimes?: string[]; reason?: "deadline" | "child_failed" | "cancelled"; updatedAtMs: number } | null;
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
  /**
   * Computer owner v1 (#wg-rbac:#32): who Raft records as this Computer's
   * owner, null = a Public Computer. Not the connector (`userId`, the
   * attacher): display and transfer only, no rights. Additive.
   */
  ownerUserId: string | null;
  // True when the current requester is the user who attached the backing
  // Computer row. Raw daemons expose false. Web Add Computer uses this to
  // avoid pivoting one user's setup wizard onto another user's Computer.
  computerAttachedByCurrentUser: boolean;
  // Number of active agents assigned to this machine. This is the user-visible
  // identity signal for Computer recovery flows: if a freshly attached
  // Computer has zero agents while another locally-known machine has agents,
  // the latter is probably the user's real Computer.
  agentCount: number;
  // Latest disk report while connected (null when offline or never
  // reported). Clients derive the low-disk warning with isMachineDiskLow.
  diskStatus: MachineDiskStatus | null;
  // Latest memory report while connected (null when offline, never reported,
  // or from a Computer older than the report).
  memoryStatus: MachineMemoryStatus | null;
};

/**
 * A machine row as it may leave the server: the stored key hash, the key
 * fingerprint (sha256 prefix, SECRET REDLINE in machineService.ts) and the web
 * session that issued the key never do.
 * Responses that start from a raw `daemons` row (register, PATCH, the read
 * model) pass through this.
 */
export function withoutMachineKeySecrets<T extends object>(row: T): Omit<T, "apiKeyHash" | "apiKeyFingerprint" | "keyIssuedByWebSessionFamilyId" | "credentialExposureFoundAt"> {
  // Which web session issued the key is the cascade's (webSessionIssuedKeys.ts), never a client's.
  // A credential exposure is the owner's to see (buildMachineReadModel adds it back for them).
  const { apiKeyHash: _hash, apiKeyFingerprint: _fingerprint, keyIssuedByWebSessionFamilyId: _issuedBy, credentialExposureFoundAt: _exposure, ...rest } =
    row as T & { apiKeyHash?: unknown; apiKeyFingerprint?: unknown; keyIssuedByWebSessionFamilyId?: unknown; credentialExposureFoundAt?: unknown };
  return rest;
}

export async function buildMachineReadModel(
  machine: MachineReadModelInput,
  agentOrchestrator: Pick<
    AgentOrchestrator,
    "getMachineStatus" | "getMachineStatusVersion" | "getMachineDaemonVersion"
  > & Partial<Pick<AgentOrchestrator, "getMachineComputerVersion" | "getMachineComputerVersionFact" | "getMachineRuntimeVersions" | "getMachineDiskStatus" | "getMachineMemoryStatus" | "getMachineRuntimeDetection">>,
  opts?: { isComputer?: boolean; computerAttachedByCurrentUser?: boolean; agentCount?: number; viewerUserId?: string | null },
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
  const runtimeDetectionPromise = agentOrchestrator.getMachineRuntimeDetection
    ? agentOrchestrator.getMachineRuntimeDetection(machine.id)
    : Promise.resolve(null);
  const diskStatusPromise = agentOrchestrator.getMachineDiskStatus
    ? agentOrchestrator.getMachineDiskStatus(machine.id)
    : Promise.resolve(null);
  const memoryStatusPromise = agentOrchestrator.getMachineMemoryStatus
    ? agentOrchestrator.getMachineMemoryStatus(machine.id)
    : Promise.resolve(null);
  const [status, statusVersion, liveComputerFact, runtimeVersions, diskStatus, memoryStatus, runtimeDetection] = await Promise.all([
    agentOrchestrator.getMachineStatus(machine.id),
    agentOrchestrator.getMachineStatusVersion(machine.id),
    liveComputerFactPromise,
    runtimeVersionsPromise,
    diskStatusPromise,
    memoryStatusPromise,
    runtimeDetectionPromise,
  ]);
  return {
    ...withoutMachineKeySecrets(machine),
    status,
    statusVersion,
    runtimes: machine.runtimes || [],
    runtimeVersions,
    runtimeDetection: status === "online" ? (runtimeDetection ?? null) : null,
    hostname: machine.hostname ?? null,
    os: machine.os ?? null,
    deviceClass: isDeviceClass(machine.deviceClass) ? machine.deviceClass : null,
    hostProvider: isHostProvider(machine.hostProvider) ? machine.hostProvider : null,
    osRelease: normalizeOsRelease(machine.osRelease),
    osId: normalizeOsId(machine.osId),
    osIdLike: normalizeOsIdLike(machine.osIdLike),
    lastHeartbeat: machine.lastHeartbeat ?? null,
    daemonVersion: liveDaemonVersion ?? machine.daemonVersion ?? null,
    ...computerVersionFields(status, liveComputerFact, machine),
    isComputer: opts?.isComputer ?? false,
    ownerUserId: machine.ownerUserId ?? null,
    computerAttachedByCurrentUser: opts?.computerAttachedByCurrentUser ?? false,
    agentCount: opts?.agentCount ?? 0,
    // #proj-raft-computer task #38: only the machine's owner, and only while the
    // exposed key has not been retired by the move to a Computer credential.
    credentialExposureFoundAt: opts?.viewerUserId && opts.viewerUserId === machine.userId && !machine.legacyKeyMigratedAt && machine.credentialExposureFoundAt
      ? machine.credentialExposureFoundAt.toISOString()
      : null,
    diskStatus: status === "online" ? diskStatus : null,
    memoryStatus: status === "online" ? memoryStatus : null,
  };
}

/**
 * The live fact when there is one. An ONLINE machine with no live version yet
 * (just reconnected, e.g. right after an upgrade restart, and this replica has
 * not seen its `ready`) shows the version it last reported instead of none, so
 * the page does not sit on "reading the version". Offline machines keep null.
 */
function computerVersionFields(
  status: "online" | "offline",
  live: { version: string | null; observedAt: string | null; provenance: ComputerSourceFactProvenance | null } | null,
  machine: Pick<MachineReadModelInput, "computerVersion" | "computerVersionReportedAt">,
): Pick<MachineReadModel, "computerVersion" | "computerVersionObservedAt" | "computerVersionProvenance"> {
  if (live?.version) {
    return { computerVersion: live.version, computerVersionObservedAt: live.observedAt, computerVersionProvenance: live.provenance };
  }
  const stored = machine.computerVersion?.trim();
  if (status === "online" && stored) {
    return {
      computerVersion: stored,
      computerVersionObservedAt: machine.computerVersionReportedAt?.toISOString() ?? null,
      computerVersionProvenance: "stored_report",
    };
  }
  return {
    computerVersion: live?.version ?? null,
    computerVersionObservedAt: live?.observedAt ?? null,
    computerVersionProvenance: live?.provenance ?? null,
  };
}
