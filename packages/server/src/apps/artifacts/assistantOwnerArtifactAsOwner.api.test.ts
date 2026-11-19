// A personal assistant publishing an Artifact AS its owner (#proj-assistant:#33; here, beside the app it publishes
// through, as core tests may not import an app; POST /internal/agent-api/assistant/owner-artifact/as-owner,
// services/assistantOwnerArtifactAsOwner.ts). Pins: only while "send as me" is on; the owner is the author, from the
// assistant's own record; a home the owner may post in, under send-as-owner's rules, every other one the same
// not-found; a new version only of one it published; a held push carries no comment text; one receipt per publish,
// worded for a new Artifact or a new version, with no Retract.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";
import { createApiTest } from "../../test/integration/apiTest";
import { getDb } from "../../db/index";
import {
  agents,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppServerGrants,
  externalChannelBindings,
  featureFlagRules,
  featureFlags,
  integrationAuditEvents,
  messages,
  oauthClients,
} from "../../db/schema";
import { createAgent } from "../../services/agentService";
import { mintAgentCredential } from "../../services/agentCredentialService";
import { setAssistantReadsDms } from "../../services/assistantDmScope";
import { setAssistantSendAsOwner } from "../../services/assistantSendAsOwnerService";
import { publishAsOwnerReceiptText } from "../../services/assistantOwnerArtifactAsOwner";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";
import { PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { addMember } from "../../services/serverService";
import { addHuman, createChannel, findOrCreateDM, findOrCreateUserDM } from "../../services/channelService";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { artifactComments, artifactItems, artifactVersions } from "./schema";
import { createServer, seedUser } from "../../routes/channels.api.fixtures";

const test = createApiTest();

afterEach(() => {
  __setArtifactR2StoreForTests(undefined);
});

function memoryR2(objects: Map<string, Buffer>): ArtifactR2Store {
  return {
    async put(key, bytes) { objects.set(key, bytes); },
    async delete(key) { objects.delete(key); },
    async read(blob) {
      const bytes = blob.r2Key ? objects.get(blob.r2Key) : undefined;
      return bytes ? { stream: Readable.from([bytes]), size: bytes.length } : null;
    },
    async presign() { return null; },
  };
}

async function seed() {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`ao-owner-${suffix}@slock.test`, `ao-owner-${suffix}`);
  const bob = await seedUser(`ao-bob-${suffix}@slock.test`, `ao-bob-${suffix}`);
  const server = await createServer("As Owner", `ao-${suffix}`, bob.id);
  await addMember(server.id, owner.id, "member");
  const serverId = asServerId(server.id);
  await getDb().insert(featureFlags).values({ key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false }).onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({ flagKey: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id] });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const assistant = await createAgent(server.id, `ao-helper-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  await getDb().update(agents).set({ assistantOwnerUserId: owner.id }).where(eq(agents.id, assistant.id));
  await setAssistantSendAsOwner(assistant.id, true);
  const { apiKey } = await mintAgentCredential({ agentId: assistant.id, scopes: ["read", "send"], name: "ao-test", issuedVia: "computer", createdByUserId: null });

  const design = await createChannel(server.id, `design-${suffix}`, undefined, "private");
  await addHuman(design.id, owner.id);
  await addHuman(design.id, bob.id);
  const bobsOwn = await createChannel(server.id, `bobs-${suffix}`, undefined, "private");
  await addHuman(bobsOwn.id, bob.id);
  const ownerWithBob = await findOrCreateUserDM(server.id, owner.id, bob.id);
  const ownDm = await findOrCreateDM(server.id, owner.id, assistant.id);
  __setArtifactR2StoreForTests(memoryR2(new Map()));
  return { suffix, owner, bob, server, serverId, assistant, apiKey, design, bobsOwn, ownerWithBobId: ownerWithBob!.id, ownDmId: ownDm!.id };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function publish(baseUrl: string, apiKey: string, body: Record<string, unknown>, path = "/assistant/owner-artifact/as-owner") {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> };
}

const files = (text: string) => [{ path: "index.html", content: `<h1>${text}</h1>` }];

async function audits(s: Seeded) {
  return (await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.actorId, s.assistant.id)))
    .filter((row) => row.eventType === "assistant.publish_artifact_as_owner");
}

async function receipts(s: Seeded): Promise<string[]> {
  const rows = await getDb().select({ content: messages.content, actionMetadata: messages.actionMetadata }).from(messages)
    .where(and(eq(messages.channelId, s.ownDmId), eq(messages.messageType, "system"), eq(messages.systemSubtype, "assistant.delegated_receipt")));
  for (const row of rows) assert.equal(row.actionMetadata ?? null, null, "no delegatedReceipt metadata: nothing to retract");
  return rows.map((row) => row.content);
}

test("a new Artifact as the owner: authored by the owner, marked as the assistant's, homed where named; one receipt; a new version, its own receipt", async ({ app }) => {
  const s = await seed();
  const made = await publish(app.baseUrl, s.apiKey, { home: `#design-${s.suffix}`, title: "Roadmap", files: files("Roadmap") });
  assert.ok(made.status === 200 || made.status === 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.home, { id: s.design.id, ref: `#design-${s.suffix}` });
  const id = made.body.artifact.id as string;
  const [row] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, id));
  assert.equal(row!.createdByType, "user");
  assert.equal(row!.createdById, s.owner.id);
  assert.equal(row!.publishedByAssistantAgentId, s.assistant.id);
  assert.equal(row!.homeChannelId, s.design.id);
  assert.deepEqual(await receipts(s), [`Published Roadmap in #design-${s.suffix} as you: ${made.body.artifact.url}`]);
  const [audit] = await audits(s);
  assert.equal(audit!.outcome, "success");
  assert.equal(audit!.source, "api");
  assert.equal(audit!.subjectType, "human");
  assert.equal(audit!.subjectId, s.owner.id);
  assert.equal(audit!.targetType, "channel");
  assert.equal(audit!.targetId, s.design.id);
  assert.deepEqual(audit!.metadata, { artifactId: id, version: 1, homeChannelId: s.design.id, newArtifact: true });

  const next = await publish(app.baseUrl, s.apiKey, { artifact: id, base: 1, files: files("Roadmap 2") });
  assert.ok(next.status === 200 || next.status === 201, JSON.stringify(next.body));
  assert.equal(next.body.artifact.version, 2);
  const [v2] = await getDb().select().from(artifactVersions).where(and(eq(artifactVersions.itemId, id), eq(artifactVersions.number, 2)));
  assert.equal(v2!.publisherType, "user");
  assert.equal(v2!.publisherId, s.owner.id);
  const lines = await receipts(s);
  assert.equal(lines.length, 2);
  assert.ok(lines.includes(`Published v2 of Roadmap in #design-${s.suffix} as you: ${next.body.artifact.url}`), JSON.stringify(lines));
  assert.deepEqual((await audits(s)).map((row) => row.metadata).find((m) => m.version === 2), { artifactId: id, version: 2, homeChannelId: s.design.id, newArtifact: false });

  // The same files again make no version, and no receipt.
  const same = await publish(app.baseUrl, s.apiKey, { artifact: id, base: 2, files: files("Roadmap 2") });
  assert.equal(same.body.artifact.unchanged, true, JSON.stringify(same.body));
  assert.equal((await receipts(s)).length, 2);
  assert.equal((await audits(s)).length, 2, "one audit per publish that made a version");
});

