import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { channelExternalInvites, channelHumans, channels, featureFlagRules, serverMembers, servers, userAnalyticsIds, users } from "../db/schema";
import { addHuman, archiveChannel, createChannel, findOrCreateUserDM, getOrCreateThread, getSystemAllChannel, updateChannel } from "../services/channelService";
import { createServer } from "../services/serverService";
import { createMessage } from "../services/messageService";
import { EXTERNAL_CHANNEL_MAX_SLOTS } from "../services/externalChannelLimitService";
import { captureEmails, enableExternalChannelsFlag, login, seedUser, seedWorld, sha256, tokenOf } from "../test/externalInviteFixture";
import { seedJointChannel } from "../test/integration/jointFixture";
import { seedBoundGuest } from "../test/guestFixture";
import { fixturePasswordHash } from "../test/integration/credentials";
import { capturePaywallHits, captureProductEvents, captureRefusalSpans } from "../test/integration/paywallHits";
import { __setEmailDeliveryObserverForTests } from "../services/emailService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";

// External channel invites, P2a-1 (#wg-rbac:#16): a host owner/admin sends,
// lists, resends and revokes email invites of people outside the Server.
// Preview, send and resend are behind external_channels_v1; list and revoke
// are not (plan §2a: turning the flag off never strands an open invite).
const test = createApiTest();

const DAY_MS = 24 * 60 * 60 * 1000;

async function inviteRows(channelId: string) {
  return getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.channelId, channelId));
}

test("with external_channels_v1 off, preview, send and resend are 404; list and revoke keep working for the host owner/admin", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const mail = captureEmails();
  let invites: Array<{ id: string; email: string }>;
  try {
    const sent = await world.call("owner", "POST", `${world.room.id}/external-invites`, { emails: ["a@example.com", "b@example.com"] });
    assert.equal(sent.status, 200);
    invites = ((await sent.json()) as { sent: Array<{ id: string; email: string }> }).sent;
  } finally {
    mail.stop();
  }
  // The kill switch: the flag goes off with invites open.
  await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY));

  const gated = await Promise.all([
    world.call("owner", "POST", `${world.room.id}/external-invites/preview`, { emails: ["c@example.com"] }),
    world.call("owner", "POST", `${world.room.id}/external-invites`, { emails: ["c@example.com"] }),
    world.call("owner", "POST", `${world.room.id}/external-invites/${invites[0]!.id}/resend`),
  ]);
  for (const response of gated) {
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Not found" });
  }

  // Same permission checks as with the flag on: members, channel admins and Guests are refused.
  for (const as of ["member", "channelAdmin", "guest"] as const) {
    const responses = await Promise.all([
      world.call(as, "GET", `${world.room.id}/external-invites`),
      world.call(as, "DELETE", `${world.room.id}/external-invites/${invites[0]!.id}`),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [403, 403], as);
  }

  const listed = await world.call("admin", "GET", `${world.room.id}/external-invites`);
  assert.equal(listed.status, 200);
  assert.deepEqual(
    ((await listed.json()) as { invites: Array<{ email: string }> }).invites.map((row) => row.email).sort(),
    ["a@example.com", "b@example.com"],
  );
  assert.equal((await world.call("owner", "DELETE", `${world.room.id}/external-invites/${invites[0]!.id}`)).status, 200);
  const after = await world.call("owner", "GET", `${world.room.id}/external-invites`);
  assert.deepEqual(((await after.json()) as { invites: Array<{ id: string }> }).invites.map((row) => row.id), [invites[1]!.id]);
  assert.deepEqual(
    (await inviteRows(world.room.id)).map((row) => [row.email, row.status]).sort(),
    [["a@example.com", "revoked"], ["b@example.com", "pending"]],
  );
});

test("with external_channels_v1 off, an unknown channel or one the caller cannot see is still 404 for list and revoke", async ({ app }) => {
  const world = await seedWorld(app.baseUrl, { flag: false });
  const responses = await Promise.all([
    world.call("owner", "GET", `${randomUUID()}/external-invites`),
    world.call("owner", "DELETE", `${randomUUID()}/external-invites/${randomUUID()}`),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [404, 404]);
});

test("only the host owner or admin manages external invites", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const mail = captureEmails();
  try {
    const sent = await world.call("admin", "POST", `${world.room.id}/external-invites`, { emails: ["outside@example.com"] });
    assert.equal(sent.status, 200);
    const [invite] = ((await sent.json()) as { sent: Array<{ id: string }> }).sent;
    assert.ok(invite);

    for (const as of ["member", "channelAdmin", "guest"] as const) {
      const responses = await Promise.all([
        world.call(as, "POST", `${world.room.id}/external-invites/preview`, { emails: ["b@example.com"] }),
        world.call(as, "POST", `${world.room.id}/external-invites`, { emails: ["b@example.com"] }),
        world.call(as, "GET", `${world.room.id}/external-invites`),
        world.call(as, "POST", `${world.room.id}/external-invites/${invite.id}/resend`),
        world.call(as, "DELETE", `${world.room.id}/external-invites/${invite.id}`),
      ]);
      assert.deepEqual(responses.map((response) => response.status), [403, 403, 403, 403, 403], as);
    }
    assert.deepEqual((await inviteRows(world.room.id)).map((row) => [row.email, row.status]), [["outside@example.com", "pending"]]);

    for (const as of ["owner", "admin"] as const) {
      const preview = await world.call(as, "POST", `${world.room.id}/external-invites/preview`, { emails: ["c@example.com"] });
      assert.equal(preview.status, 200, as);
      const list = await world.call(as, "GET", `${world.room.id}/external-invites`);
      assert.equal(list.status, 200, as);
      assert.deepEqual(((await list.json()) as { invites: Array<{ id: string }> }).invites.length, 1);
    }
    const resent = await world.call("owner", "POST", `${world.room.id}/external-invites/${invite.id}/resend`);
    assert.equal(resent.status, 200);
    const { id: resentId } = (await resent.json()) as { id: string };
    const revoked = await world.call("owner", "DELETE", `${world.room.id}/external-invites/${resentId}`);
    assert.equal(revoked.status, 200);
  } finally {
    mail.stop();
  }
});

