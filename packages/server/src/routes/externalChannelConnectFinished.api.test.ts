import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { channelExternalInvites, serverMembers, servers, userAnalyticsIds } from "../db/schema";
import { acceptJointChannelInvite, addHuman, createChannel, createJointChannel } from "../services/channelService";
import { runChannelConversionJob, startChannelToJointConversion } from "../services/channelConversionService";
import { runChannelConversionWorkerPass } from "../services/channelConversionWorker";
import { connectRefusalCode, setExternalConnectWorkerProductEventSink } from "../services/externalConnectProductEvents";
import { prepareJointHumanMembershipMirror } from "../services/jointHumanMembershipMirror";
import { PRODUCT_EVENT_SINK_APP_KEY } from "../services/productEventIngest";
import type { ProductEventRow, ProductEventSink } from "../services/productEventScopeDbWriter";
import { createServer } from "../services/serverService";
import { createApiTest } from "../test/integration/apiTest";
import { enableExternalChannelsFlag, login, seedUser, sha256 } from "../test/externalInviteFixture";
import { seedBoundGuest } from "../test/guestFixture";

// external_channel_connect_finished (cindyz via Warden, 2026-11-12,
// #wg-rbac:db8d6e83): one row per finished join or connect attempt, through
// the real routes and the real connect worker.
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const DAY_MS = 24 * 60 * 60 * 1000;
const EVENT = "external_channel_connect_finished";

type Person = Awaited<ReturnType<typeof seedUser>> & { token: string };
type Row = { properties: ProductEventRow["properties"]; server: string | null; who: string | null };

async function person(baseUrl: string, label: string): Promise<Person> {
  const user = await seedUser(`${label}-${randomBytes(4).toString("hex")}`);
  return { ...user, token: await login(baseUrl, user.email) };
}

/**
 * The event's rows, from the routes (the app's sink) and the worker (its
 * startup sink) alike. `expect` waits for exactly `count` rows (routes record
 * without awaiting), then a little longer for an unwanted one.
 */
function captureConnectFinished(app: { app: { set(key: string, value: unknown): unknown } }) {
  const all: ProductEventRow[] = [];
  const sink: ProductEventSink = { enqueue: (batch) => { all.push(...batch); }, flush: async () => {} };
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, sink);
  setExternalConnectWorkerProductEventSink(sink);
  const rows = (): Row[] => all.filter((row) => row.event === EVENT).map((row) => ({ properties: row.properties, server: row.server_id, who: row.analytics_id }));
  let seen = 0;
  return {
    rows,
    /** The rows recorded since the last call: exactly `count` of them. */
    async next(count: number, label: string): Promise<Row[]> {
      const until = Date.now() + 2000;
      while (rows().length < seen + count && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
      await new Promise((resolve) => setTimeout(resolve, 150));
      const fresh = rows().slice(seen);
      assert.equal(fresh.length, count, `${label}: ${JSON.stringify(fresh)}`);
      seen += count;
      return fresh;
    },
  };
}

async function analyticsIdOf(userId: string): Promise<string | null> {
  const [row] = await getDb().select({ id: userAnalyticsIds.analyticsId }).from(userAnalyticsIds).where(eq(userAnalyticsIds.userId, userId));
  return row?.id ?? null;
}

async function seedHost(baseUrl: string, plan: "free" | "pro" = "pro") {
  const owner = await person(baseUrl, "cf-host-owner");
  const server = await createServer("Finished Host", `cf-host-${randomBytes(4).toString("hex")}`, owner.id);
  await getDb().update(servers).set({ plan }).where(eq(servers.id, server.id));
  await enableExternalChannelsFlag(server.id);
  const room = async () => createChannel(server.id, `cf-room-${randomBytes(4).toString("hex")}`, undefined, "private", { type: "user", id: owner.id });
  return { owner, server, room };
}

