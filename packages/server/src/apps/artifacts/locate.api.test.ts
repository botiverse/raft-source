// Where an Artifact's canonical link opens (`GET /api/artifacts/:id/locate`,
// webLocate.ts) over HTTP with real user tokens: the server it opens in for
// whoever can see it, whichever of their servers they ask from; the one 404
// for everything else; 403 ARTIFACTS_NOT_ENABLED naming the server only to
// someone who sees it there; a public Artifact for another server's reader;
// joints; no read position moved; the per-user limit.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { artifactWebPaths, asArtifactId, asServerId, type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { featureFlagRules } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { createAgent } from "../../services/agentService";
import { addHuman, createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { addMember } from "../../services/serverService";
import { createApiTest } from "../../test/integration/apiTest";
import { seedJointChannel } from "../../test/integration/jointFixture";
import type { createSeed } from "../../test/integration/seed";
import { refusalBody } from "../../platform/refusals";
import { ARTIFACTS_NOT_ENABLED_ERROR } from "./apiCommon";
import { artifactItems, artifactReadPositions } from "./schema";
import { webNotVisible } from "./webCommon";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();
const limitedTest = createApiTest({ appRateLimitMax: { "artifacts.locate": 2 } });
const label = () => randomUUID().slice(0, 8);

type Who = { token: string; serverId: string };

async function locate(app: { baseUrl: string }, artifact: string, who: Who) {
  const res = await fetch(`${app.baseUrl}${artifactWebPaths.locate(asArtifactId(artifact))}`, {
    headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId },
  });
  return { status: res.status, cacheControl: res.headers.get("cache-control"), body: await res.json() as Record<string, unknown> };
}

async function insertItem(input: { serverId: ServerId; homeChannelId?: string; serverHome?: boolean; author: { type: "user" | "agent"; id: string }; deleted?: boolean; revoked?: boolean }) {
  const id = `pt_${randomUUID()}`;
  await getDb().insert(artifactItems).values({
    id,
    serverId: input.serverId,
    urlKey: id,
    name: `art-${label()}`,
    title: `Artifact ${id.slice(3, 11)}`,
    homeKind: input.homeChannelId ? "conversation" : input.serverHome ? "server" : "public",
    homeChannelId: input.homeChannelId ?? null,
    createdByType: input.author.type,
    createdById: input.author.id,
    deletedAt: input.deleted ? new Date() : null,
    revokedAt: input.revoked ? new Date() : null,
  });
  return id;
}

