import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import type { AgentActivityDetailKind, AgentActivityKind } from "@botiverse/raft-shared";

import {
  buildLifecycleShadowVerdictAttrs,
  isLegacyExpressibleProjection,
  legacyActivityToCanonicalProjection,
  type LifecycleCanonicalProjection,
  type LifecycleObservationClass,
  type LifecycleShadowSnapshotInput,
  type LifecycleShadowSignalSite,
} from "./agentLifecycleReducer.js";

// Lifecycle-v2 PR-beta shadow-builder tests (task #460).
//
// Truth surface: buildLifecycleShadowVerdictAttrs output only (the attrs that
// become the `lifecycle_v2.shadow_verdict` span event). Oracle scope: each
// verdict measures PER-STEP divergence against the live snapshot; these attrs
// must never be read as trajectory equivalence (#459 DoD pin).

const busySnapshot: LifecycleShadowSnapshotInput = {
  activity: "working",
  detail: "Running command…",
  detailKind: "running_command",
  updatedAtMs: 1_000,
};

const startingSnapshot: LifecycleShadowSnapshotInput = {
  activity: "working",
  detail: "Starting…",
  detailKind: "runtime_starting",
  updatedAtMs: 1_000,
};

interface GoldenReplayRow {
  agent_id: string;
  bucket?: string;
  path_signature: string;
  residual_owner?: string;
}

interface GoldenPath {
  action: string;
  agree?: string;
  legacy?: LifecycleCanonicalProjection;
  observationClass: string;
  prior?: LifecycleCanonicalProjection;
  projection: LifecycleCanonicalProjection;
  reason: string;
  site: LifecycleShadowSignalSite;
}

function readTsvFixture(relativePath: string): GoldenReplayRow[] {
  const text = readFileSync(new URL(relativePath, import.meta.url), "utf8").trimEnd();
  const [headerLine, ...lines] = text.split("\n");
  assert.ok(headerLine, `${relativePath} must include a header`);
  const headers = headerLine.split("\t");
  return lines.map((line) => {
    const values = line.split("\t");
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])) as unknown as GoldenReplayRow;
  });
}

function parseGoldenPath(signature: string): GoldenPath {
  const [site, observationClass, action, reason, ...rest] = signature.split("|");
  assert.ok(site && observationClass && action && reason, `invalid golden path signature: ${signature}`);
  const attrs = Object.fromEntries(rest.flatMap((part) => {
    const separator = part.indexOf("=");
    return separator === -1 ? [] : [[part.slice(0, separator), part.slice(separator + 1)]];
  })) as Record<string, string>;
  const projection = attrs.projection ?? attrs.previous;
  assert.ok(projection, `golden path must include projection or previous: ${signature}`);
  return {
    action,
    observationClass,
    projection: projection as LifecycleCanonicalProjection,
    reason,
    site: site as LifecycleShadowSignalSite,
    ...(attrs.agree !== undefined ? { agree: attrs.agree } : {}),
    ...(attrs.legacy !== undefined ? { legacy: attrs.legacy as LifecycleCanonicalProjection } : {}),
    ...(attrs.prior !== undefined || attrs.previous !== undefined
      ? { prior: (attrs.prior ?? attrs.previous) as LifecycleCanonicalProjection }
      : {}),
  };
}

function snapshotFromPrior(prior: LifecycleCanonicalProjection | undefined): LifecycleShadowSnapshotInput | undefined {
  if (!prior || prior === "unknown") return undefined;
  const activity = prior === "idle" ? "online" : prior;
  return {
    activity: activity as AgentActivityKind,
    detail: prior === "working" ? "Running command..." : "",
    detailKind: prior === "working" || prior === "thinking" ? "running_command" : prior === "idle" ? "idle" : "none",
    updatedAtMs: 1_000,
  };
}

function signalActivity(path: GoldenPath): AgentActivityKind {
  if (path.legacy) return (path.legacy === "idle" ? "online" : path.legacy) as AgentActivityKind;
  if (path.site === "preserve_rebroadcast") return "working";
  return (path.projection === "idle" ? "online" : path.projection) as AgentActivityKind;
}

function signalDetailKind(activity: AgentActivityKind, path: GoldenPath): AgentActivityDetailKind {
  if (path.legacy === "idle") return "idle";
  if (activity === "working" || activity === "thinking") return "running_command";
  return "none";
}