test("preview classifies valid, duplicate, invalid, already pending and already member addresses", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const outsider = await seedUser(`ext-outsider-${world.tag}`);
  const mail = captureEmails();
  try {
    assert.equal((await world.call("owner", "POST", `${world.room.id}/external-invites`, { emails: ["pending@example.com"] })).status, 200);
  } finally {
    mail.stop();
  }
  const response = await world.call("owner", "POST", `${world.room.id}/external-invites/preview`, {
    emails: [
      " New@Example.com ",
      "new@example.com",
      "not-an-email",
      "PENDING@example.com",
      world.member.email.toUpperCase(),
      world.guest.email,
      outsider.email,
    ],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    valid: ["new@example.com", outsider.email],
    duplicates: ["new@example.com"],
    invalid: ["not-an-email"],
    alreadyPending: ["pending@example.com"],
    alreadyMembers: [],
    alreadyInChannel: [world.member.email, world.guest.email],
    guestsElsewhere: [],
    // The host, seedWorld's Guest and the one open invite take three slots.
    slotsLeft: EXTERNAL_CHANNEL_MAX_SLOTS - 3,
  });
  assert.equal((await inviteRows(world.room.id)).length, 1, "preview writes nothing");

  const tooMany = await world.call("owner", "POST", `${world.room.id}/external-invites/preview`, {
    emails: Array.from({ length: 21 }, (_, index) => `x${index}@example.com`),
  });
  assert.equal(tooMany.status, 400);
  const notStrings = await world.call("owner", "POST", `${world.room.id}/external-invites`, { emails: [1] });
  assert.equal(notStrings.status, 400);
});

