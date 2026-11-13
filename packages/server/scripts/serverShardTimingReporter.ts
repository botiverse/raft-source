import type { Reporter, TestModule, TestSpecification } from "vitest/node";
import { recordFileTiming, SERVER_SHARD_TIMINGS_ENV, type FileTimingEvent } from "./serverShardTimings";

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
    });
    this.queued.delete(file);
  }

  onTestRunEnd(): void {
    this.record({ event: "run-end" });
  }
}
