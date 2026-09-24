import assert from "node:assert/strict";
import test from "node:test";
import {
  FEATURE_FLAG_ROLLOUT_GUARDRAIL_ISSUER,
  FEATURE_FLAG_ROLLOUT_GUARDRAIL_POLICY_VERSION,
  FEATURE_FLAG_ROLLOUT_GUARDRAIL_SCHEMA,
  classifyFeatureFlagRollout,
  decideFeatureFlagRolloutGuardrail,
  type FeatureFlagRolloutGuardrailDependencies,
  type FeatureFlagRolloutGuardrailReceiptV1,
  type FeatureFlagRolloutRuleInput,
  type FeatureFlagRolloutStateInput,
  type FeatureFlagRolloutWideningOperation,
} from "./featureFlagRolloutGuardrail.js";

const NOW = Date.parse("2026-07-10T14:00:00.000Z");
const RECEIPT_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_RECEIPT_ID = "00000000-0000-4000-8000-000000000002";
const SERVER_1 = "10000000-0000-4000-8000-000000000001";
const SERVER_2 = "10000000-0000-4000-8000-000000000002";
const SERVER_3 = "10000000-0000-4000-8000-000000000003";
const SERVER_RULE_ID = "20000000-0000-4000-8000-000000000001";
const PERCENTAGE_RULE_ID = "30000000-0000-4000-8000-000000000001";

function serverRule(overrides: Partial<FeatureFlagRolloutRuleInput> = {}): FeatureFlagRolloutRuleInput {
  return {
    id: SERVER_RULE_ID,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [SERVER_1],
    percentageBasisPoints: null,
    variant: null,
    ...overrides,
  };
}

function percentageRule(overrides: Partial<FeatureFlagRolloutRuleInput> = {}): FeatureFlagRolloutRuleInput {
  return {
    id: PERCENTAGE_RULE_ID,
    stage: "percentage",
    priority: 0,
    decision: "allow",
    values: [],
    percentageBasisPoints: 1_000,
    variant: null,
    ...overrides,
  };
}

function state(overrides: Partial<FeatureFlagRolloutStateInput> = {}): FeatureFlagRolloutStateInput {
  return {
    controlPlaneId: "production",
    flagKey: "message_forwarding_v0",
    configVersion: 41,
    killSwitch: false,
    rules: [serverRule(), percentageRule()],
    ...overrides,
  };
}

function receipt(
  operation: FeatureFlagRolloutWideningOperation,
  overrides: Partial<FeatureFlagRolloutGuardrailReceiptV1> = {},
): FeatureFlagRolloutGuardrailReceiptV1 {
  return {
    schema: FEATURE_FLAG_ROLLOUT_GUARDRAIL_SCHEMA,
    id: RECEIPT_ID,
    verdict: "pass",
    issuer: FEATURE_FLAG_ROLLOUT_GUARDRAIL_ISSUER,
    controlPlaneId: "production",
    flagKey: "message_forwarding_v0",
    configVersion: 41,
    operation,
    policyVersion: FEATURE_FLAG_ROLLOUT_GUARDRAIL_POLICY_VERSION,
    evaluatedAt: "2026-07-10T13:58:00.000Z",
    expiresAt: "2026-07-10T14:03:00.000Z",
    ...overrides,
  };
}

function dependencies(storedReceipt: unknown, overrides: Partial<FeatureFlagRolloutGuardrailDependencies> = {}) {
  let loads = 0;
  let clockReads = 0;
  const deps: FeatureFlagRolloutGuardrailDependencies = {
    async loadTrustedReceipt(receiptId) {
      loads += 1;
      assert.equal(receiptId, RECEIPT_ID);
      return storedReceipt;
    },
    nowMs() {
      clockReads += 1;
      return NOW;
    },
    ...overrides,
  };
  return { deps, calls: () => ({ loads, clockReads }) };
}

