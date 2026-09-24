import { z } from "zod";

/**
 * Phase-3 progressive-delivery contract for feature-flag writes.
 *
 * Request-adjacent callers provide raw locked state plus desired state. This
 * module derives direction itself: callers cannot submit `safe`, `from`, a
 * canonical operation, or a verdict. Receipt records are loaded only through
 * a server-owned provider dependency; request JSON is never receipt evidence.
 */

export const FEATURE_FLAG_ROLLOUT_GUARDRAIL_SCHEMA = "feature_flag_rollout_guardrail.v1" as const;
export const FEATURE_FLAG_ROLLOUT_GUARDRAIL_ISSUER = "feature-flag-guardrail" as const;
export const FEATURE_FLAG_ROLLOUT_GUARDRAIL_POLICY_VERSION = "v1" as const;
export const FEATURE_FLAG_ROLLOUT_GUARDRAIL_MAX_RECEIPT_AGE_MS = 5 * 60 * 1_000;

const FLAG_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const CONTROL_PLANE_ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,127}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const flagKeySchema = z.string().regex(FLAG_KEY_RE);
const controlPlaneIdSchema = z.string().regex(CONTROL_PLANE_ID_RE);
const uuidSchema = z.string().regex(UUID_RE);
const configVersionSchema = z.number().refine(Number.isSafeInteger).refine((value) => value >= 0);
const basisPointsSchema = z.number().int().min(0).max(10_000);

// Persisted rows carry adapter-specific metadata (timestamps, etc.). Strip
// irrelevant columns, but retain the optional row key so it can be checked
// against the locked top-level flag before any rule drives a decision.
const ruleSchema = z.object({
  id: uuidSchema,
  flagKey: flagKeySchema.optional(),
  stage: z.enum(["user", "platform", "server", "audience", "lab", "plan", "percentage"]),
  priority: z.number().int(),
  decision: z.enum(["allow", "deny"]),
  values: z.array(z.string().min(1)).refine((values) => new Set(values).size === values.length),
  percentageBasisPoints: basisPointsSchema.nullable(),
  variant: z.string().min(1).nullable(),
});

export type FeatureFlagRolloutRuleInput = z.infer<typeof ruleSchema>;

export interface FeatureFlagRolloutStateInput {
  controlPlaneId: string;
  flagKey: string;
  configVersion: number;
  killSwitch: boolean;
  /** Every persisted rule for this flag, not a writer-selected subset. */
  rules: readonly FeatureFlagRolloutRuleInput[];
}

const baseStateSchema = z.strictObject({
  controlPlaneId: controlPlaneIdSchema,
  flagKey: flagKeySchema,
  configVersion: configVersionSchema,
  killSwitch: z.boolean(),
  // Rules are parsed only when the requested operation depends on them. This
  // keeps emergency kill available even if unrelated rule payloads are bad.
  rules: z.unknown().optional(),
});
type ParsedState = Omit<z.infer<typeof baseStateSchema>, "rules"> & { rules: unknown[] };

const intentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("server_allowlist_set"),
    flagKey: flagKeySchema,
    expectedConfigVersion: configVersionSchema.optional(),
    serverId: uuidSchema,
    desired: z.enum(["present", "absent"]),
  }),
  z.strictObject({
    kind: z.literal("percentage_set"),
    flagKey: flagKeySchema,
    expectedConfigVersion: configVersionSchema.optional(),
    desiredBasisPoints: basisPointsSchema,
  }),
  z.strictObject({
    kind: z.literal("kill_switch_set"),
    flagKey: flagKeySchema,
    expectedConfigVersion: configVersionSchema.optional(),
    desired: z.boolean(),
  }),
]);

export type FeatureFlagRolloutIntent = z.infer<typeof intentSchema>;

const wideningOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("server_allowlist_add"),
    ruleId: uuidSchema.nullable(),
    serverId: uuidSchema,
  }),
  z.strictObject({
    kind: z.literal("percentage_increase"),
    ruleId: uuidSchema.nullable(),
    fromBasisPoints: basisPointsSchema,
    toBasisPoints: basisPointsSchema,
  }).refine((operation) => operation.toBasisPoints > operation.fromBasisPoints),
  z.strictObject({ kind: z.literal("kill_switch_disable") }),
]);

export type FeatureFlagRolloutWideningOperation = z.infer<typeof wideningOperationSchema>;

