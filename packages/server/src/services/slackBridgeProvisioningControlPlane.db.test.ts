import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import {
  slackBridgeProvisioningResponseSchema,
  type SlackBridgeProvisioningResponse,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import {
  channelHumans,
  channels,
  jointChannels,
  jointChannelServers,
  externalActorProjections,
  externalAddressabilityProjections,
  externalBindingAudienceSnapshots,
  externalAppCredentials,
  externalAppInstallServerGrants,
  externalAppInstalls,
  externalAppServerGrants,
  externalChannelBindings,
  externalDeliveryPartitions,
  externalOutboundDeliveries,
  externalDeliveryOperatorDecisions,
  externalCardEditPairNotices,
  externalCardEditSyncs,
  serverMembers,
} from "../db/schema";
import { refreshSlackCardEditPairNotices } from "./slackCardEditSync";
import { canUserAccessChannel, addHuman } from "./channelService";
import { asServerId } from "@botiverse/raft-shared";
import { SLACK_BRIDGE_REQUIRED_BOT_SCOPES } from "../routes/slackBridge";
import { dbTest } from "../test/integration/dbTest";
import { seedBoundGuest } from "../test/guestFixture";
import {
  createSlackBridgeProvisioningControlPlane,
  listSlackBridgeMentionCandidates,
  slackBridgeProvisioningManifestHash,
  SLACK_BRIDGE_PROVISIONING_CAPABILITIES,
  type SlackBridgeProvisioningProvider,
} from "./slackBridgeProvisioningControlPlane";

const REGISTRATION_ID = "33333333-3333-4333-8333-333333333333";
const OAUTH_REDIRECT_URI = "https://raft.example/api/slack-bridge/oauth/callback";
const EVENTS_REQUEST_URL = "https://bridge.example/api/slack-bridge/events";

const BOOTSTRAP = {
  registrationId: REGISTRATION_ID,
  environment: "test" as const,
  providerAppId: "A_MEMBER_READ",
  providerOAuthClientId: "member-read-client",
  oauthRedirectUri: OAUTH_REDIRECT_URI,
  eventsRequestUrl: EVENTS_REQUEST_URL,
  capabilityManifestVersion: 1,
  capabilityManifestHash: slackBridgeProvisioningManifestHash({
    oauthRedirectUri: OAUTH_REDIRECT_URI,
    eventsRequestUrl: EVENTS_REQUEST_URL,
  }),
  requiredCapabilities: SLACK_BRIDGE_PROVISIONING_CAPABILITIES,
  signingSecret: {
    encryptedSecretRef: "env:SLACK_BRIDGE_SIGNING_SECRET",
    envelopeKeyId: "env:process",
    secretRevision: 1,
  },
  oauthClientSecret: {
    encryptedSecretRef: "env:SLACK_BRIDGE_OAUTH_CLIENT_SECRET",
    envelopeKeyId: "env:process",
    secretRevision: 1,
  },
};

type FakeProviderChannel = { id: string; name: string; privacyClass: "public" | "private"; isMember?: boolean };

function fakeProvider(channels: FakeProviderChannel[] = [
  { id: "C_GENERAL", name: "slack-general", privacyClass: "public", isMember: true },
  { id: "C_SECRET", name: "slack-secret", privacyClass: "private", isMember: true },
  { id: "C_MINE", name: "slack-mine", privacyClass: "private", isMember: true },
  { id: "C_UNPAIRED", name: "slack-unpaired", privacyClass: "public", isMember: true },
]) {
  const calls = { readWorkspace: 0 };
  const provider: SlackBridgeProvisioningProvider = {
    async readInstallGrant() { return { kind: "unverified" }; },
    async readWorkspace() {
      calls.readWorkspace += 1;
      return {
        oauth: "passed",
        directory: {
          kind: "fact",
          fact: {
            workspaceName: "Member Read Workspace",
            channels: channels.map((channel) => ({ ...channel })),
          },
        },
      };
    },
    async readConversationAudience() { return { kind: "unverified" }; },
    async readConversationMember() { return { kind: "fact", fact: true }; },
  };
  return { provider, calls };
}

function parsed(response: SlackBridgeProvisioningResponse): SlackBridgeProvisioningResponse {
  const result = slackBridgeProvisioningResponseSchema.safeParse(response);
  assert.ok(result.success, `response must satisfy the route schema: ${JSON.stringify(result.error?.issues)}`);
  return result.data;
}

async function seedActiveInstall(serverId: string, ownerId: string, now: Date) {
  const [grant] = await getDb().select().from(externalAppServerGrants).where(and(
    eq(externalAppServerGrants.serverId, serverId),
    eq(externalAppServerGrants.registrationId, REGISTRATION_ID),
  ));
  const [install] = await getDb().insert(externalAppInstalls).values({
    serverId,
    registrationId: REGISTRATION_ID,
    serverGrantId: grant.id,
    grantEpoch: grant.grantEpoch,
    state: "active",
    installedScopes: [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES],
    providerAppId: BOOTSTRAP.providerAppId,
    providerTeamId: "T_MEMBER_READ",
    authorityType: "team",
    providerAuthorityId: "T_MEMBER_READ",
    botUserId: "U_MEMBER_READ_BOT",
    providerBotId: "B_MEMBER_READ_BOT",
    workspaceName: "Member Read Workspace",
  }).returning();
  await getDb().insert(externalAppInstallServerGrants).values({
    installId: install.id,
    serverId,
    registrationId: REGISTRATION_ID,
    serverGrantId: grant.id,
    grantEpoch: grant.grantEpoch,
    authorizedByType: "human",
    authorizedById: ownerId,
    providerAuthorizingUserId: "U_AUTHORIZER",
  });
  await getDb().insert(externalAppCredentials).values({
    installId: install.id,
    encryptedMaterial: "sealed-test-material",
    envelopeKeyId: "test-key",
    credentialRevision: install.credentialRevision,
  });
  const bindingFor = (channelId: string, providerConversationId: string, privacyClass: "public" | "private") => ({
    serverId,
    registrationId: REGISTRATION_ID,
    installId: install.id,
    channelId,
    providerConversationId,
    providerConversationKind: privacyClass === "public" ? "public_channel" as const : "private_channel" as const,
    privacyClass,
    ...(privacyClass === "private"
      ? { audienceRevision: 1, audienceFreshUntil: new Date(now.getTime() + 60 * 60_000) }
      : {}),
    state: "paused" as const,
    stateReason: "provisioning_preflight_pending",
    grantEpoch: grant.grantEpoch,
    connectionEpoch: install.connectionEpoch,
    consentedByType: "human" as const,
    consentedById: ownerId,
    consentedAt: now,
  });
  return { install, bindingFor };
}

async function rejectsUnauthorized(operation: Promise<unknown>, label: string) {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, "external_app_not_authorized", label);
    return true;
  });
}

dbTest("private Slack selection requires this server's authorizer membership and fences reauthorization", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const hiddenRaft = await seed.channel({ server, members: [owner], name: "hidden-existing" });
  const changedRaft = await seed.channel({ server, members: [owner], name: "privacy-changed" });
  const newRaft = await seed.channel({ server, members: [owner], name: "new-pair" });
  const { provider } = fakeProvider([
    { id: "C_SECRET", name: "slack-secret", privacyClass: "private", isMember: true },
    { id: "C_MINE", name: "slack-mine", privacyClass: "private", isMember: true },
    { id: "C_CHANGED", name: "now-private", privacyClass: "private", isMember: true },
  ]);
  let race = false;
  let installId = "";
  provider.readConversationMember = async ({ providerUserId, providerConversationId }) => {
    assert.equal(providerUserId, "U_AUTHORIZER");
    if (race) {
      race = false;
      await getDb().update(externalAppInstallServerGrants).set({ providerAuthorizingUserId: "U_NEW" })
        .where(eq(externalAppInstallServerGrants.installId, installId));
    }
    return { kind: "fact", fact: providerConversationId === "C_MINE" };
  };
  const control = createSlackBridgeProvisioningControlPlane({ db: getDb(), bootstrap: BOOTSTRAP, provider });
  const request = { serverId: server.id, requestingUserId: owner.id, now: new Date() };
  await control.connect(request);
  const seeded = await seedActiveInstall(server.id, owner.id, request.now);
  installId = seeded.install.id;
  const [hidden] = await getDb().insert(externalChannelBindings)
    .values(seeded.bindingFor(hiddenRaft.id, "C_SECRET", "private")).returning();
  const [changed] = await getDb().insert(externalChannelBindings)
    .values(seeded.bindingFor(changedRaft.id, "C_CHANGED", "public")).returning();
  const loaded = await control.load(request);
  assert.equal(loaded.snapshot.slackChannels.some(channel => channel.id === "C_SECRET"), false);
  assert.equal(loaded.snapshot.channelPairs.some(pair => pair.slackChannelId === "C_SECRET"), false);
  assert.equal(loaded.snapshot.rawHealth!.bindings.some(binding => binding.id === hidden.id), false);
  assert.equal(loaded.snapshot.channelPairs.some(pair => pair.slackChannelId === "C_CHANGED"), false,
    "stale public metadata must not expose a channel that became private");
  assert.equal(loaded.snapshot.slackChannels.some(channel => channel.id === "C_MINE"), true);
  await assert.rejects(control.saveChannelPairs({ ...request,
    pairs: [{ raftChannelId: newRaft.id, slackChannelId: "C_SECRET" }] }));
  await assert.rejects(control.saveChannelPairs({ ...request,
    pairs: [{ raftChannelId: changedRaft.id, slackChannelId: "C_CHANGED" }] }),
  (error: unknown) => (error as { code?: unknown }).code === "external_app_not_authorized");
  await control.saveChannelPairs({ ...request, pairs: [{ raftChannelId: newRaft.id, slackChannelId: "C_MINE" }] });
  const [stillHidden] = await getDb().select().from(externalChannelBindings).where(eq(externalChannelBindings.id, hidden.id));
  assert.equal(stillHidden.state, "paused", "saving a visible pair must not silently revoke a hidden one");
  const [stillChanged] = await getDb().select().from(externalChannelBindings).where(eq(externalChannelBindings.id, changed.id));
  assert.equal(stillChanged.state, "paused");
  await getDb().update(externalAppInstallServerGrants).set({ providerAuthorizingUserId: null })
    .where(eq(externalAppInstallServerGrants.installId, installId));
  const legacy = await control.load(request);
  assert.equal(legacy.snapshot.slackChannels.some(channel => channel.privacyClass === "private"), false);
  assert.equal("needsSlackReauthorization" in legacy.snapshot, false, "older clients receive their original strict shape");
  const hinted = await control.load({ ...request, includePrivateAuthorizerHint: true });
  assert.equal(hinted.snapshot.needsSlackReauthorization, true);
  let audienceReads = 0;
  provider.readConversationAudience = async () => { audienceReads += 1; return { kind: "unverified" }; };
  const preflight = await control.runPreflight(request);
  assert.notEqual(preflight.snapshot.stage, "enable");
  assert.equal(audienceReads, 0, "an unverified authorizer must not refresh private-channel audience data");
  await assert.rejects(control.saveChannelPairs({ ...request,
    pairs: [{ raftChannelId: newRaft.id, slackChannelId: "C_MINE" }] }));
  await getDb().update(externalAppInstallServerGrants).set({ providerAuthorizingUserId: "U_AUTHORIZER" })
    .where(eq(externalAppInstallServerGrants.installId, installId));
  race = true;
  await assert.rejects(control.saveChannelPairs({ ...request,
    pairs: [{ raftChannelId: newRaft.id, slackChannelId: "C_MINE" }] }),
  (error: unknown) => (error as { code?: unknown }).code === "external_app_not_authorized");
});