async function seedTarget(owner: Person, members: Array<[Person, "admin" | "member"]> = [], plan: "free" | "pro" = "pro") {
  const server = await createServer("Target", `cf-target-${randomBytes(4).toString("hex")}`, owner.id);
  for (const [member, role] of members) await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role });
  await getDb().update(servers).set({ plan }).where(eq(servers.id, server.id));
  return server;
}

async function seedInvite(host: Awaited<ReturnType<typeof seedHost>>, channelId: string, email: string) {
  const token = randomBytes(32).toString("hex");
  const [row] = await getDb().insert(channelExternalInvites).values({
    channelId, hostServerId: host.server.id, email, tokenHash: sha256(token), invitedByUserId: host.owner.id, expiresAt: new Date(Date.now() + 14 * DAY_MS),
  }).returning({ id: channelExternalInvites.id });
  return { id: row!.id, token };
}

async function convertToJoint(host: Awaited<ReturnType<typeof seedHost>>, channelId: string) {
  const job = await startChannelToJointConversion({ serverId: host.server.id, sourceChannelId: channelId, createdByUserId: host.owner.id });
  assert.equal((await runChannelConversionJob(job.id)).status, "done");
}

/** The free plan's one external channel, taken: a channel of the server with a bound Guest. */
async function makeExternal(baseUrl: string, server: { id: string }, ownerId: string) {
  const channel = await createChannel(server.id, `cf-used-${randomBytes(4).toString("hex")}`, undefined, "private", { type: "user", id: ownerId });
  await seedBoundGuest({ serverId: server.id, userId: (await person(baseUrl, "cf-used-guest")).id, channelId: channel.id });
}

