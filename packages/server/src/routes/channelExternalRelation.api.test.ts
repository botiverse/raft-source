import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { channelExternalInvites, serverMembers, servers } from "../db/schema";
import { addHuman, attachExternalRelations, createChannel } from "../services/channelService";
import { createServer } from "../services/serverService";
import { captureEmails, login, seedUser, seedWorld } from "../test/externalInviteFixture";
import { seedBoundGuest } from "../test/guestFixture";
import { seedJointChannel } from "../test/integration/jointFixture";

// `hasExternalRelation` on channel payloads (#wg-rbac:#16, web #12189): true
// while a Guest is bound to the channel or an external invite to it is open.
// The channel's own Server's non-guest members get it; a Guest gets it on its
// own bound channel only (always true); other Servers' joint projections never
// do (the field is omitted, not false).
const test = createApiTest();

const requireWeb = createRequire(new URL("../../../web/package.json", import.meta.url));
const { io: clientIo } = requireWeb("socket.io-client");

type Row = { id: string; hasExternalRelation?: boolean };

async function listRow(baseUrl: string, token: string, serverId: string, channelId: string): Promise<Row | undefined> {
  const response = await fetch(`${baseUrl}/api/channels`, { headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverId } });
  assert.equal(response.status, 200);
  return ((await response.json()) as Row[]).find((row) => row.id === channelId);
}

async function detailRow(baseUrl: string, token: string, serverId: string, channelId: string): Promise<Row> {
  const response = await fetch(`${baseUrl}/api/channels/${channelId}`, { headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverId } });
  assert.equal(response.status, 200);
  return (await response.json()) as Row;
}

/** The field as list and detail carry it ("omitted" when absent); both must agree. */
async function relationOf(baseUrl: string, token: string, serverId: string, channelId: string): Promise<boolean | "omitted"> {
  const listed = await listRow(baseUrl, token, serverId, channelId);
  assert.ok(listed, "the channel is listed for this viewer");
  const detail = await detailRow(baseUrl, token, serverId, channelId);
  const fromList = "hasExternalRelation" in listed ? listed.hasExternalRelation! : "omitted";
  const fromDetail = "hasExternalRelation" in detail ? detail.hasExternalRelation! : "omitted";
  assert.equal(fromDetail, fromList, "GET /channels/:id agrees with GET /channels");
  return fromList;
}

test("a bound Guest makes the channel external for its non-guest members and for the Guest itself", async ({ app }) => {
  // seedWorld binds a Guest to `room`; the flag is off: existing relations stay.
  const world = await seedWorld(app.baseUrl, { flag: false });
  const tokens = {
    owner: await login(app.baseUrl, world.owner.email),
    member: await login(app.baseUrl, world.member.email),
    guest: await login(app.baseUrl, world.guest.email),
  };
  assert.equal(await relationOf(app.baseUrl, tokens.owner, world.server.id, world.room.id), true);
  assert.equal(await relationOf(app.baseUrl, tokens.member, world.server.id, world.room.id), true);
  // The Guest's own channel is external by definition: its sidebar files it under External.
  assert.equal(await relationOf(app.baseUrl, tokens.guest, world.server.id, world.room.id), true);

  // A plain public channel: false (not omitted) for members.
  const plain = await createChannel(world.server.id, `plain-${world.tag}`, undefined, "channel", { type: "user", id: world.owner.id });
  assert.equal(await relationOf(app.baseUrl, tokens.member, world.server.id, plain.id), false);

  // The Guest's binding ends (promoted to member): no longer external.
  const promoted = await fetch(`${app.baseUrl}/api/servers/${world.server.id}/members/${world.guest.id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${tokens.owner}`, "Content-Type": "application/json", "X-Server-Id": world.server.id },
    body: JSON.stringify({ role: "member" }),
  });
  assert.equal(promoted.status, 200);
  assert.equal(await relationOf(app.baseUrl, tokens.owner, world.server.id, world.room.id), false);
});

