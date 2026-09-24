import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { currentTimeMs } from "@botiverse/raft-shared";

/**
 * Serialized persistence seam for the task #274 machine reducer.
 *
 * This module deliberately knows nothing about process spawning, signalling,
 * sockets, or Web transport. A worker supplies a durable text cell later; the
 * reducer/fault harness already crosses the same JSON boundary on every step.
 */
export interface DurableTextCell {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  withLock?<T>(run: () => Promise<T>): Promise<T>;
}

export interface MachineProcessIdentity {
  pid: number;
  startIdentity: string;
  role: "origin_runner" | "coordinator" | "standby" | "service" | "managed_runner";
  serverId?: string;
  version?: string;
}

export interface MachineDispatchIdentity {
  dispatchOperationId: string;
  /** Null only when a historical first hop predates U metadata forwarding. */
  parentUserOperationId: string | null;
  dispatchAction: "restart" | "upgrade";
  targetVersion: string;
  adapter: string;
  originServerId: string;
  machineId: string;
}

export interface MachineAcceptanceSnapshot {
  sourceServiceGeneration: string;
  acceptedManagedSetRevision: number;
  acceptedManagedServerIds: string[];
  capturedOldProcessIdentities: MachineProcessIdentity[];
}

export type MachineOperationPhase =
  | "accepted"
  | "mutation_claimed"
  | "first_hop_observed"
  | "handoff_arming"
  | "handoff_armed"
  | "old_service_stop_claimed"
  | "old_service_dead"
  | "target_supervisor_live"
  | "managed_set_converged"
  | "terminal_outbox"
  | "receipt_observed"
  | "finalized";

export interface MachineEffectIntent {
  key: string;
  kind:
    | "spawn_coordinator"
    | "spawn_standby"
    | "stop_old_service"
    | "promote_standby"
    | "spawn_managed_runner"
    | "write_terminal_outbox";
  process?: MachineProcessIdentity;
  managedSetRevision?: number;
  targetGeneration?: string;
}

export interface MachineOperationRecord {
  schemaVersion: 1;
  identity: MachineDispatchIdentity;
  acceptance: MachineAcceptanceSnapshot;
  phase: MachineOperationPhase;
  phaseVersion: number;
  claimEpoch: number;
  leaseHolder: string | null;
  leaseUntil: string | null;
  firstHopProgressOrdinal: number;
  currentManagedSetRevision: number;
  observedTargetGeneration: string | null;
  originRunner: MachineProcessIdentity | null;
  coordinator: MachineProcessIdentity | null;
  standby: MachineProcessIdentity | null;
  targetSupervisor: MachineProcessIdentity | null;
  appendOnlyObservedOldProcessIdentities: MachineProcessIdentity[];
  effectIntents: MachineEffectIntent[];
  terminalOutbox: { dispatchOperationId: string; writtenAt: string } | null;
  receipt: { dispatchOperationId: string; observedAt: string } | null;
}

function isRecord(value: unknown): value is MachineOperationRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<MachineOperationRecord>;
  return record.schemaVersion === 1
    && typeof record.identity?.dispatchOperationId === "string"
    && (record.identity.parentUserOperationId === null
      || typeof record.identity.parentUserOperationId === "string")
    && typeof record.phase === "string"
    && typeof record.phaseVersion === "number"
    && Array.isArray(record.effectIntents);
}

export function serializeMachineOperationRecord(record: MachineOperationRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function parseMachineOperationRecord(serialized: string): MachineOperationRecord {
  const parsed = JSON.parse(serialized) as unknown;
  if (!isRecord(parsed)) throw new Error("MACHINE_OPERATION_RECORD_INVALID");
  return parsed;
}

export class SerializedMachineOperationStore {
  constructor(private readonly cell: DurableTextCell) {}

  async load(): Promise<MachineOperationRecord | null> {
    const serialized = await this.cell.read();
    return serialized === null ? null : parseMachineOperationRecord(serialized);
  }

  async replace(record: MachineOperationRecord): Promise<void> {
    await this.cell.write(serializeMachineOperationRecord(record));
  }

  async createIfAbsent(record: MachineOperationRecord): Promise<
    | { kind: "created"; record: MachineOperationRecord }
    | { kind: "exists"; record: MachineOperationRecord }
  > {
    return this.exclusive(async () => {
      const existing = await this.load();
      if (existing) return { kind: "exists", record: existing };
      await this.replace(record);
      return { kind: "created", record: await this.requireReload() };
    });
  }

  async compareAndSwap(
    expectedPhaseVersion: number,
    next: MachineOperationRecord,
  ): Promise<
    | { kind: "applied"; record: MachineOperationRecord }
    | { kind: "stale"; record: MachineOperationRecord }
    | { kind: "missing" }
  > {
    return this.exclusive(async () => {
      const current = await this.load();
      if (!current) return { kind: "missing" };
      if (current.phaseVersion !== expectedPhaseVersion) return { kind: "stale", record: current };
      await this.replace(next);
      return { kind: "applied", record: await this.requireReload() };
    });
  }

  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    return this.cell.withLock ? this.cell.withLock(run) : run();
  }

  private async requireReload(): Promise<MachineOperationRecord> {
    const reloaded = await this.load();
    if (!reloaded) throw new Error("MACHINE_OPERATION_RECORD_MISSING_AFTER_WRITE");
    return reloaded;
  }
}

/** Atomic, crash-safe filesystem cell used by the production worker. */
export class FileDurableTextCell implements DurableTextCell {
  constructor(private readonly path: string) {}

  async read(): Promise<string | null> {
    try {
      return await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(value: string): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${currentTimeMs()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.path);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async withLock<T>(run: () => Promise<T>): Promise<T> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(directory, {
      lockfilePath: `${this.path}.lock`,
      realpath: false,
      retries: { retries: 50, factor: 1.2, minTimeout: 10, maxTimeout: 250 },
      stale: 30_000,
      update: 10_000,
    });
    try {
      return await run();
    } finally {
      await release();
    }
  }
}