/**
 * A server with #priv (owner, reader) and a peer server. The reader is in
 * both; outsider only in the server (not #priv); peerUser only in the peer.
 * Artifacts on. Items of the server: page in #priv, whole (server
 * home), memo (public), deleted and revoked in #priv.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const reader = await seed.human();
  const outsider = await seed.human();
  const peerUser = await seed.human();
  const server = await seed.server({ owner, members: [reader, outsider] });
  const peer = await seed.server({ owner: peerUser, members: [reader] });
  const serverId = asServerId(server.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const priv = await createChannel(server.id, `loc-priv-${label()}`, undefined, "private");
  for (const human of [owner, reader]) await addHuman(priv.id, human.id);
  const agent = await createAgent(server.id, `loc-a-${label()}`, { runtime: "claude", model: "sonnet" });
  const author = { type: "agent" as const, id: agent.id };
  const items = {
    page: await insertItem({ serverId, homeChannelId: priv.id, author }),
    whole: await insertItem({ serverId, serverHome: true, author }),
    memo: await insertItem({ serverId, author }),
    deleted: await insertItem({ serverId, homeChannelId: priv.id, author, deleted: true }),
    revoked: await insertItem({ serverId, homeChannelId: priv.id, author, revoked: true }),
  };
  const as = async (userId: string, sid: string): Promise<Who> => ({ token: await accessTokenForTest(userId), serverId: sid });
  return {
    server, peer, owner, reader, outsider, peerUser, priv, items,
    who: {
      reader: await as(reader.id, server.id),
      readerFromPeer: await as(reader.id, peer.id),
      outsider: await as(outsider.id, server.id),
      peerUser: await as(peerUser.id, peer.id),
    },
  };
}

const NOT_VISIBLE = webNotVisible().body;

test("a member who can see it gets its own server's slug, whichever of their servers they ask from; private, no-store; no read position moves", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  for (const who of [world.who.reader, world.who.readerFromPeer]) {
    for (const item of [world.items.page, world.items.whole, world.items.memo]) {
      const res = await locate(app, item, who);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body, { serverSlug: world.server.slug }, "only the slug");
      assert.equal(res.cacheControl, "private, no-store");
    }
  }
  assert.equal((await getDb().select().from(artifactReadPositions).where(eq(artifactReadPositions.itemId, world.items.page))).length, 0);
});

test("whatever the reason it can't be seen, the same 404 NOT_VISIBLE: no such id, deleted, revoked, not in its home, not in its server", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const cases: Array<[Who, string, string]> = [
    [world.who.reader, `pt_${randomUUID()}`, "no such id"],
    [world.who.reader, "not-an-id", "not an id"],
    [world.who.reader, world.items.deleted, "deleted"],
    [world.who.reader, world.items.revoked, "revoked"],
    [world.who.outsider, world.items.page, "a member outside its conversation"],
    [world.who.peerUser, world.items.page, "another server's conversation"],
    [world.who.peerUser, world.items.whole, "another server's server home"],
  ];
  for (const [who, artifact, why] of cases) {
    const res = await locate(app, artifact, who);
    assert.equal(res.status, 404, why);
    assert.deepEqual(res.body, NOT_VISIBLE, why);
  }
  // Witness: the outsider sees what its server shares.
  assert.deepEqual((await locate(app, world.items.whole, world.who.outsider)).body, { serverSlug: world.server.slug });
});

test("a public Artifact opens for someone of another server in the server they ask from; with Artifacts off they get the one 404, its own server's member the 403", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  assert.deepEqual((await locate(app, world.items.memo, world.who.peerUser)).body, { serverSlug: world.peer.slug });
  // Artifacts off: another server's reader learns nothing of it.
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  const off = await locate(app, world.items.memo, world.who.peerUser);
  assert.equal(off.status, 404);
  assert.deepEqual(off.body, NOT_VISIBLE);
  // Its own server's member gets the 403 naming that server: it is their own server.
  const member = await locate(app, world.items.memo, world.who.readerFromPeer);
  assert.equal(member.status, 403);
  assert.deepEqual(member.body.details, { serverSlug: world.server.slug });
});

test("Artifacts off: 403 ARTIFACTS_NOT_ENABLED naming the Artifact's server, only to someone who could see it there; anyone else gets the one 404", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  for (const who of [world.who.reader, world.who.readerFromPeer]) {
    const res = await locate(app, world.items.page, who);
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, refusalBody({ code: "ARTIFACTS_NOT_ENABLED", error: ARTIFACTS_NOT_ENABLED_ERROR, details: { serverSlug: world.server.slug } }));
  }
  // Someone of the server who can't see it gets the one 404, Artifacts on or off.
  const outsider = await locate(app, world.items.page, world.who.outsider);
  assert.equal(outsider.status, 404);
  assert.deepEqual(outsider.body, NOT_VISIBLE);
});

test("a joint channel: a peer member in it is sent to the server they see it from, asked from any of their servers; with Artifacts off, the 403 names that server", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const member = await seed.human();
  await addMember(world.peer.id, member.id);
  const third = await seed.server({ owner: member });
  const joint = await seedJointChannel({ name: `loc-joint-${label()}`, serverIds: [world.server.id, world.peer.id], createdByUserId: world.owner.id });
  const [, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addHuman(peerProjection.id, member.id);
  const item = await insertItem({ serverId: asServerId(world.server.id), homeChannelId: joint.canonical.id, author: { type: "user", id: world.owner.id } });

  for (const sid of [world.peer.id, third.id]) {
    const res = await locate(app, item, { token: await accessTokenForTest(member.id), serverId: sid });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { serverSlug: world.peer.slug });
  }
  // The peer's member outside its projection: nothing.
  assert.equal((await locate(app, item, world.who.peerUser)).status, 404);
  // Artifacts off: the member is told, about the server they see it from.
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  const off = await locate(app, item, { token: await accessTokenForTest(member.id), serverId: third.id });
  assert.equal(off.status, 403);
  assert.deepEqual(off.body.details, { serverSlug: world.peer.slug });
});

limitedTest("locate is limited per user on its own budget (429 RATE_LIMITED past it, other users unaffected)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  assert.equal((await locate(app, world.items.page, world.who.reader)).status, 200);
  assert.equal((await locate(app, world.items.page, world.who.reader)).status, 200);
  const third = await locate(app, world.items.page, world.who.reader);
  assert.equal(third.status, 429);
  assert.equal(third.body.code, "RATE_LIMITED");
  assert.equal((await locate(app, world.items.whole, world.who.outsider)).status, 200, "another user");
});
