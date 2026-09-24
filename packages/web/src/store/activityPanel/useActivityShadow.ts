/**
 * task #364 S1/S2 — the thin React bindings onto the Activity runtime.
 *
 * S1 introduced the primitive `useSyncExternalStore` subscription below. S2
 * keeps that observation contract and adds the gate-aware atomic receiver at
 * the bottom of this file. The module stays thin: it may import the lightweight
 * bootstrap entry, but never the heavy runtime/projection implementation.
 *
 * This hook has a REAL PRODUCTION CALLER (`ThreadsInbox`). That is not a
 * detail: this directory has twice shipped a layer whose header claimed it ran
 * while nothing in the production graph referenced it, so a hook that only
 * tests mount would be the same defect a third time.
 *
 * WHY THE SNAPSHOT IS A PRIMITIVE:
 *
 * `useSyncExternalStore` calls `getSnapshot` on every render and again after
 * every notification, and compares results with `Object.is`. A function that
 * builds a fresh object each time — even a structurally identical one — is
 * never equal to its own previous result, so React re-renders on every
 * notification and can tear or loop. The store's snapshot is therefore a
 * canonical decimal STRING (or null): `Object.is`-stable when nothing changed,
 * and never round-tripping a >2^53 watermark through a number.
 *
 * This is the trap I shipped in #693, where a selector returning `{read}` spun
 * forever; the warning comment in `MentionLink.tsx` is from that fix.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import {
  getActivityShadowVersion,
  getActivityShadowVersionServer,
  recordActivityShadowObservation,
  subscribeActivityShadow,
} from "../activityShadowBridge";
import { loadActivityRuntime } from "./bootstrap";
import { resolveActivityGateFromEnv } from "./gate";
import type { ActivityPanelProjectionInput } from "./projection";
import type { ActivityWindowBundle } from "./windowBundle";
import type { InboxGroupCount, InboxItem } from "../inboxStore";

/**
 * Observe the shadow's applied watermark for the scope the runtime is tracking,
 * or null when it holds nothing (which includes the gate being `off`).
 *
 * Observation only — a non-null value here does NOT mean the core may serve the
 * window. S2 separately requires gate `on`, module readiness, Core authority,
 * and every projection/overlay eligibility condition.
 *
 * The scope id is deliberately NOT a parameter: it is only knowable from the
 * response body, and a caller computing its own would be a second derivation
 * free to drift from the one the core actually wrote under.
 */
export function useActivityShadowVersion(): string | null {
  const version = useSyncExternalStore(
    subscribeActivityShadow,
    getActivityShadowVersion,
    getActivityShadowVersionServer,
  );
  // Parallel observation has to land somewhere real, or "the panel subscribes"
  // is an unobservable claim and the wiring can rot back to no caller at all.
  useEffect(() => {
    recordActivityShadowObservation(version);
  }, [version]);
  return version;
}

type ActivityRuntimeModule = Exclude<
  Awaited<ReturnType<typeof loadActivityRuntime>>,
  null
>;

/**
 * S2 — compose the one visible Activity window without crossing the chunk
 * boundary statically.
 *
 * The hook never stores a bundle. It stores only the lazily resolved runtime
 * module, then asks that module's sole receiver entry point to synchronously
 * decide from the CURRENT legacy snapshot on every render. A facet, overlay or
 * generation change therefore falls back in the same render; an async result
 * built from old inputs can never remain visible.
 *
 * `shadow` is checked explicitly here even though the host also downgrades its
 * authority. That duplicated *rollout fence* is intentional; eligibility and
 * projection remain single-owned by the P2 builder, while only gate `on` is
 * permitted to call the visible core branch at all.
 */
export function useActivityPanelWindowBundle(
  input: Omit<ActivityPanelProjectionInput, "verdict">,
): ActivityWindowBundle<InboxItem, InboxGroupCount> {
  const shadowVersion = useActivityShadowVersion();
  const gate = resolveActivityGateFromEnv();
  const [runtime, setRuntime] = useState<ActivityRuntimeModule | null>(null);

  useEffect(() => {
    let current = true;
    if (gate === "off") {
      return () => {
        current = false;
      };
    }

    // Promise resolution publishes module readiness through React state. This
    // is a required wake of its own: the Core and legacy snapshots may both be
    // unchanged while the lazy chunk finishes loading.
    void loadActivityRuntime().then((loaded) => {
      if (current && loaded) setRuntime(loaded);
    });
    return () => {
      current = false;
    };
  }, [gate, input.legacySnapshot.generation, shadowVersion]);

  return useMemo(() => {
    // Intentional read barrier: the runtime owns the Core snapshot, so its
    // primitive publication must invalidate this memo even though the value is
    // consumed across the lazy module boundary rather than as an argument.
    void shadowVersion;
    const legacyFallback = (): ActivityWindowBundle<InboxItem, InboxGroupCount> => ({
      source: "legacy",
      reason: "gate_closed",
      ...input.legacySnapshot.window,
    });

    // Explicit visible rollout fence: shadow may load/fold/notify, never serve.
    if (gate !== "on") return legacyFallback();
    // SSR/first paint/chunk failure remain wholly legacy until module readiness
    // itself schedules a new render. No throw and no partial source transition.
    if (!runtime) return legacyFallback();

    return runtime.activityPanelWindowForBoundScope(input);
  }, [gate, input, runtime, shadowVersion]);
}
