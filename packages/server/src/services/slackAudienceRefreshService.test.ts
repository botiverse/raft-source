import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppCredentials,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppServerGrants,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
  oauthClientInstalls,
  oauthClients,
  serverAgentMembers,
  serverMembers,
  users,
} from "../db/schema.js";
import { createServer } from "./serverService.js";
import {
  createSlackPrivateAudienceRefresher,
  type SlackAudienceIdentityMapping,
  type SlackAudienceRefreshDependencies,
} from "./slackAudienceRefreshService.js";
import {
  startSlackBridgePersistentWorker,
  type SlackBridgeBindingRuntime,
  type SlackBridgeLifecycleExecutionReceipt,
} from "./slackBridgeWorkerLifecycle.js";
import {
  SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA,
  type SlackBridgeCredentialHandle,
  type SlackProviderAuthorityFence,
  type SlackWebApiRequest,
  type SlackWebApiTransportResult,
} from "./slackProviderAdapter.js";


const NOW = new Date("2026-08-11T08:00:00.000Z");

beforeEach(async () => {
  await openTestDatabase("pglite://");
});

afterEach(async () => {
  await closeTestDatabase();
});

async function seedPrivateAudience(input: {
  includeSecondChannelMember?: boolean;
} = {}) {
  const [owner] = await getDb().insert(users).values({
    email: `slack-audience-${randomUUID()}@raft.test`,
    name: `slack-audience-${randomUUID().slice(0, 8)}`,
    displayName: "Slack Audience Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer(
    "Slack Audience Test",
    `slack-audience-${randomUUID()}`,
    owner.id,
  );
  const [member] = await getDb().insert(users).values({
    email: `slack-audience-member-${randomUUID()}@raft.test`,
    name: `slack-audience-member-${randomUUID().slice(0, 8)}`,
    displayName: "Slack Audience Member",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  await getDb().insert(serverMembers).values({
    serverId: server.id,
    userId: member.id,
    role: "member",
  });
  const [channel] = await getDb().insert(channels).values({
    serverId: server.id,
    name: `slack-private-${randomUUID().slice(0, 8)}`,
    type: "private",
  }).returning();
  await getDb().insert(channelHumans).values({
    channelId: channel.id,
    userId: owner.id,
  });
  if (input.includeSecondChannelMember !== false) {
    await getDb().insert(channelHumans).values({
      channelId: channel.id,
      userId: member.id,
    });
  }
  const [client] = await getDb().insert(oauthClients).values({
    serverId: server.id,
    clientId: `slack-audience-${randomUUID()}`,
    clientSecretHash: "hash",
    appType: "slock_builtin",
    name: "Slack Audience",
    allowedScopes: ["groups:read"],
    createdByUserId: owner.id,
  }).returning();
  await getDb().insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
  });
  const [registration] = await getDb().insert(externalAppRegistrations).values({
    oauthClientId: client.id,
    provider: "slack",
    environment: "test",
    providerAppId: "A_AUDIENCE",
    providerOAuthClientId: `oauth-${randomUUID()}`,
    capabilityManifestVersion: 1,
    capabilityManifestHash: "manifest-audience-v1",
    requiredCapabilities: ["private_audience"],
  }).returning();
  const [grant] = await getDb().insert(externalAppServerGrants).values({
    serverId: server.id,
    registrationId: registration.id,
    grantEpoch: 1,
    grantedManifestVersion: 1,
    grantedManifestHash: "manifest-audience-v1",
    grantedCapabilities: ["private_audience"],
    grantedByType: "human",
    grantedById: owner.id,
  }).returning();
  const [install] = await getDb().insert(externalAppInstalls).values({
    serverId: server.id,
    registrationId: registration.id,
    serverGrantId: grant.id,
    grantEpoch: 1,
    state: "active",
    connectionEpoch: 3,
    scopeRevision: 1,
    credentialRevision: 7,
    installedScopes: ["groups:read"],
    providerAppId: "A_AUDIENCE",
    providerTeamId: "T_AUDIENCE",
    providerEnterpriseId: null,
    authorityType: "team",
    providerAuthorityId: "T_AUDIENCE",
    botUserId: "U_BRIDGE_BOT",
  }).returning();
  await getDb().insert(externalAppCredentials).values({
    installId: install.id,
    state: "active",
    encryptedMaterial: "sealed:test-only",
    envelopeKeyId: "test-key",
    credentialRevision: 7,
  });
  const [binding] = await getDb().insert(externalChannelBindings).values({
    serverId: server.id,
    registrationId: registration.id,
    installId: install.id,
    channelId: channel.id,
    providerConversationId: "G_PRIVATE",
    providerConversationKind: "private_channel",
    privacyClass: "private",
    state: "active",
    grantEpoch: 1,
    connectionEpoch: 3,
    bindingEpoch: 5,
    audienceRevision: 1,
    audienceFreshUntil: new Date(NOW.getTime() + 60_000),
    consentedByType: "human",
    consentedById: owner.id,
    consentedAt: NOW,
  }).returning();
  const identityMappings: SlackAudienceIdentityMapping[] = [];
  for (const [index, externalActorId] of ["U_A", "U_B"].entries()) {
    const [actor] = await getDb().insert(externalActorProjections).values({
      provider: "slack",
      appRegistrationId: registration.id,
      installId: install.id,
      workspaceId: "T_AUDIENCE",
      externalActorId,
      displayName: externalActorId,
      handles: [externalActorId.toLowerCase()],
      actorKind: "human",
      projectionRevision: 4 + index,
      observedAt: NOW,
    }).returning();
    await getDb().insert(externalAddressabilityProjections).values({
      projectionId: actor.id,
      provider: "slack",
      appRegistrationId: registration.id,
      installId: install.id,
      workspaceId: "T_AUDIENCE",
      connectionEpoch: 3,
      bindingId: binding.id,
      bindingEpoch: 5,
      conversationId: "G_PRIVATE",
      memberRevision: 6,
      contextRevision: 8,
      state: "active",
      observedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60 * 60_000),
    });
    identityMappings.push({
      kind: "human",
      id: index === 0 ? owner.id : member.id,
      projectionId: actor.id,
    });
  }
  return {
    owner,
    member,
    server,
    channel,
    registration,
    install,
    binding,
    identityMappings,
  };
}

