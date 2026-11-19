/**
 * Shared pure feature-flag evaluation core used by both the Raft API server
 * (`packages/server/src/services/featureFlagService.ts`) and the Feature Flag
 * Admin Worker (`apps/feature-flag-admin/src/worker.ts`).
 *
 * Imported by the Worker through `@botiverse/raft-shared/feature-flag-evaluation`,
 * so this module imports only narrow shared leaves and zero Node-only modules.
 *
 * Bucket computation uses a synchronous pure-JS FIPS 180-4 SHA-256 over UTF-8
 * bytes (`readUInt32BE(0) % 10_000`) so:
 * 1. Every existing percentage-rollout bucket stays bit-for-bit identical to
 *    `node:crypto` `createHash("sha256")` (pinned by golden vectors and
 *    differential tests);
 * 2. Server batch evaluation stays synchronous on the hot path (~1.78 us/hash
 *    on Node 24 vs ~1.34 us for `node:crypto` and ~2.93-8.17 us + Promise
 *    allocations for async `crypto.subtle.digest`);
 * 3. Server and Cloudflare Worker execute the exact same hash code.
 */

import { canUseProBillingFeatures, type ServerPlan } from "./billingPlanFeatures";
export type { ServerPlan };
export {
  PRO_PREPAID_GRACE_DAYS,
  isInternalEntitlementPlan,
  isSubscriptionEntitling,
  parseFfaServerPlanEntitlementInputs,
  prepaidGrantOf,
  resolveEffectiveServerBillingPlan,
  resolveServerBillingPlanSource,
  type ParsedFfaServerPlanEntitlementInputs,
  type PrepaidEntitlement,
  type PrepaidGrantPurchaseInput,
  type ResolvedServerBillingPlanSource,
  type ServerBillingPlanInputs,
  type ServerPlanEntitlementSource,
} from "./serverBillingEntitlement";
export {
  DEPLOYMENT_ANSWERED_FEATURE_FLAG_KEYS,
  isDeploymentAnsweredFeatureFlagKey,
} from "./featureFlags";
import { clientRuleConstraintsSatisfied, type FeatureFlagClientFacts } from "./featureFlagClientRules";
import {
  describeEffectiveDefault,
  type EffectiveDefault,
  type FeatureFlagDefaultPolicy,
} from "./featureFlagDefaultPolicy";

export const FEATURE_FLAG_RULE_STAGE_ORDER = [
  "user",
  "platform",
  "client",
  "server",
  "audience",
  "lab",
  "plan",
  "percentage",
] as const;

export type FeatureFlagRuleStage = (typeof FEATURE_FLAG_RULE_STAGE_ORDER)[number];
export type FeatureFlagRuleDecision = "allow" | "deny";
export type FeatureFlagRandomizationUnit = "user" | "server";
export type FeatureFlagPlatform = "web" | "mobile";

export type FeatureFlagEvaluationReason =
  | "missing_flag"
  | "kill_switch"
  | "flag_disabled"
  | "missing_user_unit"
  | "missing_server_unit"
  | "user_rule"
  | "platform_rule"
  | "client_rule"
  | "server_rule"
  | "audience_rule"
  | "lab_rule"
  | "plan_rule"
  | "percentage_rule"
  | "default";

export type FeatureFlagUndeterminedReason =
  | "lab_read_failed"
  | "plan_preview_unavailable"
  | "plan_read_failed";

export type FeatureFlagPreviewReason =
  | FeatureFlagEvaluationReason
  | FeatureFlagUndeterminedReason
  | "not_pre_auth_evaluable";

export type FeatureFlagRowInput = {
  key: string;
  enabled: boolean;
  killSwitch: boolean;
  randomizationUnit: FeatureFlagRandomizationUnit;
  defaultEnabled: boolean;
  defaultVariant?: string | null;
  salt: string;
  preAuthEvaluable?: boolean;
};