function call(baseUrl: string, as: Person, method: string, path: string, body?: unknown, serverId?: string) {
  return fetch(`${baseUrl}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${as.token}`, "Content-Type": "application/json", ...(serverId ? { "X-Server-Id": serverId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function expectStatus(response: Response, status: number, code?: string) {
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, status, JSON.stringify(body));
  if (code) assert.equal(body.code, code);
  return body;
}

async function driveWorker(inviteId: string) {
  for (let pass = 0; pass < 40; pass += 1) {
    const [row] = await getDb().select({ status: channelExternalInvites.status }).from(channelExternalInvites).where(eq(channelExternalInvites.id, inviteId));
    if (row?.status !== "connecting" && row?.status !== "self_connecting") return;
    await runChannelConversionWorkerPass();
  }
}

const sync = { async: false, multi: false };

test("guest and connect: one row each for a success and a refusal, under the caller's own server only; the page GET and its reloads record nothing", async ({ app }) => {
  const events = captureConnectFinished(app);
  const host = await seedHost(app.baseUrl, "pro");
  const room = await host.room();
  await convertToJoint(host, room.id);

  // A Guest: no server on the row (the host is not theirs), the host's plan read after the answer.
  const guest = await person(app.baseUrl, "cf-guest");
  const guestInvite = await seedInvite(host, room.id, guest.email);
  await expectStatus(await call(app.baseUrl, guest, "GET", `external-invites/${guestInvite.token}`), 200);
  await expectStatus(await call(app.baseUrl, guest, "POST", `external-invites/${guestInvite.token}/accept-as-guest`), 200);
  assert.deepEqual(await events.next(1, "the Guest accept"), [{ properties: { path: "guest", result: "connected", ...sync, host_plan: "paid" }, server: null, who: await analyticsIdOf(guest.id) }]);
  // Again: already their Guest, nobody joined. No row.
  await expectStatus(await call(app.baseUrl, guest, "POST", `external-invites/${guestInvite.token}/accept-as-guest`), 200);
  await events.next(0, "a repeated accept");
  // An unusable invite: the one 404 is invite_unusable; no invite, so no host and no host plan.
  await expectStatus(await call(app.baseUrl, guest, "POST", `external-invites/${randomBytes(32).toString("hex")}/accept-as-guest`), 404);
  assert.deepEqual((await events.next(1, "the unusable invite")).map((row) => [row.properties, row.server]), [[{ path: "guest", result: "refused", refusal_code: "invite_unusable", ...sync }, null]]);

  // Connect a server they own: the row is under it.
  const owner = await person(app.baseUrl, "cf-connect");
  const target = await seedTarget(owner);
  const invite = await seedInvite(host, room.id, owner.email);
  await expectStatus(await call(app.baseUrl, owner, "POST", `external-invites/${invite.token}/connect`, { serverId: target.id }), 200);
  assert.deepEqual(await events.next(1, "the connect"), [{ properties: { path: "connect", result: "connected", ...sync, host_plan: "paid" }, server: target.id, who: await analyticsIdOf(owner.id) }]);

  // A free server already in an external channel, refused by its own limit (the connecting side): under it, with the host's plan.
  const freeOwner = await person(app.baseUrl, "cf-free");
  const free = await seedTarget(freeOwner, [], "free");
  await makeExternal(app.baseUrl, free, freeOwner.id);
  await expectStatus(await call(app.baseUrl, freeOwner, "POST", `external-invites/${(await seedInvite(host, room.id, freeOwner.email)).token}/connect`, { serverId: free.id }), 409, "free_external_limit");
  assert.deepEqual((await events.next(1, "the limit refusal")).map((row) => [row.properties, row.server]), [[{ path: "connect", result: "refused", refusal_code: "free_external_limit", limit_side: "connecting", ...sync, host_plan: "paid" }, free.id]]);

  // A server the caller is not in is never their row's server.
  const stranger = await person(app.baseUrl, "cf-stranger");
  await expectStatus(await call(app.baseUrl, stranger, "POST", `external-invites/${(await seedInvite(host, room.id, stranger.email)).token}/connect`, { serverId: target.id }), 400, "invalid_server");
  assert.deepEqual((await events.next(1, "someone else's server")).map((row) => [row.properties, row.server]), [[{ path: "connect", result: "refused", refusal_code: "invalid_server", ...sync, host_plan: "paid" }, null]]);

  // Nothing of the invite, channel or host is on any row.
  for (const row of events.rows()) for (const key of Object.keys(row.properties)) assert.ok(["path", "result", "refusal_code", "limit_side", "async", "multi", "host_plan"].includes(key), key);
});

test("a private channel: the connect answers connecting (one row), the page reloads record nothing, the worker's settlement is one async row", async ({ app }) => {
  const events = captureConnectFinished(app);
  const host = await seedHost(app.baseUrl, "free");
  const room = await host.room();
  const owner = await person(app.baseUrl, "cf-async");
  const target = await seedTarget(owner);
  const invite = await seedInvite(host, room.id, owner.email);

  await expectStatus(await call(app.baseUrl, owner, "POST", `external-invites/${invite.token}/connect`, { serverId: target.id }), 202);
  assert.deepEqual((await events.next(1, "the 202")).map((row) => [row.properties, row.server]), [[{ path: "connect", result: "connecting", ...sync, host_plan: "free" }, target.id]]);
  // What the web does while connecting: reloads the page. No rows.
  for (let poll = 0; poll < 3; poll += 1) await expectStatus(await call(app.baseUrl, owner, "GET", `external-invites/${invite.token}`), 200);
  await events.next(0, "the polls");

  await driveWorker(invite.id);
  assert.deepEqual(await events.next(1, "the worker"), [{ properties: { path: "connect", result: "connected", async: true, multi: false, host_plan: "free" }, server: target.id, who: await analyticsIdOf(owner.id) }]);
  // A later pass finds nothing to settle: no second row.
  await runChannelConversionWorkerPass();
  await events.next(0, "a later pass");
  assert.ok(await analyticsIdOf(owner.id), "the caller shares usage data: their analytics id is on the row");

  // One that runs out while it waits: the worker's row is expired.
  const paidHost = await seedHost(app.baseUrl, "pro");
  const late = await seedInvite(paidHost, (await paidHost.room()).id, owner.email);
  await expectStatus(await call(app.baseUrl, owner, "POST", `external-invites/${late.token}/connect`, { serverId: target.id }), 202);
  await events.next(1, "the second 202");
  await getDb().update(channelExternalInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(channelExternalInvites.id, late.id));
  await driveWorker(late.id);
  assert.deepEqual((await events.next(1, "the expiry")).map((row) => [row.properties, row.server]), [[{ path: "connect", result: "expired", async: true, multi: false, host_plan: "paid" }, target.id]]);
});

test("connect-servers: one row per chosen server as it resolved (multi), the span names the refused codes; the approver's approve and decline are their own rows", async ({ app }) => {
  const tracing = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink: tracing }));
  const events = captureConnectFinished(app);
  const host = await seedHost(app.baseUrl, "pro");
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invitee = await person(app.baseUrl, "cf-multi");
  const approver = await person(app.baseUrl, "cf-approver");
  const owned = await seedTarget(invitee);
  const asked = await seedTarget(approver, [[invitee, "member"]]);
  const alsoAsked = await seedTarget(approver, [[invitee, "member"]]);
  const atLimit = await seedTarget(invitee, [], "free");
  await makeExternal(app.baseUrl, atLimit, invitee.id);
  const invite = await seedInvite(host, room.id, invitee.email);

  const body = await expectStatus(await call(app.baseUrl, invitee, "POST", `external-invites/${invite.token}/connect-servers`, {
    servers: [{ serverId: owned.id }, { serverId: asked.id, approverUserId: approver.id }, { serverId: alsoAsked.id, approverUserId: approver.id }, { serverId: atLimit.id }],
  }), 200) as { servers: Array<{ serverId: string; state: string; requestId?: string }> };
  assert.deepEqual(body.servers.map((server) => server.state), ["connected", "awaiting_approval", "awaiting_approval", "refused"]);
  const multi = { async: false, multi: true };
  assert.deepEqual((await events.next(4, "the multi-connect")).map((row) => [row.properties, row.server]), [
    [{ path: "connect", result: "connected", ...multi, host_plan: "paid" }, owned.id],
    [{ path: "request_approval", result: "awaiting_approval", ...multi, host_plan: "paid" }, asked.id],
    [{ path: "request_approval", result: "awaiting_approval", ...multi, host_plan: "paid" }, alsoAsked.id],
    [{ path: "connect", result: "refused", refusal_code: "free_external_limit", limit_side: "connecting", ...multi, host_plan: "paid" }, atLimit.id],
  ]);
  const span = tracing.getAllSpans().find((candidate) => candidate.name === "server.http.request" && String(candidate.attrs?.route_pattern ?? "").includes("connect-servers"));
  assert.equal(span?.attrs?.refused_codes, "free_external_limit");
  assert.equal(span?.attrs?.error_code, undefined, "a 200: no error_code");

  // The approver's page GET records nothing; the approve is a row of theirs, under the connecting server (theirs).
  const [requestA, requestB] = [body.servers[1]!.requestId!, body.servers[2]!.requestId!];
  await expectStatus(await call(app.baseUrl, approver, "GET", `server-connect-requests/${requestA}`), 200);
  await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${requestA}/approve`), 200);
  assert.deepEqual(await events.next(1, "the approve"), [{ properties: { path: "approve", result: "connected", ...sync, host_plan: "paid" }, server: asked.id, who: await analyticsIdOf(approver.id) }]);
  await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${requestB}/reject`), 200);
  assert.deepEqual((await events.next(1, "the decline")).map((row) => [row.properties, row.server]), [[{ path: "decline", result: "declined", ...sync, host_plan: "paid" }, alsoAsked.id]]);
  // Again: already decided. Refused, still under the server.
  await expectStatus(await call(app.baseUrl, approver, "POST", `server-connect-requests/${requestB}/reject`), 409, "request_not_pending");
  assert.deepEqual((await events.next(1, "the decided request")).map((row) => [row.properties, row.server]), [[{ path: "decline", result: "refused", refusal_code: "request_not_pending", ...sync, host_plan: "paid" }, alsoAsked.id]]);
  // A request that is not theirs: no server; the host is still the request's (read, never told).
  const other = await person(app.baseUrl, "cf-other");
  await expectStatus(await call(app.baseUrl, other, "POST", `server-connect-requests/${requestA}/approve`), 404, "request_not_found");
  assert.deepEqual((await events.next(1, "not their request")).map((row) => [row.properties, row.server]), [[{ path: "approve", result: "refused", refusal_code: "request_not_found", ...sync, host_plan: "paid" }, null]]);
});