function identityAuthority(mappings: readonly SlackAudienceIdentityMapping[]) {
  const byPrincipal = new Map(mappings.map((mapping) => [
    `${mapping.kind}:${mapping.id}`,
    mapping,
  ]));
  return {
    async resolve(input: { principals: readonly { kind: "human" | "agent"; id: string }[] }) {
      const selected = input.principals.map((principal) =>
        byPrincipal.get(`${principal.kind}:${principal.id}`));
      return selected.some((mapping) => !mapping)
        ? { kind: "unavailable" as const }
        : {
            kind: "resolved" as const,
            mappings: selected as SlackAudienceIdentityMapping[],
          };
    },
  };
}

function credential(authority: SlackProviderAuthorityFence): SlackBridgeCredentialHandle {
  return {
    schema: SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA,
    leaseId: "audience-lease",
    installId: authority.installId,
    providerAppId: authority.providerAppId,
    providerAuthorityId: authority.providerAuthorityId,
    connectionEpoch: authority.connectionEpoch,
    credentialRevision: authority.credentialRevision,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
  };
}

function refresher(input: {
  outcomes: SlackWebApiTransportResult[];
  identityMappings: readonly SlackAudienceIdentityMapping[];
  calls?: SlackWebApiRequest[];
  overrides?: Partial<SlackAudienceRefreshDependencies>;
}) {
  return createSlackPrivateAudienceRefresher({
    transport: {
      evidence: "double",
      async call(request) {
        input.calls?.push(request);
        const outcome = input.outcomes.shift();
        if (!outcome) throw new Error("missing provider outcome");
        return outcome;
      },
    },
    quarantineSink: {
      async quarantine() {
        return "applied";
      },
    },
    credentialResolver: {
      async resolve({ authority }) {
        return credential(authority);
      },
    },
    identityAuthority: identityAuthority(input.identityMappings),
    now: () => NOW,
    freshnessMs: 10 * 60_000,
    ...input.overrides,
  });
}

