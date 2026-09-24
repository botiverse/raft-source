import type {
  SyncCore,
  SyncDifferenceResponse,
  SyncDomainName,
  SyncEpoch,
  SyncFrame,
  SyncIngestOutcome,
  SyncScopeId,
  SyncSeq,
  SyncSnapshot,
} from "./types.js";

export type SyncHarnessInput<E = unknown, S = unknown> =
  | { kind: "frame"; domain: SyncDomainName; frame: SyncFrame<E> }
  | { kind: "snapshot"; domain: SyncDomainName; snapshot: SyncSnapshot<S> }
  | { kind: "difference"; domain: SyncDomainName; response: SyncDifferenceResponse<E> };

export interface SyncHarnessStep<E = unknown, S = unknown> {
  ordinal: number;
  input: SyncHarnessInput<E, S>;
  expectedOutcome: SyncIngestOutcome;
}

export interface SyncHarnessFixture<E = unknown, S = unknown> {
  seed: number;
  domain: SyncDomainName;
  steps: ReadonlyArray<SyncHarnessStep<E, S>>;
}

export interface SyncHarnessFixtureOptions {
  seed: number;
  domain: SyncDomainName;
  scopeIds: ReadonlyArray<SyncScopeId>;
  steps: number;
  epoch?: SyncEpoch | null;
}

export interface SyncMixedInterleavingFixtureOptions extends SyncHarnessFixtureOptions {
  /** Include the canonical stale-snapshot rollback witness before fuzz steps. */
  includeStaleSnapshotRollbackWitness?: boolean;
}

export interface SyncHarnessEvent {
  value: number;
}

export interface SyncHarnessSnapshotState {
  applied: ReadonlyArray<number>;
}

export function createSyncHarnessPrng(seed: number): () => number {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError("Sync harness seed must be a safe integer");
  }

  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function generateSyncHarnessFixture(
  options: SyncHarnessFixtureOptions,
): SyncHarnessFixture<SyncHarnessEvent, SyncHarnessSnapshotState> {
  if (options.scopeIds.length === 0) {
    throw new RangeError("Sync harness needs at least one scopeId");
  }
  if (!Number.isSafeInteger(options.steps) || options.steps < 0) {
    throw new RangeError("Sync harness steps must be a non-negative safe integer");
  }

  const epoch = options.epoch ?? "epoch-0";
  const nextByScope = new Map<SyncScopeId, SyncSeq>(options.scopeIds.map((scopeId) => [scopeId, 1n]));
  const random = createSyncHarnessPrng(options.seed);
  const steps: SyncHarnessStep<SyncHarnessEvent, SyncHarnessSnapshotState>[] = [];

  for (let ordinal = 0; ordinal < options.steps; ordinal += 1) {
    const scopeId = options.scopeIds[Math.floor(random() * options.scopeIds.length)] as SyncScopeId;
    const nextSeq = nextByScope.get(scopeId) ?? 1n;
    const shape = Math.floor(random() * 5);

    if (ordinal === 0 || shape === 0) {
      const watermark = nextSeq > 1n ? nextSeq - 1n : 0n;
      steps.push({
        ordinal,
        input: {
          kind: "snapshot",
          domain: options.domain,
          snapshot: { scopeId, watermark, epoch, state: { applied: rangeInclusive(1, Number(watermark)) } },
        },
        expectedOutcome: { kind: "applied", scopeId, seq: watermark },
      });
      continue;
    }

    if (shape === 1 && nextSeq > 1n) {
      const seq = nextSeq - 1n;
      steps.push({
        ordinal,
        input: {
          kind: "frame",
          domain: options.domain,
          frame: { scopeId, seq, epoch, event: { value: Number(seq) } },
        },
        expectedOutcome: { kind: "duplicate_dropped", scopeId, seq },
      });
      continue;
    }

    if (shape === 2) {
      const seq = nextSeq + 1n;
      steps.push({
        ordinal,
        input: {
          kind: "frame",
          domain: options.domain,
          frame: { scopeId, seq, epoch, event: { value: Number(seq) } },
        },
        expectedOutcome: { kind: "gap_repair_requested", scopeId, fromSeq: nextSeq, toSeq: seq },
      });
      continue;
    }

    if (shape === 3) {
      const seq = nextSeq + 1n;
      steps.push({
        ordinal,
        input: {
          kind: "difference",
          domain: options.domain,
          response: {
            scopeId,
            epoch,
            fromSeq: nextSeq,
            toSeq: seq,
            events: [
              { seq: nextSeq, event: { value: Number(nextSeq) } },
              { seq, event: { value: Number(seq) } },
            ],
          },
        },
        expectedOutcome: { kind: "applied", scopeId, seq },
      });
      nextByScope.set(scopeId, seq + 1n);
      continue;
    }

    steps.push({
      ordinal,
      input: {
        kind: "frame",
        domain: options.domain,
        frame: { scopeId, seq: nextSeq, epoch, event: { value: Number(nextSeq) } },
      },
      expectedOutcome: { kind: "applied", scopeId, seq: nextSeq },
    });
    nextByScope.set(scopeId, nextSeq + 1n);
  }

  return { seed: options.seed, domain: options.domain, steps };
}

