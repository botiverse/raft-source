// Moving an Artifact to the whole server (`POST /internal/agent-api/artifacts/:artifact/home`)
// and deleting it (`DELETE /internal/agent-api/artifacts/:artifact`) through
// the agent API, over HTTP with real agent credentials. Proves what the agent
// routes add to manage.ts (whose own rule manage.api.test.ts proves): the
// flag first; the Artifact the agent sees (an id or a name; anything else
// the one 404); only its author among agents (403 FORBIDDEN with the title
// and author); `public` refused to an agent (403); an agent's move only while
// that person sees the Artifact and may move it themselves (403
// `manager_cannot_see`, `manager_cannot_move`, `no_manager`), a personal
// assistant's owner being that person; the home only grows (409
// HOME_NOT_WIDER, before the manager rule); a name taken in the
// server home (409 NAME_TAKEN); the move's audit row and its event for the
// followers; a delete gone from the agent's list and read, and the people
// whose Activity rows went with it told.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ACTIVITY_CHANGED_EVENT, asServerId, RAFT_HINTS, type ActivityChangedEvent, type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { agents, objectEventRecipients, objectEvents, objectInboxStates } from "../../db/schema";
import { setActivityRealtimeIO } from "../../services/activityRealtime";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel, findOrCreateDM } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { removeMember } from "../../services/serverService";
import { createApiTest } from "../../test/integration/apiTest";
import { seedJointChannel } from "../../test/integration/jointFixture";
import type { createSeed } from "../../test/integration/seed";
import { refusalBody } from "../../platform/refusals";
import { notVisible } from "./apiCommon";
import { deleteArtifact, widenArtifactHome } from "./manage";
import { artifactAudit, artifactItems, artifactSubscriptions, artifactVersions } from "./schema";
import { indexArtifactSearch } from "./search";
import { seedBoundGuest } from "../../test/guestFixture";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-manage-agent-tests-hmac-secret-0123456789");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
const label = () => randomUUID().slice(0, 8);

type Actor = { type: "user" | "agent"; id: string };

/** A published Artifact (one version, current) with its search row, as a publish leaves it. */
async function artifact(input: { serverId: ServerId; author: Actor; homeChannelId?: string; name?: string; title?: string }) {
  const db = getDb();
  const id = `pt_${randomUUID()}`;
  // An old name, as an Artifact from before titles has: the moves and deletes below address it so.
  const name = input.name ?? `art-${label()}`;
  await db.insert(artifactItems).values({
    id,
    serverId: input.serverId,
    urlKey: id,
    name,
    title: input.title ?? `Quarterly ${label()}`,
    homeKind: input.homeChannelId ? "conversation" : "server",
    homeChannelId: input.homeChannelId ?? null,
    createdByType: input.author.type,
    createdById: input.author.id,
  });
  const versionId = `v_${randomUUID()}`;
  await db.insert(artifactVersions).values({
    id: versionId, itemId: id, number: 1, entry: "index.html", fileCount: 1, sizeBytes: 10, publishDigest: "digest",
    status: "published", publisherType: input.author.type, publisherId: input.author.id, position: 1,
  });
  const [item] = await db.update(artifactItems).set({ currentVersionId: versionId, lastPosition: 1 }).where(eq(artifactItems.id, id)).returning();
  await indexArtifactSearch(db, item!);
  return { ...item!, name };
}