function members(memberIds: string[]): SlackWebApiTransportResult {
  return {
    kind: "response",
    status: 200,
    headers: {},
    body: {
      ok: true,
      members: memberIds,
      response_metadata: { next_cursor: "" },
    },
    observedAuthority: {
      providerAppId: "A_AUDIENCE",
      providerAuthorityId: "T_AUDIENCE",
    },
  };
}

test("refresher with explicit identity authority advances matched/mismatch revisions without membership writes", async () => {
  const seeded = await seedPrivateAudience();
  const calls: SlackWebApiRequest[] = [];
  const refresh = refresher({
    identityMappings: seeded.identityMappings,
    outcomes: [
      members(["U_BRIDGE_BOT", "U_B", "U_A"]),
      members(["U_A", "U_EXTERNAL"]),
    ],
    calls,
  });
  const before = {
    serverMembers: await getDb().select().from(serverMembers),
    channelHumans: await getDb().select().from(channelHumans),
    actors: await getDb().select().from(externalActorProjections),
    addresses: await getDb().select().from(externalAddressabilityProjections),
  };

  assert.deepEqual(await refresh({ bindingId: seeded.binding.id }), {
    kind: "recorded",
    bindingId: seeded.binding.id,
    audienceStatus: "matched",
    observedAtMs: NOW.getTime(),
    revision: 2,
  });
  assert.deepEqual(await refresh({ bindingId: seeded.binding.id }), {
    kind: "recorded",
    bindingId: seeded.binding.id,
    audienceStatus: "mismatch",
    observedAtMs: NOW.getTime(),
    revision: 3,
  });
  assert.deepEqual(calls.map((call) => call.method), [
    "conversations.members",
    "conversations.members",
  ]);
  assert.deepEqual(
    (await getDb().select().from(externalBindingAudienceSnapshots))
      .map((snapshot) => [snapshot.audienceRevision, snapshot.status]),
    [[2, "matched"], [3, "mismatch"]],
  );
  assert.deepEqual(await getDb().select().from(serverMembers), before.serverMembers);
  assert.deepEqual(await getDb().select().from(channelHumans), before.channelHumans);
  assert.deepEqual(await getDb().select().from(externalActorProjections), before.actors);
  assert.deepEqual(await getDb().select().from(externalAddressabilityProjections), before.addresses);
});

test("persistent worker entry refreshes audience on event and periodic drains before planning", async () => {
  const seeded = await seedPrivateAudience();
  const calls: SlackWebApiRequest[] = [];
  const refresh = refresher({
    identityMappings: seeded.identityMappings,
    outcomes: [
      members(["U_BRIDGE_BOT", "U_A", "U_B"]),
      members(["U_A", "U_EXTERNAL"]),
    ],
    calls,
  });
  const before = {
    serverMembers: await getDb().select().from(serverMembers),
    channelHumans: await getDb().select().from(channelHumans),
    actors: await getDb().select().from(externalActorProjections),
    addresses: await getDb().select().from(externalAddressabilityProjections),
  };
  const binding: SlackBridgeBindingRuntime = {
    bindingId: seeded.binding.id,
    mode: "active",
    desiredEpoch: seeded.binding.bindingEpoch,
    authority: {
      appInstallState: "active",
      channelBindingState: "active",
      credentialState: "active",
      audienceStatus: "matched",
    },
    worker: {
      state: "running",
      epoch: seeded.binding.bindingEpoch,
      leaseId: "worker-lease",
      leaseOwnerId: "audience-worker",
      leaseExpiresAtMs: NOW.getTime() + 60_000,
    },
    backlog: { pendingEvents: 0, oldestPendingEventAgeMs: 0 },
    probes: {
      slack: { surface: "slack", ok: true, observedAtMs: NOW.getTime(), trigger: "periodic" },
      raft: { surface: "raft", ok: true, observedAtMs: NOW.getTime(), trigger: "periodic" },
    },
  };
  const receipts: SlackBridgeLifecycleExecutionReceipt[] = [];
  const worker = startSlackBridgePersistentWorker({
    async loadBindings() {
      return [binding];
    },
    async refreshAudience(current) {
      return refresh({ bindingId: current.bindingId });
    },
    async executeCommand() {
      throw new Error("unexpected command");
    },
    async runProbe(request) {
      return {
        surface: request.surface,
        ok: true,
        observedAtMs: NOW.getTime(),
        trigger: request.trigger,
      };
    },
    async persistReceipt(receipt) {
      receipts.push(receipt);
    },
  }, {
    orchestratorId: "audience-worker",
    intervalMs: 60_000,
    probeFreshnessMs: 60_000,
    maxPendingEvents: 50,
    maxOldestPendingEventAgeMs: 120_000,
    nowMs: () => NOW.getTime(),
  });

  await worker.requestReconcile("event");
  await worker.requestReconcile("periodic");
  worker.stop();

  assert.deepEqual(calls.map((call) => call.method), [
    "conversations.members",
    "conversations.members",
  ]);
  assert.deepEqual(
    receipts.map((receipt) => [
      receipt.audienceRefresh.audienceStatus,
      receipt.audienceRefresh.revision,
      receipt.plan.health.state,
      receipt.plan.health.reason,
    ]),
    [
      ["matched", 2, "Connected", null],
      ["mismatch", 3, "Degraded", "audience_mismatch"],
    ],
  );
  assert.deepEqual(
    (await getDb().select().from(externalBindingAudienceSnapshots))
      .map((snapshot) => [snapshot.audienceRevision, snapshot.status]),
    [[2, "matched"], [3, "mismatch"]],
  );
  assert.deepEqual(await getDb().select().from(serverMembers), before.serverMembers);
  assert.deepEqual(await getDb().select().from(channelHumans), before.channelHumans);
  assert.deepEqual(await getDb().select().from(externalActorProjections), before.actors);
  assert.deepEqual(await getDb().select().from(externalAddressabilityProjections), before.addresses);
});