test("request-approval and connect-new-server: one row each way they end", async ({ app }) => {
  const events = captureConnectFinished(app);
  const host = await seedHost(app.baseUrl, "pro");
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invitee = await person(app.baseUrl, "cf-ask");
  const approver = await person(app.baseUrl, "cf-ask-approver");
  const target = await seedTarget(approver, [[invitee, "member"]]);
  const invite = await seedInvite(host, room.id, invitee.email);

  await expectStatus(await call(app.baseUrl, invitee, "POST", `external-invites/${invite.token}/request-approval`, { serverId: target.id, approverUserId: approver.id }), 201);
  assert.deepEqual((await events.next(1, "the request")).map((row) => [row.properties, row.server]), [[{ path: "request_approval", result: "awaiting_approval", ...sync, host_plan: "paid" }, target.id]]);
  await expectStatus(await call(app.baseUrl, invitee, "POST", `external-invites/${invite.token}/request-approval`, { serverId: target.id, approverUserId: approver.id }), 409, "approval_in_progress");
  assert.deepEqual((await events.next(1, "asked again")).map((row) => [row.properties, row.server]), [[{ path: "request_approval", result: "refused", refusal_code: "approval_in_progress", ...sync, host_plan: "paid" }, target.id]]);
  // Withdrawing it is not an attempt.
  await expectStatus(await call(app.baseUrl, invitee, "POST", `external-invites/${invite.token}/cancel-request`), 200);
  await events.next(0, "the cancel");

  const founder = await person(app.baseUrl, "cf-new");
  const newInvite = await seedInvite(host, room.id, founder.email);
  await expectStatus(await call(app.baseUrl, founder, "POST", `external-invites/${newInvite.token}/connect-new-server`, { name: "Bad", slug: "!!" }), 400);
  assert.deepEqual((await events.next(1, "a bad server")).map((row) => [row.properties, row.server]), [[{ path: "new_server", result: "refused", refusal_code: "invalid_input", ...sync, host_plan: "paid" }, null]]);
  const created = await expectStatus(await call(app.baseUrl, founder, "POST", `external-invites/${newInvite.token}/connect-new-server`, { name: "Newco", slug: `cf-new-${randomBytes(4).toString("hex")}` }), 200) as { serverId: string };
  assert.deepEqual(await events.next(1, "the new server"), [{ properties: { path: "new_server", result: "connected", ...sync, host_plan: "paid" }, server: created.serverId, who: await analyticsIdOf(founder.id) }]);
});