function signalObservationClass(path: GoldenPath): LifecycleObservationClass {
  switch (path.observationClass) {
    case "activity_assertion":
    case "runtime_lifecycle_observation":
      return "observed";
    case "activity_replay":
      return "replayed";
    case "synthetic_diagnostic":
      return "synthetic";
    case "control_intent":
      return "control";
    case "diagnostic":
      return "diagnostic";
    default:
      throw new Error(`unmapped golden observation class: ${path.observationClass}`);
  }
}

function expectedAgree(value: string | undefined): boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`invalid golden agree value: ${value}`);
}

function countByBucket(rows: GoldenReplayRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const bucket = row.bucket ?? "";
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

test("task #178 golden replay pack re-drives trace signatures through the lifecycle shadow reducer", () => {
  const representative = readTsvFixture("./fixtures/task177-representative-cases-v0.tsv");
  const residualSpans = readTsvFixture("./fixtures/task177-residual-469-span-rows-v0.tsv");

  assert.equal(representative.length, 31, "representative pack must keep the agreed 31-case v0 sample");
  assert.deepEqual(
    countByBucket(representative),
    {
      hint_resolution_replay_no_authority: 3,
      lifecycle_plan_synthetic_no_authority: 3,
      preflip_1032_fake_working_preserve_rebroadcast: 6,
      residual_469_true_hung_runtime_probe_timeout: 13,
      resolve_race_authority_ordering: 3,
      same_tick_priority_arbitration: 3,
    },
  );
  assert.equal(residualSpans.length, 39, "residual span pack must preserve the full #469 span count");
  assert.equal(new Set(residualSpans.map((row) => row.agent_id)).size, 13, "residual span pack must cover all 13 #469 agents");

  for (const row of representative) {
    const path = parseGoldenPath(row.path_signature);
    const activity = signalActivity(path);
    const current = snapshotFromPrior(path.prior);
    const attrs = buildLifecycleShadowVerdictAttrs(current, {
      activity,
      agentId: row.agent_id,
      atMs: 1_000,
      detailKind: signalDetailKind(activity, path),
      observationClass: signalObservationClass(path),
      site: path.site,
      ...(path.site === "lifecycle_plan" ? { planKind: "machine_disconnected" as const } : {}),
    });

    assert.equal(attrs.shadow_signal_site, path.site, row.path_signature);
    assert.equal(attrs.shadow_observation_class, path.observationClass, row.path_signature);
    assert.equal(attrs.shadow_action, path.action, row.path_signature);
    assert.equal(attrs.shadow_reason, path.reason, row.path_signature);
    assert.equal(attrs.shadow_prior_projection, path.prior ?? "unknown", row.path_signature);
    assert.equal(attrs.shadow_projection, path.projection, row.path_signature);
    assert.equal(attrs.shadow_legacy_outcome, path.legacy ?? "working", row.path_signature);
    assert.equal(attrs.shadow_agree, expectedAgree(path.agree) ?? attrs.shadow_agree, row.path_signature);

    if (row.bucket !== "same_tick_priority_arbitration") {
      assert.equal(attrs.advances_observed_clock, "none", `${row.bucket} must not refresh observed freshness`);
    }
  }

  const residualRows = representative.filter((row) => row.bucket === "residual_469_true_hung_runtime_probe_timeout");
  assert.ok(residualRows.every((row) => row.residual_owner === "#469"));
  assert.equal(
    residualRows.reduce((sum, row) => {
      const rowCount = /(?:^|\|)row_count=(\d+)(?:\||$)/.exec(row.path_signature)?.[1];
      assert.ok(rowCount, `residual grouped row is missing row_count: ${row.path_signature}`);
      return sum + Number(rowCount);
    }, 0),
    residualSpans.length,
    "representative #469 grouped rows must account for every residual span",
  );
  assert.ok(
    representative
      .filter((row) => row.bucket !== "residual_469_true_hung_runtime_probe_timeout")
      .every((row) => row.residual_owner !== "#469"),
    "fixed fake-working replay inputs must stay separated from #469 residual stock",
  );
});

test("legacy mapping: conservative canonicalization and expressibility", () => {
  assert.equal(legacyActivityToCanonicalProjection("online", "idle"), "idle");
  assert.equal(legacyActivityToCanonicalProjection("online", "none"), "online");
  assert.equal(legacyActivityToCanonicalProjection("working", "runtime_starting"), "working");
  assert.equal(isLegacyExpressibleProjection("idle"), true);
  assert.equal(isLegacyExpressibleProjection("stopping"), false);
  assert.equal(isLegacyExpressibleProjection("unknown"), false);
});

test("shadow: fresh observed turn-end downgrade agrees with legacy outcome", () => {
  const attrs = buildLifecycleShadowVerdictAttrs(busySnapshot, {
    activity: "online",
    agentId: "agent-1",
    detailKind: "idle",
    atMs: 2_000,
    observationClass: "observed",
    site: "daemon_ingest",
  });
  assert.equal(attrs.shadow_agent_id, "agent-1", "gamma-3.1: per-verdict agent key (multi-agent spans make span-level attribution unsound)");
  assert.equal(attrs.shadow_action, "replace");
  assert.equal(attrs.shadow_projection, "idle");
  assert.equal(attrs.shadow_legacy_outcome, "idle");
  assert.equal(attrs.shadow_agree, true);
  assert.equal(attrs.shadow_direction, "downgrade");
  assert.equal(attrs.event_kind, "runtime_idle");
  assert.equal(attrs.source, "daemon_runtime");
  assert.equal(attrs.authority, "daemon_runtime");
  assert.equal(attrs.observation_class, "runtime_lifecycle_observation");
  assert.equal(attrs.shadow_observation_class, "runtime_lifecycle_observation");
  assert.equal(attrs.lifecycle_observed_at_ms, 2_000);
  assert.equal(attrs.advances_observed_clock, "lifecycle");

  // Direction-symmetry witness: the upgrade literal is pinned too, so a
  // single-literal mutation cannot survive (Yingjun's knife B).
  const wake = buildLifecycleShadowVerdictAttrs(
    { activity: "online", detail: "", detailKind: "idle", updatedAtMs: 1_000 },
    { activity: "working", agentId: "agent-1", detailKind: "running_command", atMs: 2_000, observationClass: "observed", site: "daemon_ingest" },
  );
  assert.equal(wake.shadow_action, "replace");
  assert.equal(wake.shadow_projection, "working");
  assert.equal(wake.shadow_direction, "upgrade");
  assert.equal(wake.event_kind, "activity_observed");
  assert.equal(wake.observation_class, "activity_assertion");
  assert.equal(wake.shadow_observation_class, "activity_assertion");
  assert.equal(wake.activity_observed_at_ms, 2_000);
  assert.equal(wake.advances_observed_clock, "activity");
});

test("shadow: replayed busy signal diverges from legacy re-apply (the I6 case)", () => {
  const attrs = buildLifecycleShadowVerdictAttrs(busySnapshot, {
    activity: "working",
    agentId: "agent-1",
    atMs: 2_000,
    observationClass: "replayed",
    site: "daemon_ingest",
  });
  assert.equal(attrs.shadow_action, "preserve");
  assert.equal(attrs.shadow_reason, "replayed_no_authority");
  // Legacy would re-apply working; shadow preserves. Same projection value
  // here, so agree stays true on the value axis — the action/reason axes are
  // what #459 buckets on for this family.
  assert.equal(attrs.shadow_projection, "working");
  assert.equal(attrs.shadow_direction, "lateral");
  assert.equal(attrs.event_kind, "activity_replayed");
  assert.equal(attrs.source, "replay_tooling");
  assert.equal(attrs.authority, "replay_tooling");
  assert.equal(attrs.observation_class, "activity_replay");
  assert.equal(attrs.shadow_observation_class, "activity_replay");
  assert.equal(attrs.advances_observed_clock, "none");
});

test("shadow: probe echo binds as liveness-only snapshot without advancing display clocks", () => {
  const attrs = buildLifecycleShadowVerdictAttrs(busySnapshot, {
    activity: "working",
    agentId: "agent-1",
    atMs: 2_000,
    observationClass: "observed",
    probeIdPresent: true,
    site: "daemon_ingest",
  });
  assert.equal(attrs.event_kind, "activity_snapshot");
  assert.equal(attrs.source, "activity_probe");
  assert.equal(attrs.authority, "activity_probe");
  assert.equal(attrs.observation_class, "liveness_observation");
  assert.equal(attrs.shadow_observation_class, "liveness_observation");
  assert.equal(attrs.advances_observed_clock, "none");
  assert.equal(attrs.activity_observed_at_ms, undefined);
  assert.equal(attrs.lifecycle_observed_at_ms, undefined);
});

test("shadow: starting affordance derives from detailKind, not projection", () => {
  const stale = buildLifecycleShadowVerdictAttrs(startingSnapshot, {
    activity: "online",
    agentId: "agent-1",
    detailKind: "idle",
    atMs: 2_000,
    currentLaunchGeneration: "launch-new",
    launchGeneration: "launch-old",
    observationClass: "observed",
    site: "daemon_ingest",
  });
  assert.equal(stale.shadow_starting_affordance, true);
  assert.equal(stale.shadow_action, "resolve_starting");
  assert.equal(stale.shadow_projection, "idle");

  const nonStarting = buildLifecycleShadowVerdictAttrs(busySnapshot, {
    activity: "online",
    agentId: "agent-1",
    detailKind: "idle",
    atMs: 2_000,
    currentLaunchGeneration: "launch-new",
    launchGeneration: "launch-old",
    observationClass: "observed",
    site: "daemon_ingest",
  });
  assert.equal(nonStarting.shadow_starting_affordance, false);
  assert.equal(nonStarting.shadow_action, "preserve");
  assert.equal(nonStarting.shadow_reason, "stale_generation");
  assert.equal(nonStarting.shadow_projection, "working");
  assert.equal(nonStarting.shadow_agree, false);
});

test("shadow: missing snapshot is unknown WITHOUT the Starting affordance (fail-closed)", () => {
  const attrs = buildLifecycleShadowVerdictAttrs(undefined, {
    activity: "online",
    agentId: "agent-1",
    atMs: 2_000,
    currentLaunchGeneration: "launch-new",
    launchGeneration: "launch-old",
    observationClass: "observed",
    site: "daemon_ingest",
  });
  assert.equal(attrs.shadow_prior_projection, "unknown");
  assert.equal(attrs.shadow_starting_affordance, false);
  assert.equal(attrs.shadow_action, "preserve");
  assert.equal(attrs.shadow_reason, "stale_generation");
});

test("shadow: synthetic refusal is a true per-step disagree (legacy applied, shadow refused)", () => {
  const attrs = buildLifecycleShadowVerdictAttrs(busySnapshot, {
    activity: "offline",
    agentId: "agent-1",
    atMs: 2_000,
    observationClass: "synthetic",
    site: "daemon_ingest",
  });
  assert.equal(attrs.shadow_action, "preserve");
  assert.equal(attrs.shadow_reason, "synthetic_no_authority");
  assert.equal(attrs.shadow_projection, "working");
  assert.equal(attrs.shadow_legacy_outcome, "offline");
  // This is the divergence #459's "old heuristic fired" bucket exists for.
  assert.equal(attrs.shadow_agree, false);
  assert.equal(attrs.event_kind, "synthetic_repair");
  assert.equal(attrs.source, "scheduler_repair");
  assert.equal(attrs.authority, "scheduler_repair");
  assert.equal(attrs.observation_class, "synthetic_diagnostic");
  assert.equal(attrs.shadow_observation_class, "synthetic_diagnostic");
});

test("shadow: inexpressible verdicts bucket as null instead of voting agree/disagree", () => {
  // Missing snapshot + synthetic signal: shadow preserves "unknown", which
  // legacy cannot express — agree must be null (bucketed), not false.
  const attrs = buildLifecycleShadowVerdictAttrs(undefined, {
    activity: "online",
    agentId: "agent-1",
    atMs: 2_000,
    observationClass: "synthetic",
    site: "daemon_ingest",
  });
  assert.equal(attrs.shadow_action, "preserve");
  assert.equal(attrs.shadow_projection, "unknown");
  assert.equal(attrs.shadow_expressible, false);
  assert.equal(attrs.shadow_agree, null);

  const diagnostic = buildLifecycleShadowVerdictAttrs(
    { ...busySnapshot, activity: "online", detailKind: "none" },
    { activity: "online", agentId: "agent-1", detailKind: "idle", atMs: 2_000, observationClass: "diagnostic", site: "daemon_ingest" },
  );
  assert.equal(diagnostic.shadow_action, "preserve");
  assert.equal(diagnostic.shadow_reason, "diagnostic_no_authority");
});

// --- observed/replayed classifier witnesses (Kai/Yingjun merge-gate pair) ----
//
// Fixture discipline (archer): replay fixtures derive clientSeq and
// producerFactId the production way — FRESH per emission, exactly like
// agentProcessManager's heartbeat timer. The classifier is structurally
// blind to both (they are not inputs), and the seq-keyed reference mutant
// below shows what a proxy-keyed classifier would do with the same stream.

import { classifyDaemonActivityObservation, type LifecycleObservationIdentity } from "./agentLifecycleReducer.js";

interface FixtureEmission extends LifecycleObservationIdentity {
  clientSeq: number;
  producerFactId: string;
}

let fixtureSeq = 100;
function emitLikeProduction(content: Omit<LifecycleObservationIdentity, "hasEntries">, hasEntries: boolean): FixtureEmission {
  const clientSeq = ++fixtureSeq;
  return {
    ...content,
    hasEntries,
    clientSeq,
    producerFactId: `daemon_activity:agent-1:launch-new:${clientSeq}`,
  };
}

const busyContent = { activity: "working" as const, detail: "Running command…", detailKind: "running_command" as const };

test("classifier witness pair: seq advances + content unchanged + no entries -> replayed", () => {
  const first = emitLikeProduction(busyContent, true);
  const heartbeat1 = emitLikeProduction(busyContent, false);
  const heartbeat2 = emitLikeProduction(busyContent, false);
  // Production-shaped fixtures: seq and factId DID advance on both replays.
  assert.notEqual(heartbeat1.clientSeq, first.clientSeq);
  assert.notEqual(heartbeat2.producerFactId, heartbeat1.producerFactId);

  assert.equal(classifyDaemonActivityObservation({ incoming: heartbeat1, lastAccepted: first }), "replayed");
  assert.equal(classifyDaemonActivityObservation({ incoming: heartbeat2, lastAccepted: first }), "replayed");
});

test("classifier witness pair: seq advances + content changed -> observed", () => {
  const first = emitLikeProduction(busyContent, true);
  const next = emitLikeProduction({ ...busyContent, detail: "Editing file…", detailKind: "running_command" }, false);
  assert.equal(classifyDaemonActivityObservation({ incoming: next, lastAccepted: first }), "observed");
});

test("classifier probe witness: probe echo (no entries, content unchanged, probeId) -> observed", () => {
  // respondToActivityProbe echoes the unchanged lastActivity with no entries
  // — on the content axis it is indistinguishable from a heartbeat replay.
  // The explicit probeId marker must rescue it BEFORE content guessing;
  // probes are the ground-truth liveness answers the stale sweep depends on.
  const first = emitLikeProduction(busyContent, true);
  const probeEcho = { ...emitLikeProduction(busyContent, false), probeId: "probe-7" };
  assert.equal(classifyDaemonActivityObservation({ incoming: probeEcho, lastAccepted: first }), "observed");

  // Same emission without the probeId marker stays replayed — the witness
  // pair that discriminates the probe rescue from a blanket loosening.
  const heartbeatTwin = emitLikeProduction(busyContent, false);
  assert.equal(classifyDaemonActivityObservation({ incoming: heartbeatTwin, lastAccepted: first }), "replayed");
});

test("classifier reverse-pit mitigation: identical content WITH fresh entries -> observed", () => {
  const first = emitLikeProduction(busyContent, true);
  const repeatWithEntries = emitLikeProduction(busyContent, true);
  assert.equal(classifyDaemonActivityObservation({ incoming: repeatWithEntries, lastAccepted: first }), "observed");
});

test("classifier canonical key: producer-declared bit wins in both directions", () => {
  const first = emitLikeProduction(busyContent, true);
  const declaredReplay = emitLikeProduction({ ...busyContent, detail: "Editing file…" }, true);
  assert.equal(
    classifyDaemonActivityObservation({ declaredHeartbeat: true, incoming: declaredReplay, lastAccepted: first }),
    "replayed",
  );
  const declaredFresh = emitLikeProduction(busyContent, false);
  assert.equal(
    classifyDaemonActivityObservation({ declaredHeartbeat: false, incoming: declaredFresh, lastAccepted: first }),
    "observed",
  );
});

test("classifier RED: a seq-advance-keyed classifier launders the heartbeat replay", () => {
  const seqKeyedClassifier = (last: FixtureEmission | undefined, incoming: FixtureEmission) =>
    !last || incoming.clientSeq > last.clientSeq ? "observed" : "replayed";
  const factIdKeyedClassifier = (last: FixtureEmission | undefined, incoming: FixtureEmission) =>
    !last || incoming.producerFactId !== last.producerFactId ? "observed" : "replayed";

  const first = emitLikeProduction(busyContent, true);
  const heartbeat = emitLikeProduction(busyContent, false);

  assert.throws(() => {
    assert.equal(seqKeyedClassifier(first, heartbeat), "replayed", "seq-advance key laundered a stale heartbeat replay");
  }, /seq-advance/);
  assert.throws(() => {
    assert.equal(factIdKeyedClassifier(first, heartbeat), "replayed", "factId key laundered a stale heartbeat replay (seq-derived)");
  }, /factId key/);
});

// --- gamma-2.1 control-command authority (Kai calibration v3 §B split) ------

import { foldLifecycleArbitration } from "./agentLifecycleReducer.js";

test("control class: authorized command replaces on its own axis in both directions (gamma-2.1)", () => {
  // Upgrade direction: online -> working via control command.
  const up = buildLifecycleShadowVerdictAttrs(
    { activity: "online", detail: "", detailKind: "none", updatedAtMs: 1_000 },
    { activity: "working", agentId: "agent-1", detailKind: "slock_action", atMs: 2_000, observationClass: "control", site: "slock_action_status" },
  );
  assert.equal(up.shadow_action, "replace");
  assert.equal(up.shadow_reason, "control_command_authority");
  assert.equal(up.shadow_projection, "working");
  assert.equal(up.shadow_direction, "upgrade");
  assert.equal(up.event_kind, "start_requested");
  assert.equal(up.source, "server_control");
  assert.equal(up.authority, "server_control");
  assert.equal(up.observation_class, "control_intent");
  assert.equal(up.shadow_observation_class, "control_intent");

  // Downgrade direction (direction-symmetry witness): a control command may
  // also legally lower the projection — authority is not a ratchet.
  const down = buildLifecycleShadowVerdictAttrs(busySnapshot, {
    activity: "online",
    agentId: "agent-1",
    detailKind: "none",
    atMs: 2_000,
    observationClass: "control",
    site: "slock_action_status",
  });
  assert.equal(down.shadow_action, "replace");
  assert.equal(down.shadow_reason, "control_command_authority");
  assert.equal(down.shadow_direction, "downgrade");

  // Contrast pin: the same signal as plain synthetic stays suppressed —
  // the class split is what separates command authority from intent.
  const intent = buildLifecycleShadowVerdictAttrs(busySnapshot, {
    activity: "online",
    agentId: "agent-1",
    detailKind: "none",
    atMs: 2_000,
    observationClass: "synthetic",
    site: "slock_action_status",
  });
  assert.equal(intent.shadow_action, "preserve");
  assert.equal(intent.shadow_reason, "synthetic_no_authority");
});

test("control class: fold admits the value but never synthesizes liveness (I6 pin, gamma-2.1)", () => {
  const state = {
    currentLaunchGeneration: null,
    lastObservedAtMs: 1_000,
    projection: "online" as const,
    startingAffordance: false,
  };
  const { state: next, verdict } = foldLifecycleArbitration(state, {
    atMs: 5_000,
    launchGeneration: null,
    observationClass: "control",
    projection: "working",
  });
  assert.equal(verdict.action, "replace");
  assert.equal(next.projection, "working", "control command's value IS admitted");
  assert.equal(next.lastObservedAtMs, 1_000, "observed-freshness must NOT advance from a server-side command (I6)");

  // Observed contrast: the same admission from an observation advances it.
  const observed = foldLifecycleArbitration(state, {
    atMs: 5_000,
    launchGeneration: null,
    observationClass: "observed",
    projection: "working",
  });
  assert.equal(observed.state.lastObservedAtMs, 5_000, "observed admission advances freshness");

  // Affordance still clears on an admitted control value (real projection).
  const starting = foldLifecycleArbitration(
    { ...state, projection: "working" as const, startingAffordance: true },
    { atMs: 5_000, launchGeneration: null, observationClass: "control", projection: "working" },
  );
  assert.equal(starting.state.startingAffordance, false, "admitted real projection clears the Starting affordance");

  // Fail-safe: control with unknown projection degrades like the rest.
  const unknown = buildLifecycleShadowVerdictAttrs(undefined, {
    activity: "online",
    agentId: "agent-1",
    atMs: 2_000,
    observationClass: "control",
    site: "slock_action_status",
  });
  assert.equal(unknown.shadow_action, "replace", "known projection from missing snapshot still replaces");
});

// --- gamma-3 plan-path decision (skip-set + total class map) ----------------

import { lifecyclePlanShadowDecision, LIFECYCLE_PLAN_SHADOW_CLASS } from "./agentLifecycleReducer.js";
import { createAgentLifecycleEvent } from "./agentLifecycleEvents.js";

test("gamma-3 decision: handler-emitted families skip, everything else emits with the total map", () => {
  const base = {
    serverId: "server-1",
    agentId: "agent-1",
    actor: "server" as const,
    source: "server" as const,
    reason: "machine_disconnect" as const,
    correlationId: "c",
    occurredAt: new Date(1_000),
  };
  // Skip 1: daemon activity ingest (classifier context lives at the handler).
  const ingest = lifecyclePlanShadowDecision(createAgentLifecycleEvent({
    ...base, eventType: "activity_changed", source: "daemon", reason: "runtime_working",
  }));
  assert.deepEqual(ingest, { kind: "skip", reason: "handler_emits" }, "daemon activity_changed is handler-emitted");
  const runtimeErrorCarrier = lifecyclePlanShadowDecision(createAgentLifecycleEvent({
    ...base,
    eventType: "runtime_crashed",
    source: "daemon",
    reason: "runtime_crash",
    attrs: { source_protocol: "daemon_runtime_error_carrier_v1" },
  }));
  assert.deepEqual(
    runtimeErrorCarrier,
    { kind: "skip", reason: "handler_emits" },
    "typed runtime-error activity carrier is still handler-emitted",
  );
  // Skip 2: synthetic repairs (site=synthetic_repair emitted at apply sites).
  const repair = lifecyclePlanShadowDecision(createAgentLifecycleEvent({
    ...base, eventType: "activity_changed", source: "scheduler", reason: "runtime_idle",
    attrs: { synthetic_repair: true, repair_kind: "stale_sweep" },
  }));
  assert.deepEqual(repair, { kind: "skip", reason: "handler_emits" }, "synthetic repairs are handler-emitted");
  // Emit: non-daemon activity_changed (wake/message legs) is NOT skipped —
  // the skip-set is (eventType AND source), not eventType alone.
  const wakeLeg = lifecyclePlanShadowDecision(createAgentLifecycleEvent({
    ...base, eventType: "activity_changed", source: "server", reason: "runtime_working",
  }));
  assert.deepEqual(wakeLeg, { kind: "emit", observationClass: "synthetic", planKind: "activity_changed" });
  // Emit: the g2 break-1 family.
  const disconnect = lifecyclePlanShadowDecision(createAgentLifecycleEvent({
    ...base, eventType: "machine_disconnected",
  }));
  assert.deepEqual(disconnect, { kind: "emit", observationClass: "synthetic", planKind: "machine_disconnected" });
  // Emit: authorized commands map to control.
  assert.equal(LIFECYCLE_PLAN_SHADOW_CLASS.manual_stop_requested, "control");
  assert.equal(LIFECYCLE_PLAN_SHADOW_CLASS.runtime_profile_control_changed, "control");
  assert.equal(LIFECYCLE_PLAN_SHADOW_CLASS.migration_started, "control");
  assert.equal(LIFECYCLE_PLAN_SHADOW_CLASS.migration_completed, "control");
  assert.equal(LIFECYCLE_PLAN_SHADOW_CLASS.migration_aborted, "control");
  // Daemon-reported facts map to observed.
  assert.equal(LIFECYCLE_PLAN_SHADOW_CLASS.runtime_crashed, "observed");
  assert.equal(LIFECYCLE_PLAN_SHADOW_CLASS.daemon_shutdown, "observed");
});