/** A member of the host Server who is not in the room; Guests of a channel the owner is in, of one only the admin is in, and of none. */
async function seedPeopleElsewhere(world: Awaited<ReturnType<typeof seedWorld>>) {
  const serverMember = await seedUser(`ext-notinroom-${world.tag}`);
  await getDb().insert(serverMembers).values({ serverId: world.server.id, userId: serverMember.id, role: "member" });
  const shared = await createChannel(world.server.id, `ext-vendor-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });
  const adminsOnly = await createChannel(world.server.id, `ext-secret-${world.tag}`, undefined, "private", { type: "user", id: world.admin.id });
  const guestShared = await seedUser(`ext-gshared-${world.tag}`);
  const guestHidden = await seedUser(`ext-ghidden-${world.tag}`);
  await seedBoundGuest({ serverId: world.server.id, userId: guestShared.id, channelId: shared.id });
  await seedBoundGuest({ serverId: world.server.id, userId: guestHidden.id, channelId: adminsOnly.id });
  return { serverMember, shared, adminsOnly, guestShared, guestHidden };
}

async function isInChannel(channelId: string, userId: string) {
  const [row] = await getDb().select({ userId: channelHumans.userId }).from(channelHumans)
    .where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, userId)));
  return !!row;
}

test("preview: a Server member not in the channel will be added; Guests of another channel are blocked, the channel named only where the inviter sees it", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const people = await seedPeopleElsewhere(world);
  const emails = [people.serverMember.email, world.member.email, people.guestShared.email, people.guestHidden.email];
  const asOwner = await world.call("owner", "POST", `${world.room.id}/external-invites/preview`, { emails });
  assert.equal(asOwner.status, 200);
  assert.deepEqual(await asOwner.json(), {
    valid: [],
    duplicates: [],
    invalid: [],
    alreadyPending: [],
    alreadyMembers: [people.serverMember.email],
    alreadyInChannel: [world.member.email],
    guestsElsewhere: [
      { email: people.guestShared.email, channelName: people.shared.name },
      { email: people.guestHidden.email, channelName: null },
    ],
    // The host and seedWorld's Guest.
    slotsLeft: EXTERNAL_CHANNEL_MAX_SLOTS - 2,
  });
  // The admin is in the other channel: named for them.
  const asAdmin = await world.call("admin", "POST", `${world.room.id}/external-invites/preview`, { emails: [people.guestHidden.email] });
  assert.deepEqual(((await asAdmin.json()) as { guestsElsewhere: unknown }).guestsElsewhere, [
    { email: people.guestHidden.email, channelName: people.adminsOnly.name },
  ]);
});

test("send adds the Server's members to the channel, invites the outsiders, and sends nothing to Guests of another channel", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const people = await seedPeopleElsewhere(world);
  const mail = captureEmails();
  try {
    const response = await world.call("owner", "POST", `${world.room.id}/external-invites`, {
      emails: ["outside@example.com", people.serverMember.email, people.guestShared.email],
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { sent: Array<{ email: string }>; added: string[]; skipped: Record<string, unknown> };
    assert.deepEqual(body.sent.map((invite) => invite.email), ["outside@example.com"]);
    assert.deepEqual(body.added, [people.serverMember.email]);
    assert.deepEqual(body.skipped, {
      duplicates: [],
      invalid: [],
      alreadyPending: [],
      alreadyMembers: [],
      alreadyInChannel: [],
      guestsElsewhere: [{ email: people.guestShared.email, channelName: people.shared.name }],
    });
    assert.deepEqual(mail.deliveries.map((delivery) => delivery.to), ["outside@example.com"]);
  } finally {
    mail.stop();
  }
  assert.equal(await isInChannel(world.room.id, people.serverMember.id), true, "the member was added");
  assert.equal(await isInChannel(world.room.id, people.guestShared.id), false, "the Guest of another channel was not");
  assert.deepEqual((await inviteRows(world.room.id)).map((row) => row.email), ["outside@example.com"]);
});

test("the review before Create Channel makes an External channel: flag-gated, host owner/admin only, nothing pending or in a channel yet", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const people = await seedPeopleElsewhere(world);
  const emails = ["new@example.com", "new@example.com", "bad", world.member.email, people.guestShared.email];
  // A free host whose one external channel is taken (seedWorld's room) is refused as a send would be.
  const refused = await expectRefusal(await world.call("owner", "POST", "external-invites/preview", { emails }), "free_external_limit");
  assert.deepEqual({ side: refused.limitSide, server: refused.limitServerId }, { side: "host", server: world.server.id });
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, world.server.id));
  const asOwner = await world.call("owner", "POST", "external-invites/preview", { emails });
  assert.equal(asOwner.status, 200);
  assert.deepEqual(await asOwner.json(), {
    valid: ["new@example.com"],
    duplicates: ["new@example.com"],
    invalid: ["bad"],
    alreadyPending: [],
    alreadyMembers: [world.member.email],
    alreadyInChannel: [],
    guestsElsewhere: [{ email: people.guestShared.email, channelName: people.shared.name }],
    // A new channel's slots: the host's only.
    slotsLeft: EXTERNAL_CHANNEL_MAX_SLOTS - 1,
  });
  assert.equal((await world.call("admin", "POST", "external-invites/preview", { emails })).status, 200);
  for (const as of ["member", "channelAdmin", "guest"] as const) {
    assert.equal((await world.call(as, "POST", "external-invites/preview", { emails })).status, 403, as);
  }
  assert.equal((await world.call("owner", "POST", "external-invites/preview", { emails: [] })).status, 400);

  await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY));
  const off = await world.call("owner", "POST", "external-invites/preview", { emails });
  assert.equal(off.status, 404);
});

test("send creates one pending invite per new address, emails each its own link, and reports the rest as skipped", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const mail = captureEmails();
  try {
    const before = Date.now();
    const response = await world.call("owner", "POST", `${world.room.id}/external-invites`, {
      emails: ["one@example.com", "TWO@example.com", "one@example.com", "bad", world.admin.email],
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { sent: Array<{ id: string; email: string; expiresAt: string }>; skipped: Record<string, string[]> };
    assert.deepEqual(body.sent.map((invite) => invite.email), ["one@example.com", "two@example.com"]);
    assert.deepEqual(body.skipped, { duplicates: ["one@example.com"], invalid: ["bad"], alreadyPending: [], alreadyMembers: [], alreadyInChannel: [world.admin.email], guestsElsewhere: [] });
    for (const invite of body.sent) {
      const lifetime = new Date(invite.expiresAt).getTime() - before;
      assert.ok(lifetime >= 14 * DAY_MS && lifetime < 14 * DAY_MS + 60_000, "expires 14 days out");
    }

    assert.deepEqual(mail.deliveries.map((delivery) => delivery.to).sort(), ["one@example.com", "two@example.com"]);
    const rows = await inviteRows(world.room.id);
    for (const delivery of mail.deliveries) {
      assert.equal(delivery.subject, `${world.owner.displayName} invited you to #${world.room.name} in External Host on Raft`);
      const row = rows.find((candidate) => candidate.email === delivery.to);
      assert.ok(row);
      assert.equal(row.tokenHash, sha256(tokenOf(delivery)), "the stored hash is of the emailed token");
      assert.equal(row.status, "pending");
      assert.equal(row.hostServerId, world.server.id);
      assert.equal(row.invitedByUserId, world.owner.id);
    }

    const again = await world.call("owner", "POST", `${world.room.id}/external-invites`, { emails: ["one@example.com"] });
    assert.equal(again.status, 200);
    assert.deepEqual(((await again.json()) as { skipped: { alreadyPending: string[] } }).skipped.alreadyPending, ["one@example.com"]);
    assert.equal((await inviteRows(world.room.id)).length, 2);
  } finally {
    mail.stop();
  }
});

test("a public channel needs makePrivate, which turns it private in the same send", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  // Paid: seedWorld's room is already the free plan's one external channel.
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, world.server.id));
  const open = await createChannel(world.server.id, `ext-open-${world.tag}`, undefined, "channel", { type: "user", id: world.owner.id });
  const mail = captureEmails();
  try {
    const refused = await world.call("owner", "POST", `${open.id}/external-invites`, { emails: ["pub@example.com"] });
    assert.equal(refused.status, 400);
    assert.equal(((await refused.json()) as { code: string }).code, "make_private_required");
    assert.equal((await inviteRows(open.id)).length, 0);

    // Not a member of the channel: turning it private would lock the admin out.
    const notMember = await world.call("admin", "POST", `${open.id}/external-invites`, { emails: ["pub@example.com"], makePrivate: true });
    assert.equal(notMember.status, 403);
    assert.equal(((await notMember.json()) as { code: string }).code, "channel_membership_required");

    const sent = await world.call("owner", "POST", `${open.id}/external-invites`, { emails: ["pub@example.com"], makePrivate: true });
    assert.equal(sent.status, 200);
    const [row] = await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, open.id));
    assert.equal(row?.type, "private");
    assert.deepEqual((await inviteRows(open.id)).map((invite) => invite.email), ["pub@example.com"]);
  } finally {
    mail.stop();
  }
});