export type FeatureFlagRolloutNarrowingOperation =
  | { kind: "server_allowlist_remove"; ruleId: string; serverId: string }
  | { kind: "percentage_decrease"; ruleId: string; fromBasisPoints: number; toBasisPoints: number }
  | { kind: "kill_switch_enable" };

export type FeatureFlagRolloutBlockedReason =
  | "invalid_state"
  | "invalid_intent"
  | "flag_key_mismatch"
  | "config_version_required"
  | "config_version_mismatch"
  | "unsupported_server_allowlist_shape"
  | "unsupported_percentage_shape";

export type FeatureFlagRolloutClassification =
  | {
      kind: "widening";
      controlPlaneId: string;
      flagKey: string;
      configVersion: number;
      operation: FeatureFlagRolloutWideningOperation;
    }
  | { kind: "narrowing"; operation: FeatureFlagRolloutNarrowingOperation }
  | { kind: "no_op" }
  | { kind: "blocked"; reason: FeatureFlagRolloutBlockedReason };

const receiptSchema = z.strictObject({
  schema: z.literal(FEATURE_FLAG_ROLLOUT_GUARDRAIL_SCHEMA),
  id: uuidSchema,
  verdict: z.enum(["pass", "fail"]),
  issuer: z.literal(FEATURE_FLAG_ROLLOUT_GUARDRAIL_ISSUER),
  controlPlaneId: controlPlaneIdSchema,
  flagKey: flagKeySchema,
  configVersion: configVersionSchema,
  operation: wideningOperationSchema,
  policyVersion: z.literal(FEATURE_FLAG_ROLLOUT_GUARDRAIL_POLICY_VERSION),
  evaluatedAt: z.string(),
  expiresAt: z.string(),
});

export type FeatureFlagRolloutGuardrailReceiptV1 = z.infer<typeof receiptSchema>;

/**
 * Must be implemented by trusted control-plane code. A request body cannot
 * satisfy this contract because it cannot supply executable dependencies.
 */
export interface FeatureFlagRolloutGuardrailDependencies {
  loadTrustedReceipt(receiptId: string): Promise<unknown | null>;
  nowMs(): number;
}

export type FeatureFlagRolloutGuardrailDecision =
  | { allowed: true; reason: "narrowing"; operation: FeatureFlagRolloutNarrowingOperation }
  | { allowed: true; reason: "no_op" }
  | {
      allowed: true;
      reason: "guardrail_passed";
      receiptId: string;
      operation: FeatureFlagRolloutWideningOperation;
    }
  | {
      allowed: false;
      reason:
        | FeatureFlagRolloutBlockedReason
        | "receipt_missing"
        | "receipt_unavailable"
        | "receipt_invalid"
        | "receipt_failed"
        | "receipt_mismatch"
        | "receipt_stale";
    };

function classifyWidening(
  state: ParsedState,
  intent: FeatureFlagRolloutIntent,
  operation: FeatureFlagRolloutWideningOperation,
): FeatureFlagRolloutClassification {
  if (intent.expectedConfigVersion === undefined) {
    return { kind: "blocked", reason: "config_version_required" };
  }
  if (intent.expectedConfigVersion !== state.configVersion) {
    return { kind: "blocked", reason: "config_version_mismatch" };
  }
  return {
    kind: "widening",
    controlPlaneId: state.controlPlaneId,
    flagKey: state.flagKey,
    configVersion: state.configVersion,
    operation,
  };
}

function parseAllRules(state: ParsedState): FeatureFlagRolloutRuleInput[] | null {
  const parsed = z.array(ruleSchema).safeParse(state.rules);
  if (
    !parsed.success
    || parsed.data.some((rule) => rule.flagKey !== undefined && rule.flagKey !== state.flagKey)
  ) return null;
  return parsed.data;
}

function deriveServerAllowlist(state: ParsedState):
  | { shape: "canonical"; ruleId: string | null; serverIds: string[] }
  | { shape: "unsupported" } {
  const allRules = parseAllRules(state);
  if (!allRules) return { shape: "unsupported" };
  const rules = allRules.filter((rule) => rule.stage === "server");
  if (rules.length === 0) return { shape: "canonical", ruleId: null, serverIds: [] };
  if (rules.length !== 1) return { shape: "unsupported" };
  const [rule] = rules;
  if (
    rule.decision !== "allow"
    || rule.priority !== 0
    || rule.percentageBasisPoints !== null
    || rule.variant !== null
    || rule.values.some((serverId) => !UUID_RE.test(serverId))
  ) return { shape: "unsupported" };
  return { shape: "canonical", ruleId: rule.id, serverIds: [...rule.values] };
}