export type FeatureFlagRuleRowInput = {
  id: string;
  stage: FeatureFlagRuleStage;
  priority: number;
  decision: FeatureFlagRuleDecision;
  values: readonly string[];
  percentageBasisPoints: number | null;
  variant?: string | null;
  clientOs?: readonly string[] | null;
  minClientBuild?: number | null;
  clientBuildTypes?: readonly string[] | null;
  createdAt: Date | string | number;
};

export type EvaluateFeatureFlagSubjectInput = {
  key: string;
  userId?: string | null;
  serverId?: string | null;
  platform?: FeatureFlagPlatform | null;
  client?: FeatureFlagClientFacts | null;
};

export type FeatureFlagMatchedRuleSummary = {
  id: string;
  stage: FeatureFlagRuleStage;
  priority: number;
  decision: FeatureFlagRuleDecision;
};

export type ReadyFeatureFlagLabCohortInput = {
  status: "ready";
  effectiveLabKeys: ReadonlySet<string>;
};

export type FeatureFlagLabCohortInput =
  | ReadyFeatureFlagLabCohortInput
  | { status: "unavailable"; reason: "lab_read_failed" };

export type ReadyFeatureFlagPlanCohortInput = {
  status: "ready";
  entitlementPlan: ServerPlan | null;
  now: Date;
};

export type FeatureFlagPlanCohortInput =
  | ReadyFeatureFlagPlanCohortInput
  | { status: "unavailable"; reason: "plan_preview_unavailable" | "plan_read_failed" };

export type ReadyFeatureFlagCohortContext = {
  matchingAudienceKeys: ReadonlySet<string>;
  lab: ReadyFeatureFlagLabCohortInput;
  plan: ReadyFeatureFlagPlanCohortInput;
};

export type FeatureFlagCohortContext = {
  matchingAudienceKeys: ReadonlySet<string>;
  lab: FeatureFlagLabCohortInput;
  plan: FeatureFlagPlanCohortInput;
};

export type DeterminedFeatureFlagRowEvaluation = {
  key: string;
  decision: "enabled" | "disabled";
  enabled: boolean;
  reason: FeatureFlagEvaluationReason;
  variant?: string;
  fallback?: EffectiveDefault;
  matchedRule: FeatureFlagMatchedRuleSummary | null;
};

export type UndeterminedFeatureFlagRowEvaluation = {
  key: string;
  decision: "undetermined";
  enabled: false;
  reason: FeatureFlagUndeterminedReason;
  matchedRule: null;
};

export type FeatureFlagRowEvaluation =
  | DeterminedFeatureFlagRowEvaluation
  | UndeterminedFeatureFlagRowEvaluation;

export type PreAuthFeatureFlagRowEvaluation = {
  key: string;
  decision: "enabled" | "disabled";
  enabled: boolean;
  reason:
    | "missing_flag"
    | "not_pre_auth_evaluable"
    | "kill_switch"
    | "flag_disabled"
    | "platform_rule"
    | "default";
  fallback?: EffectiveDefault;
  matchedRule: FeatureFlagMatchedRuleSummary | null;
};

const utf8Encoder = new TextEncoder();

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_W = new Uint32Array(64);