test("Your servers (host_direct): rows under the host server, the worker's after the conversion; the host side's refusal codes", async ({ app }) => {
  const events = captureConnectFinished(app);
  const host = await seedHost(app.baseUrl, "pro");
  const room = await host.room();
  const owned = await seedTarget(host.owner);
  const administered = await seedTarget(await person(app.baseUrl, "cf-hd-other"), [[host.owner, "admin"]]);
  const connectOwn = (channelId: string, serverIds: unknown) => call(app.baseUrl, host.owner, "POST", `channels/${channelId}/external-connect-servers`, { serverIds }, host.server.id);

  await expectStatus(await connectOwn(room.id, "nope"), 400, "invalid_input");
  assert.deepEqual((await events.next(1, "a bad list")).map((row) => [row.properties, row.server]), [[{ path: "host_direct", result: "refused", refusal_code: "invalid_input", ...sync, host_plan: "paid" }, host.server.id]]);

  const body = await expectStatus(await connectOwn(room.id, [owned.id, administered.id]), 200) as { servers: Array<{ state: string }> };
  assert.deepEqual(body.servers.map((server) => server.state), ["connecting", "connecting"]);
  const multi = { async: false, multi: true, host_plan: "paid" };
  assert.deepEqual((await events.next(2, "the 200")).map((row) => [row.properties, row.server]), [
    [{ path: "host_direct", result: "connecting", ...multi }, host.server.id],
    [{ path: "host_direct", result: "connecting", ...multi }, host.server.id],
  ]);
  const [direct] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.channelId, room.id));
  await driveWorker(direct!.id);
  const settled = { path: "host_direct", result: "connected", async: true, multi: true, host_plan: "paid" };
  assert.deepEqual(await events.next(2, "the worker, one per server"), [
    { properties: settled, server: host.server.id, who: await analyticsIdOf(host.owner.id) },
    { properties: settled, server: host.server.id, who: await analyticsIdOf(host.owner.id) },
  ]);

  // The host side's own refusals have their codes (Nova, #14526), no longer other.
  const open = await createChannel(host.server.id, `cf-public-${randomBytes(4).toString("hex")}`, undefined, "channel", { type: "user", id: host.owner.id });
  await expectStatus(await connectOwn(open.id, [owned.id]), 400, "make_private_required");
  const hostMember = await person(app.baseUrl, "cf-hd-member");
  await getDb().insert(serverMembers).values({ serverId: host.server.id, userId: hostMember.id, role: "member" });
  await addHuman(room.id, hostMember.id);
  await expectStatus(await call(app.baseUrl, hostMember, "POST", `channels/${room.id}/external-connect-servers`, { serverIds: [owned.id] }, host.server.id), 403, "forbidden");
  assert.deepEqual((await events.next(2, "the host side's refusals")).map((row) => [row.properties.refusal_code, row.server]), [
    ["make_private_required", host.server.id],
    ["forbidden", host.server.id],
  ]);
});

