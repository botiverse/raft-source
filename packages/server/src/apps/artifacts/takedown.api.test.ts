// Taking an Artifact down and restoring it (takedown.ts): `POST
// /api/artifacts/:id/takedown` and `/restore` over HTTP with real user
// tokens, and the service for the operator's path. Proves who may (the
// owners and admins of the Artifact's own server, and a Raft operator; never
// its author, a member, a guest, an agent or another server), that every
// read refuses a taken-down Artifact as a deleted one and reads it again
// after a restore, the audit rows, and that both are idempotent.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  SERVER_GUEST_FEATURE_FLAG_KEY,
  artifactPublicPaths,
  artifactWebPaths,
  asArtifactId,
  asServerId,
  objectWebPaths,
  webSearchPath,
  type ServerId,
} from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { featureFlagRules, objectInboxStates, serverMembers } from "../../db/schema";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { addMember } from "../../services/serverService";
import { seedBoundGuest } from "../../test/guestFixture";
import { createApiTest } from "../../test/integration/apiTest";
import { accessTokenForTest, signInForTest } from "../../test/integration/credentials";
import type { createSeed } from "../../test/integration/seed";
import { recordArtifactEvent } from "./events";
import { ARTIFACT_OPS_IMPORT_ACTOR, ARTIFACT_OPS_MODERATION_ACTOR } from "./import";
import { mayManageArtifact } from "./manage";
import { artifactAudit, artifactItems, artifactPendingNotices, artifactSubscriptions, artifactVersions } from "./schema";
import { indexArtifactSearch } from "./search";
import { restoreArtifact, takedownArtifact } from "./takedown";
import { webNotVisible } from "./webCommon";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();