test("archived channels answer 409; DMs, threads and #all answer 400", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const archived = await createChannel(world.server.id, `ext-archived-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });
  await archiveChannel(archived.id, world.owner.id);
  const dm = await findOrCreateUserDM(world.server.id, world.owner.id, world.member.id);
  assert.ok(dm);
  const open = await createChannel(world.server.id, `ext-parent-${world.tag}`, undefined, "channel", { type: "user", id: world.owner.id });
  const parent = await createMessage(open.id, "user", world.owner.id, "thread parent");
  const thread = await getOrCreateThread(parent.id, world.owner.id, "user");
  // A new Server's #all starts hidden (and so unseen, 404); restore it to reach the type check.
  const hiddenAll = await getSystemAllChannel(world.server.id);
  assert.ok(hiddenAll);
  const all = await updateChannel(hiddenAll.id, { type: "channel" });

  const archivedResponse = await world.call("owner", "POST", `${archived.id}/external-invites`, { emails: ["z@example.com"] });
  assert.equal(archivedResponse.status, 409);
  for (const channelId of [dm.id, thread.id, all.id]) {
    const response = await world.call("owner", "POST", `${channelId}/external-invites`, { emails: ["z@example.com"], makePrivate: true });
    assert.equal(response.status, 400, `${channelId === dm.id ? "dm" : channelId === thread.id ? "thread" : "all"}`);
    assert.equal(((await response.json()) as { code: string }).code, "channel_not_invitable");
  }
  const [allAfter] = await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, all.id));
  assert.equal(allAfter?.type, "channel", "#all is never made private here");
});

test("a host Server sends at most 100 external invites in 24 hours, resends included", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const other = await createChannel(world.server.id, `ext-other-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });
  const now = Date.now();
  // 98 recent sends on another channel and 5 from yesterday that no longer count.
  await getDb().insert(channelExternalInvites).values([
    ...Array.from({ length: 98 }, (_, index) => ({
      channelId: other.id,
      hostServerId: world.server.id,
      email: `recent${index}@example.com`,
      tokenHash: randomUUID(),
      expiresAt: new Date(now + 14 * DAY_MS),
    })),
    ...Array.from({ length: 5 }, (_, index) => ({
      channelId: other.id,
      hostServerId: world.server.id,
      email: `old${index}@example.com`,
      tokenHash: randomUUID(),
      createdAt: new Date(now - DAY_MS - 60_000),
      expiresAt: new Date(now + 13 * DAY_MS),
    })),
  ]);
  const mail = captureEmails();
  try {
    const overCap = await world.call("owner", "POST", `${world.room.id}/external-invites`, { emails: ["a@example.com", "b@example.com", "c@example.com"] });
    assert.equal(overCap.status, 429);
    assert.equal(((await overCap.json()) as { code: string }).code, "daily_cap");
    assert.equal((await inviteRows(world.room.id)).length, 0, "nothing of a refused batch is written");

    const fits = await world.call("owner", "POST", `${world.room.id}/external-invites`, { emails: ["a@example.com", "b@example.com"] });
    assert.equal(fits.status, 200);
    const [first] = ((await fits.json()) as { sent: Array<{ id: string }> }).sent;
    assert.ok(first);

    const resend = await world.call("owner", "POST", `${world.room.id}/external-invites/${first.id}/resend`);
    assert.equal(resend.status, 429, "a resend is a send");
    assert.equal(mail.deliveries.length, 2);
  } finally {
    mail.stop();
  }
});

test("resend issues a new token and a fresh 14 days; revoke ends an invite and drops it from the list", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const mail = captureEmails();
  try {
    const sent = await world.call("owner", "POST", `${world.room.id}/external-invites`, { emails: ["keep@example.com", "drop@example.com"] });
    assert.equal(sent.status, 200);
    const invites = ((await sent.json()) as { sent: Array<{ id: string; email: string }> }).sent;
    const keep = invites.find((invite) => invite.email === "keep@example.com")!;
    const drop = invites.find((invite) => invite.email === "drop@example.com")!;
    const firstToken = tokenOf(mail.deliveries.find((delivery) => delivery.to === "keep@example.com")!);

    // Age the invite so the reset is visible.
    await getDb().update(channelExternalInvites)
      .set({ expiresAt: new Date(Date.now() + DAY_MS) })
      .where(eq(channelExternalInvites.id, keep.id));
    const before = Date.now();
    const resent = await world.call("owner", "POST", `${world.room.id}/external-invites/${keep.id}/resend`);
    assert.equal(resent.status, 200);
    const fresh = (await resent.json()) as { id: string; email: string; expiresAt: string };
    assert.equal(fresh.email, "keep@example.com");
    assert.ok(new Date(fresh.expiresAt).getTime() - before >= 14 * DAY_MS - 1000, "expiry reset to 14 days");
    const secondToken = tokenOf(mail.deliveries.at(-1)!);
    assert.notEqual(secondToken, firstToken);
    const [old] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.id, keep.id));
    assert.equal(old?.status, "expired", "the old link stops working");
    const [current] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.id, fresh.id));
    assert.equal(current?.tokenHash, sha256(secondToken));
    assert.equal(current?.status, "pending");

    const revoked = await world.call("admin", "DELETE", `${world.room.id}/external-invites/${drop.id}`);
    assert.equal(revoked.status, 200);
    const [dropRow] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.id, drop.id));
    assert.equal(dropRow?.status, "revoked");
    assert.equal(dropRow?.revokedByUserId, world.admin.id);
    assert.ok(dropRow?.decidedAt);
    assert.equal((await world.call("owner", "POST", `${world.room.id}/external-invites/${drop.id}/resend`)).status, 409);
    assert.equal((await world.call("owner", "DELETE", `${world.room.id}/external-invites/${drop.id}`)).status, 409);

    // An invite past its expiry no longer lists, and its address can be invited again.
    await getDb().update(channelExternalInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(channelExternalInvites.id, fresh.id));
    const list = await world.call("owner", "GET", `${world.room.id}/external-invites`);
    assert.equal(list.status, 200);
    assert.deepEqual(((await list.json()) as { invites: unknown[] }).invites, []);
    const reinvite = await world.call("owner", "POST", `${world.room.id}/external-invites`, { emails: ["keep@example.com", "drop@example.com"] });
    assert.equal(reinvite.status, 200);
    assert.equal(((await reinvite.json()) as { sent: unknown[] }).sent.length, 2);
    const listed = await world.call("owner", "GET", `${world.room.id}/external-invites`);
    const listedInvites = ((await listed.json()) as { invites: Array<{ email: string; invitedBy: { id: string; name: string } }> }).invites;
    assert.deepEqual(listedInvites.map((invite) => invite.email).sort(), ["drop@example.com", "keep@example.com"]);
    assert.deepEqual(listedInvites[0]!.invitedBy, { id: world.owner.id, name: world.owner.name });
    const [lapsed] = await getDb().select({ status: channelExternalInvites.status }).from(channelExternalInvites)
      .where(and(eq(channelExternalInvites.id, fresh.id)));
    assert.equal(lapsed?.status, "expired", "the lapsed row was marked expired to free its slot");
  } finally {
    mail.stop();
  }
});