test("a host with product analytics off records nothing about attempts on its channels: a Guest's, a serverless refusal, a server's, the worker's", async ({ app }) => {
  const events = captureConnectFinished(app);
  const host = await seedHost(app.baseUrl, "pro");
  const joint = await host.room();
  await convertToJoint(host, joint.id);
  const waiting = await host.room();
  const owner = await person(app.baseUrl, "cf-off-owner");
  const target = await seedTarget(owner);
  // Started while the switch is on: answered connecting (a row), then the switch goes off before the worker settles it.
  const pending = await seedInvite(host, waiting.id, owner.email);
  await expectStatus(await call(app.baseUrl, owner, "POST", `external-invites/${pending.token}/connect`, { serverId: target.id }), 202);
  await events.next(1, "the 202, switch on");
  await getDb().update(servers).set({ productAnalyticsEnabled: false }).where(eq(servers.id, host.server.id));

  const guest = await person(app.baseUrl, "cf-off-guest");
  await expectStatus(await call(app.baseUrl, guest, "POST", `external-invites/${(await seedInvite(host, joint.id, guest.email)).token}/accept-as-guest`), 200);
  const stranger = await person(app.baseUrl, "cf-off-stranger");
  await expectStatus(await call(app.baseUrl, stranger, "POST", `external-invites/${(await seedInvite(host, joint.id, stranger.email)).token}/connect`, { serverId: target.id }), 400, "invalid_server");
  await expectStatus(await call(app.baseUrl, owner, "POST", `external-invites/${(await seedInvite(host, joint.id, owner.email)).token}/connect`, { serverId: target.id }), 200);
  await driveWorker(pending.id);
  await events.next(0, "the host's switch is off");

  // Back on: recorded again.
  await getDb().update(servers).set({ productAnalyticsEnabled: true }).where(eq(servers.id, host.server.id));
  const later = await person(app.baseUrl, "cf-on-guest");
  await expectStatus(await call(app.baseUrl, later, "POST", `external-invites/${(await seedInvite(host, joint.id, later.email)).token}/accept-as-guest`), 200);
  assert.deepEqual((await events.next(1, "switch on")).map((row) => row.properties.path), ["guest"]);
});

