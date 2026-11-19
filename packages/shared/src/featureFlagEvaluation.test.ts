import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { featureFlagDefaultPolicyFromEnv } from "./featureFlagDefaultPolicy";
import { FEATURE_FLAG_BUCKET_GOLDEN_VECTORS } from "./test/featureFlagBucketGoldenVectors";
import {
  compareFeatureFlagRules,
  computeFeatureFlagBucket,
  evaluateFeatureFlagRow,
  evaluatePreAuthFeatureFlagRow,
  matchFeatureFlagPlanRule,
  sortFeatureFlagRulesForStage,
  type FeatureFlagRowInput,
  type FeatureFlagRuleRowInput,
  type ReadyFeatureFlagCohortContext,
} from "./featureFlagEvaluation";

function nodeCryptoBucket(args: {
  key: string;
  salt: string;
  unit: "user" | "server";
  unitId: string;
}): number {
  const digest = createHash("sha256")
    .update(`${args.salt}:${args.key}:${args.unit}:${args.unitId}`)
    .digest();
  return digest.readUInt32BE(0) % 10_000;
}

async function webCryptoBucket(args: {
  key: string;
  salt: string;
  unit: "user" | "server";
  unitId: string;
}): Promise<number> {
  const bytes = new TextEncoder().encode(`${args.salt}:${args.key}:${args.unit}:${args.unitId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return (((digest[0] ?? 0) * 0x1000000)
    + ((digest[1] ?? 0) * 0x10000)
    + ((digest[2] ?? 0) * 0x100)
    + (digest[3] ?? 0)) % 10_000;
}

const DEFAULT_OFF_POLICY = featureFlagDefaultPolicyFromEnv({});
const STAGING_DEFAULT_ON_POLICY = featureFlagDefaultPolicyFromEnv({ FEATURE_FLAGS_DEFAULT_ON: "true" });

const BASE_FLAG: FeatureFlagRowInput = {
  key: "shared_eval_v0",
  enabled: true,
  killSwitch: false,
  randomizationUnit: "server",
  defaultEnabled: false,
  defaultVariant: null,
  salt: "shared-eval-salt",
  preAuthEvaluable: false,
};

function readyCohorts(overrides: Partial<ReadyFeatureFlagCohortContext> = {}): ReadyFeatureFlagCohortContext {
  return {
    matchingAudienceKeys: new Set<string>(),
    lab: { status: "ready", effectiveLabKeys: new Set<string>() },
    plan: { status: "ready", entitlementPlan: "free", now: new Date("2026-11-15T00:00:00.000Z") },
    ...overrides,
  };
}

function makeRule(overrides: Partial<FeatureFlagRuleRowInput> & Pick<FeatureFlagRuleRowInput, "id" | "stage" | "decision">): FeatureFlagRuleRowInput {
  return {
    priority: 0,
    values: [],
    percentageBasisPoints: null,
    variant: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("computeFeatureFlagBucket golden vectors and cross-runtime SHA-256 parity", () => {
  it("matches all 83 committed golden vectors generated from the original node:crypto implementation", () => {
    expect(FEATURE_FLAG_BUCKET_GOLDEN_VECTORS.length).toBe(83);
    for (const vector of FEATURE_FLAG_BUCKET_GOLDEN_VECTORS) {
      expect(computeFeatureFlagBucket(vector)).toBe(vector.bucket);
      expect(nodeCryptoBucket(vector)).toBe(vector.bucket);
    }
  });

  it("matches node:crypto and Web Crypto subtle.digest bit-for-bit across 2,500 inputs and all padding boundaries", async () => {
    const units: Array<"user" | "server"> = ["server", "user"];
    const vectors: Array<{ key: string; salt: string; unit: "user" | "server"; unitId: string }> = [];

    // Cover every UTF-8 byte length around SHA-256 64-byte block and 55/56-byte length-field boundaries.
    for (let padLen = 0; padLen <= 256; padLen += 1) {
      vectors.push({
        key: "k",
        salt: "x".repeat(padLen),
        unit: padLen % 2 === 0 ? "server" : "user",
        unitId: "u",
      });
    }

    // Deterministic LCG sweep over UUIDs, salts, colons, CJK, and astral-plane UTF-8 code points.
    let state = 0x9e3779b9;
    const nextU32 = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    const specialSalts = [
      "",
      "a:b:c:d",
      "预发灰度-开关盐值",
      "rocket-🚀-🧪-salt",
      "6d4558cc-95eb-40cb-92cb-a7f7bf535e40",
    ];
    for (let i = 0; i < 2243; i += 1) {
      const a = nextU32().toString(16).padStart(8, "0");
      const b = nextU32().toString(16).padStart(8, "0");
      const c = nextU32().toString(16).padStart(8, "0");
      vectors.push({
        key: `flag_${i % 97}_v${i % 3}`,
        salt: i < specialSalts.length * 20
          ? `${specialSalts[i % specialSalts.length]}:${a}`
          : `salt-${b}`,
        unit: units[i % 2]!,
        unitId: `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-8${c.slice(1, 4)}-${a}${c.slice(0, 4)}`,
      });
    }

    expect(vectors.length).toBe(2500);
    for (const vector of vectors) {
      const shared = computeFeatureFlagBucket(vector);
      const nodeExpected = nodeCryptoBucket(vector);
      const subtleExpected = await webCryptoBucket(vector);
      expect(shared).toBe(nodeExpected);
      expect(shared).toBe(subtleExpected);
    }
  });
});

describe("compareFeatureFlagRules and sortFeatureFlagRulesForStage", () => {
  it("sorts deterministically by priority ASC, createdAt ASC, id ASC across all permutations", () => {
    const t = "2026-11-10T12:00:00.000Z";
    const rSmall = makeRule({
      id: "00000000-0000-4000-8000-00000000000a",
      stage: "server",
      priority: 0,
      decision: "allow",
      values: ["s1"],
      createdAt: new Date(t),
    });
    const rMid = makeRule({
      id: "00000000-0000-4000-8000-00000000000B", // uppercase hex normalized to lowercase `b`
      stage: "server",
      priority: 0,
      decision: "deny",
      values: ["s1"],
      createdAt: t,
    });
    const rLarge = makeRule({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      stage: "server",
      priority: 0,
      decision: "deny",
      values: ["s1"],
      createdAt: Date.parse(t),
    });

    const permutations = [
      [rSmall, rMid, rLarge],
      [rSmall, rLarge, rMid],
      [rMid, rSmall, rLarge],
      [rMid, rLarge, rSmall],
      [rLarge, rSmall, rMid],
      [rLarge, rMid, rSmall],
    ];

    for (const perm of permutations) {
      expect(sortFeatureFlagRulesForStage(perm, "server").map((r) => r.id)).toEqual([
        rSmall.id,
        rMid.id,
        rLarge.id,
      ]);
      const evaluated = evaluateFeatureFlagRow({
        flag: BASE_FLAG,
        rules: perm,
        input: { key: BASE_FLAG.key, serverId: "s1" },
        cohorts: readyCohorts(),
        defaultPolicy: DEFAULT_OFF_POLICY,
      });
      expect(evaluated).toEqual({
        key: BASE_FLAG.key,
        decision: "enabled",
        enabled: true,
        reason: "server_rule",
        matchedRule: { id: rSmall.id, stage: "server", priority: 0, decision: "allow" },
      });
    }

    expect(compareFeatureFlagRules(
      { id: rLarge.id, priority: -1, createdAt: "2026-12-01T00:00:00.000Z" },
      { id: rSmall.id, priority: 0, createdAt: "2026-01-01T00:00:00.000Z" },
    )).toBeLessThan(0);

    expect(compareFeatureFlagRules(
      { id: rLarge.id, priority: 0, createdAt: "2026-11-01T00:00:00.000Z" },
      { id: rSmall.id, priority: 0, createdAt: "2026-11-01T00:00:00.001Z" },
    )).toBeLessThan(0);
  });
});

describe("matchFeatureFlagPlanRule", () => {
  const postTrial = new Date("2026-11-15T00:00:00.000Z");
  const duringTrial = new Date("2026-05-01T00:00:00.000Z");

  it("matches exact plans and lets partner/founder/active-trial match pro allow rules, never pro deny rules", () => {
    const proAllow = [makeRule({ id: "00000000-0000-4000-8000-000000000001", stage: "plan", decision: "allow", values: ["pro"] })];
    expect(matchFeatureFlagPlanRule("f", proAllow, "pro", postTrial)?.enabled).toBe(true);
    expect(matchFeatureFlagPlanRule("f", proAllow, "partner", postTrial)?.enabled).toBe(true);
    expect(matchFeatureFlagPlanRule("f", proAllow, "founder", postTrial)?.enabled).toBe(true);
    expect(matchFeatureFlagPlanRule("f", proAllow, "free", postTrial)).toBeNull();
    expect(matchFeatureFlagPlanRule("f", proAllow, "free", duringTrial)?.enabled).toBe(true);

    const proDeny = [makeRule({ id: "00000000-0000-4000-8000-000000000002", stage: "plan", decision: "deny", values: ["pro"] })];
    expect(matchFeatureFlagPlanRule("f", proDeny, "pro", postTrial)?.enabled).toBe(false);
    expect(matchFeatureFlagPlanRule("f", proDeny, "partner", postTrial)).toBeNull();
    expect(matchFeatureFlagPlanRule("f", proDeny, "founder", postTrial)).toBeNull();
  });
});

describe("evaluateFeatureFlagRow and evaluatePreAuthFeatureFlagRow", () => {
  it("returns undetermined only when evaluation actually reaches an unavailable lab or plan stage", () => {
    const serverAllow = makeRule({
      id: "00000000-0000-4000-8000-000000000010",
      stage: "server",
      decision: "allow",
      values: ["srv-hit"],
    });
    const planAllow = makeRule({
      id: "00000000-0000-4000-8000-000000000020",
      stage: "plan",
      decision: "allow",
      values: ["pro"],
    });

    const previewCohorts = {
      matchingAudienceKeys: new Set<string>(),
      lab: { status: "ready" as const, effectiveLabKeys: new Set<string>() },
      plan: { status: "unavailable" as const, reason: "plan_preview_unavailable" as const },
    };

    // Earlier `server` stage hits -> definite enabled result, not undetermined.
    expect(evaluateFeatureFlagRow({
      flag: BASE_FLAG,
      rules: [serverAllow, planAllow],
      input: { key: BASE_FLAG.key, serverId: "srv-hit" },
      cohorts: previewCohorts,
      defaultPolicy: DEFAULT_OFF_POLICY,
    })).toEqual({
      key: BASE_FLAG.key,
      decision: "enabled",
      enabled: true,
      reason: "server_rule",
      matchedRule: { id: serverAllow.id, stage: "server", priority: 0, decision: "allow" },
    });

    // Server rule misses -> reaches `plan` stage -> returns undetermined `plan_preview_unavailable`.
    expect(evaluateFeatureFlagRow({
      flag: BASE_FLAG,
      rules: [serverAllow, planAllow],
      input: { key: BASE_FLAG.key, serverId: "srv-other" },
      cohorts: previewCohorts,
      defaultPolicy: DEFAULT_OFF_POLICY,
    })).toEqual({
      key: BASE_FLAG.key,
      decision: "undetermined",
      enabled: false,
      reason: "plan_preview_unavailable",
      matchedRule: null,
    });
  });

  it("evaluates preAuth platform rules and staging default-on fallback identically", () => {
    const markedFlag = { ...BASE_FLAG, preAuthEvaluable: true };
    const denyLaterId = makeRule({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      stage: "platform",
      decision: "deny",
      values: ["mobile"],
    });
    const allowSmallerId = makeRule({
      id: "00000000-0000-4000-8000-000000000001",
      stage: "platform",
      decision: "allow",
      values: ["mobile"],
    });

    expect(evaluatePreAuthFeatureFlagRow({
      key: markedFlag.key,
      flag: markedFlag,
      platformRules: [denyLaterId, allowSmallerId],
      platform: "mobile",
      defaultPolicy: DEFAULT_OFF_POLICY,
    })).toEqual({
      key: markedFlag.key,
      decision: "enabled",
      enabled: true,
      reason: "platform_rule",
      matchedRule: { id: allowSmallerId.id, stage: "platform", priority: 0, decision: "allow" },
    });

    expect(evaluatePreAuthFeatureFlagRow({
      key: markedFlag.key,
      flag: markedFlag,
      platformRules: [denyLaterId, allowSmallerId],
      platform: "web",
      defaultPolicy: STAGING_DEFAULT_ON_POLICY,
    })).toEqual({
      key: markedFlag.key,
      decision: "enabled",
      enabled: true,
      reason: "default",
      fallback: { enabled: true, source: "default_on" },
      matchedRule: null,
    });
  });
});