test("an open invite makes the channel external until it is revoked or expires", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  // Paid: seedWorld's room is already the free plan's one external channel.
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, world.server.id));
  const owner = await login(app.baseUrl, world.owner.email);
  const room = await createChannel(world.server.id, `inv-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });
  assert.equal(await relationOf(app.baseUrl, owner, world.server.id, room.id), false);

  const mail = captureEmails();
  try {
    const sent = await world.call("owner", "POST", `${room.id}/external-invites`, { emails: ["one@example.com", "two@example.com"] });
    assert.equal(sent.status, 200);
    const [first, second] = ((await sent.json()) as { sent: Array<{ id: string }> }).sent;
    assert.equal(await relationOf(app.baseUrl, owner, world.server.id, room.id), true);

    assert.equal((await world.call("owner", "DELETE", `${room.id}/external-invites/${first!.id}`)).status, 200);
    assert.equal(await relationOf(app.baseUrl, owner, world.server.id, room.id), true, "the other invite is still open");

    // The other one passes its expiry: an expired invite no longer counts.
    await getDb().update(channelExternalInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(channelExternalInvites.id, second!.id));
    assert.equal(await relationOf(app.baseUrl, owner, world.server.id, room.id), false);
  } finally {
    mail.stop();
  }
});

test("another Server's projection of a joint channel carries no field; the host's does", async ({ app }) => {
  const world = await seedWorld(app.baseUrl, { flag: false });
  const peerOwner = await seedUser(`ext-peer-${world.tag}`);
  const peer = await createServer("Peer", `ext-peer-${world.tag}`, peerOwner.id);
  const joint = await seedJointChannel({ name: `joint-${world.tag}`, serverIds: [world.server.id, peer.id], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections;
  await addHuman(hostProjection!.id, world.owner.id);
  await addHuman(peerProjection!.id, peerOwner.id);
  const guest = await seedUser(`ext-jguest-${world.tag}`);
  await seedBoundGuest({ serverId: world.server.id, userId: guest.id, channelId: hostProjection!.id });
  // Even an (unexpected) relation row keyed by the peer's projection stays invisible to the peer.
  const stray = await seedUser(`ext-stray-${world.tag}`);
  await seedBoundGuest({ serverId: peer.id, userId: stray.id, channelId: peerProjection!.id });

  assert.equal(await relationOf(app.baseUrl, await login(app.baseUrl, world.owner.email), world.server.id, hostProjection!.id), true);
  assert.equal(await relationOf(app.baseUrl, await login(app.baseUrl, peerOwner.email), peer.id, peerProjection!.id), "omitted");
});

test("the relation is read for the whole list in one statement", async ({ app }) => {
  const world = await seedWorld(app.baseUrl, { flag: false });
  const rows = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    createChannel(world.server.id, `batch-${index}-${world.tag}`, undefined, "channel", { type: "user", id: world.owner.id })));
  const all = [...rows, world.room].map((row) => ({ ...row, jointRole: null }));
  type PgLike = { query: (...args: unknown[]) => Promise<unknown> };
  const pg = (getDb() as unknown as { $client: PgLike }).$client;
  const original = pg.query.bind(pg);
  /** What `read` answers, and how many statements it ran. */
  const counted = async <R>(read: () => Promise<R>): Promise<{ value: R; queries: number }> => {
    let queries = 0;
    pg.query = ((...args: unknown[]) => {
      queries += 1;
      return original(...args);
    }) as PgLike["query"];
    try {
      return { value: await read(), queries };
    } finally {
      pg.query = original;
    }
  };
  const asMember = await counted(() => attachExternalRelations(all, { role: "member" }));
  assert.equal(asMember.queries, 1);
  assert.deepEqual(asMember.value.filter((row) => row.hasExternalRelation).map((row) => row.id), [world.room.id]);
  assert.equal(asMember.value.every((row) => typeof row.hasExternalRelation === "boolean"), true);
  // A Guest viewer: no statement, and the field on its own channel only (true), whatever the other rows hold.
  const asGuest = await counted(() => attachExternalRelations(all, { role: "guest", guestChannelId: rows[0]!.id }));
  assert.equal(asGuest.queries, 0);
  assert.deepEqual(asGuest.value.filter((row) => "hasExternalRelation" in row).map((row) => [row.id, row.hasExternalRelation]), [[rows[0]!.id, true]]);
  // A legacy Guest bound to no channel: no field anywhere.
  assert.equal((await attachExternalRelations(all, { role: "guest", guestChannelId: null })).some((row) => "hasExternalRelation" in row), false);
});

test("sending, revoking and a Guest's removal tell the channel's clients to re-read the row", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const memberToken = await login(app.baseUrl, world.member.email);
  const socket = clientIo(app.baseUrl, { auth: { token: memberToken, serverId: world.server.id }, transports: ["websocket"], autoConnect: false });
  const updates: unknown[] = [];
  socket.on("channel:updated", (payload: unknown) => updates.push(payload));
  const waitFor = async (label: string) => {
    for (let pass = 0; pass < 80; pass += 1) {
      if (updates.some((payload) => (payload as { channelId?: string }).channelId === world.room.id)) {
        updates.length = 0;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`no id-only channel:updated for the room after ${label}`);
  };
  const mail = captureEmails();
  try {
    const ready = new Promise((resolve) => socket.once("rooms:joined", resolve));
    socket.connect();
    await ready;

    const sent = await world.call("owner", "POST", `${world.room.id}/external-invites`, { emails: [`ws-${randomUUID().slice(0, 6)}@example.com`] });
    assert.equal(sent.status, 200);
    await waitFor("send");
    const [invite] = ((await sent.json()) as { sent: Array<{ id: string }> }).sent;
    assert.equal((await world.call("owner", "DELETE", `${world.room.id}/external-invites/${invite!.id}`)).status, 200);
    await waitFor("revoke");

    const removed = await fetch(`${app.baseUrl}/api/servers/${world.server.id}/members/${world.guest.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await login(app.baseUrl, world.owner.email)}`, "X-Server-Id": world.server.id },
    });
    assert.equal(removed.status, 200);
    await waitFor("the Guest's removal");
    const [gone] = await getDb().select().from(serverMembers).where(eq(serverMembers.userId, world.guest.id));
    assert.equal(gone, undefined);
  } finally {
    mail.stop();
    socket.disconnect();
  }
});