export function generateSyncMixedInterleavingHarnessFixture(
  options: SyncMixedInterleavingFixtureOptions,
): SyncHarnessFixture<SyncHarnessEvent, SyncHarnessSnapshotState> {
  validateFixtureOptions(options);
  const includeStaleSnapshotRollbackWitness = options.includeStaleSnapshotRollbackWitness ?? true;
  if (includeStaleSnapshotRollbackWitness && options.steps < STALE_SNAPSHOT_WITNESS_STEPS) {
    throw new RangeError("Mixed sync harness needs at least 6 steps for the stale snapshot rollback witness");
  }

  const epoch = options.epoch ?? "epoch-0";
  const random = createSyncHarnessPrng(options.seed);
  const steps: SyncHarnessStep<SyncHarnessEvent, SyncHarnessSnapshotState>[] = [];
  const nextByScope = new Map<SyncScopeId, SyncSeq>(options.scopeIds.map((scopeId) => [scopeId, 1n]));
  const baselinedScopes = new Set<SyncScopeId>();

  if (includeStaleSnapshotRollbackWitness) {
    const scopeId = options.scopeIds[Math.floor(random() * options.scopeIds.length)] as SyncScopeId;
    appendStaleSnapshotRollbackWitness({
      steps,
      domain: options.domain,
      scopeId,
      epoch,
    });
    nextByScope.set(scopeId, 6n);
    baselinedScopes.add(scopeId);
  }

  while (steps.length < options.steps) {
    const ordinal = steps.length;
    const scopeId = options.scopeIds[Math.floor(random() * options.scopeIds.length)] as SyncScopeId;
    const nextSeq = nextByScope.get(scopeId) ?? 1n;
    const hasBaseline = baselinedScopes.has(scopeId);
    const shape = Math.floor(random() * 6);

    if (!hasBaseline || shape === 0) {
      const watermark = nextSeq > 1n ? nextSeq - 1n : 0n;
      steps.push({
        ordinal,
        input: {
          kind: "snapshot",
          domain: options.domain,
          snapshot: { scopeId, watermark, epoch, state: { applied: rangeInclusive(1, Number(watermark)) } },
        },
        expectedOutcome: hasBaseline
          ? { kind: "duplicate_dropped", scopeId, seq: watermark }
          : { kind: "applied", scopeId, seq: watermark },
      });
      baselinedScopes.add(scopeId);
      continue;
    }

    if (shape === 1) {
      steps.push({
        ordinal,
        input: {
          kind: "frame",
          domain: options.domain,
          frame: { scopeId, seq: nextSeq, epoch, event: { value: Number(nextSeq) } },
        },
        expectedOutcome: { kind: "applied", scopeId, seq: nextSeq },
      });
      nextByScope.set(scopeId, nextSeq + 1n);
      continue;
    }

    if (shape === 2) {
      const seq = nextSeq > 1n ? nextSeq - 1n : 0n;
      steps.push({
        ordinal,
        input: {
          kind: "frame",
          domain: options.domain,
          frame: { scopeId, seq, epoch, event: { value: Number(seq) } },
        },
        expectedOutcome: { kind: "duplicate_dropped", scopeId, seq },
      });
      continue;
    }

    if (shape === 3) {
      const seq = nextSeq + 1n;
      steps.push({
        ordinal,
        input: {
          kind: "frame",
          domain: options.domain,
          frame: { scopeId, seq, epoch, event: { value: Number(seq) } },
        },
        expectedOutcome: { kind: "gap_repair_requested", scopeId, fromSeq: nextSeq, toSeq: nextSeq },
      });
      continue;
    }

    if (shape === 4) {
      const toSeq = nextSeq + 1n;
      steps.push({
        ordinal,
        input: {
          kind: "difference",
          domain: options.domain,
          response: {
            scopeId,
            epoch,
            fromSeq: nextSeq > 1n ? nextSeq - 1n : 0n,
            toSeq,
            events: [
              { seq: nextSeq, event: { value: Number(nextSeq) } },
              { seq: toSeq, event: { value: Number(toSeq) } },
            ],
          },
        },
        expectedOutcome: { kind: "applied", scopeId, seq: toSeq },
      });
      nextByScope.set(scopeId, toSeq + 1n);
      continue;
    }

    const watermark = nextSeq > 2n ? nextSeq - 2n : 0n;
    steps.push({
      ordinal,
      input: {
        kind: "snapshot",
        domain: options.domain,
        snapshot: { scopeId, watermark, epoch, state: { applied: rangeInclusive(1, Number(watermark)) } },
      },
      expectedOutcome: { kind: "duplicate_dropped", scopeId, seq: watermark },
    });
  }

  return { seed: options.seed, domain: options.domain, steps };
}

