import { clearClockInterval, noopTracer, setClockInterval, type Tracer } from "@botiverse/raft-shared";
import { recordTraceEvent, withTraceRoot } from "../tracing/semanticTrace";
import { listDueAppLinkPreviewRechecks, recheckAppLinkPreview } from "./appLinkPreviewService";

/**
 * Rechecks App link preview domain proofs that no view has rechecked:
 * idle registrations past SOFT_TTL, so they are suspended once their origin
 * stops proving, and suspended ones, so they resume once it proves again. A
 * bounded batch per tick, one proof fetch (at most 3 s) at a time; the row
 * claim keeps every registration to one fetch per RETRY across instances.
 *
 * Idle ticks leave no trace; a tick with work emits
 * `server.app_link_preview.recheck_sweep` with counts only (never origins).
 */
export interface AppLinkPreviewRecheckWorkerOptions {
  tracer?: Tracer;
  intervalMs?: number;
  batchSize?: number;
}

export interface AppLinkPreviewRecheckWorkerHandle {
  tick(): Promise<void>;
  stop(): void;
}

export function startAppLinkPreviewRecheckWorker(opts: AppLinkPreviewRecheckWorkerOptions = {}): AppLinkPreviewRecheckWorkerHandle {
  const tracer = opts.tracer ?? noopTracer;
  const batchSize = opts.batchSize ?? 20;
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const due = await listDueAppLinkPreviewRechecks(batchSize);
      if (!due.length) return;
      await withTraceRoot(tracer, "server.app_link_preview.recheck_sweep_tick", { surface: "server", kind: "internal" }, async () => {
        const summary = { due: due.length, claimed: 0, match: 0, mismatch: 0, unavailable: 0, suspension_changed: 0, failed: 0 };
        for (const clientId of due) {
          if (stopped) break;
          try {
            const result = await recheckAppLinkPreview(clientId);
            if (!result) continue; // another instance holds this check
            summary.claimed += 1;
            summary[result.proof] += 1;
            if (result.suspensionChanged) summary.suspension_changed += 1;
          } catch {
            summary.failed += 1;
          }
        }
        recordTraceEvent("server.app_link_preview.recheck_sweep", summary, tracer);
      });
    } catch (error) {
      console.error("[AppLinkPreviewRecheck] sweep failed", error instanceof Error ? error.name : "unknown");
    } finally {
      running = false;
    }
  };

  const handle = setClockInterval(() => void tick(), opts.intervalMs ?? 15 * 60_000);
  if (typeof handle === "object" && handle && "unref" in handle && typeof handle.unref === "function") handle.unref();
  return { tick, stop() { stopped = true; clearClockInterval(handle); } };
}