async function analyticsIdOf(userId: string) {
  const [row] = await getDb().select({ analyticsId: userAnalyticsIds.analyticsId }).from(userAnalyticsIds).where(eq(userAnalyticsIds.userId, userId));
  assert.ok(row, "the person shares usage data by default");
  return row.analyticsId;
}

// #wg-rbac:#60 (Nova's contract): external_invite_email_sent, one per invite
// email handed to the mail provider, for the host server and the sender.
test("each invite email handed to the provider is one external_invite_email_sent on the host server for its sender; a resend is its own", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const events = captureProductEvents(app, "external_invite_email_sent");
  const mail = captureEmails();
  try {
    // The duplicate, the invalid entry and the member get no email: three emails, three events.
    const sent = await world.call("owner", "POST", `${world.room.id}/external-invites`, {
      emails: ["one@example.com", "two@example.com", "three@example.com", "one@example.com", "bad", world.admin.email],
    });
    assert.equal(sent.status, 200);
    const invites = ((await sent.json()) as { sent: Array<{ id: string; email: string }> }).sent;
    assert.equal(invites.length, 3);
    const first = await events.expect(3, "a send of three");
    const owner = await analyticsIdOf(world.owner.id);
    for (const row of first) {
      assert.deepEqual(row.properties, { trigger: "send", result: "sent" }, "the two enums and nothing else");
      assert.deepEqual({ source: row.source, server: row.server_id, who: row.analytics_id }, { source: "server", server: world.server.id, who: owner });
    }

    // Addresses that are all skipped attempt no email: nothing.
    assert.equal((await world.call("owner", "POST", `${world.room.id}/external-invites`, { emails: ["one@example.com", "bad"] })).status, 200);
    await events.expect(3, "a send that emails nobody");

    const resent = await world.call("admin", "POST", `${world.room.id}/external-invites/${invites[0]!.id}/resend`);
    assert.equal(resent.status, 200);
    const fresh = (await resent.json()) as { id: string };
    const rows = await events.expect(4, "a resend");
    assert.deepEqual(rows[3]!.properties, { trigger: "resend", result: "sent" });
    assert.deepEqual({ server: rows[3]!.server_id, who: rows[3]!.analytics_id }, { server: world.server.id, who: await analyticsIdOf(world.admin.id) }, "the person who resent it");

    const raw = JSON.stringify(rows);
    for (const secret of ["example.com", world.room.id, fresh.id, ...invites.map((invite) => invite.id), ...mail.deliveries.map(tokenOf)]) {
      assert.equal(raw.includes(secret), false, "no address, domain, invite, token or channel in a row");
    }
  } finally {
    mail.stop();
  }
});

test("an invite email the provider refuses is recorded as failed, on a send and on a resend; the invite is still made", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const events = captureProductEvents(app, "external_invite_email_sent");
  __setEmailDeliveryObserverForTests((delivery) => {
    if (delivery.to === "down@example.com") throw new Error("mail provider down");
  });
  try {
    const sent = await world.call("owner", "POST", `${world.room.id}/external-invites`, { emails: ["up@example.com", "down@example.com"] });
    assert.equal(sent.status, 200);
    const invites = ((await sent.json()) as { sent: Array<{ id: string; email: string }> }).sent;
    assert.deepEqual(invites.map((invite) => invite.email), ["up@example.com", "down@example.com"], "a failed delivery rolls nothing back");
    const first = await events.expect(2, "one taken, one refused");
    assert.deepEqual(first.map((row) => row.properties), [{ trigger: "send", result: "sent" }, { trigger: "send", result: "failed" }]);

    const down = invites.find((invite) => invite.email === "down@example.com")!;
    assert.equal((await world.call("owner", "POST", `${world.room.id}/external-invites/${down.id}/resend`)).status, 200);
    const rows = await events.expect(3, "a resend the provider refuses");
    assert.deepEqual(rows[2]!.properties, { trigger: "resend", result: "failed" });
    for (const row of rows) assert.equal(row.server_id, world.server.id);
  } finally {
    __setEmailDeliveryObserverForTests(null);
  }
});