/**
 * A server (the flag on unless `enabled: false`): its owner; manager, the
 * person who made (and so manages) its agents; member, another person;
 * agents A (who makes the Artifacts) and B, with member and manager in #priv
 * (private); agent Out in no channel; an agent of another server.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, opts: { enabled?: boolean } = {}) {
  const owner = await seed.human();
  const manager = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [manager, member] });
  const serverId = asServerId(server.id);
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, opts.enabled !== false);
  const make = (sid: string, prefix: string) => createAgent(sid, `${prefix}-${label()}`, { runtime: "claude", model: "sonnet", creatorType: "user", creatorId: sid === server.id ? manager.id : peerOwner.id });
  const agentA = await make(server.id, "ma-a");
  const agentB = await make(server.id, "ma-b");
  const agentOut = await make(server.id, "ma-out");
  const peerAgent = await make(peer.id, "ma-peer");
  const priv = await createChannel(server.id, `ma-priv-${label()}`, undefined, "private");
  for (const human of [member, manager]) await addHuman(priv.id, human.id);
  for (const agent of [agentA, agentB]) await addAgent(priv.id, agent.id);
  const key = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["read", "send"], name: `ma-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const byA: Actor = { type: "agent", id: agentA.id };
  return {
    server, serverId, owner, manager, member, agentA, agentB, priv, byA, key, peer, peerAgent,
    keys: { a: await key(agentA.id), b: await key(agentB.id), out: await key(agentOut.id), peer: await key(peerAgent.id) },
    /** A fresh Artifact of the server, by agent A unless `author`; in #priv unless `serverHome`. */
    make: (input: { author?: Actor; serverHome?: boolean; homeChannelId?: string; name?: string; title?: string } = {}) =>
      artifact({ serverId, author: input.author ?? byA, homeChannelId: input.serverHome ? undefined : input.homeChannelId ?? priv.id, name: input.name, title: input.title }),
  };
}

type Reply = { status: number; body: any };

async function call(app: { baseUrl: string }, method: string, path: string, apiKey: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const move = (app: { baseUrl: string }, apiKey: string, ref: string, to: unknown) => call(app, "POST", `/artifacts/${encodeURIComponent(ref)}/home`, apiKey, { to });
const remove = (app: { baseUrl: string }, apiKey: string, ref: string) => call(app, "DELETE", `/artifacts/${encodeURIComponent(ref)}`, apiKey);
const rowOf = async (item: { id: string }) => (await getDb().select().from(artifactItems).where(eq(artifactItems.id, item.id)))[0]!;
const auditOf = (item: { id: string }) => getDb().select().from(artifactAudit).where(eq(artifactAudit.itemId, item.id)).orderBy(artifactAudit.id);
const eventsOf = (item: { id: string }) => getDb().select().from(objectEvents).where(eq(objectEvents.objectId, item.id)).orderBy(objectEvents.seq);
const NOT_VISIBLE = notVisible().body;
/** A refused move or delete as the agent API answers it (manage.ts agentRefusal): the envelope, no step. */
const refused = (code: string, error: string, details: Record<string, unknown>) => refusalBody({ code, error, details });
const MANAGER_CANNOT_SEE = "The person who manages this agent can't see the artifact where it is, and moving it would show its pages and comments to the whole server: ask a server owner or admin who can see it to make it visible to the whole server on the web.";

/** Nothing about the item changed: its home and deletion as made, no audit row, no event. */
async function untouched(item: Awaited<ReturnType<typeof artifact>>, message: string) {
  const row = await rowOf(item);
  assert.deepEqual([row.homeKind, row.homeChannelId, row.deletedAt], [item.homeKind, item.homeChannelId, null], message);
  assert.deepEqual(await auditOf(item), [], `${message}: no audit row`);
  assert.deepEqual(await eventsOf(item), [], `${message}: no event`);
}

test("move: the author agent moves its Artifact to the whole server; the answer names the home it left; audit row and moved event for its followers", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const item = await world.make();
  await getDb().insert(artifactSubscriptions).values([
    { itemId: item.id, actorType: "agent", actorId: world.agentA.id, reason: "published" },
    { itemId: item.id, actorType: "agent", actorId: world.agentB.id, reason: "followed" },
    { itemId: item.id, actorType: "user", actorId: world.member.id, reason: "followed" },
  ]);
  assert.equal((await call(app, "GET", `/artifacts/${item.id}`, world.keys.out)).status, 404, "witness: an agent outside #priv can't see it yet");

  const res = await move(app, world.keys.a, item.name, "server");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.artifact.id, item.id);
  assert.deepEqual(res.body.artifact.home, { kind: "server", serverName: world.server.name }, "named by its server (#84)");
  assert.deepEqual(res.body.from, { kind: "conversation", conversation: { id: world.priv.id, type: "private", target: `#${world.priv.name}` } });
  assert.deepEqual([(await rowOf(item)).homeKind, (await rowOf(item)).homeChannelId], ["server", null]);
  assert.equal((await call(app, "GET", `/artifacts/${item.id}`, world.keys.out)).status, 200, "the whole server's agents see it now");

  const audit = await auditOf(item);
  assert.deepEqual(audit.map((row) => [row.action, row.actorType, row.actorId, row.before, row.after]), [
    ["home_changed", "agent", world.agentA.id, { home_kind: "conversation", home_channel_id: world.priv.id }, { home_kind: "server", home_channel_id: null }],
  ]);
  const events = await eventsOf(item);
  assert.deepEqual(events.map((event) => [event.eventKind, event.homeKind, event.actorType, event.actorId, event.data]), [
    ["moved", "server", "agent", world.agentA.id, { from: "conversation", to: "server", fromChannelId: world.priv.id }],
  ]);
  const recipients = (await getDb().select().from(objectEventRecipients).where(eq(objectEventRecipients.eventId, events[0]!.id)))
    .map((row) => `${row.recipientType}:${row.recipientId}:${row.reason}`).sort();
  // Its followers, never the agent that moved it.
  assert.deepEqual(recipients, [`agent:${world.agentB.id}:following`, `user:${world.member.id}:following`].sort());
});

