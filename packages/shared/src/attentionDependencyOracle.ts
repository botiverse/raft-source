export const ATTENTION_HINT_COPY_VERSION = "attention-hint-copy-v1";
export const ATTENTION_HINT_SCHEMA = "attention-dependency-hint.v1";
export const ATTENTION_HINT_DEFAULT_K = 12;
export const ATTENTION_HINT_DEFAULT_SMALL_K = 3;
export const ATTENTION_HINT_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type AttentionHintTrigger = "M2" | "M3";
export type AttentionDependencyFact = boolean | "unknown";
export type AttentionParticipationFact = "pure_receive" | "single_drive_by" | "substantive" | "unknown";

/**
 * D(t) oracle hint attached to delivered inbox/wake messages.
 *
 * This is intentionally distinct from the Agent API `.attention` management
 * envelope returned by channel commands. `.attention` describes the result of a
 * management operation; `attention_hint` is evidence that the oracle recommends
 * a management operation before one has happened.
 */
export type AttentionHint = {
  schema: typeof ATTENTION_HINT_SCHEMA;
  trigger: AttentionHintTrigger;
  scope: string;
  suggested_command: string;
  copy: string;
  copy_version: typeof ATTENTION_HINT_COPY_VERSION;
  epoch_ms: number;
  thresholds: {
    K?: number;
    k?: number;
    window_ms: number;
  };
};

export type AttentionDependencyOracleInput = {
  trigger: AttentionHintTrigger;
  scope: string;
  targetKind: "channel" | "thread";
  deliveryCount?: number;
  unfollowCount?: number;
  thresholds?: {
    K?: number;
    k?: number;
    windowMs?: number;
  };
  dependencies: {
    directedOpenAsk: AttentionDependencyFact;
    taskAnchor: AttentionDependencyFact;
    awaitedReview: AttentionDependencyFact;
  };
  participation: AttentionParticipationFact;
  nowMs?: number;
};

export type AttentionDependencyOracleVerdict =
  | { kind: "show"; hint: AttentionHint }
  | {
      kind: "silence";
      reason:
        | "below_threshold"
        | "dependency_present"
        | "dependency_unknown"
        | "participation_substantive"
        | "participation_unknown"
        | "unsupported_scope";
    };

export function evaluateAttentionDependencyOracle(input: AttentionDependencyOracleInput): AttentionDependencyOracleVerdict {
  const windowMs = input.thresholds?.windowMs ?? ATTENTION_HINT_DEFAULT_WINDOW_MS;
  const K = input.thresholds?.K ?? ATTENTION_HINT_DEFAULT_K;
  const k = input.thresholds?.k ?? ATTENTION_HINT_DEFAULT_SMALL_K;
  if (input.targetKind !== "channel") return { kind: "silence", reason: "unsupported_scope" };
  if (input.participation === "unknown") return { kind: "silence", reason: "participation_unknown" };
  if (input.participation === "substantive") return { kind: "silence", reason: "participation_substantive" };

  for (const dependency of Object.values(input.dependencies)) {
    if (dependency === "unknown") return { kind: "silence", reason: "dependency_unknown" };
    if (dependency === true) return { kind: "silence", reason: "dependency_present" };
  }

  if (input.trigger === "M2" && (input.deliveryCount ?? 0) < K) return { kind: "silence", reason: "below_threshold" };
  if (input.trigger === "M3" && (input.unfollowCount ?? 0) < k) return { kind: "silence", reason: "below_threshold" };

  return {
    kind: "show",
    hint: {
      schema: ATTENTION_HINT_SCHEMA,
      trigger: input.trigger,
      scope: input.scope,
      suggested_command: `raft channel mute "${input.scope}"`,
      copy: input.trigger === "M2"
        ? `You've received ${input.deliveryCount ?? K} updates from ${input.scope} with no action taken. If this channel doesn't need your attention: raft channel mute "${input.scope}" -- @mentions still reach you; followed threads keep delivering until you unfollow them.`
        : `You've unfollowed ${input.unfollowCount ?? k} threads in ${input.scope} recently, but its updates keep coming. Channel-level noise needs the channel-level tool: raft channel mute "${input.scope}" -- @mentions still pierce, and any threads you still follow keep delivering.`,
      copy_version: ATTENTION_HINT_COPY_VERSION,
      epoch_ms: input.nowMs ?? Date.now(),
      thresholds: {
        ...(input.trigger === "M2" ? { K } : { k }),
        window_ms: windowMs,
      },
    },
  };
}
