import { emitWebTrace, emitWebTraceAndFlushBeforeUnload } from "./webAuthTrace";

let emit = emitWebTrace;
let emitBeforeUnload = emitWebTraceAndFlushBeforeUnload;

export function __setUpdateGateTraceEmittersForTest(input: {
  emit?: typeof emitWebTrace;
  emitBeforeUnload?: typeof emitWebTraceAndFlushBeforeUnload;
} | null): void {
  emit = input?.emit ?? emitWebTrace;
  emitBeforeUnload = input?.emitBeforeUnload ?? emitWebTraceAndFlushBeforeUnload;
}

export type UpdateGateAction =
  | "detected"
  | "prompt_shown"
  | "prompt_suppressed"
  | "continued"
  | "recovery_started"
  | "recovery_finished";

export type UpdateGateReason =
  | "dynamic_import_failure"
  | "dismissed_prompt"
  | "user_continue"
  | "user_recover"
  | "cleanup_completed"
  | "cleanup_partial_failure";

export type UpdateGateTriggerSource =
  | "vite_preload_error"
  | "error_boundary"
  | "later_action";

export interface UpdateGateDecision {
  action: UpdateGateAction;
  reason: UpdateGateReason;
  triggerSource: UpdateGateTriggerSource;
  cleanupFailureCount?: number;
  serviceWorkerCount?: number;
  assetCacheCount?: number;
}

const ACTION_REASONS = {
  detected: ["dynamic_import_failure"],
  prompt_shown: ["dynamic_import_failure"],
  prompt_suppressed: ["dismissed_prompt"],
  continued: ["user_continue"],
  recovery_started: ["user_recover"],
  recovery_finished: ["cleanup_completed", "cleanup_partial_failure"],
} as const satisfies Record<UpdateGateAction, readonly UpdateGateReason[]>;

const TRIGGER_SOURCES = ["vite_preload_error", "error_boundary", "later_action"] as const;

function boundedCount(value: number | undefined): number | undefined {
  if (value == null) return undefined;
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid update-gate count");
  return Math.min(Math.trunc(value), 10_000);
}

export function updateGateDecisionAttrs(input: UpdateGateDecision): Record<string, unknown> {
  const reasons = ACTION_REASONS[input.action] as readonly string[] | undefined;
  if (!reasons?.includes(input.reason)) throw new Error("Invalid update-gate action/reason pair");
  if (!(TRIGGER_SOURCES as readonly string[]).includes(input.triggerSource)) {
    throw new Error("Invalid update-gate trigger source");
  }
  const cleanupFailureCount = boundedCount(input.cleanupFailureCount);
  const serviceWorkerCount = boundedCount(input.serviceWorkerCount);
  const assetCacheCount = boundedCount(input.assetCacheCount);
  return {
    eventKind: "decision",
    outcome: "decided",
    action: input.action,
    reason: input.reason,
    triggerSource: input.triggerSource,
    ...(cleanupFailureCount == null ? {} : { cleanupFailureCount }),
    ...(serviceWorkerCount == null ? {} : { serviceWorkerCount }),
    ...(assetCacheCount == null ? {} : { assetCacheCount }),
  };
}

export function reportUpdateGateDecision(input: UpdateGateDecision): void {
  try {
    emit("slock.update_gate.decision", updateGateDecisionAttrs(input));
  } catch {
    // Trace validation/emission must never change the update-gate behavior.
  }
}

export async function reportUpdateGateDecisionBeforeUnload(input: UpdateGateDecision): Promise<void> {
  try {
    await emitBeforeUnload(
      "slock.update_gate.decision",
      updateGateDecisionAttrs(input),
      { timeoutMs: 500 },
    );
  } catch {
    // Trace validation/emission must never block recovery navigation.
  }
}