test("provider failure is recorded as unavailable rather than mismatch", async () => {
  const seeded = await seedPrivateAudience();
  const refresh = refresher({
    identityMappings: seeded.identityMappings,
    outcomes: [{
      kind: "transport_failure",
      phase: "before_send",
      code: "unavailable",
    }],
  });

  assert.deepEqual(await refresh({ bindingId: seeded.binding.id }), {
    kind: "recorded",
    bindingId: seeded.binding.id,
    audienceStatus: "unavailable",
    observedAtMs: NOW.getTime(),
    reason: "provider_unavailable",
    revision: 2,
  });
  const [snapshot] = await getDb().select().from(externalBindingAudienceSnapshots);
  assert.equal(snapshot.status, "unavailable");
});

test("identity-authority failure records unavailable without calling Slack", async () => {
  const seeded = await seedPrivateAudience();
  await getDb().delete(externalAddressabilityProjections).where(
    eq(externalAddressabilityProjections.bindingId, seeded.binding.id),
  );
  const calls: SlackWebApiRequest[] = [];
  const refresh = refresher({
    outcomes: [],
    calls,
    identityMappings: seeded.identityMappings,
  });

  assert.deepEqual(await refresh({ bindingId: seeded.binding.id }), {
    kind: "recorded",
    bindingId: seeded.binding.id,
    audienceStatus: "unavailable",
    observedAtMs: NOW.getTime(),
    reason: "identity_mapping_unavailable",
    revision: 2,
  });
  assert.equal(calls.length, 0);
  const [snapshot] = await getDb().select().from(externalBindingAudienceSnapshots);
  assert.equal(snapshot.status, "unavailable");
});

test("missing or ambiguous principal identity mapping fails closed before provider access", async () => {
  const seeded = await seedPrivateAudience();
  for (const identityAuthorityOverride of [
    identityAuthority(seeded.identityMappings.slice(0, 1)),
    {
      async resolve() {
        return {
          kind: "resolved" as const,
          mappings: seeded.identityMappings.map((mapping) => ({
            ...mapping,
            projectionId: seeded.identityMappings[0]!.projectionId,
          })),
        };
      },
    },
  ]) {
    const calls: SlackWebApiRequest[] = [];
    const refresh = refresher({
      outcomes: [],
      calls,
      identityMappings: seeded.identityMappings,
      overrides: { identityAuthority: identityAuthorityOverride },
    });
    const receipt = await refresh({ bindingId: seeded.binding.id });
    assert.equal(receipt.audienceStatus, "unavailable");
    assert.equal(receipt.reason, "identity_mapping_unavailable");
    assert.equal(calls.length, 0);
  }
});

