import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { channelExternalInvites, channels, jointChannelServers, servers } from "../db/schema";
import { createChannel } from "../services/channelService";
import { runChannelConversionJob, startChannelToJointConversion } from "../services/channelConversionService";
import { runChannelConversionWorkerPass } from "../services/channelConversionWorker";
import { setExternalConnectWorkerProductEventSink } from "../services/externalConnectProductEvents";
import { PRODUCT_EVENT_SINK_APP_KEY } from "../services/productEventIngest";
import type { ProductEventRow, ProductEventSink } from "../services/productEventScopeDbWriter";
import { createServer } from "../services/serverService";
import { createApiTest } from "../test/integration/apiTest";
import { enableExternalChannelsFlag, login, seedUser } from "../test/externalInviteFixture";

// #triage:#536: connecting a server that already has a channel of the joint
// channel's name can never succeed (a joint channel has one name on every
// server). The worker retried it forever, and the reservation held every
// other connect on the channel with 409 `connecting`. It is now refused
// `channel_name_taken`, settled at once, with the reason shown to the person.
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type Person = Awaited<ReturnType<typeof seedUser>> & { token: string };

async function person(baseUrl: string, label: string): Promise<Person> {
  const user = await seedUser(`${label}-${randomBytes(4).toString("hex")}`);
  return { ...user, token: await login(baseUrl, user.email) };
}

async function seedHost(baseUrl: string) {
  const owner = await person(baseUrl, "nt-host-owner");
  const server = await createServer("Name Host", `nt-host-${randomBytes(4).toString("hex")}`, owner.id);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  await enableExternalChannelsFlag(server.id);
  const room = await createChannel(server.id, `nt-room-${randomBytes(4).toString("hex")}`, undefined, "private", { type: "user", id: owner.id });
  return { owner, server, room };
}

async function seedTarget(owner: Person, label: string) {
  const server = await createServer(`Target ${label}`, `nt-${label}-${randomBytes(4).toString("hex")}`, owner.id);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  return server;
}

function connectOwn(baseUrl: string, host: Awaited<ReturnType<typeof seedHost>>, serverIds: string[]) {
  return fetch(`${baseUrl}/api/channels/${host.room.id}/external-connect-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${host.owner.token}`, "Content-Type": "application/json", "X-Server-Id": host.server.id },
    body: JSON.stringify({ serverIds }),
  });
}

async function servePassesUntilSettled(inviteId: string) {
  for (let pass = 0; pass < 40; pass += 1) {
    const [row] = await getDb().select({ status: channelExternalInvites.status }).from(channelExternalInvites).where(eq(channelExternalInvites.id, inviteId));
    if (row?.status !== "connecting") return;
    await runChannelConversionWorkerPass();
  }
}

function captureRefusalCodes(app: { app: { set(key: string, value: unknown): unknown } }) {
  const rows: ProductEventRow[] = [];
  const sink: ProductEventSink = { enqueue: (batch) => { rows.push(...batch); }, flush: async () => {} };
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, sink);
  setExternalConnectWorkerProductEventSink(sink);
  return () => rows.filter((row) => row.event === "external_channel_connect_finished").map((row) => row.properties);
}

async function inviteOf(channelId: string) {
  const [invite] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.channelId, channelId));
  assert.ok(invite);
  return invite;
}

async function projectionOn(channelServerId: string, jointServerId: string) {
  const rows = await getDb().select().from(jointChannelServers).where(and(eq(jointChannelServers.serverId, jointServerId), eq(jointChannelServers.status, "active")));
  return rows.filter((row) => row.localChannelId !== channelServerId);
}

for (const clash of ["live", "archived"] as const) {
  test(`Your servers on a private channel: a ${clash} channel of the same name on the server settles refused channel_name_taken at once, and no longer holds the channel`, async ({ app }) => {
    const finished = captureRefusalCodes(app);
    const host = await seedHost(app.baseUrl);
    const clashing = await seedTarget(host.owner, "clash");
    const other = await seedTarget(host.owner, "other");
    const holder = await createChannel(clashing.id, host.room.name, undefined, "channel", { type: "user", id: host.owner.id });
    if (clash === "archived") await getDb().update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, holder.id));

    const first = await connectOwn(app.baseUrl, host, [clashing.id]);
    assert.equal(first.status, 200, await first.clone().text());
    assert.deepEqual(((await first.json()) as { servers: Array<{ state: string }> }).servers.map((s) => s.state), ["connecting"]);
    const invite = await inviteOf(host.room.id);
    await servePassesUntilSettled(invite.id);

    // Settled as a refusal on the first try, never down the retry path.
    const settled = await inviteOf(host.room.id);
    assert.notEqual(settled.status, "connecting");
    assert.equal(settled.connectAttempts, 0);
    assert.equal(settled.connectLastError, null);
    assert.deepEqual(await projectionOn(host.room.id, clashing.id), []);
    const workerRows = finished().filter((row) => row.async === true);
    assert.deepEqual(workerRows.map((row) => [row.result, row.refusal_code]), [["refused", "channel_name_taken"]]);

    // The channel (now joint) takes another connect: no 409 `connecting`.
    const next = await connectOwn(app.baseUrl, host, [other.id]);
    const nextBody = await next.json() as { servers: Array<{ state: string }> };
    assert.equal(next.status, 200, JSON.stringify(nextBody));
    assert.deepEqual(nextBody.servers.map((s) => s.state), ["connected"]);

    // Asked again while the clash stands: refused synchronously with the code (was a 500 internal_error), one sentence for live and archived.
    const again = await connectOwn(app.baseUrl, host, [clashing.id]);
    const againBody = await again.json() as { servers: Array<{ state: string; status?: number; code?: string; error?: string }> };
    assert.equal(again.status, 200, JSON.stringify(againBody));
    assert.deepEqual(againBody.servers.map((s) => [s.state, s.status, s.code, s.error]), [[
      "refused", 409, "channel_name_taken", "That server already has a channel with this name. Rename that channel, then connect again.",
    ]]);

    // Renamed on that server: it connects.
    await getDb().update(channels).set({ name: `${host.room.name}-old` }).where(eq(channels.id, holder.id));
    const renamed = await connectOwn(app.baseUrl, host, [clashing.id]);
    const renamedBody = await renamed.json() as { servers: Array<{ state: string }> };
    assert.deepEqual(renamedBody.servers.map((s) => s.state), ["connected"], JSON.stringify(renamedBody));
  });
}

test("the conversion is not repeated: a channel already joint stays joint after a refused connect", async ({ app }) => {
  captureRefusalCodes(app);
  const host = await seedHost(app.baseUrl);
  const job = await startChannelToJointConversion({ serverId: host.server.id, sourceChannelId: host.room.id, createdByUserId: host.owner.id });
  assert.equal((await runChannelConversionJob(job.id)).status, "done");
  const clashing = await seedTarget(host.owner, "clash2");
  await createChannel(clashing.id, host.room.name, undefined, "channel", { type: "user", id: host.owner.id });
  const res = await connectOwn(app.baseUrl, host, [clashing.id]);
  const body = await res.json() as { servers: Array<{ state: string; code?: string }> };
  assert.deepEqual(body.servers.map((s) => [s.state, s.code]), [["refused", "channel_name_taken"]]);
  const [room] = await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, host.room.id));
  assert.equal(room?.type, "joint");
});