dbTest("pair selection requires both Raft viewer access and Slack authorizer membership", async ({ seed }) => {
  const owner = await seed.human();
  const admin = await seed.human();
  const server = await seed.server({ owner, members: [admin] });
  await getDb().update(serverMembers).set({ role: "admin" }).where(and(
    eq(serverMembers.serverId, server.id), eq(serverMembers.userId, admin.id)));
  const privateRaft = await seed.channel({ server, members: [owner], name: "restricted", visibility: "private" });
  const publicRaft = await seed.channel({ server, members: [owner, admin], name: "allowed" });
  const { provider } = fakeProvider();
  provider.readConversationMember = async ({ providerConversationId }) => ({
    kind: "fact", fact: providerConversationId === "C_MINE",
  });
  const control = createSlackBridgeProvisioningControlPlane({ db: getDb(), bootstrap: BOOTSTRAP, provider });
  const ownerRequest = { serverId: server.id, requestingUserId: owner.id, now: new Date() };
  await control.connect(ownerRequest);
  await seedActiveInstall(server.id, owner.id, ownerRequest.now);
  const request = { ...ownerRequest, requestingUserId: admin.id };
  const view = await control.load(request);
  assert.equal(view.snapshot.raftChannels.some(channel => channel.id === privateRaft.id), false);
  assert.equal(view.snapshot.slackChannels.some(channel => channel.id === "C_SECRET"), false);
  await assert.rejects(control.saveChannelPairs({ ...request, pairs: [{ raftChannelId: privateRaft.id, slackChannelId: "C_MINE" }] }));
  await assert.rejects(control.saveChannelPairs({ ...request, pairs: [{ raftChannelId: publicRaft.id, slackChannelId: "C_SECRET" }] }));
  const result = await control.saveChannelPairs({ ...request, pairs: [{ raftChannelId: publicRaft.id, slackChannelId: "C_MINE" }] });
  assert.equal(result.snapshot.channelPairs.some(pair => pair.raftChannelId === publicRaft.id && pair.slackChannelId === "C_MINE"), true);
});

dbTest("Slack Bridge setup is readable by members, narrowed to their channels, and still managed only by owners/admins", async ({ seed }) => {
  const owner = await seed.human();
  const admin = await seed.human();
  const member = await seed.human();
  const outsider = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner, members: [admin, member, guest] });
  await seedBoundGuest({ serverId: server.id, userId: guest.id });
  await getDb().update(serverMembers).set({ role: "admin" }).where(and(
    eq(serverMembers.serverId, server.id),
    eq(serverMembers.userId, admin.id),
  ));
  const general = await seed.channel({ server, members: [owner], name: "general-bridge" });
  const secret = await seed.channel({ server, members: [owner], name: "secret-bridge", visibility: "private" });
  const mine = await seed.channel({ server, members: [owner, member], name: "mine-bridge", visibility: "private" });

  const { provider, calls } = fakeProvider();
  const controlPlane = createSlackBridgeProvisioningControlPlane({ db: getDb(), bootstrap: BOOTSTRAP, provider });
  const now = new Date();
  const as = (userId: string) => ({ serverId: server.id, requestingUserId: userId, now });

  const connected = parsed(await controlPlane.connect(as(owner.id)));
  assert.equal(connected.snapshot.stage, "oauth");
  assert.ok(connected.oauthAuthority, "a manager at the OAuth stage receives the authority to start it");

  // A member sees the OAuth step read-only: no authority to start it.
  const memberOAuth = parsed(await controlPlane.load(as(member.id)));
  assert.equal(memberOAuth.snapshot.stage, "oauth");
  assert.equal(memberOAuth.oauthAuthority, null);

  const { install, bindingFor } = await seedActiveInstall(server.id, owner.id, now);
  const [generalBinding, secretBinding, mineBinding] = await getDb().insert(externalChannelBindings).values([
    bindingFor(general.id, "C_GENERAL", "public"),
    bindingFor(secret.id, "C_SECRET", "private"),
    bindingFor(mine.id, "C_MINE", "private"),
  ]).returning();

  // Management authority does not grant private channel read access. The
  // admin retains OAuth/setup authority but sees only accessible Raft facts.
  const adminView = parsed(await controlPlane.load(as(admin.id)));
  assert.equal(adminView.snapshot.stage, "preflight");
  assert.ok(adminView.oauthAuthority, "a manager past connect keeps the re-authorization authority");
  const adminRaftIds = adminView.snapshot.raftChannels.map((channel) => channel.id);
  assert.ok(adminRaftIds.includes(general.id));
  for (const id of [secret.id, mine.id]) assert.ok(!adminRaftIds.includes(id));
  assert.deepEqual(
    adminView.snapshot.slackChannels.map((channel) => channel.id).sort(),
    ["C_GENERAL", "C_MINE", "C_SECRET", "C_UNPAIRED"],
  );
  assert.deepEqual(
    adminView.snapshot.channelPairs.map((pair) => pair.slackChannelId).sort(),
    ["C_GENERAL"],
  );
  assert.deepEqual(
    adminView.snapshot.rawHealth!.bindings.map((binding) => binding.id).sort(),
    [generalBinding.id],
  );
  const ownerView = parsed(await controlPlane.load(as(owner.id)));
  assert.deepEqual(ownerView.snapshot.channelPairs.map(pair => pair.slackChannelId).sort(), ["C_GENERAL", "C_MINE", "C_SECRET"]);
  assert.deepEqual(ownerView.oauthAuthority, adminView.oauthAuthority, "both roles keep management authority");

  // A member sees the same setup progress, narrowed to channels they can view.
  const readsBefore = calls.readWorkspace;
  const memberView = parsed(await controlPlane.load(as(member.id)));
  assert.equal(calls.readWorkspace, readsBefore + 1, "a member read observes the workspace once, like a manager read");
  assert.equal(memberView.oauthAuthority, null);
  assert.equal(memberView.snapshot.stage, adminView.snapshot.stage);
  assert.deepEqual(memberView.snapshot.preflight, adminView.snapshot.preflight);
  assert.equal(memberView.snapshot.workspaceName, "Member Read Workspace");
  const memberRaftIds = memberView.snapshot.raftChannels.map((channel) => channel.id);
  assert.ok(memberRaftIds.includes(general.id), "public channels are visible");
  assert.ok(memberRaftIds.includes(mine.id), "private channels the member belongs to are visible");
  assert.ok(!memberRaftIds.includes(secret.id), "a private channel the member is not in stays hidden");
  assert.deepEqual(
    memberView.snapshot.channelPairs.map((pair) => [pair.raftChannelId, pair.slackChannelId]).sort(),
    [[general.id, "C_GENERAL"], [mine.id, "C_MINE"]].sort(),
  );
  assert.deepEqual(
    memberView.snapshot.slackChannels.map((channel) => channel.id).sort(),
    ["C_GENERAL", "C_MINE"],
    "members see only the paired Slack channels, never the workspace inventory",
  );
  assert.deepEqual(
    memberView.snapshot.rawHealth!.bindings.map((binding) => binding.id).sort(),
    [generalBinding.id, mineBinding.id].sort(),
  );
  assert.deepEqual(
    memberView.snapshot.rawHealth!.audiences.map((audience) => audience.bindingId).sort(),
    [generalBinding.id, mineBinding.id].sort(),
  );
  const serialized = JSON.stringify(memberView);
  for (const leaked of [secret.id, secret.name, secretBinding.id, "C_SECRET", "slack-secret", "C_UNPAIRED"]) {
    assert.ok(!serialized.includes(leaked), `member projection must not mention ${leaked}`);
  }

  // Non-members and Guests still cannot read anything.
  await rejectsUnauthorized(controlPlane.load(as(outsider.id)), "non-member load");
  await rejectsUnauthorized(controlPlane.load(as(guest.id)), "guest load");

  // Every mutation stays owner/admin only.
  const memberRequest = as(member.id);
  await rejectsUnauthorized(controlPlane.connect(memberRequest), "member connect");
  await rejectsUnauthorized(controlPlane.saveChannelPairs({
    ...memberRequest,
    pairs: [{ raftChannelId: general.id, slackChannelId: "C_UNPAIRED" }],
  }), "member saveChannelPairs");
  await rejectsUnauthorized(controlPlane.removeChannelPairs({
    ...memberRequest,
    pairs: [{ raftChannelId: general.id, slackChannelId: "C_GENERAL", expectedBindingEpoch: generalBinding.bindingEpoch }],
  }), "member removeChannelPairs");
  await rejectsUnauthorized(controlPlane.runPreflight(memberRequest), "member runPreflight");
  await rejectsUnauthorized(controlPlane.enable(memberRequest), "member enable");
  await rejectsUnauthorized(controlPlane.disconnect({
    ...memberRequest,
    expectedConnectionEpoch: install.connectionEpoch,
  }), "member disconnect");
  const bindingsAfter = await getDb().select({ id: externalChannelBindings.id, state: externalChannelBindings.state })
    .from(externalChannelBindings).where(eq(externalChannelBindings.installId, install.id));
  assert.deepEqual(
    bindingsAfter.map((binding) => binding.state),
    ["paused", "paused", "paused"],
    "rejected member mutations leave every binding untouched",
  );
});

