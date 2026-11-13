import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";
import type { Database } from "../db";
import { jointChannelServers, messages, oauthAppLinkPreviews, oauthClientInstalls, oauthLinkPreviewDeclines, oauthUserConsents, officialAppRegistry, servers } from "../db/schema";
import { __setPreviewHttpForTests, __settleAppLinkPreviewRechecksForTests } from "../services/appLinkPreviewService";
import { disconnectJointChannel, getActiveJointThreadProjectionsByCanonicalThread, getOrCreateThreadForChannel } from "../services/channelService";
import { __resetLinkCardActionLimitsForTests } from "../services/linkCardActionLimits";
import { __resetLinkCardReadBudgetForTests } from "../services/linkCardReadService";
import { createMessage, getMessageContext } from "../services/messageService";
import { createOAuthClient } from "../services/oauthService";
import { oidcIssuer } from "../services/oidcService";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import type { createSeed } from "../test/integration/seed";
import { connected } from "../test/jointHumanMembershipScenarios";
import { ALL_CAPABILITIES, appAnswer, clientRequestId, post as postAction, stubApp } from "../test/linkCardActionFixture";

// App link cards in Joint Channels (RFC 076 §16), behind link_cards_joint_v0:
// every link is resolved in the context of the Server the viewer reads from,
// never the Server that stores the message. Real joint storage (a canonical
// channel in the joint-storage namespace, a projection on each Server), the
// real routes, and the App as the substituted preview transport.
const test = createApiTest();
const originalKey = process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY;
const originalOfficialServer = process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
beforeEach(() => {
  process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});
