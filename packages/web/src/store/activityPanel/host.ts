/**
 * Activity panel — the host that actually RUNS the sync-core consumer.
 *
 * This file exists because the consumer previously had no production caller at
 * all: its header claimed it "runs as a shadow consumer" while at runtime it
 * executed zero times, and only tests imported it. A comment is not a wiring.
 * (@赵梓淇 P1.)
 *
 * What the host owns:
 *
 * - one consumer instance for the app,
 * - issuing request ids so responses can be correlated (the core clears pending
 *   requests by scope alone, so correlation cannot live in the core),
 * - draining `pendingRequests()` into real fetches,
 * - the **gate**: with the gate off, every window is served wholesale from
 *   legacy and the core is a pure shadow that never touches rendered state; only
 *   with the gate on may a window be served from the core, and then only if the
 *   core claims authority for the WHOLE window.
 *
 * The gate is off by default and there is no UI to turn it on. S2's visible
 * receiver independently requires gate `on` plus a fully eligible atomic
 * window. Shadow mode still exercises ingest, gap stop-gating and repair
 * bookkeeping against real traffic without any user-visible effect.
 */

import { createActivityConsumer } from "./consumer";
import type { ActivityConsumer } from "./consumer";
import type { ActivityWindowAuthority } from "./windowAuthority";

// The gate type and resolver moved to the leaf `gate.ts` so the gate-off
// initial bundle can consult them without importing this module's dependency
// tree (task #393). Re-exported here so existing consumers/tests keep working.
import type { ActivityCutoverGate } from "./gate";

export {
  resolveActivityCutoverGate,
  type ActivityCutoverGate,
} from "./gate";

export interface ActivityHostDeps {
  /** Issues the actual HTTP request and returns the parsed JSON body. */
  fetchSnapshot(scopeId: string, requestId: string): Promise<unknown>;
  fetchDifference(
    scopeId: string,
    requestId: string,
    sinceSeq: bigint,
  ): Promise<unknown>;
  /** Monotonic request-id source; the host never invents correlation itself. */
  nextRequestId(): string;
}

export interface ActivityHost {
  /** Feed a socket-pushed frame / readStateUpdated. */
  onPush(raw: unknown): void;
  /**
   * Drain the core's declarative requests exactly once.
   *
   * Each drained request gets a fresh id recorded via `issueRequest`, so a
   * response that arrives after a newer drain is dropped as superseded rather
   * than allowed to clear the newer repair.
   */
  drain(): Promise<void>;
  /**
   * The authority verdict for a window, already gate-adjusted.
   *
   * With the gate off or in shadow, this is ALWAYS legacy regardless of what the
   * core holds — that is what makes shadow mode unable to affect rendering.
   */
  windowAuthority(scopeId: string): ActivityWindowAuthority;
  readonly gate: ActivityCutoverGate;
  readonly consumer: ActivityConsumer;
}

export function createActivityHost(
  deps: ActivityHostDeps,
  gate: ActivityCutoverGate = "off",
  consumer: ActivityConsumer = createActivityConsumer(),
): ActivityHost {
  return {
    gate,
    consumer,

    onPush(raw) {
      // Pushes are always ingested, even with the gate off: shadow mode is only
      // meaningful if the core sees the same traffic the panel does. What the
      // gate controls is whether the core may SERVE, never whether it observes.
      consumer.acceptPush(raw);
    },

    async drain() {
      for (const request of consumer.pendingRequests()) {
        const requestId = deps.nextRequestId();
        consumer.issueRequest(request.scopeId, requestId);
        if (request.kind === "snapshot") {
          consumer.acceptSnapshot(
            await deps.fetchSnapshot(request.scopeId, requestId),
          );
        } else {
          consumer.acceptDifference(
            await deps.fetchDifference(
              request.scopeId,
              requestId,
              (request as { sinceSeq: bigint }).sinceSeq,
            ),
          );
        }
      }
    },

    windowAuthority(scopeId) {
      // The gate is applied AFTER the core's own verdict, and can only ever
      // downgrade it. There is deliberately no path where a gate value promotes
      // a window the core did not claim authority for.
      if (gate !== "on") {
        return { authority: "legacy", reason: "gate_closed" };
      }
      return consumer.windowAuthority(scopeId);
    },
  };
}