dbTest("Slack Bridge channel save keeps an unchanged pair that went stale, validates only new pairs, and the snapshot marks the stale pair", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const general = await seed.channel({ server, members: [owner], name: "general-stale" });
  const secret = await seed.channel({ server, members: [owner], name: "secret-kept", visibility: "private" });
  const extra = await seed.channel({ server, members: [owner], name: "extra-new" });
  const hidden = await seed.channel({ server, members: [owner], name: "hidden-new", visibility: "private" });
  const providerChannels: FakeProviderChannel[] = [
    { id: "C_GENERAL", name: "slack-general", privacyClass: "public", isMember: true },
    { id: "C_SECRET", name: "slack-secret", privacyClass: "private", isMember: true },
    { id: "C_EXTRA", name: "slack-extra", privacyClass: "public", isMember: true },
    { id: "C_OUTSIDE", name: "slack-outside", privacyClass: "public", isMember: false },
    { id: "C_PUBLIC", name: "slack-public", privacyClass: "public", isMember: true },
  ];
  const { provider } = fakeProvider(providerChannels);
  const controlPlane = createSlackBridgeProvisioningControlPlane({ db: getDb(), bootstrap: BOOTSTRAP, provider });
  const now = new Date();
  const request = { serverId: server.id, requestingUserId: owner.id, now };
  await controlPlane.connect(request);
  const { install, bindingFor } = await seedActiveInstall(server.id, owner.id, now);
  const [generalBinding] = await getDb().insert(externalChannelBindings).values([
    bindingFor(general.id, "C_GENERAL", "public"),
    bindingFor(secret.id, "C_SECRET", "private"),
  ]).returning();

  // The app is later removed from the Slack channel behind an existing pair.
  providerChannels[0] = { ...providerChannels[0]!, isMember: false };
  const loaded = parsed(await controlPlane.load(request));
  const pairReasons = Object.fromEntries(loaded.snapshot.channelPairs.map((pair) => [pair.slackChannelId, pair.invalidReason]));
  assert.deepEqual(pairReasons, { C_GENERAL: "not_member", C_SECRET: undefined });

  // Resubmitting the stale pair with a valid new one is accepted.
  const later = new Date(now.getTime() + 60_000);
  const saved = parsed(await controlPlane.saveChannelPairs({
    ...request,
    now: later,
    pairs: [
      { raftChannelId: general.id, slackChannelId: "C_GENERAL" },
      { raftChannelId: secret.id, slackChannelId: "C_SECRET" },
      { raftChannelId: extra.id, slackChannelId: "C_EXTRA" },
    ],
  }));
  assert.deepEqual(
    saved.snapshot.channelPairs.map((pair) => [pair.slackChannelId, pair.invalidReason]).sort(),
    [["C_EXTRA", undefined], ["C_GENERAL", "not_member"], ["C_SECRET", undefined]],
  );
  const rows = await getDb().select().from(externalChannelBindings).where(eq(externalChannelBindings.installId, install.id));
  const keptGeneral = rows.find((row) => row.id === generalBinding.id)!;
  assert.equal(keptGeneral.state, "paused");
  assert.equal(keptGeneral.consentedAt?.getTime(), now.getTime(), "a kept stale pair is not re-consented");
  assert.ok(rows.some((row) => row.channelId === extra.id && row.providerConversationId === "C_EXTRA" && row.state === "paused"));

  // A new invalid pair is still rejected, naming the reason and the pair.
  const rejectsWith = async (
    pair: { raftChannelId: string; slackChannelId: string },
    reason: string,
  ) => {
    await assert.rejects(controlPlane.saveChannelPairs({
      ...request,
      now: later,
      pairs: [
        { raftChannelId: general.id, slackChannelId: "C_GENERAL" },
        { raftChannelId: secret.id, slackChannelId: "C_SECRET" },
        { raftChannelId: extra.id, slackChannelId: "C_EXTRA" },
        pair,
      ],
    }), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "external_app_invalid_state");
      assert.equal((error as { reason?: unknown }).reason, reason, `${pair.slackChannelId} rejection reason`);
      return true;
    });
  };
  await rejectsWith({ raftChannelId: hidden.id, slackChannelId: "C_OUTSIDE" }, "not_member");
  await assert.rejects(controlPlane.saveChannelPairs({ ...request, now: later,
    pairs: [{ raftChannelId: hidden.id, slackChannelId: "C_MISSING" }] }),
  (error: unknown) => (error as { code?: unknown }).code === "external_app_not_authorized");
  const afterRejects = await getDb().select().from(externalChannelBindings).where(eq(externalChannelBindings.installId, install.id));
  assert.equal(afterRejects.length, 3, "rejected saves persist nothing");

  // A cross-class pair — private Raft channel to a public Slack channel — is
  // admissible; each platform keeps its own visibility.
  const crossClass = parsed(await controlPlane.saveChannelPairs({
    ...request,
    now: later,
    pairs: [
      { raftChannelId: general.id, slackChannelId: "C_GENERAL" },
      { raftChannelId: secret.id, slackChannelId: "C_SECRET" },
      { raftChannelId: extra.id, slackChannelId: "C_EXTRA" },
      { raftChannelId: hidden.id, slackChannelId: "C_PUBLIC" },
    ],
  }));
  assert.equal(
    crossClass.snapshot.channelPairs.some((pair) => pair.raftChannelId === hidden.id && pair.slackChannelId === "C_PUBLIC"),
    true,
  );
});