test("the receipt's two wordings: a new Artifact, a new version of one (Tenny, #33)", () => {
  assert.equal(publishAsOwnerReceiptText({ title: "Plan", where: "#design", url: "https://x/a", version: 1, newArtifact: true }), "Published Plan in #design as you: https://x/a");
  assert.equal(publishAsOwnerReceiptText({ title: "Plan", where: "#design", url: "https://x/a", version: 3, newArtifact: false }), "Published v3 of Plan in #design as you: https://x/a");
});

test("only while \"send as me\" is on, checked on every request; nothing written when off", async ({ app }) => {
  const s = await seed();
  await setAssistantSendAsOwner(s.assistant.id, false);
  const off = await publish(app.baseUrl, s.apiKey, { home: `#design-${s.suffix}`, title: "x", files: files("x") });
  assert.equal(off.status, 403, JSON.stringify(off.body));
  assert.equal(off.body.code, "assistant_send_as_owner_off");
  assert.equal((await getDb().select().from(artifactItems).where(eq(artifactItems.homeChannelId, s.design.id))).length, 0);
  assert.deepEqual(await receipts(s), []);
  assert.deepEqual(await audits(s), [], "no audit on a refusal");
});

test("every home it can't use is the same not-found: missing, one the owner isn't in, its own DM with the owner, a thread-less garbage id", async ({ app }) => {
  const s = await seed();
  const answers = [];
  for (const home of [`#nope-${s.suffix}`, `#bobs-${s.suffix}`, s.bobsOwn.id, s.ownDmId, randomUUID(), "not-an-id"]) {
    const res = await publish(app.baseUrl, s.apiKey, { home, title: "x", files: files("x") });
    assert.equal(res.status, 404, `${home}: ${JSON.stringify(res.body)}`);
    answers.push(res.body);
  }
  for (const body of answers) assert.deepEqual(body, answers[0], "one body for every reason");
  assert.equal(answers[0].code, "TARGET_NOT_FOUND");
  assert.deepEqual(await receipts(s), []);
});

