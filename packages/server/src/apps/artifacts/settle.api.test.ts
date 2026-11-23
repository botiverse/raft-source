// Settled (#334, settle.ts; flag artifact_settled_v0) over HTTP, the agent API
// and the web API together: the flag (off: no route, no field, no hold), who
// may (whoever may comment: an agent and a person of the server; one that
// can't see it the one 404), settling again or unsettling a Working one
// changing nothing, settling following the Artifact, the state on read, list
// and the web's card, people's Activity row moved to the event but read, the
// queued (never pushed) notices to its agents, and a push: held once (409
// SETTLED, nothing published), the same push again going through and taking
// it back to Working (`wasSettled`, `reopened`, the version event's
// `wasSettled`); the settler's own push, a push that changes nothing and a
// comment leave it as it is.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { ARTIFACT_SETTLED_FEATURE_FLAG_KEY, artifactWebPaths, asArtifactId, type AgentMessage, type ArtifactAgentAppEvent, type ArtifactId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { featureFlagRules, objectEvents, objectInboxStates, thirdPartyAgentEvents } from "../../db/schema";
import { accessTokenForTest } from "../../test/integration/credentials";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { __setArtifactR2StoreForTests } from "./blobStore";
import { artifactItems, artifactSettledHolds, artifactVersions } from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-settle-tests-hmac-secret-0123456789");
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setArtifactR2StoreForTests(undefined);
});
const label = () => randomUUID().slice(0, 8);

type Reply = { status: number; body: any };
type Who = { token: string; serverId: string };
type App = { baseUrl: string; app: { get(key: string): unknown } };