test("a send or resend that is refused attempts no email and records no external_invite_email_sent: the daily cap, the free limit, a member, an agent", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const other = await createChannel(world.server.id, `ext-other-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });
  const [open] = await getDb().insert(channelExternalInvites).values({
    channelId: world.room.id,
    hostServerId: world.server.id,
    email: "open@example.com",
    tokenHash: randomUUID(),
    invitedByUserId: world.owner.id,
    origin: "external_invite",
    expiresAt: new Date(Date.now() + 14 * DAY_MS),
  }).returning({ id: channelExternalInvites.id });
  const events = captureProductEvents(app, "external_invite_email_sent");
  const mail = captureEmails();
  try {
    // A member is not the host's owner or admin; an agent's key reaches neither route.
    assert.equal((await world.call("member", "POST", `${world.room.id}/external-invites`, { emails: ["m@example.com"] })).status, 403);
    assert.equal((await world.call("member", "POST", `${world.room.id}/external-invites/${open!.id}/resend`)).status, 403);
    const agent = await createAgent(world.server.id, `ext-agent-${world.tag}`, { runtime: "claude" });
    const key = (await mintAgentCredential({ agentId: agent.id, scopes: ["read", "tasks"], name: "ext-invites", issuedVia: "computer", createdByUserId: null })).apiKey;
    const asAgent = (path: string) => fetch(`${app.baseUrl}/api/channels/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Server-Id": world.server.id },
      body: JSON.stringify({ emails: ["agent@example.com"] }),
    });
    assert.equal((await asAgent(`${world.room.id}/external-invites`)).status, 401);
    assert.equal((await asAgent(`${world.room.id}/external-invites/${open!.id}/resend`)).status, 401);

    // The free plan's one external channel is the room (it has a Guest): a send to another is refused.
    await expectRefusal(await world.call("owner", "POST", `${other.id}/external-invites`, { emails: ["second@example.com"] }), "free_external_limit");

    // The daily cap: 100 sends in 24 hours with the open one.
    await getDb().insert(channelExternalInvites).values(Array.from({ length: 99 }, (_, index) => ({
      channelId: other.id,
      hostServerId: world.server.id,
      email: `recent${index}@example.com`,
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 14 * DAY_MS),
    })));
    const overCap = await world.call("owner", "POST", `${world.room.id}/external-invites`, { emails: ["a@example.com"] });
    assert.equal(overCap.status, 429);
    assert.equal(((await overCap.json()) as { code: string }).code, "daily_cap");
    assert.equal((await world.call("owner", "POST", `${world.room.id}/external-invites/${open!.id}/resend`)).status, 429, "a resend is a send");

    assert.equal(mail.deliveries.length, 0, "no email was attempted");
    await events.expect(0, "refused sends");
  } finally {
    mail.stop();
  }
});

test("an invite of another channel is not found through this one", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  // Paid: seedWorld's room is already the free plan's one external channel.
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, world.server.id));
  const other = await createChannel(world.server.id, `ext-elsewhere-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });
  const mail = captureEmails();
  try {
    const sent = await world.call("owner", "POST", `${other.id}/external-invites`, { emails: ["elsewhere@example.com"] });
    const [invite] = ((await sent.json()) as { sent: Array<{ id: string }> }).sent;
    assert.ok(invite);
    assert.equal((await world.call("owner", "DELETE", `${world.room.id}/external-invites/${invite.id}`)).status, 404);
    assert.equal((await world.call("owner", "POST", `${world.room.id}/external-invites/${invite.id}/resend`)).status, 404);
  } finally {
    mail.stop();
  }
});

test("an invite awaiting a server approval stays open: listed, holding its address, revocable, never resent", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const mail = captureEmails();
  try {
    const sent = await world.call("owner", "POST", `${world.room.id}/external-invites`, { emails: ["approval@example.com"] });
    assert.equal(sent.status, 200);
    const [invite] = ((await sent.json()) as { sent: Array<{ id: string }> }).sent;
    // The connect-approval path (P2a-3) sets this; seeded here.
    await getDb().update(channelExternalInvites).set({ status: "awaiting_approval" }).where(eq(channelExternalInvites.id, invite!.id));

    const listed = (await (await world.call("owner", "GET", `${world.room.id}/external-invites`)).json()) as { invites: Array<{ id: string; awaitingApproval: boolean }> };
    assert.deepEqual(listed.invites.map((row) => [row.id, row.awaitingApproval]), [[invite!.id, true]]);

    const preview = (await (await world.call("owner", "POST", `${world.room.id}/external-invites/preview`, { emails: ["approval@example.com"] })).json()) as { alreadyPending: string[] };
    assert.deepEqual(preview.alreadyPending, ["approval@example.com"], "no second open invite for the same address");

    const resend = await world.call("owner", "POST", `${world.room.id}/external-invites/${invite!.id}/resend`);
    assert.equal(resend.status, 409, "an approval in progress belongs to this invite");

    const revoke = await world.call("owner", "DELETE", `${world.room.id}/external-invites/${invite!.id}`);
    assert.equal(revoke.status, 200, await revoke.clone().text());
    const [row] = await inviteRows(world.room.id);
    assert.equal(row?.status, "revoked");
  } finally {
    mail.stop();
  }
});

// ── Limits at send time (plan §5: pending invites count at send time, the accept checks again) ──

type World = Awaited<ReturnType<typeof seedWorld>>;

async function send(world: World, channelId: string, emails: string[]) {
  const mail = captureEmails();
  try {
    return await world.call("owner", "POST", `${channelId}/external-invites`, { emails });
  } finally {
    mail.stop();
  }
}

async function expectRefusal(response: Response, code: string) {
  const body = (await response.json()) as { code?: string; limitSide?: string; limitServerId?: string; error?: string };
  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.code, code);
  return body;
}

/** `n` more Guests bound to the channel, as seeded rows. */
async function seedGuests(world: World, channelId: string, n: number) {
  const passwordHash = await fixturePasswordHash("password123");
  const rows = await getDb().insert(users).values(Array.from({ length: n }, (_, index) => ({
    email: `slot-${index}-${randomUUID().slice(0, 8)}@slock.test`,
    name: `slot-${index}-${randomUUID().slice(0, 8)}`,
    passwordHash,
    emailVerified: true,
  }))).returning({ id: users.id });
  for (const row of rows) await seedBoundGuest({ serverId: world.server.id, userId: row.id, channelId });
}

test("a free host already in an external channel is refused a send to another, at preview and send; the external one keeps inviting; a paid host is not limited", async ({ app }) => {
  // seedWorld's room has a Guest: the free host's one external channel.
  const world = await seedWorld(app.baseUrl);
  const fresh = await createChannel(world.server.id, `ext-fresh-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });

  for (const path of [`${fresh.id}/external-invites/preview`, `${fresh.id}/external-invites`]) {
    const body = await expectRefusal(await world.call("owner", "POST", path, { emails: ["second@example.com"] }), "free_external_limit");
    // Told to the host's own owner/admin, with the upgrade the web offers.
    assert.deepEqual({ side: body.limitSide, server: body.limitServerId }, { side: "host", server: world.server.id });
    assert.match(String(body.error), /Free plan/);
  }
  assert.equal((await inviteRows(fresh.id)).length, 0, "nothing of a refused send is written");

  assert.equal((await send(world, world.room.id, ["more@example.com"])).status, 200, "the channel that already is external keeps inviting");

  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, world.server.id));
  assert.equal((await send(world, fresh.id, ["second@example.com"])).status, 200);
});