test("a DM with someone else: only while the owner lets it read DMs (dm:@peer as the owner names it)", async ({ app }) => {
  const s = await seed();
  await setAssistantReadsDms(s.assistant.id, false);
  const closed = await publish(app.baseUrl, s.apiKey, { home: `dm:@${s.bob.name}`, title: "For Bob", files: files("Bob") });
  assert.equal(closed.status, 404, JSON.stringify(closed.body));
  assert.equal(closed.body.code, "TARGET_NOT_FOUND");
  await setAssistantReadsDms(s.assistant.id, true);
  const open = await publish(app.baseUrl, s.apiKey, { home: `dm:@${s.bob.name}`, title: "For Bob", files: files("Bob") });
  assert.ok(open.status === 200 || open.status === 201, JSON.stringify(open.body));
  assert.equal(open.body.home.id, s.ownerWithBobId);
  assert.equal(open.body.home.ref, `dm:@${s.bob.name}`);
});

test("never a conversation bridged to an external chat", async ({ app }) => {
  const s = await seed();
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [client] = await db.insert(oauthClients).values({
    serverId: s.server.id, clientId: `bridge-${suffix}`, clientSecretHash: "hash", appType: "slock_builtin", name: "Slack", createdByUserId: s.owner.id,
  }).returning();
  const [registration] = await db.insert(externalAppRegistrations).values({
    oauthClientId: client!.id, provider: "slack", environment: "test", providerAppId: `A_${suffix}`, providerOAuthClientId: `c-${suffix}`,
    capabilityManifestVersion: 1, capabilityManifestHash: "manifest", requiredCapabilities: [],
  }).returning();
  const [grant] = await db.insert(externalAppServerGrants).values({
    serverId: s.server.id, registrationId: registration!.id, state: "active", grantEpoch: 1, grantedManifestVersion: 1,
    grantedManifestHash: "manifest", grantedCapabilities: [], grantedByType: "human", grantedById: s.owner.id,
  }).returning();
  const [install] = await db.insert(externalAppInstalls).values({
    serverId: s.server.id, registrationId: registration!.id, serverGrantId: grant!.id, grantEpoch: 1, state: "active", connectionEpoch: 1,
    scopeRevision: 1, credentialRevision: 1, installedScopes: [], providerAppId: `A_${suffix}`, providerTeamId: `T_${suffix}`,
    authorityType: "team", providerAuthorityId: `T_${suffix}`, botUserId: "U_BOT", providerBotId: "B_BOT",
  }).returning();
  await db.insert(externalChannelBindings).values({
    serverId: s.server.id, registrationId: registration!.id, installId: install!.id, channelId: s.design.id,
    providerConversationId: `C_${suffix}`, providerConversationKind: "public_channel", privacyClass: "public", state: "active",
    grantEpoch: 1, connectionEpoch: 1, bindingEpoch: 1, consentedByType: "human", consentedById: s.owner.id, consentedAt: new Date(),
  });
  const bridged = await publish(app.baseUrl, s.apiKey, { home: `#design-${s.suffix}`, title: "x", files: files("x") });
  assert.equal(bridged.status, 404, JSON.stringify(bridged.body));
  assert.equal(bridged.body.code, "TARGET_NOT_FOUND");
});