test("move: already server-wide 409 HOME_NOT_WIDER, public 403, another agent that sees it 403, one that can't 404, a name taken 409; nothing changes", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const title = `Plan ${label()}`;
  const serverWide = await world.make({ serverHome: true, title });
  const wide = await move(app, world.keys.a, serverWide.id, "server");
  assert.deepEqual([wide.status, wide.body], [409, refusalBody({ code: "HOME_NOT_WIDER", error: "Nothing changed: the whole server can already see this artifact.", next: RAFT_HINTS.artifactRead({ artifact: serverWide.id }), details: { title, home: "server", to: "server" } })]);
  await untouched(serverWide, "already server-wide");

  const item = await world.make({ title });
  const author = { type: "agent", name: world.agentA.name };
  const toPublic = await move(app, world.keys.a, item.id, "public");
  assert.deepEqual([toPublic.status, toPublic.body], [403, refused("FORBIDDEN", "Only a person can turn on link sharing for an artifact, since anyone with the link could then open it: ask a person who manages it to choose \"Anyone with the link\" on the web.", { title, author })]);
  const other = await move(app, world.keys.b, item.id, "server");
  assert.equal(other.status, 403, JSON.stringify(other.body));
  assert.deepEqual([other.body.code, other.body.details], ["FORBIDDEN", { title, author }]);
  for (const [who, key] of [["an agent outside #priv", world.keys.out], ["another server's agent", world.keys.peer]] as const) {
    const res = await move(app, key, item.id, "server");
    assert.deepEqual([res.status, res.body], [404, NOT_VISIBLE], who);
  }
  assert.equal((await move(app, world.keys.a, item.id, "everywhere")).status, 400, "only server or public is a move");
  await untouched(item, "refused moves");

  const plan = `plan-${label()}`;
  await world.make({ serverHome: true, name: plan, author: { type: "user", id: world.member.id } });
  const here = await world.make({ name: plan });
  const taken = await move(app, world.keys.a, here.id, "server");
  assert.deepEqual([taken.status, taken.body], [409, refused("NAME_TAKEN", "Another artifact visible to the whole server already has this artifact's name, so it can't move there: ask the other one's author or a server admin whether it can be deleted, then move this one again.", { name: plan })]);
  await untouched(here, "name taken");
});