const RAFT_TOKEN = "r".repeat(40);
beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-takedown-tests-hmac-secret-0123456789");
  vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", RAFT_TOKEN);
  vi.stubEnv("ARTIFACTS_CONTENT_WORKER_TOKEN", "w".repeat(40));
  vi.stubEnv("ARTIFACTS_CONTENT_DOMAIN", "content.example.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
const label = () => randomUUID().slice(0, 8);

type Actor = { type: "user" | "agent"; id: string };

/** A published Artifact (v1 and v2, v2 current) with its search row, as publishing leaves it. */
async function artifact(input: { serverId: ServerId; author: Actor; homeChannelId?: string; serverHome?: boolean; name?: string; title?: string }) {
  const db = getDb();
  const id = `pt_${randomUUID()}`;
  await db.insert(artifactItems).values({
    id,
    serverId: input.serverId,
    urlKey: id,
    name: input.name ?? `art-${label()}`,
    title: input.title ?? `Takedown ${label()}`,
    homeKind: input.homeChannelId ? "conversation" : input.serverHome ? "server" : "public",
    homeChannelId: input.homeChannelId ?? null,
    originalHomeChannelId: input.homeChannelId ?? null,
    createdByType: input.author.type,
    createdById: input.author.id,
  });
  const versions = [];
  for (const number of [1, 2]) {
    const [version] = await db.insert(artifactVersions).values({
      id: `v_${randomUUID()}`, itemId: id, number, entry: "index.html", fileCount: 1, sizeBytes: 10, publishDigest: "digest",
      status: "published", publisherType: input.author.type, publisherId: input.author.id, position: number,
    }).returning();
    versions.push(version!);
  }
  const [item] = await db.update(artifactItems).set({ currentVersionId: versions[1]!.id, lastPosition: 2 }).where(eq(artifactItems.id, id)).returning();
  await indexArtifactSearch(db, item!);
  return { item: item!, v1: versions[0]!, v2: versions[1]! };
}

/**
 * A server (Artifacts on): owner and admin, in no channel; author, member and a
 * guest; agent A (made by the author) in #room (private: author, member,
 * agent A). A peer server, whose owner is peerUser and of which
 * the author is a member too.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const admin = await seed.human();
  const author = await seed.human();
  const member = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner, members: [admin, author, member, guest] });
  const serverId = asServerId(server.id);
  const role = (userId: string, to: "admin") =>
    getDb().update(serverMembers).set({ role: to }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, userId)));
  await role(admin.id, "admin");
  const peerUser = await seed.human();
  const peer = await seed.server({ owner: peerUser });
  await addMember(peer.id, author.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  await getDb().insert(featureFlagRules).values([
    { flagKey: SERVER_GUEST_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id] },
  ]);
  const agentA = await createAgent(server.id, `td-a-${label()}`, { runtime: "claude", model: "sonnet", creatorType: "user", creatorId: author.id });
  const room = await createChannel(server.id, `td-room-${label()}`, undefined, "private");
  // The guest's one channel is #room (#wg-rbac:#15); it joins it below like the others.
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: room.id, member: false });
  for (const human of [author, member, guest]) await addHuman(room.id, human.id);
  await addAgent(room.id, agentA.id);
  // Signed in when first used (a real session family), not for every seeded world.
  const as = (userId: string, sid: string = server.id): Who => {
    let token: Promise<string> | undefined;
    return { get token() { return (token ??= accessTokenForTest(userId)); }, serverId: sid };
  };
  return {
    server, serverId, peer, owner, admin, author, member, guest, peerUser, agentA, room,
    byAuthor: { type: "user", id: author.id } as Actor,
    byAgent: { type: "agent", id: agentA.id } as Actor,
    who: { owner: as(owner.id), admin: as(admin.id), author: as(author.id), member: as(member.id), guest: as(guest.id), peerUser: as(peerUser.id, peer.id), authorInPeer: as(author.id, peer.id) },
    make: (input: { author: Actor; homeChannelId?: string; serverHome?: boolean; name?: string; title?: string }) => artifact({ serverId, ...input }),
    view: (userId: string) => ({ type: "user" as const, id: userId, serverId }),
  };
}

type Who = { token: string | Promise<string>; serverId: string };
type Reply = { status: number; body: any };

async function call(app: { baseUrl: string }, method: string, path: string, who: Who | null, body?: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...(who ? { Authorization: `Bearer ${await who.token}`, "X-Server-Id": who.serverId } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const takedown = (app: { baseUrl: string }, who: Who, id: string, body: unknown = { reason: "report #1: phishing" }) =>
  call(app, "POST", artifactWebPaths.takedown(asArtifactId(id)), who, body);
const restore = (app: { baseUrl: string }, who: Who, id: string, body: unknown = { reason: "appeal upheld" }) =>
  call(app, "POST", artifactWebPaths.restore(asArtifactId(id)), who, body);
const rowOf = async (id: string) => (await getDb().select().from(artifactItems).where(eq(artifactItems.id, id)))[0]!;
const auditOf = (id: string) => getDb().select().from(artifactAudit).where(eq(artifactAudit.itemId, id)).orderBy(artifactAudit.id);
const versionsOfItem = (id: string) => getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, id)).orderBy(artifactVersions.number);
// The one 404 body, the web's and the signed-out routes' alike.
const NOT_VISIBLE = webNotVisible().body;

async function untouched(id: string, message: string) {
  assert.equal((await rowOf(id)).revokedAt, null, message);
  assert.deepEqual(await auditOf(id), [], `${message}: no audit row`);
}

// ---- who may ----------------------------------------------------------------------

test("who may moderate: the server's owners and admins only; never its author, an agent's manager, a member, a guest, an agent or another server", async ({ seed }) => {
  const world = await seedWorld(seed);
  const { item } = await world.make({ author: world.byAuthor });
  const { item: byAgent } = await world.make({ author: world.byAgent, homeChannelId: world.room.id });
  const may = (actor: Parameters<typeof mayManageArtifact>[0], of = item) => mayManageArtifact(actor, of, "moderate");
  assert.equal(await may(world.view(world.owner.id)), true, "owner");
  assert.equal(await may(world.view(world.admin.id)), true, "admin");
  assert.equal(await may(world.view(world.author.id)), false, "its author");
  assert.equal(await may(world.view(world.author.id), byAgent), false, "its agent author's manager");
  assert.equal(await may(world.view(world.member.id)), false, "a member");
  assert.equal(await may(world.view(world.guest.id)), false, "a guest");
  assert.equal(await may({ type: "agent", id: world.agentA.id, serverId: world.serverId }, byAgent), false, "an agent, its own Artifact");
  assert.equal(await may({ type: "user", id: world.peerUser.id, serverId: asServerId(world.peer.id) }), false, "another server's owner");
  assert.equal(await may({ type: "user", id: world.author.id, serverId: asServerId(world.peer.id) }), false, "its author, through another server");
  // Witness: the same people's delete is unchanged (the author and the manager may).
  assert.equal(await mayManageArtifact(world.view(world.author.id), item, "delete"), true);
  assert.equal(await mayManageArtifact(world.view(world.author.id), byAgent, "delete"), true);
});

test("takedown over HTTP: owner and admin 200; author, member, guest and another server 403 when they see it, the one 404 when not; nothing written", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { item: open } = await world.make({ author: world.byAuthor });
  const { item: inRoom } = await world.make({ author: world.byAuthor, homeChannelId: world.room.id });

  for (const [who, name] of [[world.who.author, "its author"], [world.who.member, "a member"], [world.who.guest, "a guest"], [world.who.peerUser, "another server's owner"], [world.who.authorInPeer, "its author through another server"]] as const) {
    const refused = await takedown(app, who, open.id);
    assert.deepEqual([refused.status, refused.body.code], [403, "FORBIDDEN"], `${name}: ${JSON.stringify(refused.body)}`);
  }
  // One who can't see it learns nothing: the other server's owner and #room's Artifact.
  assert.deepEqual(await takedown(app, world.who.peerUser, inRoom.id), { status: 404, body: NOT_VISIBLE });
  assert.equal((await takedown(app, world.who.member, inRoom.id)).status, 403, "a member of #room sees it");
  await untouched(open.id, "refused");
  await untouched(inRoom.id, "refused");
  // An agent (the service: no web route reaches it) may not either.
  const { item: byAgent } = await world.make({ author: world.byAgent, homeChannelId: world.room.id });
  assert.equal((await takedownArtifact({ kind: "member", actor: { type: "agent", id: world.agentA.id, serverId: world.serverId } }, byAgent.id, "x")).kind, "forbidden");
  await untouched(byAgent.id, "an agent");

  // The owner, who isn't in #room, takes its Artifact down without seeing it; an admin a public one.
  const byOwner = await takedown(app, world.who.owner, inRoom.id);
  assert.equal(byOwner.status, 200, JSON.stringify(byOwner.body));
  assert.deepEqual(byOwner.body, { id: inRoom.id, takenDown: true, revokedAt: (await rowOf(inRoom.id)).revokedAt!.toISOString(), changed: true });
  assert.equal((await takedown(app, world.who.admin, open.id)).status, 200);

  // Taken down, it is no one's to see: a restore by anyone else is the one 404, the author's too.
  for (const who of [world.who.author, world.who.member, world.who.guest, world.who.peerUser]) {
    assert.deepEqual(await restore(app, who, open.id), { status: 404, body: NOT_VISIBLE });
  }
  assert.ok((await rowOf(open.id)).revokedAt !== null, "still down");
  assert.equal((await restore(app, world.who.owner, open.id)).status, 200, "the owner restores what an admin took down");
});

test("a Raft operator takes down and restores through the service (the operator's script), recorded as the moderation ops actor with the operator's name", async ({ seed }) => {
  const world = await seedWorld(seed);
  const { item } = await world.make({ author: world.byAuthor });
  const down = await takedownArtifact({ kind: "ops", operator: "alice" }, item.id, "report #7: malware");
  assert.equal(down.kind, "done");
  assert.deepEqual((await versionsOfItem(item.id)).map((row) => [row.revokedByType, row.revokedById]), [["user", ARTIFACT_OPS_MODERATION_ACTOR.id], ["user", ARTIFACT_OPS_MODERATION_ACTOR.id]], "the versions name it too");
  const up = await restoreArtifact({ kind: "ops", operator: "alice" }, item.id, "false positive");
  assert.equal(up.kind, "done");
  const audit = await auditOf(item.id);
  assert.deepEqual(audit.map((row) => [row.action, row.actorType, row.actorId, (row.after as any).reason, (row.after as any).ops]), [
    ["taken_down", "user", ARTIFACT_OPS_MODERATION_ACTOR.id, "report #7: malware", { operator: "alice" }],
    ["restored", "user", ARTIFACT_OPS_MODERATION_ACTOR.id, "false positive", { operator: "alice" }],
  ]);
  // Its own actor: the audit tells a takedown from the legacy import's move.
  assert.notEqual(ARTIFACT_OPS_MODERATION_ACTOR.id, ARTIFACT_OPS_IMPORT_ACTOR.id);
  assert.deepEqual((await versionsOfItem(item.id)).map((row) => row.revokedById), [null, null], "restored");
  assert.equal((await takedownArtifact({ kind: "ops", operator: "alice" }, `pt_${randomUUID()}`, "x")).kind, "not_visible", "no such Artifact");
});

// ---- the effect -------------------------------------------------------------------

test("taken down, every read refuses it as a deleted one; restored, every read has it again", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const title = `Kestrel ${label()}`;
  const { item, v2 } = await world.make({ author: world.byAuthor, title });
  const artifactId = asArtifactId(item.id);
  // Activity: the member follows it and has a row.
  await getDb().insert(artifactSubscriptions).values({ itemId: item.id, actorType: "user", actorId: world.member.id, reason: "followed" });
  await recordArtifactEvent(getDb(), { item, eventKind: "comment", actor: world.byAuthor, data: { position: 2 }, recipients: [{ actor: { type: "user", id: world.member.id }, reason: "following" }] });
  await getDb().insert(artifactPendingNotices).values({ itemId: item.id, agentId: world.agentA.id, commentIds: ["c_x"], dueAt: new Date(Date.now() + 60_000) });
  const { apiKey } = await mintAgentCredential({ agentId: world.agentA.id, scopes: ["read", "send"], name: `td-${label()}`, issuedVia: "computer", createdByUserId: null });
  const agentGet = async (path: string) => {
    const res = await fetch(`${app.baseUrl}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    return { status: res.status, body: await res.json() as any };
  };
  const signIn = await signInForTest(world.author.id);
  const authorize = async (subject: string) => (await fetch(`${app.baseUrl}/internal/artifacts-content/authorize`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RAFT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ artifact: item.id, version: v2.id, subject }),
  }).then((res) => res.json())) as { allow: boolean; code?: string };

  const reads = async () => {
    const search = await call(app, "GET", webSearchPath({ q: title }), world.who.member);
    const summaries = await call(app, "POST", objectWebPaths.summaries(), world.who.member, { kind: "artifact", refs: [{ id: item.id }] });
    const inbox = await call(app, "GET", `/api/channels/inbox?${new URLSearchParams({ filter: "all", limit: "100" })}`, world.who.member);
    return {
      viewer: (await call(app, "GET", artifactWebPaths.viewer(artifactId), world.who.author)).status,
      frame: (await call(app, "POST", artifactWebPaths.frame(artifactId), world.who.author, {})).status,
      comments: (await call(app, "GET", artifactWebPaths.comments(artifactId), world.who.author)).status,
      otherServer: (await call(app, "GET", artifactWebPaths.viewer(artifactId), world.who.peerUser)).status,
      publicView: (await call(app, "GET", artifactPublicPaths.view(artifactId), null)).status,
      publicFrame: (await call(app, "POST", artifactPublicPaths.frame(artifactId), null, {})).status,
      agentRead: (await agentGet(`/internal/agent-api/artifacts/${encodeURIComponent(item.id)}`)).status,
      agentQuery: (await agentGet(`/internal/agent-api/artifacts?${new URLSearchParams({ query: title })}`)).body.artifacts.map((row: { id: string }) => row.id),
      workerSignedIn: await authorize(`v1:${world.server.id}:${world.author.id}:${signIn.familyId}`),
      workerAnonymous: await authorize(`v1:anon:${item.id}:${v2.id}`),
      search: (search.body.groups ?? []).flatMap((group: { items: Array<{ card?: { id: string } }> }) => group.items.map((hit) => hit.card?.id)).filter((id: unknown) => id === item.id).length,
      summary: summaries.body.summaries[0].ok,
      activity: inbox.body.items.filter((row: { kind: string; objectId?: string }) => row.kind === "object" && row.objectId === item.id).length,
    };
  };
  const open = {
    viewer: 200, frame: 200, comments: 200, otherServer: 200, publicView: 200, publicFrame: 200, agentRead: 200, agentQuery: [item.id],
    workerSignedIn: { allow: true }, workerAnonymous: { allow: true }, search: 1, summary: true,
  };
  // Witness: before, every read has it.
  assert.deepEqual(await reads(), { ...open, activity: 1 });

  assert.equal((await takedown(app, world.who.admin, item.id)).status, 200);
  const gone = { allow: false, code: "deleted" };
  assert.deepEqual(await reads(), {
    viewer: 404, frame: 404, comments: 404, otherServer: 404, publicView: 404, publicFrame: 404, agentRead: 404, agentQuery: [],
    workerSignedIn: gone, workerAnonymous: gone, search: 0, summary: false, activity: 0,
  });
  // The one body, as for a deleted Artifact; its pending notices and Activity rows went with the takedown.
  assert.deepEqual((await call(app, "GET", artifactWebPaths.viewer(artifactId), world.who.author)).body, NOT_VISIBLE);
  assert.deepEqual((await call(app, "GET", artifactPublicPaths.view(artifactId), null)).body, NOT_VISIBLE);
  assert.deepEqual(await getDb().select().from(artifactPendingNotices).where(eq(artifactPendingNotices.itemId, item.id)), []);
  assert.deepEqual(await getDb().select().from(objectInboxStates).where(eq(objectInboxStates.objectId, item.id)), []);
  // Nor can it be changed: no comment, move or delete reaches it.
  for (const [method, path, body] of [
    ["POST", artifactWebPaths.comments(artifactId), { body: [{ type: "text", text: "hi" }] }],
    ["POST", artifactWebPaths.home(artifactId), { to: "server", expectedLost: 0 }],
    ["DELETE", artifactWebPaths.artifact(artifactId)],
  ] as Array<[string, string, unknown?]>) {
    assert.deepEqual(await call(app, method, path, world.who.author, body), { status: 404, body: NOT_VISIBLE }, `${method} ${path}`);
  }

  assert.equal((await restore(app, world.who.owner, item.id)).status, 200);
  // Every read has it again; the Activity rows the takedown dropped stay dropped (the next event brings one).
  assert.deepEqual(await reads(), { ...open, activity: 0 });
});

// ---- the record -------------------------------------------------------------------

test("audited and idempotent: one taken_down row with the reason and the versions, one restored row; a repeat changes and records nothing", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { item, v1 } = await world.make({ author: world.byAuthor });
  const versionsOf = async () => (await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, item.id)).orderBy(artifactVersions.number))
    .map((row) => [row.number, row.revokedAt?.toISOString() ?? null, row.revokedByType, row.revokedById]);

  const first = await takedown(app, world.who.admin, item.id, { reason: "  report #3: impersonation  " });
  const revokedAt = (await rowOf(item.id)).revokedAt!.toISOString();
  assert.deepEqual(first.body, { id: item.id, takenDown: true, revokedAt, changed: true });
  // Every version, with who; the item's same moment.
  assert.deepEqual(await versionsOf(), [[1, revokedAt, "user", world.admin.id], [2, revokedAt, "user", world.admin.id]]);
  // Again, by the owner: nothing changes, nothing recorded.
  assert.deepEqual((await takedown(app, world.who.owner, item.id)).body, { id: item.id, takenDown: true, revokedAt, changed: false });
  assert.equal((await rowOf(item.id)).revokedAt!.toISOString(), revokedAt);

  const restored = await restore(app, world.who.owner, item.id);
  assert.deepEqual(restored.body, { id: item.id, takenDown: false, revokedAt: null, changed: true });
  assert.deepEqual(await versionsOf(), [[1, null, null, null], [2, null, null, null]]);
  assert.deepEqual((await restore(app, world.who.admin, item.id)).body, { id: item.id, takenDown: false, revokedAt: null, changed: false });

  const audit = await auditOf(item.id);
  assert.deepEqual(audit.map((row) => [row.action, row.actorType, row.actorId, row.before, row.after]), [
    ["taken_down", "user", world.admin.id, { revoked_at: null }, { revoked_at: revokedAt, reason: "report #3: impersonation", versions_revoked: 2 }],
    ["restored", "user", world.owner.id, { revoked_at: revokedAt }, { revoked_at: null, reason: "appeal upheld", versions_restored: 2 }],
  ]);

  // A version revoked on its own before a takedown stays revoked after the restore: only the takedown's are undone.
  const earlier = new Date(Date.now() - 60_000);
  await getDb().update(artifactVersions).set({ revokedAt: earlier, revokedByType: "user", revokedById: world.author.id }).where(eq(artifactVersions.id, v1.id));
  await takedown(app, world.who.admin, item.id);
  await restore(app, world.who.admin, item.id);
  assert.deepEqual(await versionsOf(), [[1, earlier.toISOString(), "user", world.author.id], [2, null, null, null]]);
});

test("refusals: the body is { reason } (400), Artifacts off first (403), a restore whose name was taken meanwhile 409 NAME_TAKEN", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { item } = await world.make({ author: world.byAuthor, serverHome: true, name: "quarterly" });
  for (const body of [undefined, {}, { reason: "" }, { reason: "   " }, { reason: 1 }, { reason: "x".repeat(1001) }, { reason: "ok", extra: true }, ["ok"]]) {
    const refused = await call(app, "POST", artifactWebPaths.takedown(asArtifactId(item.id)), world.who.admin, body);
    assert.deepEqual([refused.status, refused.body.code], [400, "INVALID_REQUEST"], JSON.stringify(body));
  }
  await untouched(item.id, "a bad body");

  assert.equal((await takedown(app, world.who.admin, item.id)).status, 200);
  // Another Artifact of the server home takes the name while it is down.
  await world.make({ author: world.byAuthor, serverHome: true, name: "quarterly" });
  const taken = await restore(app, world.who.admin, item.id);
  assert.deepEqual([taken.status, taken.body.code, taken.body.details], [409, "NAME_TAKEN", { name: "quarterly" }]);
  assert.ok((await rowOf(item.id)).revokedAt !== null, "still down");

  // Artifacts off: an admin's takedown is refused before anything else.
  const { item: other } = await world.make({ author: world.byAuthor, serverHome: true });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  const off = await takedown(app, world.who.admin, other.id);
  assert.deepEqual([off.status, off.body.code], [403, "ARTIFACTS_NOT_ENABLED"]);
  await untouched(other.id, "Artifacts off");
});
