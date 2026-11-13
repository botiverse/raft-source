// A personal assistant reading an Artifact as its owner (#proj-assistant:#31; here, beside the app it reads through, as core tests may not import an app;
// GET /internal/agent-api/assistant/owner-artifact, services/assistantOwnerArtifacts.ts).
// Pins: it answers what the owner could open on the web (Artifacts'
// readArtifactAsUser) and nothing more; an Artifact the owner can't open, one
// in a DM while the owner keeps DMs from it, and any Artifact once the owner
// left the server read as the one not-found; its own DM with the owner always
// reads; the home is named as the owner sees it; the versions listed are the
// owner's; nothing is written (no read position, no follow).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { AGENT_API_ARTIFACT_COMMENTS_PAGE_LIMIT, asServerId, type ServerId } from "@botiverse/raft-shared";
import { createApiTest } from "../../test/integration/apiTest";
import { __setAgentApiWriteBudgetsForTests } from "../../services/agentApiWriteLimits";
import { getDb } from "../../db/index";
import { agents, featureFlagRules, featureFlags, serverMembers } from "../../db/schema";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { setAssistantReadsDms } from "../../services/assistantDmScope";
import { readOwnerArtifact } from "../../services/assistantOwnerArtifacts";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";
import { PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { addMember, removeMember } from "../../services/serverService";
import { addHuman, createChannel, findOrCreateDM, findOrCreateUserDM, removeHuman } from "../../services/channelService";
import { __setArtifactR2StoreForTests, r2KeyOf, type ArtifactR2Store } from "./blobStore";
import { readArtifactAsUser } from "./readAsUser";
import {
  artifactBlobs,
  artifactComments,
  artifactItems,
  artifactReadPositions,
  artifactSubscriptions,
  artifactVersionFiles,
  artifactVersions,
} from "./schema";
import { createServer, seedUser } from "../../routes/channels.api.fixtures";

const test = createApiTest();

afterEach(() => {
  __setArtifactR2StoreForTests(undefined);
});

type Actor = { type: "user" | "agent"; id: string };

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

/** An Artifact homed in `channelId` with `versions` published versions of one index.html each ("<h1>vN</h1>"). */
async function artifactIn(world: { serverId: ServerId; r2: Map<string, Buffer> }, channelId: string | null, author: Actor, versions = 1) {
  const db = getDb();
  const id = `pt_${randomUUID()}`;
  await db.insert(artifactItems).values({
    id,
    serverId: world.serverId,
    urlKey: id,
    name: `art-${randomUUID().slice(0, 8)}`,
    title: `Plan ${id.slice(3, 11)}`,
    description: null,
    homeKind: channelId ? "conversation" : "server",
    homeChannelId: channelId,
    createdByType: author.type,
    createdById: author.id,
  });
  for (let number = 1; number <= versions; number += 1) {
    const bytes = Buffer.from(`<h1>v${number}</h1>`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const blobId = `b_${randomUUID()}`;
    const r2Key = r2KeyOf(world.serverId, sha256, blobId);
    await db.insert(artifactBlobs).values({ id: blobId, serverId: world.serverId, sha256, sizeBytes: bytes.length, r2Key }).onConflictDoNothing();
    const [blob] = await db.select().from(artifactBlobs).where(and(eq(artifactBlobs.serverId, world.serverId), eq(artifactBlobs.sha256, sha256)));
    world.r2.set(blob!.r2Key!, bytes);
    const versionId = `v_${randomUUID()}`;
    await db.insert(artifactVersions).values({
      id: versionId,
      itemId: id,
      number,
      entry: "index.html",
      fileCount: 1,
      sizeBytes: bytes.length,
      publishDigest: `digest-${number}`,
      status: "published",
      publisherType: author.type,
      publisherId: author.id,
      position: number,
    });
    await db.insert(artifactVersionFiles).values({ versionId, path: "index.html", sha256, sizeBytes: bytes.length, blobId: blob!.id });
    await db.update(artifactItems).set({ currentVersionId: versionId, lastPosition: number }).where(eq(artifactItems.id, id));
  }
  return id;
}

async function seed() {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`oa-owner-${suffix}@slock.test`, `oa-owner-${suffix}`);
  const bob = await seedUser(`oa-bob-${suffix}@slock.test`, `oa-bob-${suffix}`);
  const server = await createServer("Owner Artifacts", `oa-${suffix}`, bob.id);
  await addMember(server.id, owner.id, "member");
  const serverId = asServerId(server.id);
  await getDb().insert(featureFlags).values({ key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false }).onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({ flagKey: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id] });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const assistant = await createAgent(server.id, `oa-helper-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  await getDb().update(agents).set({ assistantOwnerUserId: owner.id }).where(eq(agents.id, assistant.id));
  const { apiKey } = await mintAgentCredential({ agentId: assistant.id, scopes: ["read", "send"], name: "oa-test", issuedVia: "computer", createdByUserId: null });

  const design = await createChannel(server.id, `design-${suffix}`, undefined, "private");
  await addHuman(design.id, owner.id);
  await addHuman(design.id, bob.id);
  const bobsOwn = await createChannel(server.id, `bobs-${suffix}`, undefined, "private");
  await addHuman(bobsOwn.id, bob.id);
  const ownersOwn = await createChannel(server.id, `owners-${suffix}`, undefined, "private");
  await addHuman(ownersOwn.id, owner.id);
  const ownerWithBob = await findOrCreateUserDM(server.id, owner.id, bob.id);
  const ownerWithAssistant = await findOrCreateDM(server.id, owner.id, assistant.id);

  const r2 = new Map<string, Buffer>();
  __setArtifactR2StoreForTests(memoryR2(r2));
  const world = { serverId, r2 };
  const byBob: Actor = { type: "user", id: bob.id };
  const byAssistant: Actor = { type: "agent", id: assistant.id };
  return {
    suffix, owner, bob, server, serverId, assistant, apiKey, design,
    inDesign: await artifactIn(world, design.id, byBob, 2),
    inBobsOwn: await artifactIn(world, bobsOwn.id, byBob),
    inOwnerDm: await artifactIn(world, ownerWithBob!.id, byBob),
    inAssistantDm: await artifactIn(world, ownerWithAssistant!.id, byAssistant),
    inServer: await artifactIn(world, null, byBob),
    inOwnersOwn: await artifactIn(world, ownersOwn.id, byBob),
    ownerWithAssistantId: ownerWithAssistant!.id,
  };
}

async function readAs(baseUrl: string, apiKey: string, query: Record<string, string>) {
  const res = await fetch(`${baseUrl}/internal/agent-api/assistant/owner-artifact?${new URLSearchParams(query)}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> };
}