test("removing the sole Raft channel member fails closed before provider access", async () => {
  const seeded = await seedPrivateAudience({ includeSecondChannelMember: false });
  await getDb().delete(channelHumans).where(
    eq(channelHumans.userId, seeded.owner.id),
  );
  const calls: SlackWebApiRequest[] = [];
  const refresh = refresher({
    outcomes: [],
    calls,
    identityMappings: seeded.identityMappings,
  });

  assert.deepEqual(await refresh({ bindingId: seeded.binding.id }), {
    kind: "recorded",
    bindingId: seeded.binding.id,
    audienceStatus: "unavailable",
    observedAtMs: NOW.getTime(),
    reason: "identity_mapping_unavailable",
    revision: 2,
  });
  assert.equal(calls.length, 0);
  assert.equal(
    (await getDb().select().from(externalActorProjections)).length,
    2,
  );
  assert.equal(
    (await getDb().select().from(externalAddressabilityProjections)).length,
    2,
  );
});

test("only changing current Raft channel membership changes the authorized audience", async () => {
  const seeded = await seedPrivateAudience({ includeSecondChannelMember: false });
  const calls: SlackWebApiRequest[] = [];
  const refresh = refresher({
    outcomes: [members(["U_A", "U_B"]), members(["U_A", "U_B"])],
    calls,
    identityMappings: seeded.identityMappings,
  });
  const before = {
    serverMembers: await getDb().select().from(serverMembers),
    actors: await getDb().select().from(externalActorProjections),
    addresses: await getDb().select().from(externalAddressabilityProjections),
  };

  assert.equal(
    (await refresh({ bindingId: seeded.binding.id })).audienceStatus,
    "mismatch",
  );
  await getDb().insert(channelHumans).values({
    channelId: seeded.channel.id,
    userId: seeded.member.id,
  });
  const expectedChannelHumans = await getDb().select().from(channelHumans);
  assert.equal(
    (await refresh({ bindingId: seeded.binding.id })).audienceStatus,
    "matched",
  );

  assert.deepEqual(calls.map((call) => call.method), [
    "conversations.members",
    "conversations.members",
  ]);
  assert.deepEqual(
    (await getDb().select().from(externalBindingAudienceSnapshots))
      .map((snapshot) => [
        snapshot.audienceRevision,
        snapshot.status,
        snapshot.raftMemberCount,
        snapshot.externalMemberCount,
      ]),
    [[2, "mismatch", 1, 2], [3, "matched", 2, 2]],
  );
  assert.deepEqual(await getDb().select().from(serverMembers), before.serverMembers);
  assert.deepEqual(await getDb().select().from(channelHumans), expectedChannelHumans);
  assert.deepEqual(await getDb().select().from(externalActorProjections), before.actors);
  assert.deepEqual(await getDb().select().from(externalAddressabilityProjections), before.addresses);
});