test("move: an agent moves only what the person who manages it sees: from their DM it moves; from a private channel they aren't in 403 manager_cannot_see; an agent no person manages 403 no_manager", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const dm = await findOrCreateDM(world.server.id, world.manager.id, world.agentA.id);
  assert.ok(dm, "the manager's DM with agent A");
  const inDm = await world.make({ homeChannelId: dm.id });
  const moved = await move(app, world.keys.a, inDm.id, "server");
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual([moved.body.from.kind, moved.body.from.conversation.type], ["conversation", "dm"]);
  assert.equal((await rowOf(inDm)).homeKind, "server");

  const secret = await createChannel(world.server.id, `ma-secret-${label()}`, undefined, "private");
  await addAgent(secret.id, world.agentA.id);
  const title = `Secret ${label()}`;
  const hidden = await world.make({ homeChannelId: secret.id, title });
  const blocked = await move(app, world.keys.a, hidden.id, "server");
  assert.deepEqual([blocked.status, blocked.body], [403, refused("FORBIDDEN", MANAGER_CANNOT_SEE, {
    title, author: { type: "agent", name: world.agentA.name }, reason: "manager_cannot_see", manager: { type: "user", name: world.manager.name }, target: `#${secret.name}`,
  })]);
  await untouched(hidden, "the manager can't see it");
  // Once the manager can see it there, the same move goes through.
  await addHuman(secret.id, world.manager.id);
  assert.equal((await move(app, world.keys.a, hidden.id, "server")).status, 200);

  // An agent made by an agent has no person who manages it.
  const orphanAgent = await createAgent(world.server.id, `ma-made-${label()}`, { runtime: "claude", model: "sonnet", creatorType: "agent", creatorId: world.agentA.id });
  await addAgent(world.priv.id, orphanAgent.id);
  const its = await world.make({ author: { type: "agent", id: orphanAgent.id }, title });
  const none = await move(app, await world.key(orphanAgent.id), its.id, "server");
  assert.deepEqual([none.status, none.body], [403, refused(
    "FORBIDDEN",
    "An agent moves an artifact only for a person who manages it and can see it, and this agent has none: ask a server owner or admin to move it on the web.",
    { title, author: { type: "agent", name: orphanAgent.name }, reason: "no_manager" },
  )]);
  await untouched(its, "no manager");
});

