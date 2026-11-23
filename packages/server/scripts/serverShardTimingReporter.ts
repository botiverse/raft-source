import type { Reporter, TestModule, TestSpecification } from "vitest/node";
import { recordFileTiming, SERVER_SHARD_TIMINGS_ENV, sumIntegrationPhases, type FileTimingEvent } from "./serverShardTimings";

/** Non-negative finite numbers of a meta record; unknown shapes give null. */
function numberRecord(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] =>
    typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0));
}

/** Phase timings and reuse-probe counts src/test/integration/dbTest.ts leaves on each case's meta; unknown shapes are skipped. */
function integrationPhases(module: TestModule): { integrationCases?: number; phasesMs?: Record<string, number>; reuse?: Record<string, number> } {
  const cases: Array<{ integrationCases: number; phasesMs: Record<string, number>; reuse?: Record<string, number> }> = [];
  for (const test of module.children.allTests()) {
    const meta = test.meta() as { integrationPhasesMs?: unknown; integrationReuse?: unknown };
    const phasesMs = numberRecord(meta.integrationPhasesMs);
    if (!phasesMs) continue;
    const reuse = numberRecord(meta.integrationReuse);
    cases.push({ integrationCases: 1, phasesMs, ...(reuse ? { reuse } : {}) });
  }
  return cases.length ? sumIntegrationPhases(cases) : {};
}

export default class ServerShardTimingReporter implements Reporter {
  private readonly journal = process.env[SERVER_SHARD_TIMINGS_ENV];
  private readonly queued = new Map<string, number>();
  private writeFailed = false;

  private record(event: FileTimingEvent): void {
    if (this.writeFailed) return;
    try { recordFileTiming(this.journal, event); }
    catch {
      this.writeFailed = true;
      console.error("[serverShardTimings] journal write failed; timing data is incomplete");
    }
  }

  onTestRunStart(specifications: readonly TestSpecification[]): void {
    this.record({ event: "run-start", files: specifications.length });
  }

  onTestModuleQueued(module: TestModule): void {
    const at = Date.now();
    this.queued.set(module.relativeModuleId, at);
    this.record({ event: "queued", file: module.relativeModuleId, at });
  }

  onTestModuleEnd(module: TestModule): void {
    const file = module.relativeModuleId;
    const started = this.queued.get(file);
    this.record({
      event: "finished", file, state: module.state(),
      durationMs: module.diagnostic().duration,
      // Includes environment/setup/import time; durationMs is tests and hooks only.
      wallMs: started === undefined ? 0 : Math.max(0, Date.now() - started),
      ...integrationPhases(module),
    });
    this.queued.delete(file);
  }

  onTestRunEnd(): void {
    this.record({ event: "run-end" });
  }
}
