import assert from "node:assert/strict";
import { test } from "vitest";
import {
  SLACK_BRIDGE_FEATURE_FLAG_KEYS,
  type SlackBridgeFeatureFlagKey,
} from "@botiverse/raft-shared";
import type { DatabaseExecutor } from "../db/index.js";
import type { ExternalBindingAuthorityDecision } from "./externalAppControlPlaneService.js";
import {
  SLACK_BRIDGE_ORACLE_RECEIPT_SCHEMA,
  SLACK_BRIDGE_RELEASE_CONTRACT_REVISION,
  resolveSlackBridgeBindingActive,
  type SlackBridgeAppMembershipDecision,
  type SlackBridgeReleaseOracleDecision,
  type SlackBridgeRuntimeDependencies,
  type SlackBridgeRuntimeLevel,
} from "./slackBridgeRuntimeService.js";

type ActiveAuthorityFact = Extract<ExternalBindingAuthorityDecision, { active: true }>["fact"];

const NOW = new Date("2026-07-24T14:30:00.000Z");
const LATER = new Date("2026-07-24T15:30:00.000Z");
const EXECUTOR = {} as DatabaseExecutor;

function authorityFact(
  overrides: Partial<ActiveAuthorityFact> = {},
): ActiveAuthorityFact {
  return {
    provider: "slack",
    environment: "test",
    registrationId: "registration-1",
    serverId: "server-1",
    serverGrantId: "grant-1",
    grantEpoch: 2,
    installId: "install-1",
    providerAppId: "app-1",
    connectionEpoch: 3,
    scopeRevision: 4,
    credentialRevision: 5,
    bindingId: "binding-1",
    bindingEpoch: 5,
    privacyClass: "public",
    channelId: "channel-1",
    providerAuthorityId: "team-1",
    providerConversationId: "conversation-1",
    installGrantReceiptRevision: 6,
    audienceRevision: null,
    ...overrides,
  };
}

function membershipDecision(
  authority: ActiveAuthorityFact,
  overrides: Partial<Extract<SlackBridgeAppMembershipDecision, { active: true }>["fact"]> = {},
): SlackBridgeAppMembershipDecision {
  return {
    active: true,
    fact: {
      registrationId: authority.registrationId,
      installId: authority.installId,
      bindingId: authority.bindingId,
      connectionEpoch: authority.connectionEpoch,
      bindingEpoch: authority.bindingEpoch,
      providerAuthorityId: authority.providerAuthorityId,
      providerConversationId: authority.providerConversationId,
      receiptRevision: 7,
      expiresAt: LATER,
      ...overrides,
    },
  };
}

function oracleDecision(
  authority: ActiveAuthorityFact,
  level: SlackBridgeRuntimeLevel,
  overrides: Partial<Extract<SlackBridgeReleaseOracleDecision, { active: true }>["fact"]> = {},
): SlackBridgeReleaseOracleDecision {
  return {
    active: true,
    fact: {
      bindingId: authority.bindingId,
      connectionEpoch: authority.connectionEpoch,
      bindingEpoch: authority.bindingEpoch,
      privacyClass: authority.privacyClass,
      level,
      releaseContractRevision: SLACK_BRIDGE_RELEASE_CONTRACT_REVISION,
      oracleReceiptSchema: SLACK_BRIDGE_ORACLE_RECEIPT_SCHEMA,
      oracleReceiptRevision: 8,
      inboundGreen: true,
      outboundGreen: true,
      expiresAt: LATER,
      ...overrides,
    },
  };
}

function dependencies(input: {
  authority?: ExternalBindingAuthorityDecision;
  flagConfigVersion?: number;
  disabledFlags?: SlackBridgeFeatureFlagKey[];
  evaluations?: Array<{ key: string; enabled: boolean; reason: "default" }>;
  membership?: SlackBridgeAppMembershipDecision;
  oracle?: SlackBridgeReleaseOracleDecision;
  observedFlagKeys?: SlackBridgeFeatureFlagKey[];
  observedExecutors?: DatabaseExecutor[];
} = {}): SlackBridgeRuntimeDependencies {
  const authority = input.authority ?? { active: true, fact: authorityFact() };
  const activeFact = authority.active ? authority.fact : authorityFact();
  return {
    async withReadSnapshot(fn) {
      return fn(EXECUTOR);
    },
    async resolveBindingAuthority(_request, executor) {
      input.observedExecutors?.push(executor);
      return authority;
    },
    async evaluateFlags(requests, executor) {
      input.observedExecutors?.push(executor);
      input.observedFlagKeys?.push(...requests.map(({ key }) => key));
      return input.evaluations ?? requests.map(({ key }) => ({
        key,
        enabled: !(input.disabledFlags ?? []).includes(key),
        reason: "default" as const,
      }));
    },
    async getFlagConfigVersion(executor) {
      input.observedExecutors?.push(executor);
      return input.flagConfigVersion ?? 11;
    },
    async resolveAppMembership(_authority, executor) {
      input.observedExecutors?.push(executor);
      return input.membership ?? membershipDecision(activeFact);
    },
    async resolveReleaseOracle(request, executor) {
      input.observedExecutors?.push(executor);
      return input.oracle ?? oracleDecision(activeFact, request.level);
    },
  };
}