test("an Artifact the owner can open: its card, home as the owner names it, versions, the entry file; by id or by link; nothing written", async ({ app }) => {
  const s = await seed();
  const byId = await readAs(app.baseUrl, s.apiKey, { artifact: s.inDesign });
  assert.equal(byId.status, 200, JSON.stringify(byId.body));
  assert.equal(byId.body.owner.userId, s.owner.id);
  assert.equal(byId.body.artifact.id, s.inDesign);
  assert.deepEqual(byId.body.artifact.home, { kind: "conversation", conversation: { id: byId.body.artifact.home.conversation.id, type: "private", target: `#design-${s.suffix}` } });
  assert.equal(byId.body.artifact.version, 2);
  // Every comment is in the answer (none), so where it stood is given, as the item row has it.
  const [itemRow] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, s.inDesign));
  assert.equal(byId.body.artifact.position, itemRow!.lastPosition);
  assert.deepEqual(byId.body.versions.map((v: { number: number }) => v.number), [2, 1]);
  assert.equal(byId.body.file.kind, "text");
  assert.equal(byId.body.file.path, "index.html");
  assert.equal(byId.body.file.content, "<h1>v2</h1>");
  assert.deepEqual(byId.body.comments.items, []);
  assert.equal(byId.body.comments.olderCursor, null);
  assert.equal(typeof byId.body.comments.newestPosition, "number");

  // A link to version 1 reads version 1.
  const byLink = await readAs(app.baseUrl, s.apiKey, { artifact: `${byId.body.artifact.url.replace(/\/v\/\d+$/, "")}/v/1` });
  assert.equal(byLink.status, 200, JSON.stringify(byLink.body));
  assert.equal(byLink.body.file.content, "<h1>v1</h1>");

  // The versions are the owner's, as the web gives them.
  const asOwner = await readArtifactAsUser({ serverId: s.serverId, userId: s.owner.id, ref: s.inDesign });
  assert.equal(asOwner.kind, "json");
  if (asOwner.kind === "json") assert.deepEqual(byId.body.versions.map((v: { number: number }) => v.number), asOwner.body.versions.map((v) => v.number));

  // Nothing written for the owner or the assistant.
  assert.equal((await getDb().select().from(artifactReadPositions).where(eq(artifactReadPositions.itemId, s.inDesign))).length, 0);
  assert.equal((await getDb().select().from(artifactSubscriptions).where(eq(artifactSubscriptions.itemId, s.inDesign))).length, 0);
});