test("move: only what the manager could move: a guest manager 403 manager_cannot_move, one who left 403 manager_cannot_see, a server-wide one HOME_NOT_WIDER first; a personal assistant's owner decides", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const title = `Guarded ${label()}`;
  const item = await world.make({ title });
  const serverWide = await world.make({ serverHome: true, title });
  const author = { type: "agent", name: world.agentA.name };
  const manager = { type: "user", name: world.manager.name };

  // The manager becomes a guest of #priv (a guest reads its one channel, #wg-rbac:#15): still in #priv, so they see it, but a guest never widens.
  await seedBoundGuest({ serverId: world.server.id, userId: world.manager.id, channelId: world.priv.id });
  const asGuest = await move(app, world.keys.a, item.id, "server");
  assert.deepEqual([asGuest.status, asGuest.body], [403, refused(
    "FORBIDDEN",
    "The person who manages this agent may not move the artifact to the whole server either: ask a server owner or admin to make it visible to the whole server on the web.",
    { title, author, reason: "manager_cannot_move", manager, target: `#${world.priv.name}` },
  )]);
  // Already server-wide: that is the answer, whoever manages the agent.
  const wide = await move(app, world.keys.a, serverWide.id, "server");
  assert.deepEqual([wide.status, wide.body.code], [409, "HOME_NOT_WIDER"]);

  // The manager leaves the server: they see nothing of it any more.
  await removeMember(world.server.id, world.manager.id);
  const left = await move(app, world.keys.a, item.id, "server");
  assert.deepEqual([left.status, left.body], [403, refused("FORBIDDEN", MANAGER_CANNOT_SEE, { title, author, reason: "manager_cannot_see", manager, target: `#${world.priv.name}` })]);
  await untouched(item, "the manager is a guest, then gone");
  await untouched(serverWide, "already server-wide");

  // A personal assistant is managed by its owner, not its creator (the one who left): in its DM with its owner (the only
  // conversation an assistant is in), the owner sees it and may move it, so the service moves it. (Its own credential
  // reaches no Artifacts route: an assistant's routes are an allowlist, RFC 075.)
  const assistant = await createAgent(world.server.id, `ma-pa-${label()}`, { runtime: "claude", model: "sonnet", creatorType: "user", creatorId: world.manager.id });
  await getDb().update(agents).set({ assistantOwnerUserId: world.member.id }).where(eq(agents.id, assistant.id));
  const dm = await findOrCreateDM(world.server.id, world.member.id, assistant.id);
  assert.ok(dm, "the assistant's DM with its owner");
  const its = await world.make({ author: { type: "agent", id: assistant.id }, homeChannelId: dm.id });
  assert.equal((await move(app, await world.key(assistant.id), its.id, "server")).body.code, "assistant_route_not_allowed");
  const moved = await widenArtifactHome({ type: "agent", id: assistant.id, serverId: world.serverId }, its.id, "server");
  assert.equal(moved.kind, "moved", JSON.stringify(moved));
  assert.equal((await rowOf(its)).homeKind, "server");
  // The assistant acting for its owner (RFC 080 `delegated`) manages no Artifact: refused before any check, so it never
  // reaches the agent branch (and its manager rule) by another way.
  const another = await world.make({ author: { type: "agent", id: assistant.id }, homeChannelId: dm.id });
  const delegated = { type: "delegated" as const, id: world.member.id, agentId: assistant.id, serverId: world.serverId };
  assert.equal((await widenArtifactHome(delegated, another.id, "server")).kind, "forbidden");
  assert.equal((await deleteArtifact(delegated, another.id)).kind, "forbidden");
  await untouched(another, "an assistant acting for its owner");
});

test("move: an orphan (its conversation hard-deleted) counts as seen by the manager, so the agent's move goes through", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  // A private channel the manager was never in; then its row goes (ON DELETE SET NULL leaves a conversation home without a channel).
  const secret = await createChannel(world.server.id, `ma-gone-${label()}`, undefined, "private");
  await addAgent(secret.id, world.agentA.id);
  const item = await world.make({ homeChannelId: secret.id });
  assert.equal((await move(app, world.keys.a, item.id, "server")).body.details?.reason, "manager_cannot_see", "witness: while the channel exists, the manager can't see it");
  await getDb().update(artifactItems).set({ homeChannelId: null }).where(eq(artifactItems.id, item.id));
  // Today's behaviour, by the platform's orphan rule (visibilityService canViewHomedObjects): an orphan is seen by its
  // author, the author agent's manager and the server's owners and admins, so the manager "sees" it and may move it,
  // as on the web. This test changes with that rule, not on its own.
  const res = await move(app, world.keys.a, item.id, "server");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.from, { kind: "conversation", conversation: { id: null, type: null, target: null } });
  assert.equal((await rowOf(item)).homeKind, "server");
});

test("a joint channel: an agent of the other server, in the joint and seeing the Artifact, neither moves nor deletes it (403 FORBIDDEN)", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const joint = await seedJointChannel({ name: `ma-joint-${label()}`, serverIds: [world.server.id, world.peer.id], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.canonical, typeof joint.canonical];
  await addAgent(hostProjection.id, world.agentA.id);
  await addAgent(peerProjection.id, world.peerAgent.id);
  const title = `Joint ${label()}`;
  // Homed on the joint's canonical channel, the publishing server's (as a publish leaves it).
  const item = await world.make({ homeChannelId: joint.canonical.id, title });
  assert.equal((await call(app, "GET", `/artifacts/${item.id}`, world.keys.peer)).status, 200, "witness: the other side's agent reads it");
  const details = { title, author: { type: "agent", name: world.agentA.name } };
  for (const res of [await move(app, world.keys.peer, item.id, "server"), await remove(app, world.keys.peer, item.id)]) {
    assert.deepEqual([res.status, res.body.code, res.body.details], [403, "FORBIDDEN", details]);
  }
  await untouched(item, "the other side of the joint");
});