function sha256FirstUint32BE(bytes: Uint8Array): number {
  const byteLen = bytes.length;
  const totalLen = ((byteLen + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(totalLen);
  padded.set(bytes);
  padded[byteLen] = 0x80;
  const bitLenHi = Math.floor(byteLen / 0x20000000);
  const bitLenLo = (byteLen << 3) >>> 0;
  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 8, bitLenHi, false);
  view.setUint32(totalLen - 4, bitLenLo, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      SHA256_W[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = SHA256_W[i - 15]!;
      const w2 = SHA256_W[i - 2]!;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      SHA256_W[i] = (SHA256_W[i - 16]! + s0 + SHA256_W[i - 7]! + s1) | 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i]! + SHA256_W[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }

  return h0 >>> 0;
}

export function computeFeatureFlagBucket(args: {
  key: string;
  salt: string;
  unit: FeatureFlagRandomizationUnit;
  unitId: string;
}): number {
  const bytes = utf8Encoder.encode(`${args.salt}:${args.key}:${args.unit}:${args.unitId}`);
  return sha256FirstUint32BE(bytes) % 10_000;
}

function createdAtEpochMs(value: Date | string | number): number {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  return Date.parse(value);
}

/**
 * Canonical within-stage rule order shared by server evaluation and FFA preview:
 * `priority ASC, createdAt ASC, id ASC` (normalized lowercase UUID code-point
 * comparison, which matches PostgreSQL `uuid` `ORDER BY id ASC`).
 */
export function compareFeatureFlagRules(
  a: Pick<FeatureFlagRuleRowInput, "priority" | "createdAt" | "id">,
  b: Pick<FeatureFlagRuleRowInput, "priority" | "createdAt" | "id">,
): number {
  const priorityDiff = a.priority - b.priority;
  if (priorityDiff !== 0) return priorityDiff;
  const createdDiff = createdAtEpochMs(a.createdAt) - createdAtEpochMs(b.createdAt);
  if (createdDiff !== 0) return createdDiff;
  const aId = a.id.toLowerCase();
  const bId = b.id.toLowerCase();
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

export function sortFeatureFlagRulesForStage<T extends FeatureFlagRuleRowInput>(
  rules: readonly T[],
  stage: FeatureFlagRuleStage,
): T[] {
  return rules
    .filter((rule) => rule.stage === stage)
    .sort(compareFeatureFlagRules);
}

function toMatchedRuleSummary(rule: FeatureFlagRuleRowInput): FeatureFlagMatchedRuleSummary {
  return {
    id: rule.id,
    stage: rule.stage,
    priority: rule.priority,
    decision: rule.decision,
  };
}

function evaluationFromRule(
  key: string,
  rule: FeatureFlagRuleRowInput,
  reason: FeatureFlagEvaluationReason,
): DeterminedFeatureFlagRowEvaluation {
  const enabled = rule.decision === "allow";
  return {
    key,
    decision: enabled ? "enabled" : "disabled",
    enabled,
    reason,
    ...(enabled && rule.variant ? { variant: rule.variant } : {}),
    matchedRule: toMatchedRuleSummary(rule),
  };
}

function matchExplicitValueRule(
  key: string,
  rules: readonly FeatureFlagRuleRowInput[],
  stage: "user" | "platform" | "server",
  value: string | null | undefined,
): DeterminedFeatureFlagRowEvaluation | null {
  if (!value) return null;
  for (const rule of sortFeatureFlagRulesForStage(rules, stage)) {
    if (rule.values.includes(value)) {
      return evaluationFromRule(key, rule, `${stage}_rule`);
    }
  }
  return null;
}

function matchClientStageRule(
  key: string,
  rules: readonly FeatureFlagRuleRowInput[],
  input: Pick<EvaluateFeatureFlagSubjectInput, "serverId" | "client">,
): DeterminedFeatureFlagRowEvaluation | null {
  if (!input.serverId) return null;
  for (const rule of sortFeatureFlagRulesForStage(rules, "client")) {
    if (!rule.values.includes(input.serverId)) continue;
    const constraints = {
      clientOs: rule.clientOs == null ? null : [...rule.clientOs],
      minClientBuild: rule.minClientBuild ?? null,
      clientBuildTypes: rule.clientBuildTypes == null ? null : [...rule.clientBuildTypes],
    };
    if (clientRuleConstraintsSatisfied(constraints, input.client)) {
      return evaluationFromRule(key, rule, "client_rule");
    }
  }
  return null;
}

export function matchFeatureFlagPlanRule(
  key: string,
  rules: readonly FeatureFlagRuleRowInput[],
  entitlementPlan: ServerPlan,
  now: Date,
): DeterminedFeatureFlagRowEvaluation | null {
  for (const rule of sortFeatureFlagRulesForStage(rules, "plan")) {
    const exactMatch = rule.values.includes(entitlementPlan);
    const proCohortAllowMatch = rule.decision === "allow"
      && entitlementPlan !== "pro"
      && rule.values.includes("pro")
      && canUseProBillingFeatures(entitlementPlan, now);
    if (exactMatch || proCohortAllowMatch) {
      return evaluationFromRule(key, rule, "plan_rule");
    }
  }
  return null;
}

export function evaluateFeatureFlagRow(params: {
  flag: FeatureFlagRowInput | null;
  rules: readonly FeatureFlagRuleRowInput[];
  input: EvaluateFeatureFlagSubjectInput;
  cohorts: ReadyFeatureFlagCohortContext;
  defaultPolicy: FeatureFlagDefaultPolicy;
}): DeterminedFeatureFlagRowEvaluation;
export function evaluateFeatureFlagRow(params: {
  flag: FeatureFlagRowInput | null;
  rules: readonly FeatureFlagRuleRowInput[];
  input: EvaluateFeatureFlagSubjectInput;
  cohorts: FeatureFlagCohortContext;
  defaultPolicy: FeatureFlagDefaultPolicy;
}): FeatureFlagRowEvaluation;
export function evaluateFeatureFlagRow(params: {
  flag: FeatureFlagRowInput | null;
  rules: readonly FeatureFlagRuleRowInput[];
  input: EvaluateFeatureFlagSubjectInput;
  cohorts: FeatureFlagCohortContext;
  defaultPolicy: FeatureFlagDefaultPolicy;
}): FeatureFlagRowEvaluation {
  const { flag, rules, input, cohorts, defaultPolicy } = params;
  const key = input.key;

  if (!flag) {
    const fallback = describeEffectiveDefault({ key, defaultEnabled: false }, defaultPolicy);
    return {
      key,
      decision: fallback.enabled ? "enabled" : "disabled",
      enabled: fallback.enabled,
      reason: "missing_flag",
      ...(fallback.source === "stored" ? {} : { fallback }),
      matchedRule: null,
    };
  }

  if (flag.killSwitch === true) {
    return { key, decision: "disabled", enabled: false, reason: "kill_switch", matchedRule: null };
  }
  if (flag.enabled !== true) {
    return { key, decision: "disabled", enabled: false, reason: "flag_disabled", matchedRule: null };
  }

  const userRule = matchExplicitValueRule(key, rules, "user", input.userId);
  if (userRule) return userRule;

  const platformRule = matchExplicitValueRule(key, rules, "platform", input.platform);
  if (platformRule) return platformRule;

  const clientRule = matchClientStageRule(key, rules, input);
  if (clientRule) return clientRule;

  const serverRule = matchExplicitValueRule(key, rules, "server", input.serverId);
  if (serverRule) return serverRule;

  if (cohorts.matchingAudienceKeys.size > 0) {
    for (const rule of sortFeatureFlagRulesForStage(rules, "audience")) {
      if (rule.values.some((audienceKey) => cohorts.matchingAudienceKeys.has(audienceKey))) {
        return evaluationFromRule(key, rule, "audience_rule");
      }
    }
  }

  if (input.serverId) {
    const labRules = sortFeatureFlagRulesForStage(rules, "lab");
    if (labRules.length > 0) {
      if (cohorts.lab.status === "unavailable") {
        return {
          key,
          decision: "undetermined",
          enabled: false,
          reason: cohorts.lab.reason,
          matchedRule: null,
        };
      }
      const { effectiveLabKeys } = cohorts.lab;
      if (effectiveLabKeys.size > 0) {
        for (const rule of labRules) {
          if (rule.values.some((labKey) => effectiveLabKeys.has(labKey))) {
            return evaluationFromRule(key, rule, "lab_rule");
          }
        }
      }
    }

    const planRules = sortFeatureFlagRulesForStage(rules, "plan");
    if (planRules.length > 0) {
      if (cohorts.plan.status === "unavailable") {
        return {
          key,
          decision: "undetermined",
          enabled: false,
          reason: cohorts.plan.reason,
          matchedRule: null,
        };
      }
      if (cohorts.plan.entitlementPlan !== null) {
        const planRule = matchFeatureFlagPlanRule(
          key,
          planRules,
          cohorts.plan.entitlementPlan,
          cohorts.plan.now,
        );
        if (planRule) return planRule;
      }
    }
  }

  if (flag.randomizationUnit === "user" && !input.userId) {
    return { key, decision: "disabled", enabled: false, reason: "missing_user_unit", matchedRule: null };
  }
  if (flag.randomizationUnit === "server" && !input.serverId) {
    return { key, decision: "disabled", enabled: false, reason: "missing_server_unit", matchedRule: null };
  }

  const percentageRules = sortFeatureFlagRulesForStage(rules, "percentage");
  if (percentageRules.length > 0) {
    const unitId = flag.randomizationUnit === "server" ? input.serverId! : input.userId!;
    const bucket = computeFeatureFlagBucket({
      key: flag.key,
      salt: flag.salt,
      unit: flag.randomizationUnit,
      unitId,
    });
    for (const rule of percentageRules) {
      if (rule.percentageBasisPoints !== null && bucket < rule.percentageBasisPoints) {
        return evaluationFromRule(key, rule, "percentage_rule");
      }
    }
  }

  const fallback = describeEffectiveDefault(flag, defaultPolicy);
  return {
    key,
    decision: fallback.enabled ? "enabled" : "disabled",
    enabled: fallback.enabled,
    reason: "default",
    ...(fallback.enabled && flag.defaultVariant ? { variant: flag.defaultVariant } : {}),
    ...(fallback.source === "stored" ? {} : { fallback }),
    matchedRule: null,
  };
}

export function evaluatePreAuthFeatureFlagRow(params: {
  key: string;
  flag: Pick<FeatureFlagRowInput, "key" | "enabled" | "killSwitch" | "defaultEnabled" | "preAuthEvaluable"> | null;
  platformRules: readonly FeatureFlagRuleRowInput[];
  platform: FeatureFlagPlatform | null | undefined;
  defaultPolicy: FeatureFlagDefaultPolicy;
}): PreAuthFeatureFlagRowEvaluation {
  const { key, flag, platformRules, platform, defaultPolicy } = params;
  if (!flag) {
    return { key, decision: "disabled", enabled: false, reason: "missing_flag", matchedRule: null };
  }
  if (flag.preAuthEvaluable !== true) {
    return { key, decision: "disabled", enabled: false, reason: "not_pre_auth_evaluable", matchedRule: null };
  }
  if (flag.killSwitch === true) {
    return { key, decision: "disabled", enabled: false, reason: "kill_switch", matchedRule: null };
  }
  if (flag.enabled !== true) {
    return { key, decision: "disabled", enabled: false, reason: "flag_disabled", matchedRule: null };
  }
  if (platform) {
    const matched = matchExplicitValueRule(key, platformRules, "platform", platform);
    if (matched) {
      return {
        key,
        decision: matched.decision,
        enabled: matched.enabled,
        reason: "platform_rule",
        matchedRule: matched.matchedRule,
      };
    }
  }
  const fallback = describeEffectiveDefault(flag, defaultPolicy);
  return {
    key,
    decision: fallback.enabled ? "enabled" : "disabled",
    enabled: fallback.enabled,
    reason: "default",
    ...(fallback.source === "stored" ? {} : { fallback }),
    matchedRule: null,
  };
}