test("one the owner can't open, an unknown id and a title all read as the one not-found", async ({ app }) => {
  const s = await seed();
  for (const artifact of [s.inBobsOwn, `pt_${randomUUID()}`, "Plan"]) {
    const res = await readAs(app.baseUrl, s.apiKey, { artifact });
    assert.equal(res.status, 404, `${artifact}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "artifact_not_found");
  }
});

test("a DM: the owner's DM with someone only while they let it read DMs (named dm:@peer); its own DM with the owner always", async ({ app }) => {
  const s = await seed();
  await setAssistantReadsDms(s.assistant.id, false);
  const hidden = await readAs(app.baseUrl, s.apiKey, { artifact: s.inOwnerDm });
  assert.equal(hidden.status, 404, JSON.stringify(hidden.body));
  assert.equal(hidden.body.code, "artifact_not_found");
  const own = await readAs(app.baseUrl, s.apiKey, { artifact: s.inAssistantDm });
  assert.equal(own.status, 200, JSON.stringify(own.body));

  await setAssistantReadsDms(s.assistant.id, true);
  const shown = await readAs(app.baseUrl, s.apiKey, { artifact: s.inOwnerDm });
  assert.equal(shown.status, 200, JSON.stringify(shown.body));
  assert.equal(shown.body.artifact.home.conversation.type, "dm");
  assert.equal(shown.body.artifact.home.conversation.target, `dm:@${s.bob.name}`);
});

test("once the owner left the server, nothing reads", async ({ app }) => {
  const s = await seed();
  assert.equal((await readAs(app.baseUrl, s.apiKey, { artifact: s.inDesign })).status, 200);
  await removeMember(s.server.id, s.owner.id);
  // Leaving the server ends the assistant's credential (its departure) ...
  const after = await readAs(app.baseUrl, s.apiKey, { artifact: s.inDesign });
  assert.equal(after.status, 401, JSON.stringify(after.body));
});

test("the read itself checks the owner is still a member: readArtifactAsUser runs outside requireServer (Tenny, #31)", async ({ app: _app }) => {
  const s = await seed();
  // One everyone in the server can open: nothing but membership stands between it and a former member.
  const input = { agentId: s.assistant.id, serverId: s.serverId, ownerUserId: s.owner.id, ref: s.inServer };
  assert.equal((await readOwnerArtifact(input)).ok, true);
  // ... and the read refuses on the membership alone, whatever the credential.
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, s.server.id), eq(serverMembers.userId, s.owner.id)));
  const result = await readOwnerArtifact(input);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "artifact_not_found");
});

test("a version that isn't there and a file that isn't there keep Artifacts' own refusals", async ({ app }) => {
  const s = await seed();
  const version = await readAs(app.baseUrl, s.apiKey, { artifact: s.inDesign, version: "9" });
  assert.equal(version.status, 404, JSON.stringify(version.body));
  assert.equal(version.body.code, "VERSION_NOT_FOUND");
  const file = await readAs(app.baseUrl, s.apiKey, { artifact: s.inDesign, path: "nope.html" });
  assert.equal(file.status, 404, JSON.stringify(file.body));
  assert.equal(file.body.code, "FILE_NOT_FOUND");
});

test("comments: text as sent; with more than one page, position is null (the newest page alone is not every comment seen)", async ({ app }) => {
  const s = await seed();
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, s.inDesign));
  const [version] = await getDb().select().from(artifactVersions).where(eq(artifactVersions.id, item!.currentVersionId!));
  const add = async (count: number) => {
    const [row] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, s.inDesign));
    const from = row!.lastPosition;
    await getDb().insert(artifactComments).values(Array.from({ length: count }, (_, index) => ({
      id: `c_${String(from + index).padStart(4, "0")}-${randomUUID()}`,
      itemId: s.inDesign,
      versionId: version!.id,
      path: null,
      replyTo: null,
      authorType: "user" as const,
      authorId: s.bob.id,
      body: `note ${from + index}`,
      position: from + index + 1,
    })));
    await getDb().update(artifactItems).set({ lastPosition: from + count }).where(eq(artifactItems.id, s.inDesign));
  };
  await add(1);
  const one = await readAs(app.baseUrl, s.apiKey, { artifact: s.inDesign });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.comments.items.length, 1);
  assert.match(one.body.comments.items[0].body, /^note \d+$/);
  assert.equal(one.body.comments.items[0].author.name, s.bob.name);
  assert.equal(one.body.comments.olderCursor, null);
  assert.equal(typeof one.body.artifact.position, "number");

  await add(AGENT_API_ARTIFACT_COMMENTS_PAGE_LIMIT);
  const paged = await readAs(app.baseUrl, s.apiKey, { artifact: s.inDesign });
  assert.equal(paged.status, 200, JSON.stringify(paged.body));
  assert.notEqual(paged.body.comments.olderCursor, null);
  assert.equal(paged.body.artifact.position, null);
  // Each page says where the Artifact stood when read; an older page gives no position of its own (Remy, #14633).
  assert.equal(typeof paged.body.comments.newestPosition, "number");
  const older = await readAs(app.baseUrl, s.apiKey, { artifact: s.inDesign, commentsBefore: paged.body.comments.olderCursor });
  assert.equal(older.status, 200, JSON.stringify(older.body));
  assert.equal(older.body.comments.olderCursor, null);
  assert.ok(older.body.comments.items.length >= 1);
  assert.equal(older.body.artifact.position, null, "the oldest page's own position may cover comments posted while paging");
});

test("paging back: the first page's newestPosition as seen still holds a publish for a comment posted while paging (Remy, #14633)", async ({ app }) => {
  const s = await seed();
  const made = await publishAs(app.baseUrl, s.apiKey, { title: "Digest", files: [{ path: "index.html", content: "<h1>1</h1>" }] });
  const id = made.body.artifact.id as string;
  const [version] = await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, id));
  const comment = async (count: number) => {
    const [row] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, id));
    const from = row!.lastPosition;
    await getDb().insert(artifactComments).values(Array.from({ length: count }, (_, index) => ({
      id: `c_${String(from + index).padStart(4, "0")}-${randomUUID()}`,
      itemId: id, versionId: version!.id, path: null, replyTo: null,
      authorType: "user" as const, authorId: s.owner.id, body: `owner note ${from + index}`, position: from + index + 1,
    })));
    await getDb().update(artifactItems).set({ lastPosition: from + count }).where(eq(artifactItems.id, id));
  };
  await comment(AGENT_API_ARTIFACT_COMMENTS_PAGE_LIMIT + 1);
  const first = await readAs(app.baseUrl, s.apiKey, { artifact: id });
  assert.notEqual(first.body.comments.olderCursor, null);
  const seen = first.body.comments.newestPosition as number;
  await comment(1); // posted while the assistant pages back
  const oldest = await readAs(app.baseUrl, s.apiKey, { artifact: id, commentsBefore: first.body.comments.olderCursor });
  assert.equal(oldest.body.comments.olderCursor, null);
  const held = await publishAs(app.baseUrl, s.apiKey, { artifact: id, base: 1, seen, files: [{ path: "index.html", content: "<h1>2</h1>" }] });
  assert.equal(held.status, 409, JSON.stringify(held.body));
  assert.equal(held.body.code, "UNSEEN_CHANGES");
});

test("a hidden DM's Artifact is the one not-found whatever else is asked: a version, a file, a bad path (Warden, #14494)", async ({ app }) => {
  const s = await seed();
  await setAssistantReadsDms(s.assistant.id, false);
  for (const query of [{ version: "9" }, { version: "1" }, { path: "nope.html" }, { path: "../x" }] as Array<Record<string, string>>) {
    const res = await readAs(app.baseUrl, s.apiKey, { artifact: s.inOwnerDm, ...query });
    assert.equal(res.status, 404, `${JSON.stringify(query)}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "artifact_not_found", JSON.stringify(query));
  }
});