test("Raft agents are explicitly excluded from the Slack human audience", async () => {
  const seeded = await seedPrivateAudience();
  const [agent] = await getDb().insert(agents).values({
    serverId: seeded.server.id,
    name: `slack-audience-agent-${randomUUID().slice(0, 8)}`,
  }).returning();
  await getDb().insert(serverAgentMembers).values({
    serverId: seeded.server.id,
    agentId: agent.id,
  });
  await getDb().insert(channelAgents).values({
    channelId: seeded.channel.id,
    agentId: agent.id,
  });
  const resolvedPrincipalSets: string[][] = [];
  const calls: SlackWebApiRequest[] = [];
  const refresh = refresher({
    outcomes: [
      members(["U_A", "U_B"]),
      members(["U_A", "U_B"]),
    ],
    calls,
    identityMappings: seeded.identityMappings,
    overrides: {
      identityAuthority: {
        async resolve(input) {
          resolvedPrincipalSets.push(input.principals.map(({ kind, id }) => `${kind}:${id}`));
          assert.ok(input.principals.every(({ kind }) => kind === "human"));
          return {
            kind: "resolved" as const,
            mappings: seeded.identityMappings,
          };
        },
      },
    },
  });

  assert.equal(
    (await refresh({ bindingId: seeded.binding.id })).audienceStatus,
    "matched",
  );
  await getDb().delete(serverAgentMembers).where(
    eq(serverAgentMembers.agentId, agent.id),
  );
  const expectedChannelAgents = await getDb().select().from(channelAgents);
  assert.equal(
    (await refresh({ bindingId: seeded.binding.id })).audienceStatus,
    "matched",
  );

  assert.deepEqual(calls.map((call) => call.method), [
    "conversations.members",
    "conversations.members",
  ]);
  assert.deepEqual(
    (await getDb().select().from(externalBindingAudienceSnapshots))
      .map((snapshot) => [snapshot.status, snapshot.raftMemberCount]),
    [["matched", 2], ["matched", 2]],
  );
  assert.deepEqual(resolvedPrincipalSets, [
    seeded.identityMappings.map(({ id }) => `human:${id}`).sort(),
    seeded.identityMappings.map(({ id }) => `human:${id}`).sort(),
  ]);
  assert.deepEqual(await getDb().select().from(channelAgents), expectedChannelAgents);
  assert.equal(
    (await getDb().select().from(serverAgentMembers))
      .some((membership) => membership.agentId === agent.id),
    false,
  );
});

test("missing credential records unavailable without calling Slack", async () => {
  const seeded = await seedPrivateAudience();
  await getDb().delete(externalAppCredentials).where(
    eq(externalAppCredentials.installId, seeded.install.id),
  );
  const calls: SlackWebApiRequest[] = [];
  const refresh = refresher({
    outcomes: [],
    calls,
    identityMappings: seeded.identityMappings,
  });

  assert.deepEqual(await refresh({ bindingId: seeded.binding.id }), {
    kind: "recorded",
    bindingId: seeded.binding.id,
    audienceStatus: "unavailable",
    observedAtMs: NOW.getTime(),
    reason: "credential_unavailable",
    revision: 2,
  });
  assert.equal(calls.length, 0);
});

test("credential lease failure records unavailable without calling Slack", async () => {
  const seeded = await seedPrivateAudience();
  const calls: SlackWebApiRequest[] = [];
  const refresh = refresher({
    identityMappings: seeded.identityMappings,
    outcomes: [],
    calls,
    overrides: {
      credentialResolver: {
        async resolve() {
          return null;
        },
      },
    },
  });

  assert.deepEqual(await refresh({ bindingId: seeded.binding.id }), {
    kind: "recorded",
    bindingId: seeded.binding.id,
    audienceStatus: "unavailable",
    observedAtMs: NOW.getTime(),
    reason: "credential_unavailable",
    revision: 2,
  });
  assert.equal(calls.length, 0);
});

test("two refreshers sharing a stale audience fence append only one snapshot", async () => {
  const seeded = await seedPrivateAudience();
  let providerCalls = 0;
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  let bothStarted!: () => void;
  const bothStartedPromise = new Promise<void>((resolve) => {
    bothStarted = resolve;
  });
  const refresh = createSlackPrivateAudienceRefresher({
    transport: {
      evidence: "double",
      async call() {
        providerCalls += 1;
        if (providerCalls === 2) bothStarted();
        await providerGate;
        return members(["U_A", "U_B"]);
      },
    },
    quarantineSink: {
      async quarantine() {
        return "applied";
      },
    },
    credentialResolver: {
      async resolve({ authority }) {
        return credential(authority);
      },
    },
    identityAuthority: identityAuthority(seeded.identityMappings),
    now: () => NOW,
  });

  const first = refresh({ bindingId: seeded.binding.id });
  const second = refresh({ bindingId: seeded.binding.id });
  await bothStartedPromise;
  releaseProvider();
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((result) => result.kind === "recorded").length, 1);
  assert.equal(results.filter((result) => result.kind === "fence_mismatch").length, 1);
  assert.equal(
    (await getDb().select().from(externalBindingAudienceSnapshots)).length,
    1,
  );
  const [binding] = await getDb().select().from(externalChannelBindings)
    .where(eq(externalChannelBindings.id, seeded.binding.id));
  assert.equal(binding.audienceRevision, 2);
});