test("code-owned raw-rule classification distinguishes widening, narrowing, and no-op", () => {
  const current = state();
  assert.deepEqual(classifyFeatureFlagRollout(current, {
    kind: "server_allowlist_set",
    flagKey: current.flagKey,
    expectedConfigVersion: current.configVersion,
    serverId: SERVER_2,
    desired: "present",
  }), {
    kind: "widening",
    controlPlaneId: current.controlPlaneId,
    flagKey: current.flagKey,
    configVersion: current.configVersion,
    operation: { kind: "server_allowlist_add", ruleId: SERVER_RULE_ID, serverId: SERVER_2 },
  });
  assert.deepEqual(classifyFeatureFlagRollout(current, {
    kind: "server_allowlist_set",
    flagKey: current.flagKey,
    expectedConfigVersion: 0,
    serverId: SERVER_1,
    desired: "absent",
  }), {
    kind: "narrowing",
    operation: { kind: "server_allowlist_remove", ruleId: SERVER_RULE_ID, serverId: SERVER_1 },
  }, "stale expected version must not block narrowing");
  assert.deepEqual(classifyFeatureFlagRollout(current, {
    kind: "server_allowlist_set",
    flagKey: current.flagKey,
    serverId: SERVER_1,
    desired: "present",
  }), { kind: "no_op" });

  assert.deepEqual(classifyFeatureFlagRollout(current, {
    kind: "percentage_set",
    flagKey: current.flagKey,
    expectedConfigVersion: current.configVersion,
    desiredBasisPoints: 2_000,
  }), {
    kind: "widening",
    controlPlaneId: current.controlPlaneId,
    flagKey: current.flagKey,
    configVersion: current.configVersion,
    operation: {
      kind: "percentage_increase",
      ruleId: PERCENTAGE_RULE_ID,
      fromBasisPoints: 1_000,
      toBasisPoints: 2_000,
    },
  });
  assert.deepEqual(classifyFeatureFlagRollout(current, {
    kind: "percentage_set",
    flagKey: current.flagKey,
    expectedConfigVersion: 0,
    desiredBasisPoints: 500,
  }), {
    kind: "narrowing",
    operation: {
      kind: "percentage_decrease",
      ruleId: PERCENTAGE_RULE_ID,
      fromBasisPoints: 1_000,
      toBasisPoints: 500,
    },
  }, "stale expected version must not block percentage reduction");
});

test("absent canonical rules produce explicit create plans", () => {
  const noServerRule = state({ rules: [percentageRule()] });
  assert.deepEqual(classifyFeatureFlagRollout(noServerRule, {
    kind: "server_allowlist_set",
    flagKey: noServerRule.flagKey,
    expectedConfigVersion: noServerRule.configVersion,
    serverId: SERVER_2,
    desired: "present",
  }), {
    kind: "widening",
    controlPlaneId: noServerRule.controlPlaneId,
    flagKey: noServerRule.flagKey,
    configVersion: noServerRule.configVersion,
    operation: { kind: "server_allowlist_add", ruleId: null, serverId: SERVER_2 },
  });

  const noPercentageRule = state({ rules: [serverRule()] });
  assert.deepEqual(classifyFeatureFlagRollout(noPercentageRule, {
    kind: "percentage_set",
    flagKey: noPercentageRule.flagKey,
    expectedConfigVersion: noPercentageRule.configVersion,
    desiredBasisPoints: 500,
  }), {
    kind: "widening",
    controlPlaneId: noPercentageRule.controlPlaneId,
    flagKey: noPercentageRule.flagKey,
    configVersion: noPercentageRule.configVersion,
    operation: {
      kind: "percentage_increase",
      ruleId: null,
      fromBasisPoints: 0,
      toBasisPoints: 500,
    },
  });
});

