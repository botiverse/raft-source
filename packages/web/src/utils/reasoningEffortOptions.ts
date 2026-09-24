import {
  BASE_REASONING_EFFORTS,
  REASONING_EFFORTS,
  RUNTIME_MODELS,
} from "@botiverse/raft-shared";
import type {
  ReasoningEffort,
  RuntimeModelInfo,
} from "@botiverse/raft-shared";
import type { MessageId } from "../i18n/messages";

/**
 * Web-side reasoning-effort menu helpers for the agent model form.
 *
 * Data-driven, NOT hardcoded: the option set for a given model is gated by that
 * model's declared `supportedReasoningEfforts` (see `RUNTIME_MODELS.codex` —
 * the GPT-5.6 variants sol/terra expose all six efforts including `ultra`,
 * luna omits `ultra`). Labels come from the shared `REASONING_EFFORTS` catalog
 * (`xhigh` renders as "Extra High"). Models that don't declare a supported set
 * (e.g. Claude) fall back to the BASE set (low/medium/high/xhigh) — `max`/`ultra`
 * are opt-in only and must never leak to a non-declaring model (task #496).
 *
 * The per-effort descriptions are UI copy only (the shared catalog carries
 * id + label); they live here so the picker can show a one-line hint per level.
 */
/** Map an effort value to its catalog id (null when unknown — keep raw). */
export function reasoningEffortLabelId(effort: string): MessageId | null {
  return effort in REASONING_EFFORT_LABEL_ID ? REASONING_EFFORT_LABEL_ID[effort as ReasoningEffort] : null;
}

export const REASONING_EFFORT_LABEL_ID: Record<ReasoningEffort, MessageId> = {
  low: "agent.reasoningEffort.low",
  medium: "agent.reasoningEffort.medium",
  high: "agent.reasoningEffort.high",
  xhigh: "agent.reasoningEffort.xhigh",
  max: "agent.reasoningEffort.max",
  ultra: "agent.reasoningEffort.ultra",
};

export const REASONING_EFFORT_DESCRIPTION_ID: Partial<Record<ReasoningEffort, MessageId>> = {
  low: "agent.reasoningEffort.lowDescription",
  medium: "agent.reasoningEffort.mediumDescription",
  high: "agent.reasoningEffort.highDescription",
  xhigh: "agent.reasoningEffort.xhighDescription",
  max: "agent.reasoningEffort.maxDescription",
  ultra: "agent.reasoningEffort.ultraDescription",
};

export interface ReasoningEffortOption {
  value: ReasoningEffort;
  labelId: MessageId;
  descriptionId?: MessageId;
}

/**
 * Resolve a model's declared reasoning metadata, preferring a live
 * host-reported entry (which may carry richer per-machine data) and falling
 * back to the static shared `RUNTIME_MODELS` catalog. Returns undefined when
 * the model is unknown to both.
 */
function resolveModelInfo(
  runtime: string,
  modelId: string,
  liveModels?: readonly RuntimeModelInfo[],
): RuntimeModelInfo | undefined {
  const live = liveModels?.find((m) => m.id === modelId);
  if (live?.supportedReasoningEfforts?.length) return live;
  const stat = RUNTIME_MODELS[runtime]?.find((m) => m.id === modelId);
  return stat ?? live;
}

/**
 * Ordered reasoning options for a model. When the model declares
 * `supportedReasoningEfforts`, the catalog is filtered to that set (order and
 * labels preserved); otherwise the full catalog is returned.
 */
export function reasoningEffortOptionsForModel(
  runtime: string,
  modelId: string,
  liveModels?: readonly RuntimeModelInfo[],
): ReasoningEffortOption[] {
  const supported = resolveModelInfo(runtime, modelId, liveModels)?.supportedReasoningEfforts;
  // Never fall back to the full catalog: models without a declared set get the
  // BASE efforts only, so max/ultra can't leak to e.g. Claude (task #496).
  const allowed = supported && supported.length > 0
    ? REASONING_EFFORTS.filter((effort) => supported.includes(effort.id))
    : REASONING_EFFORTS.filter((effort) => BASE_REASONING_EFFORTS.includes(effort.id));
  return allowed.map((effort) => ({
    value: effort.id,
    labelId: REASONING_EFFORT_LABEL_ID[effort.id],
    descriptionId: REASONING_EFFORT_DESCRIPTION_ID[effort.id],
  }));
}

/**
 * Reconcile a selected reasoning effort against a model. Returns the value
 * unchanged when the model doesn't gate reasoning or the value is still valid;
 * otherwise the model's declared `defaultReasoningEffort` (e.g. GPT-5.6's
 * `medium`), or null ("runtime default") when none is declared.
 *
 * Passing `current = null` yields the model's default effort, which is how the
 * form seeds a fresh selection (variants default to Medium).
 */
export function reconcileReasoningEffort(
  runtime: string,
  modelId: string,
  current: ReasoningEffort | null,
  liveModels?: readonly RuntimeModelInfo[],
): ReasoningEffort | null {
  const info = resolveModelInfo(runtime, modelId, liveModels);
  const supported = info?.supportedReasoningEfforts;
  if (!supported || supported.length === 0) return current;
  if (current && supported.includes(current)) return current;
  const fallback = info?.defaultReasoningEffort;
  return fallback && supported.includes(fallback) ? (fallback as ReasoningEffort) : null;
}