export function ingestSyncHarnessInput(core: SyncCore, input: SyncHarnessInput): SyncIngestOutcome {
  switch (input.kind) {
    case "frame":
      return core.ingestFrame(input.domain, input.frame);
    case "snapshot":
      return core.ingestSnapshot(input.domain, input.snapshot);
    case "difference":
      return core.ingestDifference(input.domain, input.response);
  }
}

export function replaySyncHarnessFixture(core: SyncCore, fixture: SyncHarnessFixture): SyncIngestOutcome[] {
  return fixture.steps.map((step) => ingestSyncHarnessInput(core, step.input));
}

const STALE_SNAPSHOT_WITNESS_STEPS = 6;

function appendStaleSnapshotRollbackWitness({
  steps,
  domain,
  scopeId,
  epoch,
}: {
  steps: SyncHarnessStep<SyncHarnessEvent, SyncHarnessSnapshotState>[];
  domain: SyncDomainName;
  scopeId: SyncScopeId;
  epoch: SyncEpoch | null;
}): void {
  const startOrdinal = steps.length;
  steps.push(
    {
      ordinal: startOrdinal,
      input: {
        kind: "snapshot",
        domain,
        snapshot: { scopeId, watermark: 0n, epoch, state: { applied: [] } },
      },
      expectedOutcome: { kind: "applied", scopeId, seq: 0n },
    },
    {
      ordinal: startOrdinal + 1,
      input: {
        kind: "frame",
        domain,
        frame: { scopeId, seq: 1n, epoch, event: { value: 1 } },
      },
      expectedOutcome: { kind: "applied", scopeId, seq: 1n },
    },
    {
      ordinal: startOrdinal + 2,
      input: {
        kind: "frame",
        domain,
        frame: { scopeId, seq: 2n, epoch, event: { value: 2 } },
      },
      expectedOutcome: { kind: "applied", scopeId, seq: 2n },
    },
    {
      ordinal: startOrdinal + 3,
      input: {
        kind: "difference",
        domain,
        response: {
          scopeId,
          epoch,
          fromSeq: 2n,
          toSeq: 4n,
          events: [
            { seq: 3n, event: { value: 3 } },
            { seq: 4n, event: { value: 4 } },
          ],
        },
      },
      expectedOutcome: { kind: "applied", scopeId, seq: 4n },
    },
    {
      ordinal: startOrdinal + 4,
      input: {
        kind: "snapshot",
        domain,
        snapshot: { scopeId, watermark: 2n, epoch, state: { applied: [1, 2] } },
      },
      expectedOutcome: { kind: "duplicate_dropped", scopeId, seq: 2n },
    },
    {
      ordinal: startOrdinal + 5,
      input: {
        kind: "frame",
        domain,
        frame: { scopeId, seq: 5n, epoch, event: { value: 5 } },
      },
      expectedOutcome: { kind: "applied", scopeId, seq: 5n },
    },
  );
}

function validateFixtureOptions(options: SyncHarnessFixtureOptions): void {
  if (options.scopeIds.length === 0) {
    throw new RangeError("Sync harness needs at least one scopeId");
  }
  if (!Number.isSafeInteger(options.steps) || options.steps < 0) {
    throw new RangeError("Sync harness steps must be a non-negative safe integer");
  }
}

function rangeInclusive(start: number, end: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end; value += 1) {
    values.push(value);
  }
  return values;
}
