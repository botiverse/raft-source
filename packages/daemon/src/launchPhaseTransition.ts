/**
 * Launch phase-5/6 exported-row contract (task #149).
 *
 * Implements the phase-5 (runtime readiness) and phase-6 (activation delivery)
 * legs of Leiysky's #150 exported-row contract v0.1: emit
 * `launch_runtime_readiness_transition` and `launch_activation_delivery_transition`
 * enter/close rows so "which launch is stuck at runtime-ready / activation
 * delivery" is answerable from exported rows instead of the old blackbox
 * `starting`.
 *
 * Rules (mirrored from the phase-4 residency owner + #150 contract):
 * - Identity spine on every row: agent_launch_id, agent_id, server_id,
 *   machine_id, runtime, driver, launch_source.
 * - Pairing key = stable `state_instance_id`; every non-idle wait enter has
 *   exactly one later close for (agent_launch_id, state_instance_id).
 * - `transition_seq` is monotonic ordering/audit only, never a pairing key.
 * - Wait-state enter carries is_wait_state=true + closed `fence_kind` +
 *   absolute `deadline_unix_ms` (when fenced).
 * - Close carries a closed `close_result`.
 * - Negative evidence (missing launch id) is a closed
 *   `negative_evidence_bucket`; absence of rows is never evidence.
 * - Q8 scrub: no prompt/payload/stderr/secret/env/path/raw fields — the attr
 *   set here is closed by construction.
 *
 * Phase-6 activation delivery adds `delivered_via` (spawn_prompt | stdin) on the
 * advanced close; the pairing/Q8 assertion is shared across both span families
 * (assertLaunchReadinessPairing / assertLaunchActivationPairing). Phase-4
 * process residency lives in its own owner/exported-row leg (#3641).
 */

export const LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN = "launch_runtime_readiness_transition";

export type LaunchPhase = "runtime_readiness" | "activation_delivery";
export type LaunchTransitionKind = "enter" | "close";
export type LaunchReadinessState = "awaiting_runtime_ready";
export type LaunchCloseResult =
  | "advanced"
  | "terminal"
  | "suppressed"
  | "evicted"
  | "lineage_failed"
  | "timeout";
export type LaunchFenceKind = "runtime_startup_timeout" | "none";
export type LaunchNegativeEvidenceBucket = "missing_launch_id";

export interface LaunchIdentityAttrs {
  agent_launch_id: string | null;
  agent_id: string;
  server_id: string | null;
  machine_id: string | null;
  runtime: string;
  driver: string;
  launch_source: string;
}

export interface LaunchReadinessTransitionState {
  stateInstanceId: string;
  enterSeq: number;
  identity: LaunchIdentityAttrs;
  fenceKind: LaunchFenceKind;
  deadlineUnixMs: number | null;
  negativeEvidenceBucket: LaunchNegativeEvidenceBucket | null;
}

/** Missing launch id is the only negative-evidence bucket at readiness entry. */
export function launchReadinessNegativeEvidence(
  identity: LaunchIdentityAttrs,
): LaunchNegativeEvidenceBucket | null {
  return identity.agent_launch_id ? null : "missing_launch_id";
}

export function buildLaunchReadinessEnterAttrs(
  state: LaunchReadinessTransitionState,
): Record<string, unknown> {
  return {
    ...state.identity,
    phase: "runtime_readiness" satisfies LaunchPhase,
    span_name: LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN,
    transition_kind: "enter" satisfies LaunchTransitionKind,
    phase_result: "entered",
    state: "awaiting_runtime_ready" satisfies LaunchReadinessState,
    state_instance_id: state.stateInstanceId,
    transition_seq: state.enterSeq,
    is_wait_state: true,
    fence_kind: state.fenceKind,
    deadline_unix_ms: state.deadlineUnixMs ?? undefined,
    negative_evidence_bucket: state.negativeEvidenceBucket ?? undefined,
  };
}

export function buildLaunchReadinessCloseAttrs(
  state: LaunchReadinessTransitionState,
  closeResult: LaunchCloseResult,
  closeSeq: number,
): Record<string, unknown> {
  return {
    ...state.identity,
    phase: "runtime_readiness" satisfies LaunchPhase,
    span_name: LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN,
    transition_kind: "close" satisfies LaunchTransitionKind,
    state: "awaiting_runtime_ready" satisfies LaunchReadinessState,
    state_instance_id: state.stateInstanceId,
    transition_seq: closeSeq,
    close_result: closeResult,
    negative_evidence_bucket: state.negativeEvidenceBucket ?? undefined,
  };
}

// --- Phase 6: activation delivery ---------------------------------------

export const LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN = "launch_activation_delivery_transition";

export type LaunchActivationState = "awaiting_activation_delivery";
/** How the initial activation reached the runtime (closed set). */
export type LaunchDeliveredVia = "spawn_prompt" | "stdin";

export interface LaunchActivationTransitionState {
  stateInstanceId: string;
  enterSeq: number;
  identity: LaunchIdentityAttrs;
  negativeEvidenceBucket: LaunchNegativeEvidenceBucket | null;
}