dbTest("stalled delivery health and manager retry are scoped to visible channels and the current head", async ({ seed }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const channel = await seed.channel({ server, members: [owner], visibility: "private" });
  const provider = fakeProvider().provider;
  const control = createSlackBridgeProvisioningControlPlane({ db: getDb(), bootstrap: BOOTSTRAP, provider });
  const now = new Date();
  const as = (userId: string) => ({ serverId: server.id, requestingUserId: userId, now, includeDeliveryHealth: true });
  await control.connect(as(owner.id));
  const { bindingFor } = await seedActiveInstall(server.id, owner.id, now);
  const [binding] = await getDb().insert(externalChannelBindings).values({
    ...bindingFor(channel.id, "C_SECRET", "private"), state: "active", stateReason: null, bindingEpoch: 2,
  }).returning();
  const [actor] = await getDb().insert(externalActorProjections).values({
    provider: "slack", appRegistrationId: REGISTRATION_ID, installId: binding.installId,
    workspaceId: "T_MEMBER_READ", externalActorId: "U_HEALTH", displayName: "Health member",
    actorKind: "human", state: "active", projectionRevision: 1, observedAt: now,
  }).returning();
  const expiresAt = new Date(now.getTime() + 60_000);
  await getDb().insert(externalAddressabilityProjections).values({
    projectionId: actor.id, provider: "slack", appRegistrationId: REGISTRATION_ID, installId: binding.installId,
    workspaceId: "T_MEMBER_READ", connectionEpoch: binding.connectionEpoch, bindingId: binding.id,
    bindingEpoch: binding.bindingEpoch, conversationId: "C_SECRET", memberRevision: 1, contextRevision: 1,
    state: "active", observedAt: now, expiresAt,
  });
  const digest = (label: string) => createHash("sha256").update(JSON.stringify([label, ["U_HEALTH"]])).digest("hex");
  await getDb().insert(externalBindingAudienceSnapshots).values({
    bindingId: binding.id, bindingEpoch: binding.bindingEpoch, audienceRevision: 1,
    externalMemberCount: 1, raftMemberCount: 1, status: "matched",
    externalAudienceDigest: digest("slack-external-audience"), raftAudienceDigest: digest("raft-authorized-provider-audience"),
    observedAt: now, expiresAt,
  });
  const message = await seed.message({ channel, author: owner, content: "recovery probe" });
  await getDb().insert(externalDeliveryPartitions).values({ bindingId: binding.id, bindingEpoch: binding.bindingEpoch });
  const delivery = await getDb().transaction(async (tx) => {
    await tx.update(externalDeliveryPartitions).set({ lastEnqueuedPosition: 1 }).where(and(
      eq(externalDeliveryPartitions.bindingId, binding.id), eq(externalDeliveryPartitions.bindingEpoch, binding.bindingEpoch),
    ));
  const [delivery] = await tx.insert(externalOutboundDeliveries).values({
    sourceMessageId: message.id, bindingId: binding.id, bindingEpoch: binding.bindingEpoch,
    partitionPosition: 1, enqueueRuntimeRevision: "runtime-test", renderSnapshotSchema: "slack-bridge-render-snapshot.v5",
    renderSnapshot: {}, renderSnapshotDigest: "a".repeat(64), reconciliationMarker: "A".repeat(43),
    state: "dead", providerAttempts: 1, ambiguityBudgetProviderAttempts: 1, dispatchedFailureAttempts: 1,
    firstDispatchedAt: now, stateReason: "deterministic_failure",
  }).returning();
  return delivery;
  });
  const legacy = parsed(await control.load({ ...as(owner.id), includeDeliveryHealth: false }));
  assert.equal(legacy.snapshot.rawHealth!.outboundDeliveries, undefined, "old clients retain their strict response shape");
  const ownerView = parsed(await control.load(as(owner.id)));
  assert.equal(ownerView.snapshot.rawHealth!.outboundDeliveries?.[0].deliveryId, delivery.id);
  assert.notEqual(ownerView.snapshot.rawHealth!.failingSurface, null);
  const memberView = parsed(await control.load(as(member.id)));
  assert.deepEqual(memberView.snapshot.rawHealth!.outboundDeliveries, []);
  assert.ok(!JSON.stringify(memberView).includes(delivery.id));
  await getDb().update(externalOutboundDeliveries).set({ state: "queued", stateReason: "provider_thread_receipt_missing" })
    .where(eq(externalOutboundDeliveries.id, delivery.id));
  const missingRoot = parsed(await control.load(as(owner.id)));
  assert.equal(missingRoot.snapshot.rawHealth!.failingSurface, "delivery", "missing root must not look connected");
  assert.deepEqual(missingRoot.snapshot.rawHealth!.outboundDeliveries, [], "a pre-send block must not offer a resend");
  assert.notEqual(parsed(await control.load(as(member.id))).snapshot.rawHealth!.failingSurface, "delivery", "private queue health is not disclosed");
  await getDb().update(externalOutboundDeliveries).set({ stateReason: "attachment_source_size_mismatch" })
    .where(eq(externalOutboundDeliveries.id, delivery.id));
  const oldClient = parsed(await control.load(as(owner.id)));
  assert.equal(oldClient.snapshot.rawHealth!.attachmentSourceIssues, undefined, "old strict clients do not receive the new field");
  const sourceHealth = parsed(await control.load({ ...as(owner.id), includeAttachmentSourceHealth: true }));
  assert.deepEqual(sourceHealth.snapshot.rawHealth!.attachmentSourceIssues, [{ raftChannelId: channel.id, reason: "size_mismatch" }]);
  assert.deepEqual(sourceHealth.snapshot.rawHealth!.outboundDeliveries, [], "source failures do not offer an unsafe provider retry");
  for (const reason of ["attachment_source_digest_mismatch", "attachment_private_preparation_failed"]) {
    await getDb().update(externalOutboundDeliveries).set({ stateReason: reason })
      .where(eq(externalOutboundDeliveries.id, delivery.id));
    const warning = parsed(await control.load({ ...as(owner.id), includeAttachmentSourceHealth: true }));
    assert.deepEqual(warning.snapshot.rawHealth!.attachmentSourceIssues, [{ raftChannelId: channel.id, reason: "unavailable" }]);
    assert.deepEqual(warning.snapshot.rawHealth!.outboundDeliveries, [], "private preparation failures are not visible-message retries");
  }
  const hiddenSource = parsed(await control.load({ ...as(member.id), includeAttachmentSourceHealth: true }));
  assert.deepEqual(hiddenSource.snapshot.rawHealth!.attachmentSourceIssues, [], "private attachment health remains scoped");
  await getDb().update(externalOutboundDeliveries).set({ state: "dead", stateReason: "deterministic_failure" })
    .where(eq(externalOutboundDeliveries.id, delivery.id));
  await getDb().update(externalDeliveryPartitions).set({ authorityBlockedAt: now,
    authorityBlockedReason: "slack_not_in_channel", authorityRetryAt: new Date(now.getTime() + 5000),
  }).where(eq(externalDeliveryPartitions.bindingId, binding.id));
  const automatic = parsed(await control.load({ ...as(owner.id), includePairDeliveryHealth: true }));
  assert.equal(automatic.snapshot.rawHealth!.outboundPairBlocks?.[0]?.reason, "invite_app");
  assert.equal(automatic.snapshot.rawHealth!.outboundPairBlocks?.[0]?.since, now.toISOString());
  assert.deepEqual(automatic.snapshot.rawHealth!.outboundDeliveries, [], "pair recovery is automatic, not a per-message manual retry");
  const hiddenPair = parsed(await control.load({ ...as(member.id), includePairDeliveryHealth: true }));
  assert.deepEqual(hiddenPair.snapshot.rawHealth!.outboundPairBlocks, []);
  assert.equal(parsed(await control.load(as(owner.id))).snapshot.rawHealth!.outboundPairBlocks, undefined,
    "old health clients retain their exact negotiated shape");
  await getDb().update(externalDeliveryPartitions).set({ authorityBlockedReason: "binding_paused_archived" })
    .where(eq(externalDeliveryPartitions.bindingId, binding.id));
  assert.equal(parsed(await control.load({ ...as(owner.id), includePairDeliveryHealth: true }))
    .snapshot.rawHealth!.outboundPairBlocks?.[0]?.reason, "unarchive");
  await getDb().update(externalDeliveryPartitions).set({ authorityBlockedReason: "binding_paused_bot_removed" })
    .where(eq(externalDeliveryPartitions.bindingId, binding.id));
  assert.equal(parsed(await control.load({ ...as(owner.id), includePairDeliveryHealth: true }))
    .snapshot.rawHealth!.outboundPairBlocks?.[0]?.reason, "invite_app");
  await getDb().update(externalDeliveryPartitions).set({ authorityBlockedReason: "slack_workspace_admin_required" })
    .where(eq(externalDeliveryPartitions.bindingId, binding.id));
  const oldHint = parsed(await control.load({ ...as(owner.id), includePairDeliveryHealth: true }));
  assert.equal(oldHint.snapshot.rawHealth!.outboundPairBlocks?.[0]?.reason, "configuration");
  assert.equal(oldHint.snapshot.rawHealth!.outboundPairBlocks?.[0]?.action, undefined,
    "existing strict clients must not receive the new action without negotiation");
  assert.ok(!Object.hasOwn(oldHint.snapshot.rawHealth!.outboundPairBlocks?.[0] ?? {}, "action"));
  const adminHint = parsed(await control.load({ ...as(owner.id), includePairDeliveryHealth: true, includeWorkspaceAdminHint: true }));
  assert.equal(adminHint.snapshot.rawHealth!.outboundPairBlocks?.[0]?.action, "workspace_admin");
  assert.equal(adminHint.snapshot.rawHealth!.outboundPairBlocks?.[0]?.reason, "configuration");
  assert.deepEqual(parsed(await control.load({ ...as(member.id), includePairDeliveryHealth: true,
    includeWorkspaceAdminHint: true })).snapshot.rawHealth!.outboundPairBlocks, []);

  // A delivery Raft cannot confirm yet: `reason` stays "configuration" for strict older
  // clients; a client that asks (?confirmationHint=1) also gets which case it is.
  for (const [block, detail] of [
    ["reconciliation_history_limited", "history_limited"],
    ["reconciliation_bridge_metadata_missing", "metadata_missing"],
    ["reconciliation_marker_unconfirmed", "marker_unconfirmed"],
  ] as const) {
    await getDb().update(externalDeliveryPartitions).set({ authorityBlockedReason: block })
      .where(eq(externalDeliveryPartitions.bindingId, binding.id));
    const older = parsed(await control.load({ ...as(owner.id), includePairDeliveryHealth: true }));
    assert.equal(older.snapshot.rawHealth!.outboundPairBlocks?.[0]?.reason, "configuration", block);
    assert.ok(!Object.hasOwn(older.snapshot.rawHealth!.outboundPairBlocks?.[0] ?? {}, "detail"),
      `${block}: existing strict clients must not receive detail without negotiation`);
    const asked = parsed(await control.load({ ...as(owner.id), includePairDeliveryHealth: true, includeConfirmationHint: true }));
    assert.equal(asked.snapshot.rawHealth!.outboundPairBlocks?.[0]?.detail, detail, block);
    assert.equal(asked.snapshot.rawHealth!.outboundPairBlocks?.[0]?.reason, "configuration", block);
  }
  await getDb().update(externalDeliveryPartitions).set({ authorityBlockedReason: "slack_workspace_admin_required" })
    .where(eq(externalDeliveryPartitions.bindingId, binding.id));
  assert.ok(!Object.hasOwn(parsed(await control.load({ ...as(owner.id), includePairDeliveryHealth: true, includeConfirmationHint: true }))
    .snapshot.rawHealth!.outboundPairBlocks?.[0] ?? {}, "detail"), "a fault to fix carries no confirmation detail");

  await getDb().update(externalDeliveryPartitions).set({ authorityBlockedAt: null, authorityBlockedReason: null, authorityRetryAt: null })
    .where(eq(externalDeliveryPartitions.bindingId, binding.id));
  const request = { bindingId: binding.id, bindingEpoch: binding.bindingEpoch, deliveryId: delivery.id, expectedProviderAttempts: 1 };
  await rejectsUnauthorized(control.retryDelivery!({ ...as(member.id), ...request }), "member retry");
  await assert.rejects(control.retryDelivery!({ ...as(owner.id), ...request, bindingEpoch: binding.bindingEpoch + 1 }));
  await control.retryDelivery!({ ...as(owner.id), ...request });
  await control.retryDelivery!({ ...as(owner.id), ...request });
  const decisions = await getDb().select().from(externalDeliveryOperatorDecisions);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].actorId, owner.id);
  assert.equal(decisions[0].action, "retry_in_place");
  const pending = parsed(await control.load(as(owner.id)));
  assert.equal(pending.snapshot.rawHealth!.outboundDeliveries?.[0].retryRequested, true);
  await getDb().update(externalOutboundDeliveries).set({
    state: "retry_wait", providerAttempts: 3, ambiguityBudgetProviderAttempts: 3,
    nextAttemptAt: new Date(now.getTime() + 1000),
  }).where(eq(externalOutboundDeliveries.id, delivery.id));
  const exhausted = parsed(await control.load(as(owner.id)));
  assert.equal(exhausted.snapshot.rawHealth!.outboundDeliveries?.[0].state, "retry_wait");
  await getDb().update(externalOutboundDeliveries).set({ ambiguityBudgetProviderAttempts: 1 })
    .where(eq(externalOutboundDeliveries.id, delivery.id));
  const ordinary = parsed(await control.load(as(owner.id)));
  assert.deepEqual(ordinary.snapshot.rawHealth!.outboundDeliveries, [], "ordinary automatic backoff is not a stalled head");
  await assert.rejects(control.retryDelivery!({ ...as(owner.id), ...request, expectedProviderAttempts: 3 }));
  await getDb().insert(externalDeliveryPartitions).values({ bindingId: binding.id, bindingEpoch: binding.bindingEpoch - 1,
    authorityBlockedAt: now, authorityBlockedReason: "slack_not_in_channel" });
  const crossGeneration = parsed(await control.load({ ...as(owner.id), includePairDeliveryHealth: true }));
  assert.equal(crossGeneration.snapshot.rawHealth!.outboundPairBlocks?.[0]?.reason, "invite_app",
    "an empty historical wait is still shown while another generation has pending work");
  const crossGenerationHidden = parsed(await control.load({ ...as(member.id), includePairDeliveryHealth: true }));
  assert.deepEqual(crossGenerationHidden.snapshot.rawHealth!.outboundPairBlocks, [], "private pair health remains scoped");
  await getDb().update(externalChannelBindings).set({ state: "revoked", stateReason: "revoked" })
    .where(eq(externalChannelBindings.id, binding.id));
  await assert.rejects(control.retryDelivery!({ ...as(owner.id), ...request }));
});