function request(
  overrides: Partial<Parameters<typeof resolveSlackBridgeBindingActive>[0]> = {},
): Parameters<typeof resolveSlackBridgeBindingActive>[0] {
  return {
    serverId: "server-1",
    bindingId: "binding-1",
    expectedConnectionEpoch: 3,
    expectedBindingEpoch: 5,
    level: "top_level",
    now: NOW,
    ...overrides,
  };
}

test("public top-level active derives the master gate plus runtime fuses and excludes admission-only binding flag", async () => {
  const observedFlagKeys: SlackBridgeFeatureFlagKey[] = [];
  const observedExecutors: DatabaseExecutor[] = [];
  const result = await resolveSlackBridgeBindingActive(
    request(),
    dependencies({ observedFlagKeys, observedExecutors }),
  );

  assert.equal(result.active, true);
  if (!result.active) assert.fail("expected active runtime predicate");
  assert.equal(result.fact.privacyClass, "public");
  assert.equal(result.fact.level, "top_level");
  assert.equal(result.fact.featureFlagConfigVersion, 11);
  assert.equal(result.fact.runtimePredicateRevision.length, 64);
  assert.equal(observedFlagKeys.includes(SLACK_BRIDGE_FEATURE_FLAG_KEYS.binding), false);
  assert.equal(observedFlagKeys.includes(SLACK_BRIDGE_FEATURE_FLAG_KEYS.privateBinding), false);
  assert.equal(observedFlagKeys.includes(SLACK_BRIDGE_FEATURE_FLAG_KEYS.threadDelivery), false);
  assert.deepEqual(observedFlagKeys, [
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.directory,
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.customAuthorship,
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.eventIngress,
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.inboundProjection,
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.nativeMention,
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.enqueue,
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.dispatch,
  ]);
  assert.ok(observedExecutors.length >= 5);
  assert.ok(observedExecutors.every((executor) => executor === EXECUTOR));
});

test("master launch gate disables every runtime level before provider authority can advance", async () => {
  for (const level of ["top_level", "thread"] as const) {
    const result = await resolveSlackBridgeBindingActive(
      request({ level }),
      dependencies({ disabledFlags: [SLACK_BRIDGE_FEATURE_FLAG_KEYS.master] }),
    );
    assert.deepEqual(result, {
      active: false,
      reason: "feature_flag_disabled",
      disabledFlagKey: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    });
  }
});

test("private thread derives immutable private/thread additions without a caller privacy input", async () => {
  const authority = authorityFact({
    privacyClass: "private",
    audienceRevision: 9,
  });
  const observedFlagKeys: SlackBridgeFeatureFlagKey[] = [];
  const result = await resolveSlackBridgeBindingActive(
    request({ level: "thread" }),
    dependencies({
      authority: { active: true, fact: authority },
      observedFlagKeys,
    }),
  );

  assert.equal(result.active, true);
  if (!result.active) assert.fail("expected private thread active");
  assert.equal(result.fact.privacyClass, "private");
  assert.equal(result.fact.bindingAuthority.audienceRevision, 9);
  assert.ok(observedFlagKeys.includes(SLACK_BRIDGE_FEATURE_FLAG_KEYS.privateBinding));
  assert.ok(observedFlagKeys.includes(SLACK_BRIDGE_FEATURE_FLAG_KEYS.threadDelivery));
  assert.equal(observedFlagKeys.includes(SLACK_BRIDGE_FEATURE_FLAG_KEYS.binding), false);
});