afterEach(async () => {
  await __settleAppLinkPreviewRechecksForTests();
  __setPreviewHttpForTests(null);
  __resetLinkCardActionLimitsForTests();
  __resetLinkCardReadBudgetForTests();
  for (const [name, value] of [["RAFT_OIDC_SIGNING_PRIVATE_KEY", originalKey], ["RAFT_OFFICIAL_PUBLISHER_SERVER_ID", originalOfficialServer]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

type Seed = ReturnType<typeof createSeed>;
type Human = Awaited<ReturnType<Seed["human"]>>;
type Server = Awaited<ReturnType<Seed["server"]>>;
type Headers = Record<string, string>;
type ReadItem = { url: string; kind: string; actions?: { action_id: string; handle: string }[] };
type Prompt = { url: string; app: { id: string; name: string; icon: string | null } };

const v1Card = { version: 1, title: "Private PR", card: { root: "status", elements: { status: { type: "Badge", props: { text: "Approved" } } } } };
const suffix = () => randomUUID().slice(0, 8);
const originFor = (label: string) => `https://${label}-${suffix()}.example.test`;

const headersFor = async (human: Human, server: Server): Promise<Headers> =>
  ({ Authorization: `Bearer ${await tokenForHuman(human.email)}`, "X-Server-Id": server.id, "Content-Type": "application/json" });


/** An App registered for `origin` paths /pr, installed on `server`, consented there by `consenting`. */
async function installedApp(db: Database, input: { origin: string; server: Server; owner: Human; consenting: Human[]; actionEndpoint?: boolean }) {
  const key = `joint-${suffix()}`;
  const { client } = await createOAuthClient({ serverId: input.server.id, createdByUserId: input.owner.id, clientId: key, name: `${key} App` });
  const [install] = await db.insert(oauthClientInstalls).values({ clientId: client.id, serverId: input.server.id, installedByUserId: input.owner.id }).returning();
  for (const person of input.consenting) await db.insert(oauthUserConsents).values({ serverId: input.server.id, userId: person.id, clientId: client.id, scopes: ["openid", "profile"] });
  await db.insert(oauthAppLinkPreviews).values({ clientId: client.id, origin: input.origin, endpoint: `${input.origin}/callback`, paths: ["/pr"], previewVersions: [1, 2, 3],
    actionEndpoint: input.actionEndpoint ? `${input.origin}/card-actions` : null });
  return { client, install: install! };
}

async function makeOfficial(db: Database, app: { client: { id: string; clientId: string } }, publisher: Server) {
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = publisher.id;
  await db.insert(officialAppRegistry).values({ oauthClientId: app.client.id, clientKey: app.client.clientId, publisherServerId: publisher.id, purpose: "Link cards", status: "approved" });
}

const readBody = (extra: Record<string, unknown> = {}) => JSON.stringify({ view_instance_id: randomUUID(), capabilities: ALL_CAPABILITIES, locale: "en", ...extra });
const postRead = (baseUrl: string, headers: Headers, messageId: string, body = readBody()) =>
  fetch(`${baseUrl}/api/messages/${messageId}/link-cards/read`, { method: "POST", headers, body });
const getPreviews = (baseUrl: string, headers: Headers, messageId: string) =>
  fetch(`${baseUrl}/api/messages/${messageId}/app-link-previews`, { headers });

/** A read by a client without card.v2 (version 1 items, nothing signed); `body` for another client. */
async function read(baseUrl: string, headers: Headers, messageId: string, body = readBody({ capabilities: [] })) {
  const response = await postRead(baseUrl, headers, messageId, body);
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as { items: ReadItem[]; prompts: Prompt[] };
}

/** Both preview reads answer exactly what they answer for a message that does not exist. */
async function assertUnknownMessage(baseUrl: string, headers: Headers, messageId: string, why: string) {
  const unknown = randomUUID();
  for (const [name, call] of [["GET", getPreviews], ["POST", postRead]] as const) {
    const [response, reference] = [await call(baseUrl, headers, messageId), await call(baseUrl, headers, unknown)];
    assert.equal(response.status, 404, `${name}: ${why}`);
    assert.equal(reference.status, 404, `${name}: unknown message`);
    assert.equal(await response.text(), await reference.text(), `${name}: same body as an unknown message: ${why}`);
  }
}

/** A joint channel between A and B, with a real message stored in canonical, authored by a person reading B. */
async function jointFixture(db: Database, seed: Seed, baseUrl: string, content: string) {
  const x = await connected({ db, seed });
  const headersB = await headersFor(x.owner, x.b);
  const sent = await fetch(`${baseUrl}/api/messages`, { method: "POST", headers: headersB, body: JSON.stringify({ channelId: x.target.id, content }) });
  assert.equal(sent.status, 200, await sent.clone().text());
  const { id: messageId } = await sent.json() as { id: string };
  const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
  assert.equal(row?.channelId, x.joint.jointChannel.canonicalChannelId, "the message is in joint storage, not on B's projection");
  return { ...x, messageId, headersA: await headersFor(x.owner, x.a), headersB };
}

/** A message in the joint's thread, stored in canonical, with a projection of the thread on both Servers. */
async function jointThreadMessage(db: Database, x: Awaited<ReturnType<typeof jointFixture>>, content: string) {
  const thread = await getOrCreateThreadForChannel(x.target.id, x.messageId, x.owner.id, "user");
  assert.ok("canonicalThreadChannelId" in thread && thread.canonicalThreadChannelId);
  const canonicalThreadChannelId = thread.canonicalThreadChannelId;
  const projections = await getActiveJointThreadProjectionsByCanonicalThread(canonicalThreadChannelId);
  assert.deepEqual(projections.map((projection) => projection.localServerId).sort(), [x.a.id, x.b.id].sort(), "a thread projection on each Server");
  const message = await createMessage(canonicalThreadChannelId, "user", x.owner.id, content);
  const [row] = await db.select().from(messages).where(eq(messages.id, message.id));
  assert.equal(row?.channelId, canonicalThreadChannelId);
  return { id: message.id, canonicalThreadChannelId, projections };
}

test("each viewer's Server resolves its own App for a joint message authored on B, in the channel and in a thread", async ({ app, db, seed }) => {
  const [originA, originB] = [originFor("a-app"), originFor("b-app")];
  const [linkA, linkB] = [`${originA}/pr/1`, `${originB}/pr/1`];
  const content = `from B: ${linkA} and ${linkB}`;
  const x = await jointFixture(db, seed, app.baseUrl, content);
  const appA = await installedApp(db, { origin: originA, server: x.a, owner: x.owner, consenting: [x.owner] });
  const appB = await installedApp(db, { origin: originB, server: x.b, owner: x.owner, consenting: [x.owner] });
  const thread = await jointThreadMessage(db, x, content);

  for (const [surface, messageId] of [["channel", x.messageId], ["thread", thread.id]] as const) {
    const calls = stubApp(() => v1Card);
    const seenOnA = await read(app.baseUrl, x.headersA, messageId);
    assert.deepEqual(seenOnA.items.map((item) => item.url), [linkA], `${surface}: A's viewer gets A's App only`);
    assert.deepEqual(seenOnA.prompts, [], `${surface}: B's App is not on A, so no prompt either`);
    assert.deepEqual(calls.map((call) => call.url), [`${originA}/callback`], `${surface}: only A's App was called`);
    assert.equal(calls[0]!.claims.server_id, x.a.id, `${surface}: the assertion names the viewer's Server`);
    assert.equal(calls[0]!.claims.installation_id, appA.install.id);
    assert.equal(calls[0]!.claims.iss, oidcIssuer(undefined, x.a.slug));
    assert.equal(calls[0]!.claims.sub, x.owner.id);

    const seenOnB = await read(app.baseUrl, x.headersB, messageId);
    assert.deepEqual(seenOnB.items.map((item) => item.url), [linkB], `${surface}: B's viewer gets B's App only`);
    assert.deepEqual(seenOnB.prompts, []);
    assert.deepEqual(calls.slice(1).map((call) => call.url), [`${originB}/callback`], `${surface}: only B's App was called`);
    assert.equal(calls[1]!.claims.server_id, x.b.id);
    assert.equal(calls[1]!.claims.installation_id, appB.install.id);
    assert.equal(calls[1]!.claims.iss, oidcIssuer(undefined, x.b.slug));

    const previews = await getPreviews(app.baseUrl, x.headersA, messageId);
    assert.equal(previews.status, 200);
    const body = await previews.json() as { previews: { url: string }[]; prompts: Prompt[] };
    assert.deepEqual(body.previews.map((preview) => preview.url), [linkA], `${surface}: the GET resolves the same way`);
  }
});

test("a viewer on a Server with no App for that origin resolves against none", async ({ app, db, seed }) => {
  const origin = originFor("a-only");
  const x = await jointFixture(db, seed, app.baseUrl, `see ${origin}/pr/1`);
  await installedApp(db, { origin, server: x.a, owner: x.owner, consenting: [x.owner] });
  const calls = stubApp(() => v1Card);
  assert.deepEqual(await read(app.baseUrl, x.headersB, x.messageId), { items: [], prompts: [] }, "the App is on A only: B's viewer reads a plain link");
  assert.equal(calls.length, 0, "nothing was sent to A's App on behalf of a viewer reading B");
  assert.equal((await read(app.baseUrl, x.headersA, x.messageId)).items.length, 1, "the same message on A resolves");
});

test("a local channel resolves as before", async ({ app, db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const origin = originFor("local");
  const message = await seed.message({ channel, author: owner, content: `see ${origin}/pr/1` });
  await installedApp(db, { origin, server, owner, consenting: [owner] });
  const headers = await headersFor(owner, server);
  stubApp(() => v1Card);
  const expected = [{ url: `${origin}/pr/1`, kind: "v1" }];
  const shown = async () => (await read(app.baseUrl, headers, message.id)).items.map(({ url, kind }) => ({ url, kind }));
  assert.deepEqual(await shown(), expected);
  assert.equal((await getPreviews(app.baseUrl, headers, message.id)).status, 200);
});

test("no projection, an inactive projection, or a viewer who can't see the projection: the unknown message's 404", async ({ app, db, seed }) => {
  const origin = originFor("gate");
  const x = await jointFixture(db, seed, app.baseUrl, `see ${origin}/pr/1`);
  const thread = await jointThreadMessage(db, x, `threaded ${origin}/pr/1`);
  await installedApp(db, { origin, server: x.a, owner: x.owner, consenting: [x.owner, x.peer] });
  await installedApp(db, { origin: originFor("b-gate"), server: x.b, owner: x.owner, consenting: [x.owner] });
  const stranger = await seed.human();
  const c = await seed.server({ owner: stranger });
  const calls = stubApp(() => v1Card);

  // A Server that is not in the joint at all.
  await assertUnknownMessage(app.baseUrl, await headersFor(stranger, c), x.messageId, "no projection on C");
  await assertUnknownMessage(app.baseUrl, await headersFor(stranger, c), thread.id, "no thread projection on C");

  // (A J member who is also a member of B enters through B as well: computed
  // joint membership has no per-copy membership to be outside of.)
  assert.equal((await read(app.baseUrl, await headersFor(x.peer, x.a), x.messageId)).items.length, 1, "they are in A's projection");

  // An inactive thread projection, with the channel's still active.
  const onB = thread.projections.find((projection) => projection.localServerId === x.b.id)!;
  await db.update(jointChannelServers).set({ status: "disconnected" }).where(and(eq(jointChannelServers.jointChannelId, onB.jointThreadId), eq(jointChannelServers.serverId, x.b.id)));
  await assertUnknownMessage(app.baseUrl, x.headersB, thread.id, "B's thread projection is inactive");
  assert.equal((await read(app.baseUrl, x.headersA, thread.id)).items.length, 1, "A's is still active");

  // A real disconnect of B.
  await disconnectJointChannel(x.target.id, x.owner.id);
  await assertUnknownMessage(app.baseUrl, x.headersB, x.messageId, "B disconnected");
  assert.equal((await read(app.baseUrl, x.headersA, x.messageId)).items.length, 1, "A is still in the joint");
  assert.equal(calls.filter((call) => (call.claims.server_id as string) !== x.a.id).length, 0, "every callback was for a viewer on A");
});

test("the history window is the viewer's Server's, not the storing Server's", async ({ app, db, seed }) => {
  const [originA, originB] = [originFor("hist-a"), originFor("hist-b")];
  const x = await jointFixture(db, seed, app.baseUrl, `old ${originA}/pr/1 ${originB}/pr/1`);
  await installedApp(db, { origin: originA, server: x.a, owner: x.owner, consenting: [x.owner] });
  await installedApp(db, { origin: originB, server: x.b, owner: x.owner, consenting: [x.owner] });
  stubApp(() => v1Card);
  const longAgo = new Date(Date.now() - 400 * 24 * 3600_000);
  await db.update(messages).set({ createdAt: longAgo }).where(eq(messages.id, x.messageId));
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, x.a.id));
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, x.b.id));
  await assertUnknownMessage(app.baseUrl, x.headersA, x.messageId, "older than A's free plan keeps");
  assert.deepEqual((await read(app.baseUrl, x.headersB, x.messageId)).items.map((item) => item.url), [`${originB}/pr/1`], "B keeps all history");

  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, x.a.id));
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, x.b.id));
  assert.deepEqual((await read(app.baseUrl, x.headersA, x.messageId)).items.map((item) => item.url), [`${originA}/pr/1`], "and the reverse, so it isn't the storing Server's or a fixed side's");
  await assertUnknownMessage(app.baseUrl, x.headersB, x.messageId, "older than B's free plan keeps");
});