dbTest("shared workspace retains human mention groups while another server's pairs await recovery", async ({ seed }) => {
  const owner = await seed.human();
  const first = await seed.server({ owner });
  const remoteHuman = await seed.human();
  const second = await seed.server({ owner, members: [remoteHuman] });
  const plane = createSlackBridgeProvisioningControlPlane({ db: getDb(), bootstrap: BOOTSTRAP, provider: fakeProvider().provider });
  const now = new Date();
  await plane.connect({ serverId: first.id, requestingUserId: owner.id, now });
  await plane.connect({ serverId: second.id, requestingUserId: owner.id, now });
  const { install, bindingFor } = await seedActiveInstall(first.id, owner.id, now);
  const [secondGrant] = await getDb().select().from(externalAppServerGrants).where(and(
    eq(externalAppServerGrants.serverId, second.id), eq(externalAppServerGrants.registrationId, REGISTRATION_ID),
  ));
  await getDb().insert(externalAppInstallServerGrants).values({
    installId: install.id, serverId: second.id, registrationId: REGISTRATION_ID,
    serverGrantId: secondGrant.id, grantEpoch: secondGrant.grantEpoch,
    authorizedByType: "human", authorizedById: owner.id,
  });
  const local = await seed.channel({ server: first, members: [owner] });
  const remote = await seed.channel({ server: second, members: [remoteHuman] });
  const [localBinding] = await getDb().insert(externalChannelBindings).values({
    ...bindingFor(local.id, "C_GENERAL", "public"), state: "active", stateReason: null,
  }).returning();
  const [remoteBinding] = await getDb().insert(externalChannelBindings).values({
    ...bindingFor(remote.id, "C_SECRET", "private"), serverId: second.id,
    grantEpoch: secondGrant.grantEpoch, state: "active", stateReason: null,
  }).returning();
  for (const state of ["paused", "quarantined", "active", "revoked"] as const) {
    await getDb().update(externalChannelBindings).set({
      state, stateReason: state === "active" ? null : "test_recovery_or_removal",
    }).where(eq(externalChannelBindings.id, remoteBinding.id));
    const candidates = await listSlackBridgeMentionCandidates(getDb(), first.id, [localBinding]);
    assert.deepEqual(candidates.humanCandidates.map((human) => human.userId), [owner.id], "local health stays server-scoped");
    assert.equal(candidates.workspaceHumanCandidates.some((human) => human.userId === remoteHuman.id), state !== "revoked",
      `${state}: temporary recovery must not become permission to retire a still-needed group`);
  }
  await getDb().update(externalChannelBindings).set({ state: "paused", stateReason: "test_recovery" })
    .where(eq(externalChannelBindings.id, remoteBinding.id));
  await getDb().update(externalAppInstallServerGrants).set({
    state: "revoked", revokedAt: now, revokeReason: "test_disconnect",
  }).where(and(eq(externalAppInstallServerGrants.installId, install.id), eq(externalAppInstallServerGrants.serverId, second.id)));
  const disconnected = await listSlackBridgeMentionCandidates(getDb(), first.id, [localBinding]);
  assert.equal(disconnected.workspaceHumanCandidates.some((human) => human.userId === remoteHuman.id), false,
    "retention never restores a revoked server association");
});

dbTest("shared Slack workspace keeps mention health private to each Raft server association", async ({ seed }) => {
  const owner = await seed.human();
  const first = await seed.server({ owner });
  const remoteHuman = await seed.human();
  const second = await seed.server({ owner, members: [remoteHuman] });
  const { provider } = fakeProvider();
  const plane = createSlackBridgeProvisioningControlPlane({ db: getDb(), bootstrap: BOOTSTRAP, provider });
  const now = new Date();
  const as = (serverId: string) => ({ serverId, requestingUserId: owner.id, now });
  await plane.connect(as(first.id));
  await plane.connect(as(second.id));
  const { install, bindingFor } = await seedActiveInstall(first.id, owner.id, now);
  const [secondGrant] = await getDb().select().from(externalAppServerGrants).where(and(
    eq(externalAppServerGrants.serverId, second.id), eq(externalAppServerGrants.registrationId, REGISTRATION_ID),
  ));
  const failed = { state: "degraded" as const, slackError: "permission_denied", expected: 10, actual: 0, observedAt: now.toISOString() };
  const succeeded = { state: "synced" as const, slackError: null, expected: 4, actual: 4, observedAt: now.toISOString() };
  await getDb().update(externalAppInstallServerGrants).set({ agentMentionSync: failed })
    .where(and(eq(externalAppInstallServerGrants.installId, install.id), eq(externalAppInstallServerGrants.serverId, first.id)));
  await getDb().insert(externalAppInstallServerGrants).values({
    installId: install.id, serverId: second.id, registrationId: REGISTRATION_ID,
    serverGrantId: secondGrant.id, grantEpoch: secondGrant.grantEpoch,
    authorizedByType: "human", authorizedById: owner.id, agentMentionSync: succeeded,
  });
  const localChannel = await seed.channel({ server: first, members: [owner], name: "first-mention-scope" });
  const remoteChannel = await seed.channel({ server: second, members: [owner, remoteHuman], name: "second-mention-scope" });
  const [localBinding] = await getDb().insert(externalChannelBindings).values({ ...bindingFor(localChannel.id, "C_GENERAL", "public"), state: "active", stateReason: null }).returning();
  await getDb().insert(externalChannelBindings).values({ ...bindingFor(remoteChannel.id, "C_SECRET", "private"), serverId: second.id, grantEpoch: secondGrant.grantEpoch, state: "active", stateReason: null });
  const candidates = await listSlackBridgeMentionCandidates(getDb(), first.id, [localBinding]);
  assert.deepEqual(candidates.humanCandidates.map((human) => human.userId), [owner.id], "local health counts only local candidates");
  assert.deepEqual(new Set(candidates.workspaceHumanCandidates.map((human) => human.userId)), new Set([owner.id, remoteHuman.id]), "retirement uses the authorized workspace union");
  // Reviewer probe: each server remains below 200, but their union exceeds it.
  const extra = [];
  for (let index = 0; index < 200; index++) extra.push(await seed.human());
  await getDb().insert(serverMembers).values(extra.map((human, index) => ({ serverId: index < 100 ? first.id : second.id, userId: human.id, role: "member" as const })));
  const firstExtra = await seed.channel({ server: first, members: extra.slice(0, 100), name: "first-extra" });
  const secondExtra = await seed.channel({ server: second, members: extra.slice(100), name: "second-extra" });
  const [extraBinding] = await getDb().insert(externalChannelBindings).values({ ...bindingFor(firstExtra.id, "C_EXTRA_ONE", "public"), state: "active", stateReason: null }).returning();
  await getDb().insert(externalChannelBindings).values({ ...bindingFor(secondExtra.id, "C_EXTRA_TWO", "public"), serverId: second.id, grantEpoch: secondGrant.grantEpoch, state: "active", stateReason: null });
  const allCandidates = await listSlackBridgeMentionCandidates(getDb(), first.id, [localBinding, extraBinding]);
  assert.equal(allCandidates.humanCandidates.length, 101);
  assert.equal(allCandidates.workspaceHumanCandidates.length, 202, "cleanup must retain the complete set of still-needed workspace humans");
  // Legacy install-level results must never mask one server's error or leak it
  // into the other server, regardless of the last writer to that old column.
  for (const legacy of [succeeded, failed]) {
    await getDb().update(externalAppInstalls).set({ agentMentionSync: legacy }).where(eq(externalAppInstalls.id, install.id));
    assert.deepEqual(parsed(await plane.load(as(first.id))).snapshot.rawHealth!.agentMentionSync, failed);
    assert.deepEqual(parsed(await plane.load(as(second.id))).snapshot.rawHealth!.agentMentionSync, succeeded);
  }
});