test("a free host's open invites count at send: a channel with one takes the free plan's one external channel until it is withdrawn", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  // No Guest: the free host has no external channel yet.
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, world.server.id), eq(serverMembers.userId, world.guest.id)));
  const first = await createChannel(world.server.id, `ext-first-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });
  const second = await createChannel(world.server.id, `ext-second-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });

  const sent = await send(world, first.id, ["one@example.com"]);
  assert.equal(sent.status, 200);
  // The same channel takes more; another is refused while the invite is open.
  assert.equal((await send(world, first.id, ["two@example.com"])).status, 200);
  await expectRefusal(await send(world, second.id, ["three@example.com"]), "free_external_limit");
  await expectRefusal(await world.call("owner", "POST", `${second.id}/external-invites/preview`, { emails: ["three@example.com"] }), "free_external_limit");

  // Create Channel's External reads the same rule.
  const availability = await world.call("owner", "GET", "external-availability");
  assert.equal(availability.status, 200);
  assert.deepEqual(await availability.json(), { freeLimitReached: true });

  // Withdrawn (and an expired one counts no more than a withdrawn one), the other channel can invite.
  for (const invite of await inviteRows(first.id)) {
    assert.equal((await world.call("owner", "DELETE", `${first.id}/external-invites/${invite.id}`)).status, 200);
  }
  assert.deepEqual(await (await world.call("owner", "GET", "external-availability")).json(), { freeLimitReached: false });
  assert.equal((await send(world, second.id, ["three@example.com"])).status, 200);
});

test("external-availability is for the server's owners and admins, with the flag on", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  // seedWorld's room is external and the server free.
  assert.deepEqual(await (await world.call("admin", "GET", "external-availability")).json(), { freeLimitReached: true });
  for (const as of ["member", "channelAdmin"] as const) {
    assert.equal((await world.call(as, "GET", "external-availability")).status, 403, as);
  }
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, world.server.id));
  assert.deepEqual(await (await world.call("owner", "GET", "external-availability")).json(), { freeLimitReached: false });
  await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY));
  assert.equal((await world.call("owner", "GET", "external-availability")).status, 404);
});

test(`a send counts the channel's ${EXTERNAL_CHANNEL_MAX_SLOTS} slots with its open invites: the preview says how many are left, a send past them is refused whole`, async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  // The host, seedWorld's Guest and 20 more: 22 parties.
  await seedGuests(world, world.room.id, 20);
  assert.equal((await send(world, world.room.id, ["p1@example.com", "p2@example.com", "p3@example.com"])).status, 200);
  // 22 parties + 3 open invites leave 5.
  const seven = Array.from({ length: 7 }, (_, index) => `n${index}@example.com`);
  const preview = await world.call("owner", "POST", `${world.room.id}/external-invites/preview`, { emails: seven });
  assert.equal(preview.status, 200);
  const previewed = (await preview.json()) as { valid: string[]; slotsLeft: number };
  assert.deepEqual({ valid: previewed.valid.length, slotsLeft: previewed.slotsLeft }, { valid: 7, slotsLeft: EXTERNAL_CHANNEL_MAX_SLOTS - 25 });
  // The invites list says the same before anything is typed (the dialog's line under the emails).
  const listed = (await (await world.call("owner", "GET", `${world.room.id}/external-invites`)).json()) as { slotsLeft: number };
  assert.equal(listed.slotsLeft, EXTERNAL_CHANNEL_MAX_SLOTS - 25);

  // A full channel is no plan's limit: the host's own owner refused by it is no paywall hit (#wg-rbac:#60).
  const paywall = capturePaywallHits(app);
  const spans = captureRefusalSpans(app);
  await expectRefusal(await send(world, world.room.id, seven), "channel_full");
  assert.equal((await inviteRows(world.room.id)).length, 3, "nothing of a refused send is written");
  assert.deepEqual(await spans.expect(1, "the full channel's span"), [{ status: 409, errorCode: "channel_full", limitSide: "host" }]);
  await paywall.expect(0, "channel_full is not a paywall");

  assert.equal((await send(world, world.room.id, seven.slice(0, 5))).status, 200);
  const full = (await (await world.call("owner", "POST", `${world.room.id}/external-invites/preview`, { emails: ["late@example.com"] })).json()) as { slotsLeft: number };
  assert.equal(full.slotsLeft, 0);
  await expectRefusal(await send(world, world.room.id, ["late@example.com"]), "channel_full");
});