test("the owner is the assistant's own: an owner or author named in the request is ignored", async ({ app }) => {
  const s = await seed();
  const made = await publish(app.baseUrl, s.apiKey, {
    home: `#design-${s.suffix}`, title: "Mine", files: files("Mine"),
    ownerUserId: s.bob.id, author: { type: "user", id: s.bob.id }, target: `#bobs-${s.suffix}`,
  });
  assert.ok(made.status === 200 || made.status === 201, JSON.stringify(made.body));
  const [row] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, made.body.artifact.id));
  assert.equal(row!.createdById, s.owner.id);
  assert.equal(row!.homeChannelId, s.design.id);
});

test("a new version only of one it published as the owner; home with artifact, or neither, is refused", async ({ app }) => {
  const s = await seed();
  // Bob's own Artifact in #design: the owner can see it, but the assistant didn't publish it.
  const bobs = await publish(app.baseUrl, s.apiKey, { home: `#design-${s.suffix}`, title: "Bob's", files: files("b") });
  await getDb().update(artifactItems).set({ publishedByAssistantAgentId: null, createdById: s.bob.id }).where(eq(artifactItems.id, bobs.body.artifact.id));
  const notMine = await publish(app.baseUrl, s.apiKey, { artifact: bobs.body.artifact.id, base: 1, files: files("mine now") });
  assert.equal(notMine.status, 403, JSON.stringify(notMine.body));
  assert.equal(notMine.body.code, "NOT_PUBLISHED_BY_ASSISTANT");
  const both = await publish(app.baseUrl, s.apiKey, { artifact: bobs.body.artifact.id, home: `#design-${s.suffix}`, base: 1, files: files("x") });
  assert.equal(both.status, 400, JSON.stringify(both.body));
  const neither = await publish(app.baseUrl, s.apiKey, { title: "x", files: files("x") });
  assert.equal(neither.status, 400, JSON.stringify(neither.body));
  assert.equal(neither.body.code, "HOME_REQUIRED");
  // One the owner can't see: the one not-found.
  const unseen = await publish(app.baseUrl, s.apiKey, { artifact: `pt_${randomUUID()}`, base: 1, files: files("x") });
  assert.equal(unseen.status, 404, JSON.stringify(unseen.body));
  assert.equal(unseen.body.code, "artifact_not_found");
});

test("a held push says no comment text: counts and the position only (Warden, #14679)", async ({ app }) => {
  const s = await seed();
  const made = await publish(app.baseUrl, s.apiKey, { home: `#design-${s.suffix}`, title: "Spec", files: files("1") });
  const id = made.body.artifact.id as string;
  const [version] = await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, id));
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, id));
  await getDb().insert(artifactComments).values({
    id: `c_${randomUUID()}`, itemId: id, versionId: version!.id, path: null, replyTo: null,
    authorType: "user", authorId: s.bob.id, body: "a private remark from bob", position: item!.lastPosition + 1,
  });
  await getDb().update(artifactItems).set({ lastPosition: item!.lastPosition + 1 }).where(eq(artifactItems.id, id));
  const held = await publish(app.baseUrl, s.apiKey, { artifact: id, base: 1, files: files("2") });
  assert.equal(held.status, 409, JSON.stringify(held.body));
  assert.equal(held.body.code, "UNSEEN_CHANGES");
  assert.doesNotMatch(JSON.stringify(held.body), /private remark/);
  assert.equal(held.body.details.unseen.commentCount, 1);
  assert.equal(held.body.details.unseen.comments, undefined);

  // Nothing was shown, so nothing counts as seen: the same request again is held again (Tenny, #33).
  const again = await publish(app.baseUrl, s.apiKey, { artifact: id, base: 1, files: files("2") });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.code, "UNSEEN_CHANGES");
  // With seen = the position it returned, it publishes.
  const seen = held.body.details.seen as number;
  assert.equal(typeof seen, "number");
  const through = await publish(app.baseUrl, s.apiKey, { artifact: id, base: 1, seen, files: files("2") });
  assert.ok(through.status === 200 || through.status === 201, JSON.stringify(through.body));
  assert.equal(through.body.artifact.version, 2);
});