dbTest("canonical human usergroup constraints reject duplicate targets and nonhuman or unbound canonical rows", async ({ seed }) => {
  const owner = await seed.human();
  const first = await seed.server({ owner });
  const second = await seed.server({ owner });
  const { provider } = fakeProvider();
  const plane = createSlackBridgeProvisioningControlPlane({ db: getDb(), bootstrap: BOOTSTRAP, provider });
  await plane.connect({ serverId: first.id, requestingUserId: owner.id, now: new Date() });
  const { install } = await seedActiveInstall(first.id, owner.id, new Date());
  const insert = (serverId: string, kind: string, principal: string, providerId: string | null, canonical: boolean, recovery: string) => getDb().execute(sql`
    INSERT INTO slack_usergroup_identities (id, install_id, server_id, principal_kind, principal_id, provider_usergroup_id, human_canonical, recovery_ref)
    VALUES (gen_random_uuid(), ${install.id}, ${serverId}, ${kind}, ${principal}, ${providerId}, ${canonical}, ${recovery})`);
  const hasSqlState = (error: unknown, code: string) => {
    const cause = error instanceof Error && error.cause ? error.cause : error;
    return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
  };
  await insert(first.id, "user", owner.id, "S_CURRENT", true, "reviewer-current");
  await assert.rejects(insert(second.id, "user", owner.id, "S_SECOND_CURRENT", true, "reviewer-second"), (error) => hasSqlState(error, "23505"));
  await insert(second.id, "user", owner.id, "S_OLD_ALIAS", false, "reviewer-alias");
  await assert.rejects(insert(second.id, "agent", first.id, "S_AGENT", true, "reviewer-agent"), (error) => hasSqlState(error, "23514"));
  await assert.rejects(insert(second.id, "user", second.id, null, true, "reviewer-unbound"), (error) => hasSqlState(error, "23514"));
});


dbTest("directory failure keeps OAuth separate while activation still requires verified membership", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const provider = fakeProvider().provider;
  const verifiedWorkspace = provider.readWorkspace;
  const control = createSlackBridgeProvisioningControlPlane({ db: getDb(), bootstrap: BOOTSTRAP, provider });
  const now = new Date();
  const request = { serverId: server.id, requestingUserId: owner.id, now };
  await control.connect(request);
  const { bindingFor } = await seedActiveInstall(server.id, owner.id, now);
  const [binding] = await getDb().insert(externalChannelBindings).values(bindingFor(channel.id, "C_GENERAL", "public")).returning();
  provider.readInstallGrant = async () => ({ kind: "fact", fact: {
    providerAppId: BOOTSTRAP.providerAppId,
    providerAuthorityId: "T_MEMBER_READ",
    botUserId: "U_MEMBER_READ_BOT",
    providerBotId: "B_MEMBER_READ_BOT",
    grantedScopes: [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES],
  } });
  provider.readWorkspace = async () => ({ oauth: "passed", directory: { kind: "unverified", retryAfterMs: 60_000 } });
  const view = parsed(await control.runPreflight(request));
  const checks = new Map(view.snapshot.preflight!.checks.map((check) => [check.id, check.state]));
  assert.equal(checks.get("oauth"), "passed", "a channel-list failure is not an OAuth failure");
  assert.equal(checks.get("audience"), "unverified");
  assert.notEqual(view.snapshot.preflight!.state, "passed");
  const enabled = parsed(await control.enable(request));
  assert.notEqual(enabled.snapshot.preflight!.state, "passed");
  assert.equal(enabled.snapshot.preflight!.checks.find((check) => check.id === "audience")?.state, "unverified");
  const [stored] = await getDb().select({ state: externalChannelBindings.state }).from(externalChannelBindings)
    .where(eq(externalChannelBindings.id, binding.id));
  assert.equal(stored.state, "paused", "the independent OAuth pass cannot bypass membership verification");

  provider.readConversationAudience = async () => ({ kind: "fact", fact: {
    providerMemberIds: ["U_MEMBER_READ_BOT", "U_OBSERVED_MEMBER"],
    users: [{ id: "U_OBSERVED_MEMBER", displayName: "Observed member", handle: null, actorKind: "human" }],
  } });
  for (const oauth of ["failed", "unverified"] as const) {
    provider.readWorkspace = async () => ({ oauth, directory: { kind: "unverified" } });
    const unavailable = parsed(await control.runPreflight(request));
    assert.equal(unavailable.snapshot.preflight!.checks.find((check) => check.id === "oauth")?.state, oauth);
    assert.equal(unavailable.snapshot.preflight!.checks.find((check) => check.id === "audience")?.state, "unverified");
    const denied = parsed(await control.enable(request));
    assert.notEqual(denied.snapshot.preflight!.state, "passed");
    const [stillPaused] = await getDb().select({ state: externalChannelBindings.state }).from(externalChannelBindings)
      .where(eq(externalChannelBindings.id, binding.id));
    assert.equal(stillPaused.state, "paused", "verified members do not override failed or unverified OAuth");
  }
  provider.readWorkspace = async () => ({ oauth: "passed", directory: { kind: "unverified" } });
  const noDirectory = parsed(await control.runPreflight(request));
  assert.notEqual(noDirectory.snapshot.preflight!.state, "passed", "a stale public classification cannot prove current privacy");
  provider.readWorkspace = verifiedWorkspace;
  const verified = parsed(await control.runPreflight(request));
  assert.equal(verified.snapshot.preflight!.state, "passed", "a current directory and matched membership can enable the pair");
  await control.enable(request);
  const [active] = await getDb().select({ state: externalChannelBindings.state }).from(externalChannelBindings)
    .where(eq(externalChannelBindings.id, binding.id));
  assert.equal(active.state, "active");
});

dbTest("preflight reports a missing bot without erasing its lifecycle pause", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const provider = fakeProvider().provider;
  const control = createSlackBridgeProvisioningControlPlane({ db: getDb(), bootstrap: BOOTSTRAP, provider });
  const now = new Date();
  const request = { serverId: server.id, requestingUserId: owner.id, now };
  await control.connect(request);
  const { bindingFor } = await seedActiveInstall(server.id, owner.id, now);
  const [binding] = await getDb().insert(externalChannelBindings).values({
    ...bindingFor(channel.id, "C_GENERAL", "public"), state: "active", stateReason: null,
  }).returning();
  provider.readInstallGrant = async () => ({ kind: "fact", fact: {
    providerAppId: BOOTSTRAP.providerAppId,
    providerAuthorityId: "T_MEMBER_READ",
    botUserId: "U_MEMBER_READ_BOT",
    providerBotId: "B_MEMBER_READ_BOT",
    grantedScopes: [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES],
  } });
  let botPresent = false;
  provider.readConversationAudience = async () => ({ kind: "fact", fact: {
    providerMemberIds: [...(botPresent ? ["U_MEMBER_READ_BOT"] : []), "U_OBSERVED_MEMBER"],
    users: [{ id: "U_OBSERVED_MEMBER", displayName: "Observed member", handle: null, actorKind: "human" }],
  } });

  const missing = parsed(await control.runPreflight(request));
  assert.equal(missing.snapshot.preflight!.checks.find((check) => check.id === "audience")?.state, "failed");
  const [paused] = await getDb().select().from(externalChannelBindings).where(eq(externalChannelBindings.id, binding.id));
  assert.equal(paused.state, "paused");
  assert.equal(paused.stateReason, "provider_bot_removed");
  assert.equal(paused.bindingEpoch, binding.bindingEpoch + 1);
  const [mismatch] = await getDb().select().from(externalBindingAudienceSnapshots).where(and(
    eq(externalBindingAudienceSnapshots.bindingId, binding.id),
    eq(externalBindingAudienceSnapshots.bindingEpoch, paused.bindingEpoch),
  ));
  assert.equal(mismatch.status, "mismatch");
  assert.equal(mismatch.externalMemberCount, 1, "the recorded provider audience excludes the missing bot");

  botPresent = true;
  const later = { ...request, now: new Date(now.getTime() + 1_000) };
  const rechecked = parsed(await control.runPreflight(later));
  assert.equal(rechecked.snapshot.preflight!.checks.find((check) => check.id === "audience")?.state, "passed");
  await control.enable(later);
  const [stillPaused] = await getDb().select().from(externalChannelBindings).where(eq(externalChannelBindings.id, binding.id));
  assert.equal(stillPaused.state, "paused", "setup cannot bypass the lifecycle recovery fence");
  assert.equal(stillPaused.stateReason, "provider_bot_removed", "background recovery must retain its pause reason");
});

