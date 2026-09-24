/**
 * Activity panel — the PRODUCTION singleton that runs the shadow consumer.
 *
 * This module is what makes the consumer/host actually execute. Two previous
 * rounds shipped a consumer, then a host, each with a comment claiming it "runs
 * as a shadow consumer" while nothing in the production import graph referenced
 * it — the defect moved up a level instead of closing. (@赵梓淇 P1, twice.)
 *
 * Wiring rules:
 *
 * - The gate is resolved fail-closed from the environment and defaults to `off`.
 *   `off` means this module does nothing at all: no fetches, no core, no cost.
 * - `shadow` observes real traffic (bootstrap + socket pushes + repair drains)
 *   but can never serve a window; `windowAuthority` returns legacy for any gate
 *   other than `on`.
 * - Every fetch goes through the real endpoints with a real `requestId`, and
 *   every response is correlated before it can touch the core.
 * - Failures are swallowed. A shadow that can break the panel is worse than no
 *   shadow, so this must never throw into a caller's control flow.
 */

import api from "../../api/client";
import {
  captureActivityShadowGeneration,
  getActivityShadowListenerCountForTests,
  getActivityShadowObservationForTests,
  getActivityShadowVersion,
  getActivityShadowVersionServer,
  invalidateActivityShadowGeneration,
  isActivityShadowGenerationCurrent,
  notifyActivityShadowForTests,
  publishActivityShadowVersion,
  recordActivityShadowObservation,
  registerActivityShadowGenerationInvalidation,
  resetActivityShadowBridgeForTests,
  subscribeActivityShadow,
} from "../activityShadowBridge";
import {
  setActivityGateOverrideForTests,
  resolveActivityGateFromEnv,
} from "./gate";
import type {
  ActivityCutoverGate,
} from "./gate";
import { createActivityHost } from "./host";
import type { ActivityHost } from "./host";
import {
  buildActivityPanelWindowBundle,
} from "./projection";
import type {
  ActivityPanelProjectionInput,
} from "./projection";
import type { ActivityWindowAuthority } from "./windowAuthority";

/** `all` is the only window this shadow observes; the routes pin windowId=main. */
const SHADOW_FILTER = "all";
const SHADOW_WINDOW_ID = "main";

let host: ActivityHost | null = null;
let requestCounter = 0;

/**
 * Test-only gate override — the override itself lives in the leaf `gate.ts`
 * so the bootstrap entry and this runtime consult the SAME value; this
 * wrapper additionally drops the host singleton so the next call rebuilds it
 * under the new gate. Never set from production code.
 */
export function setActivityGateForTests(value: ActivityCutoverGate | null): void {
  invalidateActivityRuntimeState();
  invalidateActivityShadowGeneration();
  setActivityGateOverrideForTests(value);
}

function gate(): ActivityCutoverGate {
  return resolveActivityGateFromEnv();
}

function nextRequestId(): string {
  requestCounter += 1;
  return `web-activity-${requestCounter}`;
}

function ensureHost(): ActivityHost | null {
  if (gate() === "off") return null;
  if (!host) {
    host = createActivityHost({
      nextRequestId,
      async fetchSnapshot(_scopeId, requestId) {
        const { data } = await api.get("/channels/activity/snapshot", {
          params: { requestId, filter: SHADOW_FILTER, windowId: SHADOW_WINDOW_ID },
        });
        return data;
      },
      async fetchDifference(_scopeId, requestId, sinceSeq) {
        const { data } = await api.get("/channels/activity/difference", {
          params: {
            requestId,
            windowId: SHADOW_WINDOW_ID,
            // The route requires the epoch the client currently holds plus the
            // watermark to resume after; both are canonical decimal strings.
            epoch: host?.consumer.core.scopeSyncState("activity", _scopeId)?.epoch ?? "0",
            afterWatermark: sinceSeq.toString(),
          },
        });
        return data;
      },
    }, gate());
  }
  return host;
}

/**
 * The newest bootstrap request this runtime has ISSUED.
 *
 * The scope id is only knowable from the response body, so correlation cannot be
 * registered per-scope before the request goes out. Registering it on RECEIPT is
 * not a fence at all: two concurrent bootstraps whose responses arrive out of
 * order would each register themselves as newest and the older one would
 * overwrite the whole window. So issuance order is tracked here, before the
 * request leaves, and a response that is no longer the newest issued is dropped
 * without touching the core. (@赵梓淇 P1.)
 */
let latestIssuedBootstrapId: string | null = null;

/**
 * The scope the shadow is currently tracking.
 *
 * Derived HERE and nowhere else. The scope id is only knowable from the
 * response body, so a component cannot compute it without duplicating this
 * construction — and a second derivation that drifts from this one would read a
 * scope the core never wrote, which looks exactly like "no data yet".
 */
let activeShadowScopeId: string | null = null;

/**
 * Read the active scope's applied watermark as a canonical decimal STRING, or
 * null when the shadow holds nothing. This stays private: the public snapshot
 * lives in the lightweight bridge so the UI never imports this runtime.
 *
 * A string, not the bigint and not a wrapper object, for two independent
 * reasons: it is `Object.is`-stable across calls when nothing changed, and the
 * watermark can exceed 2^53 so it must never round-trip through a number.
 */
function currentActivityShadowVersion(): string | null {
  if (!activeShadowScopeId) return null;
  const applied = host?.consumer.core
    .scopeSyncState("activity", activeShadowScopeId)?.appliedSeq;
  return applied == null ? null : applied.toString();
}

// Compatibility exports for existing diagnostics/tests. The React hook imports
// the bridge directly; this runtime no longer owns the subscription edge.
export {
  getActivityShadowListenerCountForTests,
  getActivityShadowObservationForTests,
  getActivityShadowVersion,
  getActivityShadowVersionServer,
  notifyActivityShadowForTests,
  recordActivityShadowObservation,
  subscribeActivityShadow,
};

