export interface MachineConnectionGeneration {
  connectionEpochId: string;
  replicaGeneration: string;
}

export class MachineCatalogStaleError extends Error {
  readonly code = "builtin_catalog_stale";

  constructor() {
    super(
      "The target Computer connection changed after its model catalog was validated. Retry against the current Computer connection.",
    );
    this.name = "MachineCatalogStaleError";
  }
}

type Waiter = () => void;

/**
 * A tiny per-machine read lease. Catalog-authorized mutations acquire it
 * synchronously after comparing the exact connection generation. Connection
 * replacement waits for readers to quiesce, so validate→persist/dispatch is a
 * single linearized interval rather than a check followed by a TOCTOU race.
 */
export class MachineCatalogAuthority {
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly replacing = new Map<string, MachineConnectionGeneration>();

  constructor(
    private readonly currentGeneration: (
      machineId: string,
    ) => MachineConnectionGeneration | null,
  ) {}

  private sameGeneration(
    current: MachineConnectionGeneration | null,
    expected: MachineConnectionGeneration,
  ): boolean {
    return (
      current?.connectionEpochId === expected.connectionEpochId &&
      current.replicaGeneration === expected.replicaGeneration
    );
  }

  acquire(
    machineId: string,
    expected: MachineConnectionGeneration,
  ): () => void {
    const current = this.currentGeneration(machineId);
    const replacing = this.replacing.get(machineId);
    if (replacing && !this.sameGeneration(current, replacing)) {
      this.replacing.delete(machineId);
    }
    if (
      !this.sameGeneration(current, expected) ||
      (replacing && this.sameGeneration(replacing, expected))
    ) {
      throw new MachineCatalogStaleError();
    }
    this.active.set(machineId, (this.active.get(machineId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.active.get(machineId) ?? 1) - 1;
      if (remaining > 0) {
        this.active.set(machineId, remaining);
      } else {
        this.active.delete(machineId);
        const waiters = this.waiters.get(machineId);
        this.waiters.delete(machineId);
        for (const resolve of waiters ?? []) resolve();
      }
    };
  }

  async run<T>(
    machineId: string,
    expected: MachineConnectionGeneration,
    action: () => Promise<T>,
  ): Promise<T> {
    const release = this.acquire(machineId, expected);
    try {
      return await action();
    } finally {
      release();
    }
  }

  async beginReplacement(
    machineId: string,
    expected: MachineConnectionGeneration,
  ): Promise<void> {
    if (!this.sameGeneration(this.currentGeneration(machineId), expected)) {
      throw new MachineCatalogStaleError();
    }
    // Fence late readers before observing the current reader count. Without
    // this writer intent, a validate→persist action could acquire in the gap
    // between a zero-reader observation and actual socket removal.
    this.replacing.set(machineId, expected);
    if (!this.active.has(machineId)) return;
    await new Promise<void>((resolve) => {
      const waiters = this.waiters.get(machineId) ?? new Set<Waiter>();
      waiters.add(resolve);
      this.waiters.set(machineId, waiters);
    });
  }

  completeReplacement(
    machineId: string,
    expected: MachineConnectionGeneration,
  ): void {
    const replacing = this.replacing.get(machineId);
    if (replacing && this.sameGeneration(replacing, expected)) {
      this.replacing.delete(machineId);
    }
  }
}