test("delete: another agent that sees it 403, one that can't 404; the author's delete answers what went, leaves the agent's list and read, and tells those whose Activity rows went", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const title = `Zephyr ${label()}`;
  const item = await world.make({ title });
  await getDb().insert(artifactSubscriptions).values({ itemId: item.id, actorType: "user", actorId: world.member.id, reason: "followed" });

  const other = await remove(app, world.keys.b, item.id);
  assert.deepEqual([other.status, other.body.code, other.body.details], [403, "FORBIDDEN", { title, author: { type: "agent", name: world.agentA.name } }]);
  for (const key of [world.keys.out, world.keys.peer]) assert.deepEqual(await remove(app, key, item.id), { status: 404, body: NOT_VISIBLE });
  assert.equal((await rowOf(item)).deletedAt, null);

  // The member follows it: moving it gives them an Activity row, which the delete takes away.
  assert.equal((await move(app, world.keys.a, item.id, "server")).status, 200);
  assert.equal((await getDb().select().from(objectInboxStates).where(eq(objectInboxStates.objectId, item.id))).length, 1, "witness: the member's Activity row");
  const listed = async () => (await call(app, "GET", `/artifacts?${new URLSearchParams({ query: title })}`, world.keys.a)).body.artifacts.map((row: { id: string }) => row.id);
  assert.deepEqual(await listed(), [item.id], "witness: listed before");

  const frames: Array<{ room: string; event: string; payload: ActivityChangedEvent }> = [];
  setActivityRealtimeIO({ to: (room: string) => ({ emit: (event: string, payload: ActivityChangedEvent) => { frames.push({ room, event, payload }); return true; } }) } as never);
  let res: Reply;
  try {
    res = await remove(app, world.keys.a, item.name);
  } finally {
    setActivityRealtimeIO((app as unknown as { app: { get(key: string): never } }).app.get("io"));
  }
  assert.deepEqual([res.status, res.body], [200, { artifact: { id: item.id, name: item.name, title, currentVersion: 1 }, deleted: true }]);
  assert.deepEqual(frames, [{ room: `user:${world.member.id}`, event: ACTIVITY_CHANGED_EVENT, payload: { serverId: world.server.id, source: "object" } }]);
  assert.equal((await getDb().select().from(objectInboxStates).where(eq(objectInboxStates.objectId, item.id))).length, 0, "the row went with the delete");
  assert.notEqual((await rowOf(item)).deletedAt, null);
  assert.deepEqual((await auditOf(item)).map((row) => [row.action, row.actorType, row.actorId]), [["home_changed", "agent", world.agentA.id], ["deleted", "agent", world.agentA.id]]);

  assert.deepEqual(await listed(), []);
  assert.deepEqual(await call(app, "GET", `/artifacts/${item.id}`, world.keys.a), { status: 404, body: NOT_VISIBLE });
  assert.deepEqual(await remove(app, world.keys.a, item.id), { status: 404, body: NOT_VISIBLE }, "deleted once");
  assert.deepEqual(await move(app, world.keys.a, item.id, "server"), { status: 404, body: NOT_VISIBLE });
});

test("flag off: move and delete answer 403 ARTIFACTS_NOT_ENABLED and change nothing", async ({ app, seed }) => {
  const world = await seedWorld(seed, { enabled: false });
  const item = await world.make();
  for (const res of [await move(app, world.keys.a, item.id, "server"), await remove(app, world.keys.a, item.id)]) {
    assert.deepEqual([res.status, res.body.code], [403, "ARTIFACTS_NOT_ENABLED"]);
  }
  await untouched(item, "flag off");
});