test("a member's own servers (self_connect): one row per server, under the request's server", async ({ app }) => {
  const events = captureConnectFinished(app);
  const hostOwner = await person(app.baseUrl, "cf-sc-host");
  const peerOwner = await person(app.baseUrl, "cf-sc-peer");
  const member = await person(app.baseUrl, "cf-sc-member");
  const h = await seedTarget(hostOwner);
  const p = await seedTarget(peerOwner, [[member, "member"]]);
  const mine = await seedTarget(member);
  const peerOnly = await seedTarget(peerOwner, [[member, "member"]]);
  const created = await createJointChannel({ hostServerId: h.id, createdByUserId: hostOwner.id, name: `cf-sc-${randomBytes(3).toString("hex")}`,
    targetServerSlug: p.slug, invitedPeople: [`@${peerOwner.name}`], userIds: [] });
  const pLocal = (await acceptJointChannelInvite({ inviteId: created.invites[0]!.id, targetServerId: p.id, acceptedByUserId: peerOwner.id })).id;
  await addHuman(pLocal, member.id);
  await enableExternalChannelsFlag(h.id);

  const body = await expectStatus(await call(app.baseUrl, member, "POST", `channels/${pLocal}/connect-my-servers`, { serverIds: [mine.id, peerOnly.id] }, p.id), 200) as { servers: Array<{ state: string; code?: string }> };
  assert.deepEqual(body.servers.map((server) => [server.state, server.code]), [["connected", undefined], ["refused", "server_admin_required"]]);
  const multi = { async: false, multi: true };
  assert.deepEqual((await events.next(2, "the self connect")).map((row) => [row.properties, row.server]), [
    [{ path: "self_connect", result: "connected", ...multi, host_plan: "paid" }, p.id],
    [{ path: "self_connect", result: "refused", refusal_code: "server_admin_required", ...multi, host_plan: "paid" }, p.id],
  ]);
  await expectStatus(await call(app.baseUrl, member, "POST", `channels/${pLocal}/connect-my-servers`, { serverIds: [] }, p.id), 400, "invalid_input");
  assert.deepEqual((await events.next(1, "an empty list")).map((row) => [row.properties, row.server]), [[{ path: "self_connect", result: "refused", refusal_code: "invalid_input", ...sync, host_plan: "paid" }, p.id]]);

  // A Guest of the host on its copy of the channel: the host is no server of theirs, so the row has none.
  const guest = await person(app.baseUrl, "cf-sc-guest");
  await seedBoundGuest({ serverId: h.id, userId: guest.id, channelId: created.channel.id });
  await getDb().transaction(async (tx) => {
    const mirror = await prepareJointHumanMembershipMirror(tx, { channelIds: [created.channel.id] }, "join");
    await mirror.apply([guest.id], { actorUserId: hostOwner.id });
  });
  await expectStatus(await call(app.baseUrl, guest, "POST", `channels/${created.channel.id}/connect-my-servers`, { serverIds: [] }, h.id), 400, "invalid_input");
  assert.deepEqual((await events.next(1, "the Guest's attempt")).map((row) => [row.properties, row.server]), [[{ path: "self_connect", result: "refused", refusal_code: "invalid_input", ...sync, host_plan: "paid" }, null]]);
});

test("refusal codes: the closed list, the host side's connecting as connect_in_progress, anything else other", () => {
  assert.equal(connectRefusalCode("connecting"), "connect_in_progress");
  for (const code of ["channel_not_invitable", "make_private_required", "forbidden", "channel_membership_required", "invite_open", "invite_not_pending", "daily_cap", "free_external_limit"]) {
    assert.equal(connectRefusalCode(code), code);
  }
  assert.equal(connectRefusalCode("reserved_channel"), "other");
});
