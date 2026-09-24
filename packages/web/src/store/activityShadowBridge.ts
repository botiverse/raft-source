/**
 * Lightweight external-store bridge for the Activity shadow.
 *
 * This module deliberately lives OUTSIDE `store/activityPanel/`: the panel
 * runtime (AJV + generated contract + Sync Core) is a gate-resolved dynamic
 * chunk, while `ThreadsInbox` must be able to mount a subscription without a
 * static import that pulls those heavy bytes into its own route chunk.
 *
 * The runtime publishes one primitive canonical watermark after it has
 * settled. The React hook subscribes to this bridge only; it never imports the
 * runtime. That direction is the chunk boundary as well as the data boundary.
 */
import { resolveActivityGateFromEnv } from "./activityPanel/gate";
import { registerServerReset } from "./serverResetRegistry";

const shadowListeners = new Set<() => void>();
const shadowGenerationInvalidationListeners = new Set<() => void>();
let shadowVersion: string | null = null;
let lastObservedShadowVersion: string | null = null;
let shadowGeneration = 0;

/**
 * Notify observers without letting either a synchronous throw or an async
 * rejection become a failure source for the ingestion path being observed.
 */
function notifyShadowListeners(): void {
  for (const listener of Array.from(shadowListeners)) {
    try {
      const result = (listener as () => void | PromiseLike<void>)();
      if (result && typeof result.then === "function") {
        void Promise.resolve(result).catch(() => {});
      }
    } catch {
      // Observation stays total: one bad observer cannot stop its neighbours.
    }
  }
}

/** Gate-off means zero listener residency, not merely an idle listener. */
export function subscribeActivityShadow(listener: () => void): () => void {
  if (resolveActivityGateFromEnv() === "off") return () => {};
  shadowListeners.add(listener);
  return () => {
    shadowListeners.delete(listener);
  };
}

/** Primitive, Object.is-stable snapshot for `useSyncExternalStore`. */
export function getActivityShadowVersion(): string | null {
  return shadowVersion;
}

/** The shadow never exists during server rendering/hydration. */
export function getActivityShadowVersionServer(): string | null {
  return null;
}

/** Capture the runtime generation that owns one asynchronous publication. */
export function captureActivityShadowGeneration(): number {
  return shadowGeneration;
}

export function isActivityShadowGenerationCurrent(generation: number): boolean {
  return generation === shadowGeneration;
}

/**
 * Register heavy state that must be dropped in the SAME turn as a lightweight
 * generation invalidation.
 *
 * The callback direction is runtime -> bridge registration: the bridge never
 * imports the heavy runtime, so startup/chunk ownership stays intact. Once the
 * runtime has been loaded, however, a principal or server transition can clear
 * its bound scope synchronously before a React subscriber awakened by the same
 * transition is allowed to render.
 */
export function registerActivityShadowGenerationInvalidation(
  listener: () => void,
): () => void {
  shadowGenerationInvalidationListeners.add(listener);
  return () => {
    shadowGenerationInvalidationListeners.delete(listener);
  };
}

/**
 * Runtime-only publication point, called after the Core has settled.
 *
 * A reset invalidates the token captured before an in-flight request. That old
 * request may still resolve, but it can no longer repopulate the bridge with a
 * snapshot from the previous server/gate generation.
 */
export function publishActivityShadowVersion(
  generation: number,
  version: string | null,
): boolean {
  if (!isActivityShadowGenerationCurrent(generation)) return false;
  shadowVersion = version;
  notifyShadowListeners();
  return true;
}

/** Clear the snapshot and make every previously captured publisher stale. */
export function invalidateActivityShadowGeneration(): void {
  shadowGeneration += 1;
  shadowVersion = null;
  lastObservedShadowVersion = null;
  for (const listener of Array.from(shadowGenerationInvalidationListeners)) {
    try {
      listener();
    } catch {
      // A lifecycle observer is not allowed to interrupt principal/server reset.
    }
  }
  notifyShadowListeners();
}

/** The mounted production consumer records what it actually observed. */
export function recordActivityShadowObservation(version: string | null): void {
  lastObservedShadowVersion = version;
}

export function getActivityShadowObservationForTests(): string | null {
  return lastObservedShadowVersion;
}

export function getActivityShadowListenerCountForTests(): number {
  return shadowListeners.size;
}

export function notifyActivityShadowForTests(): void {
  notifyShadowListeners();
}

export function resetActivityShadowBridgeForTests(): void {
  invalidateActivityShadowGeneration();
  shadowListeners.clear();
}

// Server identity is a generation boundary. Register from the lightweight
// bridge itself so invalidation exists even before the heavy runtime is loaded.
registerServerReset(invalidateActivityShadowGeneration);