test("kill activation remains available with no/stale version while unkill is guarded", () => {
  assert.deepEqual(classifyFeatureFlagRollout(state(), {
    kind: "kill_switch_set",
    flagKey: "message_forwarding_v0",
    desired: true,
  }), { kind: "narrowing", operation: { kind: "kill_switch_enable" } });
  assert.deepEqual(classifyFeatureFlagRollout(state(), {
    kind: "kill_switch_set",
    flagKey: "message_forwarding_v0",
    expectedConfigVersion: 0,
    desired: true,
  }), { kind: "narrowing", operation: { kind: "kill_switch_enable" } });
  assert.deepEqual(classifyFeatureFlagRollout(state({ killSwitch: true }), {
    kind: "kill_switch_set",
    flagKey: "message_forwarding_v0",
    desired: false,
  }), { kind: "blocked", reason: "config_version_required" });
  assert.deepEqual(classifyFeatureFlagRollout(state({ killSwitch: true }), {
    kind: "kill_switch_set",
    flagKey: "message_forwarding_v0",
    expectedConfigVersion: 41,
    desired: false,
  }), {
    kind: "widening",
    controlPlaneId: "production",
    flagKey: "message_forwarding_v0",
    configVersion: 41,
    operation: { kind: "kill_switch_disable" },
  });
});

test("malformed runtime state and intent fail closed without throwing", () => {
  assert.deepEqual(classifyFeatureFlagRollout(null, {}), { kind: "blocked", reason: "invalid_state" });
  assert.deepEqual(classifyFeatureFlagRollout({ ...state(), rules: null }, {
    kind: "kill_switch_set",
    flagKey: "message_forwarding_v0",
    desired: true,
  }), { kind: "narrowing", operation: { kind: "kill_switch_enable" } });
  assert.deepEqual(classifyFeatureFlagRollout({ ...state(), rules: null }, {
    kind: "server_allowlist_set",
    flagKey: "message_forwarding_v0",
    expectedConfigVersion: 41,
    serverId: SERVER_2,
    desired: "present",
  }), { kind: "blocked", reason: "invalid_state" });
  assert.deepEqual(classifyFeatureFlagRollout({ ...state({ killSwitch: true }), rules: null }, {
    kind: "kill_switch_set",
    flagKey: "message_forwarding_v0",
    expectedConfigVersion: 41,
    desired: false,
  }), { kind: "blocked", reason: "invalid_state" }, "unkill must not reactivate an unavailable rule snapshot");
  assert.deepEqual(classifyFeatureFlagRollout(state(), {
    kind: "kill_switch_set",
    flagKey: "message_forwarding_v0",
    desired: "false",
  }), { kind: "blocked", reason: "invalid_intent" });
  assert.deepEqual(classifyFeatureFlagRollout(state(), {
    kind: "caller_declared_safe",
    flagKey: "message_forwarding_v0",
  }), { kind: "blocked", reason: "invalid_intent" });
  assert.deepEqual(classifyFeatureFlagRollout(state(), {
    kind: "kill_switch_set",
    flagKey: "message_forwarding_v0",
    desired: true,
    safe: true,
  }), { kind: "blocked", reason: "invalid_intent" });
});

