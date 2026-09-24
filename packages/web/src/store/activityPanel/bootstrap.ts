/**
 * Activity panel bootstrap entry — the ONLY activity-panel module the initial
 * bundle may import.
 *
 * It re-checks the gate with the leaf `gate.ts` and, only for shadow/on,
 * loads the real runtime (consumer + host + generated schema + sync-core)
 * through a dynamic import so Vite emits it as a separate lazy chunk. The
 * module promise is cached: the runtime loads at most once per session; a
 * failed chunk load is swallowed (a shadow must never break the panel) and
 * cleared so a later call may retry.
 *
 * Deleting this lazy boundary (importing `./runtime` statically here or in a
 * caller) is guarded by the production build budget check
 * (`scripts/check-activity-chunk-split.mjs`), which fails the build when
 * activity-runtime markers appear in the initial graph.
 */

import { resolveActivityGateFromEnv } from "./gate";
import { invalidateActivityShadowGeneration } from "../activityShadowBridge";

let runtimeModule: Promise<typeof import("./runtime")> | null = null;
let runtimeLoadRequests = 0;

/**
 * Resolve the one gate-owned runtime module promise.
 *
 * S2's thin React receiver uses the same loader as bootstrap so there is still
 * exactly one dynamic entry and one retry policy. `off` never requests the
 * heavy chunk. A failed request is forgotten so the next existing bootstrap
 * or receiver attempt may retry, while the current caller stays legacy.
 */
export async function loadActivityRuntime(): Promise<Awaited<typeof import("./runtime")> | null> {
  if (resolveActivityGateFromEnv() === "off") {
    // A runtime loaded earlier in the session must not leave its last snapshot
    // readable after the gate closes. Invalidation also rejects any old
    // in-flight publisher if the gate is enabled again later.
    invalidateActivityShadowGeneration();
    return null;
  }
  if (!runtimeModule) {
    runtimeLoadRequests += 1;
    runtimeModule = import("./runtime");
  }
  let runtime: Awaited<typeof import("./runtime")>;
  try {
    runtime = await runtimeModule;
  } catch {
    // Transient chunk-load failure: stay silent (shadow contract) but allow
    // a later inbox load to retry instead of pinning a rejected promise.
    runtimeModule = null;
    return null;
  }
  return runtime;
}

export async function observeActivityBootstrap(): Promise<void> {
  const runtime = await loadActivityRuntime();
  if (!runtime) return;
  await runtime.observeActivityBootstrap();
}

/** How many times a runtime chunk load was REQUESTED (1 per successful
 *  session; increments again after a cleared failure allows a retry). */
export function getActivityRuntimeLoadRequestsForTests(): number {
  return runtimeLoadRequests;
}

export function resetActivityBootstrapForTests(): void {
  runtimeModule = null;
  runtimeLoadRequests = 0;
}