for (const role of ["owner", "admin"] as const) {
  for (const kind of ["private", "joint"] as const) {
    dbTest(`${role} needs channel access to list and save a ${kind} Slack pairing`, async ({ seed }) => {
      const owner = await seed.human(); const other = await seed.human();
      const manager = role === "owner" ? owner : await seed.human();
      const server = await seed.server({ owner, members: [other, ...(role === "admin" ? [manager] : [])] });
      if (role === "admin") await getDb().update(serverMembers).set({ role: "admin" })
        .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, manager.id)));
      const target = await seed.channel({ server, members: [other], visibility: "private", name: `hidden-${kind}` });
      if (kind === "joint") {
        const storage = await seed.server({ owner }); const canonical = await seed.channel({ server: storage, members: [owner] });
        await getDb().update(channels).set({ type: "joint" }).where(eq(channels.id, target.id));
        const [joint] = await getDb().insert(jointChannels).values({ canonicalChannelId: canonical.id,
          createdByServerId: server.id, createdByUserId: other.id }).returning();
        await getDb().insert(jointChannelServers).values({ jointChannelId: joint.id, serverId: server.id,
          localChannelId: target.id, role: "host", joinedByUserId: other.id });
      }
      const plane = createSlackBridgeProvisioningControlPlane({ db: getDb(), bootstrap: BOOTSTRAP, provider: fakeProvider().provider });
      const request = { serverId: server.id, requestingUserId: manager.id, now: new Date() };
      await plane.connect(request); const { bindingFor } = await seedActiveInstall(server.id, owner.id, request.now);
      assert.equal(await canUserAccessChannel(target.id, manager.id, asServerId(server.id)), false);
      const hidden = parsed(await plane.load({ ...request, includeDeliveryHealth: true }));
      assert.ok(!hidden.snapshot.raftChannels.some(c => c.id === target.id), "manager list must not expose an inaccessible target");
      await rejectsUnauthorized(plane.saveChannelPairs({ ...request,
        pairs: [{ raftChannelId: target.id, slackChannelId: "C_GENERAL" }] }), "forged save");
      assert.equal((await getDb().select().from(externalChannelBindings)).length, 0);
      // An old saved pair cannot bypass the new check through the kept-invalid shortcut.
      const [old] = await getDb().insert(externalChannelBindings).values(bindingFor(target.id, "C_SECRET", "private")).returning();
      const oldHidden = parsed(await plane.load({ ...request, includeDeliveryHealth: true, includePairDeliveryHealth: true }));
      for (const value of [target.id, target.name, old.id]) assert.ok(!JSON.stringify(oldHidden).includes(value), "saved target and health facts stay hidden");
      await rejectsUnauthorized(plane.saveChannelPairs({ ...request,
        pairs: [{ raftChannelId: target.id, slackChannelId: "C_SECRET" }] }), "saved hidden pair");
      await addHuman(target.id, manager.id);
      assert.equal(await canUserAccessChannel(target.id, manager.id, asServerId(server.id)), true);
      const allowed = parsed(await plane.saveChannelPairs({ ...request,
        pairs: [{ raftChannelId: target.id, slackChannelId: "C_SECRET" }] }));
      assert.ok(allowed.snapshot.channelPairs.some(p => p.raftChannelId === target.id));
    });
  }
}

dbTest("saving visible channels preserves hidden existing pairs without consenting or revoking them", async ({ seed }) => {
  const owner = await seed.human(); const other = await seed.human(); const server = await seed.server({ owner, members: [other] });
  const visible = await seed.channel({ server, members: [owner] });
  const hidden = await seed.channel({ server, members: [other], visibility: "private" });
  const plane = createSlackBridgeProvisioningControlPlane({ db: getDb(), bootstrap: BOOTSTRAP, provider: fakeProvider().provider });
  const request = { serverId: server.id, requestingUserId: owner.id, now: new Date() };
  await plane.connect(request); const { bindingFor } = await seedActiveInstall(server.id, owner.id, request.now);
  const [old] = await getDb().insert(externalChannelBindings).values(bindingFor(hidden.id, "C_SECRET", "private")).returning();
  await plane.saveChannelPairs({ ...request, pairs: [{ raftChannelId: visible.id, slackChannelId: "C_GENERAL" }] });
  const [after] = await getDb().select().from(externalChannelBindings).where(eq(externalChannelBindings.id, old.id));
  assert.deepEqual(after, old, "omitting an invisible pair must not mutate it");
  // Active hidden pairs must likewise not prevent a valid visible save.
  const [active] = await getDb().update(externalChannelBindings).set({ state: "active", stateReason: null })
    .where(eq(externalChannelBindings.id, old.id)).returning();
  await plane.saveChannelPairs({ ...request, pairs: [{ raftChannelId: visible.id, slackChannelId: "C_GENERAL" }] });
  const [afterActive] = await getDb().select().from(externalChannelBindings).where(eq(externalChannelBindings.id, old.id));
  assert.deepEqual(afterActive, active);
});

dbTest("save rechecks channel access after provider observation before it writes", async ({ seed }) => {
  const owner = await seed.human(); const server = await seed.server({ owner });
  const target = await seed.channel({ server, members: [owner], visibility: "private" });
  const fake = fakeProvider(); let revoke = false;
  const plane = createSlackBridgeProvisioningControlPlane({ db: getDb(), bootstrap: BOOTSTRAP,
    provider: { ...fake.provider, async readWorkspace(authority) {
      const result = await fake.provider.readWorkspace(authority);
      if (revoke) await getDb().delete(channelHumans).where(and(eq(channelHumans.channelId, target.id), eq(channelHumans.userId, owner.id)));
      return result;
    } } });
  const request = { serverId: server.id, requestingUserId: owner.id, now: new Date() };
  await plane.connect(request); await seedActiveInstall(server.id, owner.id, request.now);
  revoke = true;
  await rejectsUnauthorized(plane.saveChannelPairs({ ...request,
    pairs: [{ raftChannelId: target.id, slackChannelId: "C_GENERAL" }] }), "revoked while reading provider");
  assert.equal((await getDb().select().from(externalChannelBindings)).length, 0);
});