test("only a personal assistant, only where they're on: an ordinary agent and the flag off are refused", async ({ app }) => {
  const s = await seed();
  const plain = await createAgent(s.server.id, `oa-plain-${s.suffix}`, { runtime: "codex", creatorType: "user", creatorId: s.owner.id });
  const { apiKey } = await mintAgentCredential({ agentId: plain.id, scopes: ["read", "send"], name: "oa-plain", issuedVia: "computer", createdByUserId: null });
  const ordinary = await readAs(app.baseUrl, apiKey, { artifact: s.inDesign });
  assert.equal(ordinary.status, 403, JSON.stringify(ordinary.body));
  await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
  const off = await readAs(app.baseUrl, s.apiKey, { artifact: s.inDesign });
  assert.notEqual(off.status, 200, JSON.stringify(off.body));
});

test("an owner taken out of the channel after a read can no longer read there; a guest owner reads nothing", async ({ app }) => {
  const s = await seed();
  assert.equal((await readAs(app.baseUrl, s.apiKey, { artifact: s.inDesign })).status, 200);
  await removeHuman(s.design.id, s.owner.id, { self: true });
  const after = await readAs(app.baseUrl, s.apiKey, { artifact: s.inDesign });
  assert.equal(after.status, 404, JSON.stringify(after.body));
  assert.equal(after.body.code, "artifact_not_found");

  // The service refuses a guest owner itself, whatever the route in front of it does.
  const input = { agentId: s.assistant.id, serverId: s.serverId, ownerUserId: s.owner.id, ref: s.inServer };
  assert.equal((await readOwnerArtifact(input)).ok, true);
  await getDb().update(serverMembers).set({ role: "guest", guestChannelId: s.design.id }).where(and(eq(serverMembers.serverId, s.server.id), eq(serverMembers.userId, s.owner.id)));
  const guest = await readOwnerArtifact(input);
  assert.equal(guest.ok, false);
});