test("duplicate or noncanonical relevant rules fail closed, but kill remains available", () => {
  const duplicateServer = state({
    rules: [serverRule(), serverRule({ id: "20000000-0000-4000-8000-000000000002", values: [SERVER_2] })],
  });
  assert.deepEqual(classifyFeatureFlagRollout(duplicateServer, {
    kind: "server_allowlist_set",
    flagKey: duplicateServer.flagKey,
    serverId: SERVER_1,
    desired: "absent",
  }), { kind: "blocked", reason: "unsupported_server_allowlist_shape" });

  const denyPercentage = state({ rules: [percentageRule({ decision: "deny" })] });
  assert.deepEqual(classifyFeatureFlagRollout(denyPercentage, {
    kind: "percentage_set",
    flagKey: denyPercentage.flagKey,
    desiredBasisPoints: 0,
  }), { kind: "blocked", reason: "unsupported_percentage_shape" });
  assert.deepEqual(classifyFeatureFlagRollout(duplicateServer, {
    kind: "kill_switch_set",
    flagKey: duplicateServer.flagKey,
    desired: true,
  }), { kind: "narrowing", operation: { kind: "kill_switch_enable" } });
  const malformedRules = { ...state(), rules: [{ stage: "server", values: "corrupt" }] };
  assert.deepEqual(classifyFeatureFlagRollout(malformedRules, {
    kind: "kill_switch_set",
    flagKey: malformedRules.flagKey,
    desired: true,
  }), {
    kind: "narrowing",
    operation: { kind: "kill_switch_enable" },
  }, "emergency kill must not parse unrelated rule payloads");
  assert.deepEqual(classifyFeatureFlagRollout(malformedRules, {
    kind: "server_allowlist_set",
    flagKey: malformedRules.flagKey,
    serverId: SERVER_1,
    desired: "absent",
  }), { kind: "blocked", reason: "unsupported_server_allowlist_shape" });
  assert.deepEqual(classifyFeatureFlagRollout({ ...malformedRules, killSwitch: true }, {
    kind: "kill_switch_set",
    flagKey: malformedRules.flagKey,
    expectedConfigVersion: malformedRules.configVersion,
    desired: false,
  }), { kind: "blocked", reason: "invalid_state" }, "unkill must fail closed on malformed rule payloads");
});

test("platform rules remain valid but do not change server rollout classification", () => {
  const current = state({
    rules: [
      serverRule(),
      percentageRule(),
      {
        ...serverRule({ id: "20000000-0000-4000-8000-000000000099" }),
        stage: "platform",
        values: ["mobile"],
        decision: "deny",
      },
    ],
  });

  assert.deepEqual(classifyFeatureFlagRollout(current, {
    kind: "server_allowlist_set",
    flagKey: current.flagKey,
    expectedConfigVersion: current.configVersion,
    serverId: SERVER_2,
    desired: "present",
  }), {
    kind: "widening",
    controlPlaneId: current.controlPlaneId,
    flagKey: current.flagKey,
    configVersion: current.configVersion,
    operation: { kind: "server_allowlist_add", ruleId: SERVER_RULE_ID, serverId: SERVER_2 },
  });
});

test("lab rules remain valid but cannot masquerade as server or percentage rollout", () => {
  const current = state({
    rules: [
      serverRule(),
      percentageRule(),
      {
        ...serverRule({ id: "20000000-0000-4000-8000-000000000098" }),
        stage: "lab",
        values: ["composer_lab"],
        decision: "allow",
      },
    ],
  });

  assert.deepEqual(classifyFeatureFlagRollout(current, {
    kind: "server_allowlist_set",
    flagKey: current.flagKey,
    expectedConfigVersion: current.configVersion,
    serverId: SERVER_2,
    desired: "present",
  }), {
    kind: "widening",
    controlPlaneId: current.controlPlaneId,
    flagKey: current.flagKey,
    configVersion: current.configVersion,
    operation: { kind: "server_allowlist_add", ruleId: SERVER_RULE_ID, serverId: SERVER_2 },
  });

  assert.deepEqual(classifyFeatureFlagRollout(current, {
    kind: "percentage_set",
    flagKey: current.flagKey,
    expectedConfigVersion: current.configVersion,
    desiredBasisPoints: 2_000,
  }), {
    kind: "widening",
    controlPlaneId: current.controlPlaneId,
    flagKey: current.flagKey,
    configVersion: current.configVersion,
    operation: {
      kind: "percentage_increase",
      ruleId: PERCENTAGE_RULE_ID,
      fromBasisPoints: 1_000,
      toBasisPoints: 2_000,
    },
  });
});