test("consent: an App the viewer has not consented to gets no callback and the viewer a prompt, official or not, and a consent on the other Server doesn't count", async ({ app, db, seed }) => {
  const [plain, official, otherServer] = [originFor("plain"), originFor("official"), originFor("other")];
  const x = await jointFixture(db, seed, app.baseUrl, `from B ${plain}/pr/1 ${official}/pr/1 ${otherServer}/pr/1`);
  const appPlain = await installedApp(db, { origin: plain, server: x.a, owner: x.owner, consenting: [] });
  const appOfficial = await installedApp(db, { origin: official, server: x.a, owner: x.owner, consenting: [] });
  await makeOfficial(db, appOfficial, x.a);
  // Installed on both Servers, consented on B only.
  const appOther = await installedApp(db, { origin: otherServer, server: x.a, owner: x.owner, consenting: [] });
  await db.insert(oauthClientInstalls).values({ clientId: appOther.client.id, serverId: x.b.id, installedByUserId: x.owner.id });
  await db.insert(oauthUserConsents).values({ serverId: x.b.id, userId: x.owner.id, clientId: appOther.client.id, scopes: ["openid", "profile"] });
  const calls = stubApp(() => v1Card);

  const { items, prompts } = await read(app.baseUrl, x.headersA, x.messageId);
  assert.deepEqual(items, [], "no card from an App nothing was sent to");
  assert.deepEqual(prompts.map((prompt) => prompt.app.id).sort(), [appPlain.client.id, appOfficial.client.id, appOther.client.id].sort(), "one prompt per un-consented App, the official one included");
  const previews = await getPreviews(app.baseUrl, x.headersA, x.messageId);
  assert.equal(previews.status, 200);
  const body = await previews.json() as { previews: unknown[]; prompts: Prompt[] };
  assert.deepEqual(body.previews, []);
  assert.equal(body.prompts.length, 3, "the GET prompts the same way");
  assert.equal(calls.length, 0, "nothing was sent to any App");

  // A decline hides the prompt, and still sends nothing.
  await db.insert(oauthLinkPreviewDeclines).values({ serverId: x.a.id, userId: x.owner.id, clientId: appOfficial.client.id });
  const afterDecline = await read(app.baseUrl, x.headersA, x.messageId);
  assert.deepEqual(afterDecline.items, []);
  assert.equal(afterDecline.prompts.some((prompt) => prompt.app.id === appOfficial.client.id), false, "declined: no prompt");
  assert.equal(calls.length, 0);

  // Consenting on the viewer's own Server is what opens it.
  await db.insert(oauthUserConsents).values({ serverId: x.a.id, userId: x.owner.id, clientId: appPlain.client.id, scopes: ["openid", "profile"] });
  const consented = await read(app.baseUrl, x.headersA, x.messageId);
  assert.deepEqual(consented.items.map((item) => item.url), [`${plain}/pr/1`]);
  assert.deepEqual(calls.map((call) => call.url), [`${plain}/callback`], "only the App this viewer consented to here was called");
  assert.equal(calls[0]!.claims.server_id, x.a.id);
});