export function buildLaunchActivationEnterAttrs(
  state: LaunchActivationTransitionState,
): Record<string, unknown> {
  return {
    ...state.identity,
    phase: "activation_delivery" satisfies LaunchPhase,
    span_name: LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN,
    transition_kind: "enter" satisfies LaunchTransitionKind,
    phase_result: "entered",
    state: "awaiting_activation_delivery" satisfies LaunchActivationState,
    state_instance_id: state.stateInstanceId,
    transition_seq: state.enterSeq,
    // Activation delivery has no independent fence yet — the launch's phase-5
    // readiness wait (fenced by the startup timeout) is the upstream deadline.
    // A stuck activation (session never ready-for-delivery) surfaces as an open
    // row, not a fenced one.
    is_wait_state: true,
    fence_kind: "none" satisfies LaunchFenceKind,
    negative_evidence_bucket: state.negativeEvidenceBucket ?? undefined,
  };
}

export function buildLaunchActivationCloseAttrs(
  state: LaunchActivationTransitionState,
  closeResult: LaunchCloseResult,
  closeSeq: number,
  deliveredVia?: LaunchDeliveredVia,
): Record<string, unknown> {
  return {
    ...state.identity,
    phase: "activation_delivery" satisfies LaunchPhase,
    span_name: LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN,
    transition_kind: "close" satisfies LaunchTransitionKind,
    state: "awaiting_activation_delivery" satisfies LaunchActivationState,
    state_instance_id: state.stateInstanceId,
    transition_seq: closeSeq,
    close_result: closeResult,
    delivered_via: deliveredVia ?? undefined,
    negative_evidence_bucket: state.negativeEvidenceBucket ?? undefined,
  };
}

/**
 * Attr keys/values that must never appear in exported rows (Leiysky Q8 scrub).
 * Used by the contract test to prove the closed attr set never leaks raw data.
 */
export const LAUNCH_FORBIDDEN_ATTR_SUBSTRINGS: readonly string[] = [
  "prompt",
  "payload",
  "stderr",
  "message_text",
  "text",
  "token",
  "secret",
  "credential",
  "api_key",
  "apikey",
  "cwd",
  "home",
  "path",
  "endpoint",
  "env",
];

export interface LaunchTransitionRow {
  name: string;
  attrs: Record<string, unknown>;
}

/**
 * Contract assertion for tests: every runtime-readiness enter has exactly one
 * later close for the same (agent_launch_id, state_instance_id), transition_seq
 * is strictly ordering (monotonic, never reused as pairing), and no forbidden
 * attr leaks. Throws on the first violation with a specific message.
 */
function assertLaunchTransitionPairing(context: string, rows: LaunchTransitionRow[], spanName: string): void {
  const readinessRows = rows.filter(
    (r) => r.name === spanName,
  );

  // Q8 scrub: closed attr set only.
  for (const row of readinessRows) {
    for (const key of Object.keys(row.attrs)) {
      const lower = key.toLowerCase();
      // launch_source / span_name are allow-listed closed fields even though
      // they contain a forbidden substring by coincidence.
      if (key === "launch_source" || key === "span_name") continue;
      if (LAUNCH_FORBIDDEN_ATTR_SUBSTRINGS.some((sub) => lower.includes(sub))) {
        throw new Error(
          `launch readiness pairing violation after ${context}: forbidden attr key "${key}"`,
        );
      }
    }
  }

  // transition_seq is ordering/audit only: it must be unique per row (never
  // reused as a pairing key). Uniqueness is order-independent, so callers may
  // pass rows in any order (e.g. exported unsorted).
  const seenSeqs = new Set<number>();
  for (const row of readinessRows) {
    const seq = Number(row.attrs.transition_seq);
    if (seenSeqs.has(seq)) {
      throw new Error(
        `launch readiness pairing violation after ${context}: transition_seq ${seq} reused (must be monotonic/unique ordering)`,
      );
    }
    seenSeqs.add(seq);
  }

  const opens = new Map<string, number>();
  const closes = new Map<string, number>();
  for (const row of readinessRows) {
    const key = `${String(row.attrs.agent_launch_id)}::${String(row.attrs.state_instance_id)}`;
    if (row.attrs.transition_kind === "enter") {
      opens.set(key, (opens.get(key) ?? 0) + 1);
    } else if (row.attrs.transition_kind === "close") {
      closes.set(key, (closes.get(key) ?? 0) + 1);
    }
  }
  for (const [key, enterCount] of opens) {
    if (enterCount !== 1) {
      throw new Error(
        `launch readiness pairing violation after ${context}: ${enterCount} enters for ${key}`,
      );
    }
    const closeCount = closes.get(key) ?? 0;
    if (closeCount !== 1) {
      throw new Error(
        `launch readiness pairing violation after ${context}: enter without exactly-one close for ${key} (closes=${closeCount})`,
      );
    }
  }
  for (const key of closes.keys()) {
    if (!opens.has(key)) {
      throw new Error(
        `launch readiness pairing violation after ${context}: close without enter for ${key}`,
      );
    }
  }
}

/** Phase-5 runtime-readiness enter/close pairing + Q8 contract. */
export function assertLaunchReadinessPairing(context: string, rows: LaunchTransitionRow[]): void {
  assertLaunchTransitionPairing(context, rows, LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN);
}

/** Phase-6 activation-delivery enter/close pairing + Q8 contract. */
export function assertLaunchActivationPairing(context: string, rows: LaunchTransitionRow[]): void {
  assertLaunchTransitionPairing(context, rows, LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN);
}