async function publishAs(baseUrl: string, apiKey: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/internal/agent-api/assistant/owner-artifact`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> };
}

test("publish: a new Artifact as the assistant, in its DM with its owner, marked; a new version of it; the owner reads it", async ({ app }) => {
  const s = await seed();
  const made = await publishAs(app.baseUrl, s.apiKey, { title: "Weekly digest", files: [{ path: "index.html", content: "<h1>Digest</h1>" }] });
  assert.ok(made.status === 200 || made.status === 201, JSON.stringify(made.body));
  assert.equal(made.body.artifact.version, 1);
  assert.equal(made.body.artifact.unchanged, false);
  assert.equal(made.body.artifact.homeConversationId, s.ownerWithAssistantId);
  const [row] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, made.body.artifact.id));
  assert.equal(row!.publishedByAssistantAgentId, s.assistant.id);
  assert.equal(row!.createdByType, "agent");
  assert.equal(row!.createdById, s.assistant.id);

  const next = await publishAs(app.baseUrl, s.apiKey, { artifact: made.body.artifact.id, base: 1, note: "v2", files: [{ path: "index.html", content: "<h1>Digest 2</h1>" }] });
  assert.ok(next.status === 200 || next.status === 201, JSON.stringify(next.body));
  assert.equal(next.body.artifact.version, 2);

  const asOwner = await readArtifactAsUser({ serverId: s.serverId, userId: s.owner.id, ref: made.body.artifact.id });
  assert.equal(asOwner.kind, "json");
  if (asOwner.kind === "json") assert.equal(asOwner.body.file.kind === "text" && asOwner.body.file.text, "<h1>Digest 2</h1>");
});

test("publish: never a new version of an Artifact it didn't publish; files not inline are refused; a new one needs a title", async ({ app }) => {
  const s = await seed();
  // In its own DM, so it can see it, but not marked as its own (as one its owner or another agent put there).
  const unmarked = await publishAs(app.baseUrl, s.apiKey, { artifact: s.inAssistantDm, base: 1, files: [{ path: "index.html", content: "<h1>mine now</h1>" }] });
  assert.equal(unmarked.status, 403, JSON.stringify(unmarked.body));
  assert.equal(unmarked.body.code, "NOT_PUBLISHED_BY_ASSISTANT");
  // One where it isn't (its owner's #design): not found, before anything is said about whose it is.
  for (const artifact of [s.inDesign, s.inBobsOwn]) {
    const unseen = await publishAs(app.baseUrl, s.apiKey, { artifact, base: 1, files: [] });
    assert.equal(unseen.status, 404, JSON.stringify(unseen.body));
    assert.equal(unseen.body.code, "artifact_not_found");
  }
  const bySha = await publishAs(app.baseUrl, s.apiKey, { title: "x", files: [{ path: "a.bin", sha256: "0".repeat(64), size: 3 }] });
  assert.equal(bySha.status, 400, JSON.stringify(bySha.body));
  assert.equal(bySha.body.code, "FILES_NOT_INLINE");
  const untitled = await publishAs(app.baseUrl, s.apiKey, { files: [{ path: "notes.md", content: "no title" }] });
  assert.equal(untitled.status, 400, JSON.stringify(untitled.body));
});

test("an assistant given to another owner reads as the new owner from the next request (Warden, #14494)", async ({ app }) => {
  const s = await seed();
  assert.equal((await readAs(app.baseUrl, s.apiKey, { artifact: s.inOwnersOwn })).status, 200);
  assert.equal((await readAs(app.baseUrl, s.apiKey, { artifact: s.inBobsOwn })).status, 404);
  await getDb().update(agents).set({ assistantOwnerUserId: s.bob.id }).where(eq(agents.id, s.assistant.id));
  const old = await readAs(app.baseUrl, s.apiKey, { artifact: s.inOwnersOwn });
  assert.equal(old.status, 404, JSON.stringify(old.body));
  const now = await readAs(app.baseUrl, s.apiKey, { artifact: s.inBobsOwn });
  assert.equal(now.status, 200, JSON.stringify(now.body));
  assert.equal(now.body.owner.userId, s.bob.id);
});

test("publish: no new version into its old owner's DM after a reassignment, nor of one moved out of the DM (Warden, #14524)", async ({ app }) => {
  const s = await seed();
  const made = await publishAs(app.baseUrl, s.apiKey, { title: "Plan", files: [{ path: "index.html", content: "<h1>1</h1>" }] });
  assert.ok(made.status === 200 || made.status === 201, JSON.stringify(made.body));
  const id = made.body.artifact.id as string;

  // Moved out of the DM to the whole server, where the assistant still sees it: marked, still its own, but no
  // longer where it may publish (only the home check stops it here).
  await getDb().update(artifactItems).set({ homeKind: "server", homeChannelId: null }).where(eq(artifactItems.id, id));
  const movedOut = await publishAs(app.baseUrl, s.apiKey, { artifact: id, base: 1, files: [{ path: "index.html", content: "<h1>2</h1>" }] });
  assert.equal(movedOut.status, 404, JSON.stringify(movedOut.body));
  assert.equal(movedOut.body.code, "artifact_not_found");
  await getDb().update(artifactItems).set({ homeKind: "conversation", homeChannelId: s.ownerWithAssistantId }).where(eq(artifactItems.id, id));

  // Given to bob: its old DM with its first owner is no longer its owner's DM.
  await getDb().update(agents).set({ assistantOwnerUserId: s.bob.id }).where(eq(agents.id, s.assistant.id));
  const afterReassign = await publishAs(app.baseUrl, s.apiKey, { artifact: id, base: 1, files: [{ path: "index.html", content: "<h1>2</h1>" }] });
  assert.equal(afterReassign.status, 404, JSON.stringify(afterReassign.body));
  assert.equal(afterReassign.body.code, "artifact_not_found");
  const [row] = await getDb().select().from(artifactVersions).where(and(eq(artifactVersions.itemId, id), eq(artifactVersions.number, 2)));
  assert.equal(row, undefined, "no second version");
});

test("publish: a smuggled target is not a home; an unseen Artifact is the one not-found whatever else is sent; a version needs base", async ({ app }) => {
  const s = await seed();
  const smuggled = await publishAs(app.baseUrl, s.apiKey, { title: "Elsewhere?", target: `#design-${s.suffix}`, files: [{ path: "index.html", content: "<h1>x</h1>" }] });
  assert.ok(smuggled.status === 200 || smuggled.status === 201, JSON.stringify(smuggled.body));
  assert.equal(smuggled.body.artifact.homeConversationId, s.ownerWithAssistantId);

  for (const extra of [{ base: 99 }, { base: 1, seen: 5 }, { base: 1, files: [{ path: "a.bin", sha256: "0".repeat(64), size: 3 }] }]) {
    const res = await publishAs(app.baseUrl, s.apiKey, { artifact: s.inBobsOwn, files: [], ...extra });
    assert.equal(res.status, 404, `${JSON.stringify(extra)}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "artifact_not_found");
  }

  const noBase = await publishAs(app.baseUrl, s.apiKey, { artifact: smuggled.body.artifact.id, files: [{ path: "index.html", content: "<h1>y</h1>" }] });
  assert.equal(noBase.status, 400, JSON.stringify(noBase.body));
});

test("publish counts on the Artifacts write budget: past it, 429 with when to try again", async ({ app }) => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "assistant-artifact-write-limit-tests-hmac-0123456789");
  __setAgentApiWriteBudgetsForTests({ artifactWrites: { perAgent: 1, perServer: 100 } });
  try {
    const s = await seed();
    const first = await publishAs(app.baseUrl, s.apiKey, { title: "One", files: [{ path: "index.html", content: "<h1>1</h1>" }] });
    assert.ok(first.status === 200 || first.status === 201, JSON.stringify(first.body));
    const second = await publishAs(app.baseUrl, s.apiKey, { title: "Two", files: [{ path: "index.html", content: "<h1>2</h1>" }] });
    assert.equal(second.status, 429, JSON.stringify(second.body));
    assert.equal(second.body.code, "RATE_LIMITED");
  } finally {
    __setAgentApiWriteBudgetsForTests(null);
    vi.unstubAllEnvs();
  }
});