test("private and thread fuse-down isolates only the applicable surface", async () => {
  const privateAuthority = authorityFact({ privacyClass: "private", audienceRevision: 9 });
  const privateOff = await resolveSlackBridgeBindingActive(
    request(),
    dependencies({
      authority: { active: true, fact: privateAuthority },
      disabledFlags: [SLACK_BRIDGE_FEATURE_FLAG_KEYS.privateBinding],
    }),
  );
  assert.deepEqual(privateOff, {
    active: false,
    reason: "feature_flag_disabled",
    disabledFlagKey: SLACK_BRIDGE_FEATURE_FLAG_KEYS.privateBinding,
  });

  const publicTopLevel = await resolveSlackBridgeBindingActive(
    request(),
    dependencies({
      disabledFlags: [
        SLACK_BRIDGE_FEATURE_FLAG_KEYS.privateBinding,
        SLACK_BRIDGE_FEATURE_FLAG_KEYS.threadDelivery,
        SLACK_BRIDGE_FEATURE_FLAG_KEYS.binding,
      ],
    }),
  );
  assert.equal(publicTopLevel.active, true);

  const publicThread = await resolveSlackBridgeBindingActive(
    request({ level: "thread" }),
    dependencies({
      disabledFlags: [SLACK_BRIDGE_FEATURE_FLAG_KEYS.threadDelivery],
    }),
  );
  assert.deepEqual(publicThread, {
    active: false,
    reason: "feature_flag_disabled",
    disabledFlagKey: SLACK_BRIDGE_FEATURE_FLAG_KEYS.threadDelivery,
  });
});

test("missing or duplicate feature evaluations fail closed", async () => {
  for (const flagConfigVersion of [0, -1, Number.NaN, 1.5]) {
    const invalidVersion = await resolveSlackBridgeBindingActive(
      request(),
      dependencies({ flagConfigVersion }),
    );
    assert.deepEqual(invalidVersion, {
      active: false,
      reason: "feature_flag_snapshot_invalid",
    });
  }

  const missing = await resolveSlackBridgeBindingActive(
    request(),
    dependencies({ evaluations: [] }),
  );
  assert.deepEqual(missing, { active: false, reason: "feature_flag_snapshot_invalid" });

  const duplicate = await resolveSlackBridgeBindingActive(
    request(),
    dependencies({
      evaluations: [
        { key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.directory, enabled: true, reason: "default" },
        { key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.directory, enabled: true, reason: "default" },
      ],
    }),
  );
  assert.deepEqual(duplicate, { active: false, reason: "feature_flag_snapshot_invalid" });
});

test("membership freshness and exact carrier coordinates fail closed", async () => {
  const authority = authorityFact();
  const unavailable = await resolveSlackBridgeBindingActive(
    request(),
    dependencies({
      authority: { active: true, fact: authority },
      membership: { active: false, reason: "absent" },
    }),
  );
  assert.deepEqual(unavailable, { active: false, reason: "app_membership_unavailable" });

  const stale = await resolveSlackBridgeBindingActive(
    request(),
    dependencies({
      authority: { active: true, fact: authority },
      membership: membershipDecision(authority, { expiresAt: NOW }),
    }),
  );
  assert.deepEqual(stale, { active: false, reason: "app_membership_stale" });

  for (const membership of [
    membershipDecision(authority, { bindingId: "binding-other" }),
    membershipDecision(authority, { bindingEpoch: authority.bindingEpoch + 1 }),
    membershipDecision(authority, { connectionEpoch: authority.connectionEpoch + 1 }),
    membershipDecision(authority, { providerConversationId: "conversation-other" }),
    membershipDecision(authority, { receiptRevision: 1.5 }),
  ]) {
    const mismatch = await resolveSlackBridgeBindingActive(
      request(),
      dependencies({
        authority: { active: true, fact: authority },
        membership,
      }),
    );
    assert.deepEqual(mismatch, { active: false, reason: "app_membership_mismatch" });
  }
});

test("release Oracle must be fresh, same-carrier, exact-contract, and GREEN both ways", async () => {
  const authority = authorityFact();
  const notGreen = await resolveSlackBridgeBindingActive(
    request(),
    dependencies({ oracle: { active: false, reason: "not_green" } }),
  );
  assert.deepEqual(notGreen, { active: false, reason: "release_oracle_mismatch" });

  for (const oracle of [
    oracleDecision(authority, "top_level", { bindingId: "binding-other" }),
    oracleDecision(authority, "top_level", { bindingEpoch: authority.bindingEpoch + 1 }),
    oracleDecision(authority, "top_level", { privacyClass: "private" }),
    oracleDecision(authority, "thread"),
    oracleDecision(authority, "top_level", { releaseContractRevision: "revision-3" }),
    oracleDecision(authority, "top_level", { oracleReceiptSchema: "self-reported.v0" }),
    oracleDecision(authority, "top_level", { inboundGreen: false }),
    oracleDecision(authority, "top_level", { outboundGreen: false }),
    oracleDecision(authority, "top_level", { oracleReceiptRevision: 1.5 }),
  ]) {
    const mismatch = await resolveSlackBridgeBindingActive(
      request(),
      dependencies({
        authority: { active: true, fact: authority },
        oracle,
      }),
    );
    assert.deepEqual(mismatch, { active: false, reason: "release_oracle_mismatch" });
  }

  const stale = await resolveSlackBridgeBindingActive(
    request(),
    dependencies({
      authority: { active: true, fact: authority },
      oracle: oracleDecision(authority, "top_level", { expiresAt: NOW }),
    }),
  );
  assert.deepEqual(stale, { active: false, reason: "release_oracle_stale" });
});