export async function observeActivityBootstrap(): Promise<void> {
  const active = ensureHost();
  if (!active) return;
  const shadowGeneration = captureActivityShadowGeneration();
  // Claim issuance order BEFORE the request is made, not after it returns.
  const requestId = nextRequestId();
  latestIssuedBootstrapId = requestId;
  try {
    const { data } = await api.get("/channels/activity/snapshot", {
      params: { requestId, filter: SHADOW_FILTER, windowId: SHADOW_WINDOW_ID },
    });
    // A response that a later bootstrap has already superseded must not be
    // registered or applied, however plausible its body looks.
    if (latestIssuedBootstrapId !== requestId) return;
    // A server/gate reset may have happened while the request was in flight.
    // Do not let that old generation touch either the Core or the bound scope.
    if (!isActivityShadowGenerationCurrent(shadowGeneration)) return;
    const scope = (data as { scope?: Record<string, string> }).scope;
    if (!scope) return;
    const scopeId = JSON.stringify([
      scope.serverId, scope.principalId, scope.filter, scope.windowId,
    ]);
    active.consumer.issueRequest(scopeId, requestId);
    // Do NOT set the active scope from the RAW body. The scope id above is
    // derived from a response that has not passed correlation yet, and an
    // uncorrelated or superseded response is one the consumer will refuse to
    // fold. Assigning here would let exactly that response move the
    // external-store selector to a scope the core never wrote — the core stays
    // correct while `getActivityShadowVersion()` flips to null, which reads to
    // a subscriber as "the data went away". Same correlation boundary, both
    // sides of it. (@赵梓淇 P1.)
    const report = active.consumer.acceptSnapshot(data);
    if (report.kind !== "snapshot") return;
    activeShadowScopeId = (report.outcome as { scopeId?: string }).scopeId ?? activeShadowScopeId;
    await active.drain();
    // Only after the core has actually settled — notifying earlier would hand
    // subscribers a watermark the core has not applied yet.
    publishActivityShadowVersion(shadowGeneration, currentActivityShadowVersion());
  } catch {
    // Shadow-only: never surface into the panel's control flow.
  }
}

/**
 * The window verdict for the scope the runtime has actually bound.
 *
 * Exposed so the panel never constructs a scope id of its own: the id is only
 * knowable from an accepted response, and a component deriving its own would be
 * a second derivation free to drift from the one the core wrote under. With no
 * bound scope this is `scope_absent`, which is the correct fail-closed answer
 * rather than a guess.
 */
export function activityWindowForBoundScope(): ActivityWindowAuthority {
  if (!activeShadowScopeId) return { authority: "legacy", reason: "scope_absent" };
  return activityWindowAuthority(activeShadowScopeId);
}

/**
 * S2's sole heavy receiver entry point.
 *
 * The thin UI hook supplies only the accepted legacy snapshot and visible
 * facet identity. Scope binding, the Core's candidate authority, eligibility,
 * projection and whole-window fallback all remain inside the runtime closure;
 * the UI cannot reconstruct any of them independently.
 */
export function activityPanelWindowForBoundScope(
  input: Omit<ActivityPanelProjectionInput, "verdict">,
) {
  // The thin receiver owns the explicit `gate === on` rollout fence. Use the
  // Core's candidate directly here so deleting that receiver fence is
  // observable under shadow (and therefore testable), rather than accidentally
  // relying on the host's diagnostic gate downgrade as a second hidden fence.
  const active = ensureHost();
  const verdict = !active
    ? { authority: "legacy" as const, reason: "gate_closed" as const }
    : !activeShadowScopeId
      ? { authority: "legacy" as const, reason: "scope_absent" as const }
      : active.consumer.windowAuthority(activeShadowScopeId);
  return buildActivityPanelWindowBundle({
    ...input,
    verdict,
  });
}

/**
 * The window verdict for the panel.
 *
 * Returns legacy whenever the gate is not `on`. This remains the public
 * diagnostic verdict used by older host tests; S2's visible receiver has its
 * own explicit rollout fence and consumes `activityPanelWindowForBoundScope`
 * so that deleting that fence is independently observable.
 */
export function activityWindowAuthority(scopeId: string): ActivityWindowAuthority {
  const active = ensureHost();
  if (!active) return { authority: "legacy", reason: "gate_closed" };
  return active.windowAuthority(scopeId);
}

/**
 * The shadow's applied watermark for a scope, for teeth that need to tell two
 * responses apart. Exposed because the discriminating value between a stale and
 * a fresh snapshot is the watermark, and nothing else observable differs.
 */
export function getActivityShadowAppliedSeqForTests(scopeId: string): bigint | undefined {
  return host?.consumer.core.scopeSyncState("activity", scopeId)?.appliedSeq ?? undefined;
}

function invalidateActivityRuntimeState(): void {
  host = null;
  latestIssuedBootstrapId = null;
  activeShadowScopeId = null;
}

// The Core/host is scoped by the same server/principal generation as the thin
// bridge. Registration points from the already-loaded runtime into the bridge;
// the bridge never statically imports this module. Thus principal/server
// transitions synchronously clear the bound scope before notifying React,
// while the heavy chunk remains absent from the startup closure.
registerActivityShadowGenerationInvalidation(invalidateActivityRuntimeState);

/** Test/diagnostic reset; the singleton otherwise lives for the session. */
export function resetActivityRuntimeForTests(): void {
  invalidateActivityRuntimeState();
  requestCounter = 0;
  setActivityGateOverrideForTests(null);
  resetActivityShadowBridgeForTests();
}