/**
 * A server with Artifacts on and Settled on unless `settled: false`: the
 * owner and a member (people), agents A and B in #priv (private) with both
 * people, agentOut outside it. Site: an Artifact in #priv pushed by A
 * (index.html). Notices pushed (not just queued) land in `delivered`.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, app: App, opts: { settled?: boolean } = {}) {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  if (opts.settled !== false) {
    await getDb().insert(featureFlagRules).values({ flagKey: ARTIFACT_SETTLED_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id] });
  }
  const make = (prefix: string) => createAgent(server.id, `${prefix}-${label()}`, { runtime: "claude", model: "sonnet" });
  const agentA = await make("st-a");
  const agentB = await make("st-b");
  const agentOut = await make("st-out");
  const priv = await createChannel(server.id, `st-priv-${label()}`, undefined, "private");
  for (const human of [owner, member]) await addHuman(priv.id, human.id);
  for (const agent of [agentA, agentB]) await addAgent(priv.id, agent.id);
  __setArtifactR2StoreForTests({ read: async () => null, presign: async () => null, put: async () => {}, delete: async () => {} });
  const key = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["read", "send"], name: `st-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const keys = { a: await key(agentA.id), b: await key(agentB.id), out: await key(agentOut.id) };
  const delivered: Array<{ agentId: string; message: AgentMessage }> = [];
  const orchestrator = app.app.get("agentOrchestrator") as { deliverMessage: (agentId: string, message: AgentMessage) => Promise<unknown> };
  orchestrator.deliverMessage = async (agentId, message) => {
    delivered.push({ agentId, message });
    return { status: "delivered" };
  };
  const published = await agentCall(app, "POST", "/artifacts/push", keys.a, { target: `#${priv.name}`, title: "Site", files: [{ path: "index.html", content: "<h1>v1</h1>" }] });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  const as = async (userId: string) => ({ token: await accessTokenForTest(userId), serverId: server.id });
  return {
    server, owner, member, agentA, agentB, keys, delivered,
    site: asArtifactId(published.body.artifact.id as string),
    who: { owner: await as(owner.id), member: await as(member.id) },
  };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

async function agentCall(app: { baseUrl: string }, method: string, path: string, apiKey: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function web(app: { baseUrl: string }, method: string, path: string, who: Who, body?: unknown): Promise<Reply> {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const settle = (app: App, apiKey: string, site: ArtifactId) => agentCall(app, "POST", `/artifacts/${site}/settle`, apiKey);
const unsettle = (app: App, apiKey: string, site: ArtifactId) => agentCall(app, "POST", `/artifacts/${site}/unsettle`, apiKey);
const read = (app: App, apiKey: string, site: ArtifactId) => agentCall(app, "GET", `/artifacts/${site}`, apiKey);
const push = (app: App, apiKey: string, site: ArtifactId, base: number, content: string) =>
  agentCall(app, "POST", "/artifacts/push", apiKey, { artifact: site, base, files: [{ path: "index.html", content }] });
const itemOf = async (id: string) => (await getDb().select().from(artifactItems).where(eq(artifactItems.id, id)))[0]!;
const eventsOf = (itemId: string, eventKind: string) => getDb().select().from(objectEvents).where(and(eq(objectEvents.objectId, itemId), eq(objectEvents.eventKind, eventKind)));
const queuedTo = async (agentId: string) => (await getDb().select().from(thirdPartyAgentEvents)
  .where(and(eq(thirdPartyAgentEvents.agentId, agentId), eq(thirdPartyAgentEvents.systemApp, "system.artifacts")))
  .orderBy(asc(thirdPartyAgentEvents.createdAt)))
  .map((event) => (event.payload as { app_event?: ArtifactAgentAppEvent }).app_event!)
  .filter((event) => event.settlement);

test("flag off: the routes answer 404 SETTLED_NOT_AVAILABLE, no answer carries `settled`, and a push isn't held", async ({ app, seed }) => {
  const world = await seedWorld(seed, app, { settled: false });

  const agent = await settle(app, world.keys.b, world.site);
  assert.equal(agent.status, 404, JSON.stringify(agent.body));
  assert.equal(agent.body.code, "SETTLED_NOT_AVAILABLE");
  const person = await web(app, "POST", artifactWebPaths.settle(world.site), world.who.owner);
  assert.equal(person.status, 404, JSON.stringify(person.body));
  assert.equal(person.body.code, "SETTLED_NOT_AVAILABLE");
  assert.equal((await itemOf(world.site)).settledAt, null, "nothing written");

  const shown = await read(app, world.keys.a, world.site);
  assert.equal(shown.status, 200);
  assert.equal("settled" in shown.body.artifact, false);
  assert.equal("reopened" in shown.body.artifact, false);
  const viewer = await web(app, "GET", artifactWebPaths.details(world.site), world.who.owner);
  assert.equal(viewer.status, 200, JSON.stringify(viewer.body));
  assert.equal("settled" in viewer.body.card, false);

  // Even with a settle on the row (say the flag was turned off after it), a push goes through, not held.
  await getDb().update(artifactItems).set({ settledAt: new Date(), settledByType: "agent", settledById: world.agentB.id, settledVersionNumber: 1 }).where(eq(artifactItems.id, world.site));
  const pushed = await push(app, world.keys.a, world.site, 1, "<h1>v2</h1>");
  assert.equal(pushed.status, 201, JSON.stringify(pushed.body));
  assert.equal("wasSettled" in pushed.body, false);
  // Nor does its version event say it ended a settle (so Activity can't either).
  const [version] = (await eventsOf(world.site, "version")).filter((event) => (event.data as { version?: number }).version === 2);
  assert.equal("wasSettled" in (version!.data as object), false);
});

test("an agent settles: the state on read and list, settling follows it, again changes nothing; unsettle takes it back, again changes nothing", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);

  const settled = await settle(app, world.keys.b, world.site);
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  assert.equal(settled.body.changed, true);
  assert.equal(settled.body.newlySubscribed, true, "settling follows it, as commenting does");
  assert.deepEqual({ ...settled.body.artifact.settled, at: undefined }, { by: { type: "agent", name: world.agentB.name }, at: undefined, version: 1 });
  assert.equal(settled.body.artifact.reopened, null);

  const again = await settle(app, world.keys.b, world.site);
  assert.equal(again.status, 200);
  assert.equal(again.body.changed, false);
  assert.equal(again.body.artifact.settled.at, settled.body.artifact.settled.at, "the first settle stands");

  const shown = await read(app, world.keys.a, world.site);
  assert.equal(shown.body.artifact.settled.version, 1);
  const listed = await agentCall(app, "GET", "/artifacts", world.keys.a);
  assert.equal(listed.body.artifacts.find((a: { id: string }) => a.id === world.site).settled.version, 1);

  const working = await unsettle(app, world.keys.a, world.site);
  assert.equal(working.status, 200, JSON.stringify(working.body));
  assert.equal(working.body.changed, true);
  assert.equal(working.body.artifact.settled, null);
  assert.equal(working.body.artifact.reopened, null);
  const item = await itemOf(world.site);
  assert.deepEqual([item.settledAt, item.settledByType, item.settledById, item.settledVersionNumber, item.settledLapsedVersion], [null, null, null, null, null]);
  assert.equal((await unsettle(app, world.keys.a, world.site)).body.changed, false);

  assert.equal((await eventsOf(world.site, "settled")).length, 1);
  assert.equal((await eventsOf(world.site, "unsettled")).length, 1);
});

test("who may: an agent that can't see it gets the one 404; a person of the server settles on the web, the card says so", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);

  const outside = await settle(app, world.keys.out, world.site);
  assert.equal(outside.status, 404, JSON.stringify(outside.body));
  assert.equal(outside.body.code, "NOT_VISIBLE");

  const before = await web(app, "GET", artifactWebPaths.details(world.site), world.who.member);
  assert.equal(before.body.card.settled, null, "Settled on: the card says Working (null), not absent");
  const settled = await web(app, "POST", artifactWebPaths.settle(world.site), world.who.member);
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  assert.equal(settled.body.changed, true);
  assert.equal(settled.body.settled.by.id, world.member.id);
  assert.equal(settled.body.settled.version, 1);
  const card = (await web(app, "GET", artifactWebPaths.details(world.site), world.who.owner)).body.card;
  assert.equal(card.settled.by.id, world.member.id);
  assert.equal(card.reopened, null);

  const working = await web(app, "DELETE", artifactWebPaths.settle(world.site), world.who.owner);
  assert.equal(working.status, 200, JSON.stringify(working.body));
  assert.deepEqual(working.body, { settled: null, changed: true });
});

test("people's Activity: the settle moves a follower's row, read; a row unread before stays unread", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  // Both people follow it; the owner has read it, the member hasn't.
  for (const who of [world.who.owner, world.who.member]) assert.equal((await web(app, "PUT", artifactWebPaths.subscription(world.site), who)).status, 200);
  assert.equal((await push(app, world.keys.a, world.site, 1, "<h1>v2</h1>")).status, 201);
  assert.equal((await web(app, "GET", artifactWebPaths.viewer(world.site), world.who.owner)).status, 200);
  const rowOf = async (userId: string) => (await getDb().select().from(objectInboxStates)
    .where(and(eq(objectInboxStates.userId, userId), eq(objectInboxStates.objectId, world.site))))[0]!;
  const unread = (row: Awaited<ReturnType<typeof rowOf>>) => row.lastEventSeq > Math.max(row.doneThroughSeq ?? 0, row.readThroughSeq ?? 0);
  assert.equal(unread(await rowOf(world.owner.id)), false);
  assert.equal(unread(await rowOf(world.member.id)), true);

  assert.equal((await settle(app, world.keys.b, world.site)).status, 200);
  const [event] = await eventsOf(world.site, "settled");
  const owner = await rowOf(world.owner.id);
  assert.equal(owner.lastEventId, event!.id, "the row shows the settle");
  assert.equal(unread(owner), false, "and stays read: settling asks nothing of anyone");
  assert.equal(unread(await rowOf(world.member.id)), true, "the member's unread version stays unread");
});

test("its agents are told, queued and never pushed; the settler isn't told", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  world.delivered.length = 0;

  assert.equal((await settle(app, world.keys.b, world.site)).status, 200);
  const toA = await queuedTo(world.agentA.id);
  assert.equal(toA.length, 1, "A, its author and follower, is told");
  assert.deepEqual(toA[0]!.settlement, { by: { type: "agent", name: world.agentB.name }, settled: true, version: 1 });
  assert.equal((await queuedTo(world.agentB.id)).length, 0, "the settler isn't told");
  assert.equal(world.delivered.length, 0, "nothing is pushed: a status change wakes no one");

  assert.equal((await web(app, "DELETE", artifactWebPaths.settle(world.site), world.who.owner)).status, 200);
  const unsettled = (await queuedTo(world.agentA.id)).map((event) => event.settlement!.settled);
  assert.deepEqual(unsettled, [true, false]);
  assert.equal(world.delivered.length, 0);
});

test("a push to a settled artifact: held once (409 SETTLED, nothing published), the same push again goes through and takes it back to Working", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  assert.equal((await settle(app, world.keys.b, world.site)).status, 200);

  const held = await push(app, world.keys.a, world.site, 1, "<h1>v2</h1>");
  assert.equal(held.status, 409, JSON.stringify(held.body));
  assert.equal(held.body.code, "SETTLED");
  assert.equal(held.body.details.title, "Site");
  assert.equal(held.body.details.next, 2);
  assert.deepEqual({ ...held.body.details.settled, at: undefined }, { by: { type: "agent", name: world.agentB.name }, at: undefined, version: 1 });
  assert.equal((await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, world.site))).length, 1, "nothing published");
  assert.equal((await getDb().select().from(artifactSettledHolds).where(eq(artifactSettledHolds.actorId, world.agentA.id))).length, 1, "the hold recorded that A was told");

  const pushed = await push(app, world.keys.a, world.site, 1, "<h1>v2</h1>");
  assert.equal(pushed.status, 201, JSON.stringify(pushed.body));
  assert.equal(pushed.body.version.number, 2);
  assert.equal(pushed.body.wasSettled.version, 1);
  assert.equal(pushed.body.artifact.settled, null);
  assert.deepEqual([pushed.body.artifact.reopened.version, pushed.body.artifact.reopened.was.version], [2, 1]);
  const [version] = await eventsOf(world.site, "version").then((events) => events.filter((event) => (event.data as { version?: number }).version === 2));
  assert.equal((version!.data as { wasSettled?: number }).wasSettled, 1, "the version event says it came after the settle");

  // Working again: the next push isn't held. An unsettle clears what is left of the settle ("working again"), quietly; again it changes nothing.
  assert.equal((await push(app, world.keys.a, world.site, 2, "<h1>v3</h1>")).status, 201);
  const cleared = await unsettle(app, world.keys.b, world.site);
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.changed, true);
  assert.deepEqual([cleared.body.artifact.settled, cleared.body.artifact.reopened], [null, null]);
  const item = await itemOf(world.site);
  assert.deepEqual([item.settledAt, item.settledByType, item.settledById, item.settledVersionNumber, item.settledLapsedVersion], [null, null, null, null, null]);
  assert.equal((await eventsOf(world.site, "unsettled")).length, 0, "it was Working already: no event, no notice");
  assert.equal((await unsettle(app, world.keys.b, world.site)).body.changed, false);

  // Settled again: a new settle holds A again, once.
  assert.equal((await settle(app, world.keys.b, world.site)).body.changed, true);
  assert.equal((await itemOf(world.site)).settledLapsedVersion, null, "settling again clears the lapse");
  assert.equal((await push(app, world.keys.a, world.site, 3, "<h1>v4</h1>")).body.code, "SETTLED");
});

test("what leaves it settled: the settler's own push isn't held, a push that changes nothing and a comment change nothing", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  assert.equal((await settle(app, world.keys.a, world.site)).status, 200);

  const same = await push(app, world.keys.a, world.site, 1, "<h1>v1</h1>");
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.unchanged, true);
  // B reads it first (else its comment is held for v1, which it hasn't seen).
  assert.equal((await read(app, world.keys.b, world.site)).status, 200);
  const commented = await agentCall(app, "POST", `/artifacts/${world.site}/comments`, world.keys.b, { body: "Looks done." });
  assert.equal(commented.status, 201, JSON.stringify(commented.body));
  assert.equal((await itemOf(world.site)).settledLapsedVersion, null);
  assert.equal((await read(app, world.keys.b, world.site)).body.artifact.settled.version, 1);

  // A settled it, so A's own new version goes through at once (and takes it back to Working), once it has read B's comment.
  assert.equal((await agentCall(app, "GET", `/artifacts/${world.site}/comments`, world.keys.a)).status, 200);
  const own = await push(app, world.keys.a, world.site, 1, "<h1>v2</h1>");
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(own.body.wasSettled.version, 1);
});