function derivePercentage(state: ParsedState):
  | { shape: "absent" }
  | { shape: "canonical_allow"; ruleId: string; basisPoints: number }
  | { shape: "unsupported" } {
  const allRules = parseAllRules(state);
  if (!allRules) return { shape: "unsupported" };
  const rules = allRules.filter((rule) => rule.stage === "percentage");
  if (rules.length === 0) return { shape: "absent" };
  if (rules.length !== 1) return { shape: "unsupported" };
  const [rule] = rules;
  if (
    rule.decision !== "allow"
    || rule.priority !== 0
    || rule.values.length !== 0
    || rule.percentageBasisPoints === null
    || rule.variant !== null
  ) return { shape: "unsupported" };
  return { shape: "canonical_allow", ruleId: rule.id, basisPoints: rule.percentageBasisPoints };
}

/**
 * Classify from all locked database rules plus desired state. Inputs are
 * runtime-validated unknowns so malformed request adapters fail closed.
 */
export function classifyFeatureFlagRollout(
  stateInput: unknown,
  intentInput: unknown,
): FeatureFlagRolloutClassification {
  const stateResult = baseStateSchema.safeParse(stateInput);
  if (!stateResult.success) return { kind: "blocked", reason: "invalid_state" };
  const intentResult = intentSchema.safeParse(intentInput);
  if (!intentResult.success) return { kind: "blocked", reason: "invalid_intent" };
  const intent = intentResult.data;
  const hasRuleSnapshot = Array.isArray(stateResult.data.rules);
  if (intent.kind !== "kill_switch_set" && !hasRuleSnapshot) {
    return { kind: "blocked", reason: "invalid_state" };
  }
  const state: ParsedState = {
    ...stateResult.data,
    rules: Array.isArray(stateResult.data.rules) ? stateResult.data.rules : [],
  };
  if (intent.flagKey !== state.flagKey) return { kind: "blocked", reason: "flag_key_mismatch" };

  switch (intent.kind) {
    case "kill_switch_set":
      if (intent.desired === state.killSwitch) return { kind: "no_op" };
      if (intent.desired) {
        return { kind: "narrowing", operation: { kind: "kill_switch_enable" } };
      }
      // Emergency kill and no-op must survive a broken rule adapter. Unkill is
      // widening, so it may not reactivate a snapshot we could not validate.
      if (!hasRuleSnapshot || parseAllRules(state) === null) {
        return { kind: "blocked", reason: "invalid_state" };
      }
      return classifyWidening(state, intent, { kind: "kill_switch_disable" });
    case "server_allowlist_set": {
      const allowlist = deriveServerAllowlist(state);
      if (allowlist.shape === "unsupported") {
        return { kind: "blocked", reason: "unsupported_server_allowlist_shape" };
      }
      const present = allowlist.serverIds.includes(intent.serverId);
      if ((intent.desired === "present") === present) return { kind: "no_op" };
      if (intent.desired === "present") {
        return classifyWidening(state, intent, {
          kind: "server_allowlist_add",
          ruleId: allowlist.ruleId,
          serverId: intent.serverId,
        });
      }
      // A present server can only come from the one canonical persisted rule.
      // Keep the invariant explicit so the writer never receives a nullable
      // delete target if classification changes later.
      if (allowlist.ruleId === null) return { kind: "blocked", reason: "invalid_state" };
      return {
        kind: "narrowing",
        operation: {
          kind: "server_allowlist_remove",
          ruleId: allowlist.ruleId,
          serverId: intent.serverId,
        },
      };
    }
    case "percentage_set": {
      const percentage = derivePercentage(state);
      if (percentage.shape === "unsupported") {
        return { kind: "blocked", reason: "unsupported_percentage_shape" };
      }
      const fromBasisPoints = percentage.shape === "absent" ? 0 : percentage.basisPoints;
      if (intent.desiredBasisPoints === fromBasisPoints) return { kind: "no_op" };
      if (intent.desiredBasisPoints < fromBasisPoints) {
        if (percentage.shape !== "canonical_allow") {
          return { kind: "blocked", reason: "invalid_state" };
        }
        return {
          kind: "narrowing",
          operation: {
            kind: "percentage_decrease",
            ruleId: percentage.ruleId,
            fromBasisPoints,
            toBasisPoints: intent.desiredBasisPoints,
          },
        };
      }
      return classifyWidening(state, intent, {
        kind: "percentage_increase",
        ruleId: percentage.shape === "absent" ? null : percentage.ruleId,
        fromBasisPoints,
        toBasisPoints: intent.desiredBasisPoints,
      });
    }
  }
}

function parseCanonicalTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? timestamp : null;
}

function sameOperation(
  expected: FeatureFlagRolloutWideningOperation,
  actual: FeatureFlagRolloutWideningOperation,
): boolean {
  if (expected.kind !== actual.kind) return false;
  switch (expected.kind) {
    case "server_allowlist_add":
      return actual.kind === "server_allowlist_add"
        && expected.ruleId === actual.ruleId
        && expected.serverId === actual.serverId;
    case "percentage_increase":
      return actual.kind === "percentage_increase"
        && expected.ruleId === actual.ruleId
        && expected.fromBasisPoints === actual.fromBasisPoints
        && expected.toBasisPoints === actual.toBasisPoints;
    case "kill_switch_disable":
      return actual.kind === "kill_switch_disable";
  }
}

/**
 * One-shot authorization decision. Direction is always re-derived internally;
 * no caller-constructed classification is accepted. Widening loads an opaque
 * receipt id through executable trusted dependencies. Safe operations never
 * touch the receipt store or clock.
 */
export async function decideFeatureFlagRolloutGuardrail(
  stateInput: unknown,
  intentInput: unknown,
  receiptId: unknown,
  dependencies: FeatureFlagRolloutGuardrailDependencies,
): Promise<FeatureFlagRolloutGuardrailDecision> {
  const classification = classifyFeatureFlagRollout(stateInput, intentInput);
  if (classification.kind === "blocked") return { allowed: false, reason: classification.reason };
  if (classification.kind === "narrowing") {
    return { allowed: true, reason: "narrowing", operation: classification.operation };
  }
  if (classification.kind === "no_op") return { allowed: true, reason: "no_op" };
  if (receiptId === null || receiptId === undefined || receiptId === "") {
    return { allowed: false, reason: "receipt_missing" };
  }
  if (
    !uuidSchema.safeParse(receiptId).success
    || !dependencies
    || typeof dependencies.loadTrustedReceipt !== "function"
    || typeof dependencies.nowMs !== "function"
  ) {
    return { allowed: false, reason: "receipt_invalid" };
  }

  let storedReceipt: unknown;
  let nowMs: number;
  try {
    storedReceipt = await dependencies.loadTrustedReceipt(receiptId as string);
    nowMs = dependencies.nowMs();
  } catch {
    return { allowed: false, reason: "receipt_unavailable" };
  }
  if (storedReceipt === null || storedReceipt === undefined) {
    return { allowed: false, reason: "receipt_missing" };
  }
  const receiptResult = receiptSchema.safeParse(storedReceipt);
  if (!receiptResult.success || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    return { allowed: false, reason: "receipt_invalid" };
  }
  const receipt = receiptResult.data;
  if (receipt.verdict !== "pass") return { allowed: false, reason: "receipt_failed" };
  if (
    receipt.id !== receiptId
    || receipt.controlPlaneId !== classification.controlPlaneId
    || receipt.flagKey !== classification.flagKey
    || receipt.configVersion !== classification.configVersion
    || !sameOperation(classification.operation, receipt.operation)
  ) {
    return { allowed: false, reason: "receipt_mismatch" };
  }

  const evaluatedAtMs = parseCanonicalTimestamp(receipt.evaluatedAt);
  const expiresAtMs = parseCanonicalTimestamp(receipt.expiresAt);
  if (
    evaluatedAtMs === null
    || expiresAtMs === null
    || expiresAtMs <= evaluatedAtMs
    || expiresAtMs - evaluatedAtMs > FEATURE_FLAG_ROLLOUT_GUARDRAIL_MAX_RECEIPT_AGE_MS
  ) {
    return { allowed: false, reason: "receipt_invalid" };
  }
  if (
    nowMs < evaluatedAtMs
    || nowMs >= expiresAtMs
    || nowMs - evaluatedAtMs > FEATURE_FLAG_ROLLOUT_GUARDRAIL_MAX_RECEIPT_AGE_MS
  ) {
    return { allowed: false, reason: "receipt_stale" };
  }
  return {
    allowed: true,
    reason: "guardrail_passed",
    receiptId: receipt.id,
    operation: classification.operation,
  };
}