test("enqueue revision is reusable only while the entire authoritative runtime snapshot stays exact", async () => {
  const first = await resolveSlackBridgeBindingActive(
    request(),
    dependencies(),
  );
  assert.equal(first.active, true);
  if (!first.active) assert.fail("expected first active decision");

  const unchanged = await resolveSlackBridgeBindingActive(
    request({ expectedRuntimePredicateRevision: first.fact.runtimePredicateRevision }),
    dependencies(),
  );
  assert.equal(unchanged.active, true);

  for (const deps of [
    dependencies({ flagConfigVersion: 12 }),
    dependencies({
      membership: membershipDecision(authorityFact(), { receiptRevision: 9 }),
    }),
    dependencies({
      oracle: oracleDecision(authorityFact(), "top_level", { oracleReceiptRevision: 10 }),
    }),
    dependencies({
      authority: {
        active: true,
        fact: authorityFact({ providerAuthorityId: "team-2" }),
      },
    }),
    dependencies({
      membership: membershipDecision(authorityFact(), {
        expiresAt: new Date("2026-07-24T16:30:00.000Z"),
      }),
    }),
    dependencies({
      oracle: oracleDecision(authorityFact(), "top_level", {
        expiresAt: new Date("2026-07-24T16:30:00.000Z"),
      }),
    }),
  ]) {
    const split = await resolveSlackBridgeBindingActive(
      request({ expectedRuntimePredicateRevision: first.fact.runtimePredicateRevision }),
      deps,
    );
    assert.equal(split.active, false);
    assert.equal(split.reason, "runtime_revision_mismatch");
    assert.equal(split.currentRuntimePredicateRevision?.length, 64);
    assert.notEqual(split.currentRuntimePredicateRevision, first.fact.runtimePredicateRevision);
  }
});

test("binding authority denial short-circuits flags, membership, and Oracle", async () => {
  const observedFlagKeys: SlackBridgeFeatureFlagKey[] = [];
  let membershipCalls = 0;
  let oracleCalls = 0;
  const deps = dependencies({
    authority: { active: false, reason: "epoch_mismatch" },
    observedFlagKeys,
  });
  deps.resolveAppMembership = async () => {
    membershipCalls += 1;
    return { active: false, reason: "missing" };
  };
  deps.resolveReleaseOracle = async () => {
    oracleCalls += 1;
    return { active: false, reason: "missing" };
  };

  const result = await resolveSlackBridgeBindingActive(request(), deps);
  assert.deepEqual(result, {
    active: false,
    reason: "binding_authority_epoch_mismatch",
  });
  assert.deepEqual(observedFlagKeys, []);
  assert.equal(membershipCalls, 0);
  assert.equal(oracleCalls, 0);
});

test("unwired durable membership and Oracle adapters fail closed", async () => {
  const all = dependencies();
  const {
    resolveAppMembership: _membership,
    resolveReleaseOracle: _oracle,
    ...withoutMembershipOrOracle
  } = all;
  const noMembership = await resolveSlackBridgeBindingActive(
    request(),
    withoutMembershipOrOracle,
  );
  assert.deepEqual(noMembership, {
    active: false,
    reason: "app_membership_unavailable",
  });

  const noOracle = await resolveSlackBridgeBindingActive(
    request(),
    {
      ...withoutMembershipOrOracle,
      resolveAppMembership: all.resolveAppMembership,
    },
  );
  assert.deepEqual(noOracle, {
    active: false,
    reason: "release_oracle_unavailable",
  });
});

test("untrusted runtime level input fails closed before opening a snapshot", async () => {
  let snapshots = 0;
  const deps = dependencies();
  deps.withReadSnapshot = async (fn) => {
    snapshots += 1;
    return fn(EXECUTOR);
  };
  const result = await resolveSlackBridgeBindingActive(
    request({ level: "reply" as SlackBridgeRuntimeLevel }),
    deps,
  );
  assert.deepEqual(result, { active: false, reason: "runtime_level_invalid" });
  assert.equal(snapshots, 0);
});

test("invalid caller clock fails closed before opening a snapshot", async () => {
  let snapshots = 0;
  const deps = dependencies();
  deps.withReadSnapshot = async (fn) => {
    snapshots += 1;
    return fn(EXECUTOR);
  };
  const result = await resolveSlackBridgeBindingActive(
    request({ now: new Date(Number.NaN) }),
    deps,
  );
  assert.deepEqual(result, { active: false, reason: "clock_invalid" });
  assert.equal(snapshots, 0);
});