dbTest("isolated inbound health and replay respect channel access and current authority", async ({ seed }) => {
  const { enableTestSlackIngress, writeSlackFixture } = await import("../test/integration/slackIngressRollout");
  const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
  const { sealSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
  const { claimSlackVerifiedIngressHead, deferUnrecognizedSlackIngressClaim } = await import("./slackVerifiedIngressWorker");
  const { slackVerifiedIngressEvents, slackVerifiedIngressPartitions, slackVerifiedIngressReplayAudits } = await import("../db/schema");
  const owner = await seed.human();
  const admin = await seed.human();
  const server = await seed.server({ owner, members: [admin] });
  await getDb().update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, admin.id)));
  const channel = await seed.channel({ server, members: [owner], visibility: "private" });
  const control = createSlackBridgeProvisioningControlPlane({ db: getDb(), bootstrap: BOOTSTRAP, provider: fakeProvider().provider });
  let clock = new Date();
  const as = (userId: string) => ({ serverId: server.id, requestingUserId: userId, now: clock, includeInboundRecovery: true });
  await control.connect(as(owner.id));
  const { bindingFor } = await seedActiveInstall(server.id, owner.id, clock);
  const [binding] = await getDb().insert(externalChannelBindings).values({ ...bindingFor(channel.id, "C_SECRET", "private"), state: "active", stateReason: null }).returning();
  await enableTestSlackIngress();
  const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const, registrationId: REGISTRATION_ID,
    environment: "test" as const, providerAppId: BOOTSTRAP.providerAppId, providerAuthorityId: "T_MEMBER_READ",
    providerConversationId: "C_SECRET", providerEventId: "Ev_HELD_VISIBILITY" };
  const bytes = Buffer.from("sensitive example");
  const receipt = await enqueueSlackVerifiedIngress({ db: getDb(), aad, rawDigest: createHash("sha256").update(bytes).digest("hex"),
    encryptedPayload: sealSlackVerifiedIngress({ bytes, aad, key: Buffer.alloc(32, 5) }), envelopeKeyId: "test", now: clock,
    validateEndpoint: async () => true });
  let partitionId = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const claim = await claimSlackVerifiedIngressHead({ db: getDb(), leaseOwner: "hold-test", leaseMs: 30_000, now: () => clock });
    assert.equal(claim?.event.id, receipt.id); partitionId = claim!.partition.id;
    const retryAt = new Date(clock.getTime() + 1_000);
    await deferUnrecognizedSlackIngressClaim({ db: getDb(), partitionId, eventId: receipt.id, leaseOwner: "hold-test",
      leaseGeneration: claim!.event.leaseGeneration, now: () => clock, retryAt, reason: "unsupported_event_format" });
    clock = retryAt;
  }
  const [heldTemplate] = await getDb().select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, receipt.id));
  const laterId = randomUUID();
  await writeSlackFixture(async () => {
    await getDb().insert(slackVerifiedIngressEvents).values(Array.from({ length: 500 }, (_, index) => ({
      ...heldTemplate, id: index === 499 ? laterId : randomUUID(), position: index + 2,
      providerEventId: `Ev_HELD_EXTRA_${index}`, outcomeReason: index === 499 ? "bot_identity_pending" : "unsupported_event_format",
      lastIsolationReason: index === 499 ? "bot_identity_pending" : "unsupported_event_format",
      heldAt: index === 499 ? new Date(clock.getTime() + 1_000) : heldTemplate.heldAt,
    })));
    await getDb().update(slackVerifiedIngressPartitions).set({ lastPosition: 501 }).where(eq(slackVerifiedIngressPartitions.id, partitionId));
  });
  assert.equal((await control.load({ ...as(owner.id), includeInboundRecovery: false })).snapshot.rawHealth!.inboundIsolated, undefined);
  const ownerView = parsed(await control.load(as(owner.id)));
  assert.equal(ownerView.snapshot.rawHealth!.inboundIsolated?.some(row => row.eventId === receipt.id), true);
  assert.equal(ownerView.snapshot.rawHealth!.inboundIsolatedSummary?.count, 501);
  assert.equal(ownerView.snapshot.rawHealth!.inboundIsolatedSummary?.undisplayed, 1);
  assert.equal(ownerView.snapshot.rawHealth!.inboundIsolated?.length, 500);
  assert.equal(ownerView.snapshot.rawHealth!.inboundIsolated?.some(row => row.eventId === laterId), false);
  assert.equal(ownerView.snapshot.rawHealth!.inboundIsolatedGroups?.find(row => row.reason === "bot_identity_pending")?.count, 1);
  assert.ok(!JSON.stringify(ownerView).includes("sensitive example"));
  assert.doesNotMatch(JSON.stringify(ownerView), /encryptedPayload|envelopeKeyId|rawDigest/);
  assert.deepEqual(parsed(await control.load(as(admin.id))).snapshot.rawHealth!.inboundIsolated, []);
  assert.equal(parsed(await control.load(as(admin.id))).snapshot.rawHealth!.inboundIsolatedSummary?.count, 0);
  const batch = { bindingId: binding.id, bindingEpoch: binding.bindingEpoch, reason: "bot_identity_pending" };
  await assert.rejects(control.replayInbound!({ ...as(admin.id), ...batch }));
  await control.replayInbound!({ ...as(owner.id), ...batch });
  const [later] = await getDb().select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, laterId));
  assert.equal(later.state, "queued"); assert.equal(later.replayCount, 1);
  assert.equal((await getDb().select().from(slackVerifiedIngressReplayAudits).where(eq(slackVerifiedIngressReplayAudits.eventId, laterId))).length, 1);
  await assert.rejects(control.replayInbound!({ ...as(owner.id), ...batch }));
  const request = { bindingId: binding.id, bindingEpoch: binding.bindingEpoch, eventId: receipt.id };
  await assert.rejects(control.replayInbound!({ ...as(admin.id), ...request }));
  await assert.rejects(control.replayInbound!({ ...as(owner.id), ...request, bindingEpoch: binding.bindingEpoch + 1 }));
  await control.replayInbound!({ ...as(owner.id), ...request });
  const [event] = await getDb().select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, receipt.id));
  assert.equal(event.state, "queued"); assert.equal(event.replayCount, 1); assert.ok(event.encryptedPayload);
  const audits = await getDb().select().from(slackVerifiedIngressReplayAudits).where(eq(slackVerifiedIngressReplayAudits.eventId, receipt.id));
  assert.equal(audits.length, 1); assert.equal(audits[0]?.actorId, owner.id);
  await assert.rejects(control.replayInbound!({ ...as(owner.id), ...request }));
  const afterBatch = parsed(await control.replayInbound!({ ...as(owner.id), bindingId: binding.id,
    bindingEpoch: binding.bindingEpoch, reason: "unsupported_event_format" }));
  assert.equal(afterBatch.snapshot.rawHealth!.inboundIsolatedSummary?.count, 399, "one batch processes no more than 100");
  const allAudits = await getDb().select().from(slackVerifiedIngressReplayAudits);
  assert.equal(allAudits.length, 102, "each replay has its own durable audit");
  const beforeRace = afterBatch.snapshot.rawHealth!.inboundIsolatedSummary!.count;
  const revokedDuringReplay = createSlackBridgeProvisioningControlPlane({ db: getDb(), bootstrap: BOOTSTRAP,
    provider: fakeProvider().provider, testOnlyBeforeReplay: async () => {
      await getDb().delete(channelHumans).where(and(eq(channelHumans.channelId, channel.id), eq(channelHumans.userId, owner.id)));
    } });
  await assert.rejects(revokedDuringReplay.replayInbound!({ ...as(owner.id), bindingId: binding.id,
    bindingEpoch: binding.bindingEpoch, reason: "unsupported_event_format" }));
  const remaining = await getDb().select().from(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.state, "held"));
  assert.equal(remaining.length, beforeRace, "losing channel access before the transaction must not replay any event");
  assert.equal((await getDb().select().from(slackVerifiedIngressReplayAudits)).length, 102);
});


dbTest("card edit notices reach only the admins who can see the channel, one per pair and kind, only when asked, and only while they hold", async ({ seed }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const channel = await seed.channel({ server, members: [owner], visibility: "private" });
  const provider = fakeProvider().provider;
  const control = createSlackBridgeProvisioningControlPlane({ db: getDb(), bootstrap: BOOTSTRAP, provider });
  const now = new Date();
  const as = (userId: string) => ({ serverId: server.id, requestingUserId: userId, now, includeDeliveryHealth: true });
  await control.connect(as(owner.id));
  const { bindingFor } = await seedActiveInstall(server.id, owner.id, now);
  const [binding] = await getDb().insert(externalChannelBindings).values({
    ...bindingFor(channel.id, "C_SECRET", "private"), state: "active", stateReason: null, bindingEpoch: 2,
  }).returning();
  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
  // One delivery per card message at a pair epoch, and its sync in the given state.
  const syncAt = async (epoch: number, state: Partial<typeof externalCardEditSyncs.$inferInsert>) => {
    const message = await seed.message({ channel, author: owner, content: `private card text ${randomUUID()}` });
    const delivery = await getDb().transaction(async (tx) => {
      await tx.insert(externalDeliveryPartitions).values({ bindingId: binding.id, bindingEpoch: epoch })
        .onConflictDoNothing();
      const [partition] = await tx.update(externalDeliveryPartitions)
        .set({ lastEnqueuedPosition: sql`${externalDeliveryPartitions.lastEnqueuedPosition} + 1` })
        .where(and(eq(externalDeliveryPartitions.bindingId, binding.id), eq(externalDeliveryPartitions.bindingEpoch, epoch)))
        .returning();
      const [inserted] = await tx.insert(externalOutboundDeliveries).values({
        sourceMessageId: message.id, bindingId: binding.id, bindingEpoch: epoch, partitionPosition: partition!.lastEnqueuedPosition,
        enqueueRuntimeRevision: "runtime-test", renderSnapshotSchema: "slack-bridge-render-snapshot.v5", renderSnapshot: {},
        renderSnapshotDigest: createHash("sha256").update(message.id).digest("hex"),
        reconciliationMarker: createHash("sha256").update(message.id).digest("base64url").slice(0, 43),
      }).returning();
      return inserted!;
    });
    await getDb().insert(externalCardEditSyncs).values({ deliveryId: delivery.id, sourceMessageId: message.id,
      bindingId: binding.id, bindingEpoch: epoch, latestRevision: 2, ...state });
  };
  await syncAt(2, { holdReason: "slack_not_in_channel", retryCount: 1 });
  await syncAt(2, { uncertainAt: at(-60 * 60_000) });
  await syncAt(2, { uncertainAt: at(-60_000) }); // younger than T: not yet
  await syncAt(2, { state: "ended", endReason: "card_has_files", updatedAt: at(-15 * 24 * 60 * 60_000) }); // past the window
  await syncAt(1, { refusedRevision: 2, refusedReason: "msg_too_long" }); // another pair epoch
  await refreshSlackCardEditPairNotices(getDb(), { bindingId: binding.id, bindingEpoch: 2 }, at(-3000));
  // A stale row whose condition no longer holds (no sync qualifies) is never shown.
  await getDb().insert(externalCardEditPairNotices).values({ bindingId: binding.id, bindingEpoch: 2, kind: "latest_update_not_shown",
    lastSyncId: randomUUID(), firstRaisedAt: at(-1000), lastRaisedAt: at(-1000) });

  assert.equal(parsed(await control.load(as(owner.id))).snapshot.rawHealth!.cardEditNotices, undefined,
    "strict older clients keep their exact shape");
  const asked = parsed(await control.load({ ...as(owner.id), includeCardEditNotices: true }));
  assert.deepEqual(asked.snapshot.rawHealth!.cardEditNotices, [
    { raftChannelId: channel.id, bindingId: binding.id, kind: "not_confirmed", since: at(-3000).toISOString() },
    { raftChannelId: channel.id, bindingId: binding.id, kind: "edit_waiting", reason: "invite_app", since: at(-3000).toISOString() },
  ]);
  await getDb().update(serverMembers).set({ role: "admin" })
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, member.id)));
  const hidden = parsed(await control.load({ ...as(member.id), includeCardEditNotices: true }));
  assert.deepEqual(hidden.snapshot.rawHealth!.cardEditNotices, [], "an admin who cannot see the private channel does not get it");
  assert.ok(!JSON.stringify(hidden).includes(binding.id));
  assert.ok(!JSON.stringify(asked).includes("private card text"), "a notice never carries a card's content");
});