test("the actions path goes through the same gate: prepare and execute work for a joint message, keyed to the viewer's Server, and stop with the projection", async ({ app, db, seed }) => {
  const origin = originFor("actions");
  const url = `${origin}/pr/1`;
  const x = await jointFixture(db, seed, app.baseUrl, `approve ${url}`);
  const official = await installedApp(db, { origin, server: x.a, owner: x.owner, consenting: [x.owner], actionEndpoint: true });
  await makeOfficial(db, official, x.a);
  const approve = { type: "Button", props: { label: "Approve", action: { kind: "execute", action_id: "approve", undoWindowMs: 5000 } } };
  const merge = { type: "Button", props: { label: "Merge", action: { kind: "execute", action_id: "merge", confirm: "prepare" } } };
  const calls = stubApp((call) => call.url.endsWith("/callback")
    ? JSON.stringify({ version: 2, display: "card", title: "PR #1", card_revision: "cr-1", business_revision: "br-1",
      card: { root: "root", elements: { root: { type: "Stack", props: {}, children: ["approve", "merge"] }, approve, merge } } })
    : appAnswer({ status: "accepted" }));
  const handles = async () => {
    const [item] = (await read(app.baseUrl, x.headersA, x.messageId, readBody())).items;
    assert.equal(item?.url, url);
    const handle = (id: string) => item!.actions!.find((action) => action.action_id === id)!.handle;
    return { approve: handle("approve"), merge: handle("merge") };
  };
  const actionCalls = () => calls.filter((call) => call.url === `${origin}/card-actions`);
  const fx = { headers: x.headersA };
  const first = await handles();
  const second = await handles();

  // Through the projection, the action runs for the viewer's Server.
  const executed = await postAction(app.baseUrl, "execute", fx, { client_request_id: clientRequestId(), handle: first.approve });
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  assert.equal(actionCalls().length, 1);
  assert.equal(actionCalls()[0]!.claims.server_id, x.a.id, "the action's assertion names the viewer's Server");
  assert.equal(actionCalls()[0]!.claims.installation_id, official.install.id);
  assert.equal(actionCalls()[0]!.claims.message_id, x.messageId);
  assert.equal(actionCalls()[0]!.claims.sub, x.owner.id);

  // A prepare reaches the App too (its answer here isn't a valid description: only that it was asked).
  const prepared = await postAction(app.baseUrl, "prepare", fx, { handle: first.merge, claimed: { business_revision: "br-1" } });
  assert.equal(prepared.status, 502, JSON.stringify(prepared.body));
  assert.equal(actionCalls().length, 2, "prepare reached the App through the same live-state check");

  // A's projection gone: out of date, and nothing reaches the App.
  const before = actionCalls().length;
  await db.update(jointChannelServers).set({ status: "disconnected" }).where(and(eq(jointChannelServers.jointChannelId, x.joint.jointChannel.id), eq(jointChannelServers.serverId, x.a.id)));
  const noProjection = await postAction(app.baseUrl, "execute", fx, { client_request_id: clientRequestId(), handle: second.approve });
  assert.equal(noProjection.status, 410, JSON.stringify(noProjection.body));
  assert.equal(noProjection.body.code, "HANDLE_INVALID");
  assert.equal(actionCalls().length, before, "no projection stops the action before the App");
});

test("getMessageContext with the viewer's Server returns the joint message's content, from either side", async ({ app, db, seed }) => {
  const content = `the words as written https://example.test/pr/1 中文`;
  const x = await jointFixture(db, seed, app.baseUrl, content);
  const thread = await jointThreadMessage(db, x, `${content} (thread)`);
  for (const server of [x.a, x.b]) {
    const options = { attachmentCommentViewerUserId: x.owner.id, forwardedBundleViewerUserId: x.owner.id, viewerServerId: server.id };
    const channelContext = await getMessageContext(x.messageId, 0, 0, undefined, options);
    assert.deepEqual(channelContext?.messages.map((message) => [message.id, message.content]), [[x.messageId, content]], `channel message, viewer on ${server.slug}`);
    const threadContext = await getMessageContext(thread.id, 0, 0, undefined, options);
    assert.deepEqual(threadContext?.messages.map((message) => [message.id, message.content]), [[thread.id, `${content} (thread)`]], `thread message, viewer on ${server.slug}`);
  }
});