test("persisted rule metadata is accepted only for the locked flag", () => {
  const realShapedState = {
    ...state(),
    rules: [
      {
        ...serverRule(),
        flagKey: "message_forwarding_v0",
        createdAt: new Date("2026-07-10T13:00:00.000Z"),
        updatedAt: new Date("2026-07-10T13:30:00.000Z"),
      },
      {
        ...percentageRule(),
        flagKey: "message_forwarding_v0",
        createdAt: new Date("2026-07-10T13:00:00.000Z"),
        updatedAt: new Date("2026-07-10T13:30:00.000Z"),
      },
    ],
  };
  assert.deepEqual(classifyFeatureFlagRollout(realShapedState, {
    kind: "server_allowlist_set",
    flagKey: realShapedState.flagKey,
    serverId: SERVER_1,
    desired: "absent",
  }), {
    kind: "narrowing",
    operation: { kind: "server_allowlist_remove", ruleId: SERVER_RULE_ID, serverId: SERVER_1 },
  });

  const crossFlagState = {
    ...realShapedState,
    rules: [{ ...realShapedState.rules[0], flagKey: "community_onboarding_wizard_v0" }],
  };
  assert.deepEqual(classifyFeatureFlagRollout(crossFlagState, {
    kind: "server_allowlist_set",
    flagKey: crossFlagState.flagKey,
    serverId: SERVER_1,
    desired: "absent",
  }), { kind: "blocked", reason: "unsupported_server_allowlist_shape" });
});

test("safe decisions do not touch receipt storage or clock", async () => {
  const { deps, calls } = dependencies({ forged: true }, {
    loadTrustedReceipt: async () => {
      throw new Error("safe path queried receipt storage");
    },
    nowMs: () => {
      throw new Error("safe path read clock");
    },
  });
  assert.deepEqual(await decideFeatureFlagRolloutGuardrail(state(), {
    kind: "kill_switch_set",
    flagKey: "message_forwarding_v0",
    expectedConfigVersion: 0,
    desired: true,
  }, { client: "object" }, deps), {
    allowed: true,
    reason: "narrowing",
    operation: { kind: "kill_switch_enable" },
  });
  assert.deepEqual(calls(), { loads: 0, clockReads: 0 });
});

test("widening requires current version before consulting the provider", async () => {
  const current = state();
  const { deps, calls } = dependencies(null);
  assert.deepEqual(await decideFeatureFlagRolloutGuardrail(current, {
    kind: "server_allowlist_set",
    flagKey: current.flagKey,
    serverId: SERVER_2,
    desired: "present",
  }, RECEIPT_ID, deps), { allowed: false, reason: "config_version_required" });
  assert.deepEqual(await decideFeatureFlagRolloutGuardrail(current, {
    kind: "server_allowlist_set",
    flagKey: current.flagKey,
    expectedConfigVersion: 40,
    serverId: SERVER_2,
    desired: "present",
  }, RECEIPT_ID, deps), { allowed: false, reason: "config_version_mismatch" });
  const movedBelowDesired = state({
    configVersion: 42,
    rules: [serverRule(), percentageRule({ percentageBasisPoints: 500 })],
  });
  assert.deepEqual(classifyFeatureFlagRollout(movedBelowDesired, {
    kind: "percentage_set",
    flagKey: movedBelowDesired.flagKey,
    expectedConfigVersion: 41,
    desiredBasisPoints: 1_000,
  }), { kind: "blocked", reason: "config_version_mismatch" }, "direction must be recomputed from current locked state");
  assert.deepEqual(calls(), { loads: 0, clockReads: 0 });
});