// ── Inviting from a joint channel the server hosts ──

/** A joint channel of `world.server` (the host) and a new peer server, the host's owner, admin and member in its projection. */
async function seedHostedJoint(world: World, baseUrl: string) {
  const peerOwner = await seedUser(`ext-jpeer-${world.tag}`);
  const peer = await createServer("Joint Peer", `ext-jpeer-${world.tag}`, peerOwner.id);
  await enableExternalChannelsFlag(peer.id);
  const joint = await seedJointChannel({ name: `ext-joint-${world.tag}`, serverIds: [world.server.id, peer.id], createdByUserId: world.owner.id });
  const [hostProjection, peerProjection] = joint.projections;
  for (const user of [world.owner, world.admin, world.member]) await addHuman(hostProjection!.id, user.id);
  await addHuman(peerProjection!.id, peerOwner.id);
  const peerToken = await login(baseUrl, peerOwner.email);
  /** As the peer's owner (its own admin), through the peer server. */
  const peerCall = (method: string, path: string, body?: unknown) => fetch(`${baseUrl}/api/channels/${path}`, {
    method,
    headers: { Authorization: `Bearer ${peerToken}`, "Content-Type": "application/json", "X-Server-Id": peer.id },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { peer, hostProjection: hostProjection!, peerProjection: peerProjection!, peerCall };
}

test("a joint channel takes external invites from its host's owner/admin only: not from another server's projection, not from a member", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { hostProjection, peerProjection, peerCall } = await seedHostedJoint(world, app.baseUrl);

  const mail = captureEmails();
  try {
    const preview = await world.call("admin", "POST", `${hostProjection.id}/external-invites/preview`, { emails: ["joint-one@example.com"] });
    assert.equal(preview.status, 200, await preview.clone().text());
    // Its two servers are two of the 30 parties.
    assert.equal(((await preview.json()) as { slotsLeft: number }).slotsLeft, EXTERNAL_CHANNEL_MAX_SLOTS - 2);

    const sent = await world.call("admin", "POST", `${hostProjection.id}/external-invites`, { emails: ["joint-one@example.com"] });
    assert.equal(sent.status, 200, await sent.clone().text());
    assert.equal(((await sent.json()) as { sent: unknown[] }).sent.length, 1);
    const [row] = await inviteRows(hostProjection.id);
    assert.deepEqual({ host: row?.hostServerId, status: row?.status }, { host: world.server.id, status: "pending" });
    // A joint channel is never made private (it has no public form).
    const [after] = await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, hostProjection.id));
    assert.equal(after?.type, "joint");

    // The peer server is in the same joint, but the channel is not its to share: refused as today's non-invitable channels are.
    for (const path of [`${peerProjection.id}/external-invites/preview`, `${peerProjection.id}/external-invites`]) {
      const refused = await peerCall("POST", path, { emails: ["joint-two@example.com"] });
      assert.equal(refused.status, 400, path);
      assert.equal(((await refused.json()) as { code: string }).code, "channel_not_invitable");
    }
    assert.equal((await inviteRows(peerProjection.id)).length, 0);

    // A plain member of the host (in the channel) is refused as for any channel.
    const asMember = await world.call("member", "POST", `${hostProjection.id}/external-invites`, { emails: ["joint-three@example.com"] });
    assert.equal(asMember.status, 403);
    assert.equal((await inviteRows(hostProjection.id)).length, 1);
  } finally {
    mail.stop();
  }
});

test("a free host's joint channel is its one external channel: inviting more to it takes no other, another channel is refused", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  // No Guest: the joint is the free host's only external channel.
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, world.server.id), eq(serverMembers.userId, world.guest.id)));
  const { hostProjection } = await seedHostedJoint(world, app.baseUrl);
  const other = await createChannel(world.server.id, `ext-other-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });

  assert.equal((await send(world, hostProjection.id, ["j1@example.com"])).status, 200);
  assert.equal((await send(world, hostProjection.id, ["j2@example.com", "j3@example.com"])).status, 200, "the joint keeps inviting");
  await expectRefusal(await send(world, other.id, ["o1@example.com"]), "free_external_limit");
  assert.deepEqual(await (await world.call("owner", "GET", "external-availability")).json(), { freeLimitReached: true });
});

test("P3: an invite from a joint channel offers the guest way in, and accepting binds a Guest to the host projection, in the channel", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { hostProjection } = await seedHostedJoint(world, app.baseUrl);
  const invitee = await seedUser(`ext-jinvitee-${world.tag}`);
  const mail = captureEmails();
  let token: string;
  try {
    assert.equal((await world.call("owner", "POST", `${hostProjection.id}/external-invites`, { emails: [invitee.email] })).status, 200);
    token = tokenOf(mail.deliveries.find((delivery) => delivery.to === invitee.email)!);
  } finally {
    mail.stop();
  }
  const auth = { Authorization: `Bearer ${await login(app.baseUrl, invitee.email)}` };
  const page = await fetch(`${app.baseUrl}/api/external-invites/${token}`, { headers: auth });
  assert.equal(page.status, 200);
  assert.equal(((await page.json()) as { options: { guest: boolean } }).options.guest, true);

  const accepted = await fetch(`${app.baseUrl}/api/external-invites/${token}/accept-as-guest`, { method: "POST", headers: auth });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const [member] = await getDb().select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, world.server.id), eq(serverMembers.userId, invitee.id)));
  assert.deepEqual(member, { role: "guest", guestChannelId: hostProjection.id });
  const read = await fetch(`${app.baseUrl}/api/messages/channel/${hostProjection.id}`, { headers: { ...auth, "X-Server-Id": world.server.id } });
  assert.equal(read.status, 200, await read.text());
});
