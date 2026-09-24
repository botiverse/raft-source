/** Case-owned resources; intentionally independent of Vitest and the app. */
export class IntegrationLifecycle {
  private readonly resources = new Set<() => Promise<void>>();
  readonly timings: Record<string, number> = {};

  own(dispose: () => Promise<void>): () => void {
    this.resources.add(dispose);
    return () => { this.resources.delete(dispose); };
  }

  async measure<T>(phase: string, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await work();
    } finally {
      this.timings[phase] = (this.timings[phase] ?? 0) + performance.now() - started;
    }
  }

  async close(): Promise<void> {
    const errors: Error[] = [];
    // Reverse acquisition order: stop HTTP producers before closing their DB.
    for (const dispose of [...this.resources].reverse()) {
      try {
        await dispose();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.resources.clear();
    if (errors.length) throw new AggregateError(errors, "Integration case cleanup failed");
  }
}

let active: IntegrationLifecycle | null = null;
let cleanupFailure: Error | null = null;

export function enterIntegrationCase(lifecycle: IntegrationLifecycle): () => void {
  if (cleanupFailure) throw new Error("Previous integration case could not stop; refusing to reuse its module environment", { cause: cleanupFailure });
  if (active) throw new Error("Concurrent integration cases cannot share the database module; use file parallelism");
  active = lifecycle;
  return () => { active = null; };
}

export function poisonIntegrationEnvironment(error: Error): void {
  cleanupFailure = error;
}

export function ownIntegrationResource(dispose: () => Promise<void>): () => void {
  return active?.own(dispose) ?? (() => { });
}

export async function measureIntegrationPhase<T>(phase: string, work: () => Promise<T>): Promise<T> {
  return active ? active.measure(phase, work) : work();
}