test("trusted provider records fail closed on missing, failed, stale, and mismatched evidence", async () => {
  const current = state();
  const intent = {
    kind: "server_allowlist_set",
    flagKey: current.flagKey,
    expectedConfigVersion: current.configVersion,
    serverId: SERVER_2,
    desired: "present",
  } as const;
  const operation = { kind: "server_allowlist_add", ruleId: SERVER_RULE_ID, serverId: SERVER_2 } as const;

  assert.deepEqual(await decideFeatureFlagRolloutGuardrail(current, intent, null, dependencies(null).deps), {
    allowed: false,
    reason: "receipt_missing",
  });
  assert.deepEqual(await decideFeatureFlagRolloutGuardrail(current, intent, RECEIPT_ID, dependencies(null).deps), {
    allowed: false,
    reason: "receipt_missing",
  });
  assert.deepEqual(await decideFeatureFlagRolloutGuardrail(current, intent, RECEIPT_ID, dependencies(receipt(operation, { verdict: "fail" })).deps), {
    allowed: false,
    reason: "receipt_failed",
  });
  assert.deepEqual(await decideFeatureFlagRolloutGuardrail(current, intent, RECEIPT_ID, dependencies(receipt(operation, {
    evaluatedAt: "2026-07-10T13:50:00.000Z",
    expiresAt: "2026-07-10T13:55:00.000Z",
  })).deps), { allowed: false, reason: "receipt_stale" });
  assert.deepEqual(await decideFeatureFlagRolloutGuardrail(current, intent, RECEIPT_ID, dependencies(receipt(operation, {
    evaluatedAt: "2026-07-10T13:50:00.000Z",
    expiresAt: "2026-07-10T13:56:00.000Z",
  })).deps), { allowed: false, reason: "receipt_invalid" }, "issuer cannot extend the fixed five-minute policy");
  assert.deepEqual(await decideFeatureFlagRolloutGuardrail(current, intent, RECEIPT_ID, dependencies(receipt(operation, {
    controlPlaneId: "staging",
  })).deps), { allowed: false, reason: "receipt_mismatch" });
  assert.deepEqual(await decideFeatureFlagRolloutGuardrail(current, intent, RECEIPT_ID, dependencies(receipt({
    kind: "server_allowlist_add",
    ruleId: SERVER_RULE_ID,
    serverId: SERVER_3,
  })).deps), { allowed: false, reason: "receipt_mismatch" });
});

test("fresh exact provider receipt passes and expiry is exclusive", async () => {
  const current = state();
  const intent = {
    kind: "percentage_set",
    flagKey: current.flagKey,
    expectedConfigVersion: current.configVersion,
    desiredBasisPoints: 2_000,
  } as const;
  const operation = {
    kind: "percentage_increase",
    ruleId: PERCENTAGE_RULE_ID,
    fromBasisPoints: 1_000,
    toBasisPoints: 2_000,
  } as const;

  assert.deepEqual(await decideFeatureFlagRolloutGuardrail(
    current,
    intent,
    RECEIPT_ID,
    dependencies(receipt(operation)).deps,
  ), {
    allowed: true,
    reason: "guardrail_passed",
    receiptId: RECEIPT_ID,
    operation,
  });

  assert.deepEqual(await decideFeatureFlagRolloutGuardrail(
    current,
    intent,
    RECEIPT_ID,
    dependencies(receipt(operation), { nowMs: () => Date.parse("2026-07-10T14:03:00.000Z") }).deps,
  ), { allowed: false, reason: "receipt_stale" });

  assert.deepEqual(await decideFeatureFlagRolloutGuardrail(
    current,
    intent,
    RECEIPT_ID,
    dependencies(receipt(operation, { id: OTHER_RECEIPT_ID })).deps,
  ), { allowed: false, reason: "receipt_mismatch" });
});

test("provider failure and syntactically client-like objects cannot supply executable trust", async () => {
  const current = state({ killSwitch: true });
  const intent = {
    kind: "kill_switch_set",
    flagKey: current.flagKey,
    expectedConfigVersion: current.configVersion,
    desired: false,
  } as const;
  assert.deepEqual(await decideFeatureFlagRolloutGuardrail(current, intent, RECEIPT_ID, {
    async loadTrustedReceipt() {
      throw new Error("control plane unavailable");
    },
    nowMs: () => NOW,
  }), { allowed: false, reason: "receipt_unavailable" });
  assert.deepEqual(await decideFeatureFlagRolloutGuardrail(current, intent, RECEIPT_ID, {
    loadTrustedReceipt: receipt({ kind: "kill_switch_disable" }),
    nowMs: NOW,
  } as unknown as FeatureFlagRolloutGuardrailDependencies), { allowed: false, reason: "receipt_invalid" });
});
