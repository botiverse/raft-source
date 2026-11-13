import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { channelExternalInvites, channelHumans, channels, featureFlagRules, serverInvites, serverJoinLinks, serverMembers, servers, userAnalyticsIds, users } from "../db/schema";
import { archiveChannel, createChannel, deleteChannel, unarchiveChannel } from "../services/channelService";
import { createJoinLink } from "../services/inviteService";
import { createServer } from "../services/serverService";
import { EXTERNAL_CHANNEL_MAX_SLOTS } from "../services/externalChannelLimitService";
import { getExternalInviteForInvitee, maskInviteEmail, type ConnectableServer } from "../services/externalInviteService";
import { externalInvitePageWays } from "../services/externalInviteProductEvents";
import { captureProductEvents } from "../test/integration/paywallHits";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";
import { captureEmails, login, seedUser, seedWorld, sha256, tokenOf } from "../test/externalInviteFixture";
import { seedBoundGuest } from "../test/guestFixture";

// Accepting an external invite as a Guest, P2a-2 (#wg-rbac:#16), and a Guest
// promoted by a normal server invite or join link.
const test = createApiTest();

const DAY_MS = 24 * 60 * 60 * 1000;
const NEUTRAL = { error: "This invite link is not valid" };

type World = Awaited<ReturnType<typeof seedWorld>>;

/** An invite row with a known token (the send path is covered by externalInvites.api.test.ts). */
async function seedInvite(world: World, input: {
  email: string;
  channelId?: string;
  hostServerId?: string;
  status?: "pending" | "awaiting_approval" | "accepted" | "revoked" | "expired";
  expiresAt?: Date;
}): Promise<{ id: string; token: string }> {
  const token = randomBytes(32).toString("hex");
  const status = input.status ?? "pending";
  const [row] = await getDb().insert(channelExternalInvites).values({
    channelId: input.channelId ?? world.room.id,
    hostServerId: input.hostServerId ?? world.server.id,
    email: input.email,
    tokenHash: sha256(token),
    invitedByUserId: world.owner.id,
    status,
    outcome: status === "accepted" ? "server" : null,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 14 * DAY_MS),
  }).returning({ id: channelExternalInvites.id });
  return { id: row!.id, token };
}

async function outsider(baseUrl: string, label: string) {
  const user = await seedUser(`${label}-${randomBytes(4).toString("hex")}`);
  return { user, token: await login(baseUrl, user.email) };
}

function inviteePage(baseUrl: string, as: string, token: string) {
  return fetch(`${baseUrl}/api/external-invites/${token}`, { headers: { Authorization: `Bearer ${as}` } });
}

function acceptAsGuest(baseUrl: string, as: string, token: string) {
  return fetch(`${baseUrl}/api/external-invites/${token}/accept-as-guest`, { method: "POST", headers: { Authorization: `Bearer ${as}` } });
}

async function membership(serverId: string, userId: string) {
  const [row] = await getDb().select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
  return row ?? null;
}

async function isChannelMember(channelId: string, userId: string) {
  const [row] = await getDb().select({ userId: channelHumans.userId }).from(channelHumans)
    .where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, userId)));
  return !!row;
}

async function inviteRow(id: string) {
  const [row] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.id, id));
  return row!;
}

/** `n` more Guests bound to the channel, as seeded rows. */
async function seedGuests(world: World, channelId: string, n: number) {
  const passwordHash = await fixturePasswordHash("password123");
  const rows = await getDb().insert(users).values(Array.from({ length: n }, (_, index) => ({
    email: `filler-${index}-${randomBytes(4).toString("hex")}@slock.test`,
    name: `filler-${index}-${randomBytes(4).toString("hex")}`,
    passwordHash,
    emailVerified: true,
  }))).returning({ id: users.id });
  for (const row of rows) await seedBoundGuest({ serverId: world.server.id, userId: row.id, channelId });
}

async function expectStatus(response: Response, status: number, code?: string) {
  const body = await response.json() as { error: string; code?: string };
  assert.equal(response.status, status, JSON.stringify(body));
  if (code) assert.equal(body.code, code);
  return body;
}

test("every invite the caller cannot use answers the same 404 on the page and on accept", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { user, token: as } = await outsider(app.baseUrl, "ext-neutral");
  const stranger = await outsider(app.baseUrl, "ext-stranger");
  const elsewhere = await seedWorld(app.baseUrl);
  const doomed = await createChannel(world.server.id, `ext-doomed-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });
  const flagOff = await seedWorld(app.baseUrl, { flag: false });
  // One open invite per (channel, address): the open cases each get a channel.
  const spare = () => createChannel(world.server.id, `ext-spare-${randomBytes(4).toString("hex")}`, undefined, "private", { type: "user", id: world.owner.id });

  const cases: Array<[string, string, string]> = [
    ["unknown token", as, randomBytes(32).toString("hex")],
    ["expired by time", as, (await seedInvite(world, { email: user.email, expiresAt: new Date(Date.now() - 1000) })).token],
    ["revoked", as, (await seedInvite(world, { email: user.email, status: "revoked" })).token],
    ["expired", as, (await seedInvite(world, { email: user.email, status: "expired" })).token],
    ["accepted", as, (await seedInvite(world, { email: user.email, status: "accepted" })).token],
    ["deleted channel", as, (await seedInvite(world, { email: user.email, channelId: doomed.id })).token],
    // channels.server_id never changes; an invite naming another host than its channel's is refused all the same.
    ["channel of another server", as, (await seedInvite(world, { email: user.email, channelId: (await spare()).id, hostServerId: elsewhere.server.id })).token],
    ["flag off on the host", as, (await seedInvite(flagOff, { email: user.email })).token],
  ];
  await deleteChannel(doomed.id);
  // Accept only: the page shows a valid invite to anyone holding the link.
  const wrongEmail = await seedInvite(world, { email: user.email, channelId: (await spare()).id });

  for (const [label, caller, token] of cases) {
    const page = await inviteePage(app.baseUrl, caller, token);
    assert.equal(page.status, 404, `page: ${label}`);
    assert.deepEqual(await page.json(), NEUTRAL, `page: ${label}`);
    const accepted = await acceptAsGuest(app.baseUrl, caller, token);
    assert.equal(accepted.status, 404, `accept: ${label}`);
    assert.deepEqual(await accepted.json(), NEUTRAL, `accept: ${label}`);
  }
  const wrong = await acceptAsGuest(app.baseUrl, stranger.token, wrongEmail.token);
  assert.equal(wrong.status, 404, "accept: another address");
  assert.deepEqual(await wrong.json(), NEUTRAL);
  assert.equal(await membership(world.server.id, stranger.user.id), null);
  assert.equal(await membership(world.server.id, user.id), null);
  assert.equal((await inviteRow(wrongEmail.id)).status, "pending");

  const unauthenticated = await fetch(`${app.baseUrl}/api/external-invites/${wrongEmail.token}`);
  assert.equal(unauthenticated.status, 401);
});

test("a masked invite address never shows a whole local part", () => {
  // One or two characters would be shown entire by their first character.
  assert.equal(maskInviteEmail("a@x.com"), "•••@x.com");
  assert.equal(maskInviteEmail("ab@x.com"), "•••@x.com");
  assert.equal(maskInviteEmail("abc@x.com"), "a•••@x.com");
});

test("the page tells a caller on load whether the invite is theirs, masking the address for anyone else", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const invitee = await outsider(app.baseUrl, "ext-addressed");
  const stranger = await outsider(app.baseUrl, "ext-unaddressed");
  const { token } = await seedInvite(world, { email: invitee.user.email });
  const [local, domain] = invitee.user.email.split("@") as [string, string];

  // The invited address: as before, with addressedToYou and no address at all.
  const mine = await inviteePage(app.baseUrl, invitee.token, token);
  assert.equal(mine.status, 200);
  const mineBody = await mine.json() as Record<string, unknown>;
  assert.equal(mineBody.addressedToYou, true);
  assert.equal("invitedEmailMasked" in mineBody, false);
  assert.ok(!JSON.stringify(mineBody).includes(local), "nothing of the address to its owner either");

  // Anyone else holding the link: not theirs, the local part masked, never the full address.
  const theirs = await inviteePage(app.baseUrl, stranger.token, token);
  assert.equal(theirs.status, 200);
  const theirsBody = await theirs.json() as Record<string, unknown>;
  assert.deepEqual(theirsBody, { addressedToYou: false, invitedEmailMasked: `${local[0]}•••@${domain}` },
    "another account holding the link learns which address it was for, nothing of the channel, server or inviter");
  const raw = JSON.stringify(theirsBody);
  assert.ok(!raw.includes(invitee.user.email), "the invited address never reaches another account");
  assert.ok(!raw.includes(local), "nor its local part");

  // Signed out: the page needs a session, so nothing about the address.
  const signedOut = await fetch(`${app.baseUrl}/api/external-invites/${token}`);
  assert.equal(signedOut.status, 401);
  assert.ok(!(await signedOut.text()).includes(domain));
});

test("a new person accepts as a Guest: bound to the channel, a member of it, and reads and posts only there", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { user, token: as } = await outsider(app.baseUrl, "ext-newcomer");
  const mail = captureEmails();
  let token: string;
  try {
    const sent = await world.call("owner", "POST", `${world.room.id}/external-invites`, { emails: [user.email] });
    assert.equal(sent.status, 200);
    token = tokenOf(mail.deliveries.find((delivery) => delivery.to === user.email)!);
  } finally {
    mail.stop();
  }

  // Another account holding the link: only the invited address, masked (cindyz #wg-rbac:5433e81b).
  const someoneElse = await outsider(app.baseUrl, "ext-link-holder");
  const page = await inviteePage(app.baseUrl, someoneElse.token, token);
  assert.equal(page.status, 200);
  const shown = await page.json() as Record<string, unknown>;
  assert.deepEqual(shown, {
    addressedToYou: false,
    invitedEmailMasked: `${user.email[0]}•••@${user.email.split("@")[1]}`,
  });
  assert.equal(JSON.stringify(shown).includes(world.room.name), false, "a forwarded link shows no channel name");
  assert.equal(JSON.stringify(shown).includes(user.email), false);

  const accepted = await acceptAsGuest(app.baseUrl, as, token);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.deepEqual(await accepted.json(), { serverId: world.server.id, channelId: world.room.id });

  // Every Guest written has its binding (Tenny).
  assert.deepEqual(await membership(world.server.id, user.id), { role: "guest", guestChannelId: world.room.id });
  assert.equal(await isChannelMember(world.room.id, user.id), true);
  const [invite] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.tokenHash, sha256(token)));
  assert.equal(invite?.status, "accepted");
  assert.equal(invite?.outcome, "guest");
  assert.equal(invite?.acceptedUserId, user.id);
  assert.ok(invite?.decidedAt);

  const headers = { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "X-Server-Id": world.server.id };
  const read = await fetch(`${app.baseUrl}/api/channels/${world.room.id}`, { headers });
  assert.equal(read.status, 200);
  const posted = await fetch(`${app.baseUrl}/api/messages`, { method: "POST", headers, body: JSON.stringify({ channelId: world.room.id, content: "hello from outside" }) });
  assert.equal(posted.status, 200, await posted.clone().text());
  const other = await createChannel(world.server.id, `ext-other-${world.tag}`, undefined, "channel", { type: "user", id: world.owner.id });
  assert.equal((await fetch(`${app.baseUrl}/api/channels/${other.id}`, { headers })).status, 404);

  // A retry answers as the first did and changes nothing.
  const again = await acceptAsGuest(app.baseUrl, as, token);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { serverId: world.server.id, channelId: world.room.id });

  // The page now tells the person who accepted where they landed, and nobody else anything.
  const landed = await inviteePage(app.baseUrl, as, token);
  assert.equal(landed.status, 200);
  const outcome = await landed.json() as Record<string, unknown>;
  assert.equal(outcome.status, "accepted");
  assert.deepEqual(outcome.accepted, { outcome: "guest", serverId: world.server.id, channelId: world.room.id, channelName: world.room.name });
  assert.deepEqual(outcome.options, { guest: false, connect: { servers: [] }, newServer: false });
  for (const caller of [someoneElse.token, await login(app.baseUrl, world.owner.email)]) {
    const other = await inviteePage(app.baseUrl, caller, token);
    assert.equal(other.status, 404);
    assert.deepEqual(await other.json(), NEUTRAL);
  }
  // Past its expiry it was still accepted before then: still shown to them.
  await getDb().update(channelExternalInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(channelExternalInvites.tokenHash, sha256(token)));
  assert.equal((await inviteePage(app.baseUrl, as, token)).status, 200);
  // Signed in as the invited address only: once it is no longer verified, the neutral 404.
  await getDb().update(users).set({ emailVerified: false }).where(eq(users.id, user.id));
  assert.deepEqual(await (await inviteePage(app.baseUrl, as, token)).json(), NEUTRAL);
  await getDb().update(users).set({ emailVerified: true }).where(eq(users.id, user.id));
  // The flag off on the host: the neutral 404 to them too.
  await getDb().delete(featureFlagRules).where(sql`${featureFlagRules.values} @> ${JSON.stringify([world.server.id])}::jsonb`);
  assert.deepEqual(await (await inviteePage(app.baseUrl, as, token)).json(), NEUTRAL);
});

test("an accepted Guest invite keeps its archived receipt but reveals nothing after membership removal", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { user, token: as } = await outsider(app.baseUrl, "ext-removed-recipient");
  const invite = await seedInvite(world, { email: user.email });
  await expectStatus(await acceptAsGuest(app.baseUrl, as, invite.token), 200);
  assert.equal((await inviteePage(app.baseUrl, as, invite.token)).status, 200);

  await expectStatus(await world.call("owner", "DELETE", `${world.room.id}/members/user/${user.id}`), 200);
  assert.equal(await membership(world.server.id, user.id), null);
  assert.equal(await isChannelMember(world.room.id, user.id), false);
  const direct = await fetch(`${app.baseUrl}/api/channels/${world.room.id}`, {
    headers: { Authorization: `Bearer ${as}`, "X-Server-Id": world.server.id },
  });
  assert.ok([403, 404].includes(direct.status), "ordinary channel access is already revoked");
  await getDb().update(channels).set({ name: `private-after-removal-${world.tag}` }).where(eq(channels.id, world.room.id));
  const page = await inviteePage(app.baseUrl, as, invite.token);
  assert.equal(page.status, 404, await page.clone().text());
  assert.deepEqual(await page.json(), NEUTRAL);
});

test("archiving the channel ends an accepted Guest: its invite page reveals nothing, before or after unarchive", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { user, token: as } = await outsider(app.baseUrl, "ext-archived-recipient");
  const invite = await seedInvite(world, { email: user.email });
  await expectStatus(await acceptAsGuest(app.baseUrl, as, invite.token), 200);
  await expectStatus(await world.call("owner", "POST", `${world.room.id}/archive`), 200);
  assert.equal(await membership(world.server.id, user.id), null, "the archive ends the Guest's membership");
  assert.deepEqual(await (await inviteePage(app.baseUrl, as, invite.token)).json(), NEUTRAL);
  await expectStatus(await world.call("owner", "POST", `${world.room.id}/unarchive`), 200);
  assert.equal(await membership(world.server.id, user.id), null, "unarchive brings no one back");
  assert.deepEqual(await (await inviteePage(app.baseUrl, as, invite.token)).json(), NEUTRAL);
});

test("an accepted invite needs private channel access even when the recipient stays a server member", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { user, token: as } = await outsider(app.baseUrl, "ext-removed-member");
  const invite = await seedInvite(world, { email: user.email });
  await expectStatus(await acceptAsGuest(app.baseUrl, as, invite.token), 200);
  // The recipient was subsequently promoted. Removing it from this private
  // channel now leaves its server membership intact.
  await getDb().update(serverMembers).set({ role: "member", guestChannelId: null })
    .where(and(eq(serverMembers.serverId, world.server.id), eq(serverMembers.userId, user.id)));
  assert.equal((await inviteePage(app.baseUrl, as, invite.token)).status, 200);
  await expectStatus(await world.call("owner", "DELETE", `${world.room.id}/members/user/${user.id}`), 200);
  assert.deepEqual(await membership(world.server.id, user.id), { role: "member", guestChannelId: null });
  assert.equal(await isChannelMember(world.room.id, user.id), false);
  await getDb().update(channels).set({ name: `private-after-member-left-${world.tag}` }).where(eq(channels.id, world.room.id));
  const page = await inviteePage(app.baseUrl, as, invite.token);
  assert.equal(page.status, 404, await page.clone().text());
  assert.deepEqual(await page.json(), NEUTRAL);
});

test("members, Guests of another channel and Guests of this one", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const memberToken = await login(app.baseUrl, world.member.email);
  const guestToken = await login(app.baseUrl, world.guest.email);
  const other = await createChannel(world.server.id, `ext-other-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });

  const asMember = await seedInvite(world, { email: world.member.email, channelId: other.id });
  const body = await expectStatus(await acceptAsGuest(app.baseUrl, memberToken, asMember.token), 409, "already_member");
  assert.equal(body.error, "You're already a member of this server. Ask an admin to add you to the channel.");
  assert.deepEqual(await membership(world.server.id, world.member.id), { role: "member", guestChannelId: null });

  const elsewhere = await seedInvite(world, { email: world.guest.email, channelId: other.id });
  const refused = await expectStatus(await acceptAsGuest(app.baseUrl, guestToken, elsewhere.token), 409, "guest_elsewhere");
  assert.equal(refused.error, "You can't join this channel as a guest.");
  assert.equal(await isChannelMember(other.id, world.guest.id), false);
  assert.equal((await inviteRow(elsewhere.id)).status, "pending");

  // Already this channel's Guest: the invite is used up and nothing else changes.
  const here = await seedInvite(world, { email: world.guest.email });
  await expectStatus(await acceptAsGuest(app.baseUrl, guestToken, here.token), 200);
  assert.equal((await inviteRow(here.id)).status, "accepted");
  assert.deepEqual(await membership(world.server.id, world.guest.id), { role: "guest", guestChannelId: world.room.id });
});

test("the page offers joining as a guest to a new person or this channel's Guest, never to a Guest of another channel (matrix §3)", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const other = await createChannel(world.server.id, `ext-vendor-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });
  const newcomer = await outsider(app.baseUrl, "ext-newcomer");
  const elsewhere = await outsider(app.baseUrl, "ext-elsewhere");
  await seedBoundGuest({ serverId: world.server.id, userId: elsewhere.user.id, channelId: other.id });
  const guestOption = async (as: string, email: string) => {
    const { token } = await seedInvite(world, { email });
    const response = await inviteePage(app.baseUrl, as, token);
    assert.equal(response.status, 200);
    return ((await response.json()) as { options: { guest: boolean } }).options.guest;
  };
  assert.equal(await guestOption(newcomer.token, newcomer.user.email), true);
  assert.equal(await guestOption(await login(app.baseUrl, world.guest.email), world.guest.email), true, "this channel's own Guest");
  assert.equal(await guestOption(elsewhere.token, elsewhere.user.email), false, "a Guest of another channel");
});

test("a connecting invite names the server being connected to the invitee only", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const invitee = await outsider(app.baseUrl, "ext-connecting");
  const stranger = await outsider(app.baseUrl, "ext-connecting-other");
  const theirs = await createServer("Theirs", `ext-theirs-${world.tag}`, invitee.user.id);
  const { id, token } = await seedInvite(world, { email: invitee.user.email });
  await getDb().update(channelExternalInvites).set({
    status: "connecting",
    connectPhase: "conversion",
    connectGeneration: randomUUID(),
    connectOutcome: "server",
    connectServerId: theirs.id,
  }).where(eq(channelExternalInvites.id, id));

  const mine = await inviteePage(app.baseUrl, invitee.token, token);
  assert.equal(mine.status, 200);
  const body = (await mine.json()) as { status: string; connectServerId?: string };
  assert.equal(body.status, "connecting");
  assert.equal(body.connectServerId, theirs.id);

  const other = (await (await inviteePage(app.baseUrl, stranger.token, token)).json()) as Record<string, unknown>;
  assert.equal("connectServerId" in other, false);
});

test("an invite awaiting approval and an archived channel are refused, but only to the invited address", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { user, token: as } = await outsider(app.baseUrl, "ext-waiting");
  const stranger = await outsider(app.baseUrl, "ext-other-account");

  const awaiting = await seedInvite(world, { email: user.email, status: "awaiting_approval" });
  const page = await inviteePage(app.baseUrl, as, awaiting.token);
  assert.equal(page.status, 200);
  assert.deepEqual(((await page.json()) as { options: unknown }).options, { guest: false, connect: { servers: [] }, newServer: false });
  await expectStatus(await acceptAsGuest(app.baseUrl, as, awaiting.token), 409, "approval_in_progress");
  assert.deepEqual(await (await acceptAsGuest(app.baseUrl, stranger.token, awaiting.token)).json(), NEUTRAL);

  // Archiving revokes the channel's open invites (plan §8): the neutral 404,
  // and unarchiving revives none.
  const archived = await createChannel(world.server.id, `ext-archived-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });
  const invite = await seedInvite(world, { email: user.email, channelId: archived.id });
  await archiveChannel(archived.id, world.owner.id);
  assert.equal((await inviteePage(app.baseUrl, as, invite.token)).status, 404);
  assert.deepEqual(await (await acceptAsGuest(app.baseUrl, as, invite.token)).json(), NEUTRAL);
  await unarchiveChannel(archived.id);
  assert.equal((await inviteePage(app.baseUrl, as, invite.token)).status, 404, "unarchive revives no invite");
  assert.deepEqual(await (await acceptAsGuest(app.baseUrl, as, invite.token)).json(), NEUTRAL);
  assert.deepEqual(await (await acceptAsGuest(app.baseUrl, stranger.token, invite.token)).json(), NEUTRAL);
  assert.equal(await membership(world.server.id, user.id), null);
});

test(`a channel holds ${EXTERNAL_CHANNEL_MAX_SLOTS} outside parties, the host counting as one`, async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  // seedWorld's Guest plus these leave one slot.
  await seedGuests(world, world.room.id, EXTERNAL_CHANNEL_MAX_SLOTS - 3);
  const last = await outsider(app.baseUrl, "ext-last");
  const late = await outsider(app.baseUrl, "ext-late");
  const lastInvite = await seedInvite(world, { email: last.user.email });
  const lateInvite = await seedInvite(world, { email: late.user.email });

  await expectStatus(await acceptAsGuest(app.baseUrl, last.token, lastInvite.token), 200);
  const full = await expectStatus(await acceptAsGuest(app.baseUrl, late.token, lateInvite.token), 409, "channel_full") as Record<string, unknown>;
  assert.deepEqual({ side: full.limitSide, server: full.limitServerId }, { side: "host", server: world.server.id });
  assert.equal(await membership(world.server.id, late.user.id), null);
  assert.equal((await inviteRow(lateInvite.id)).status, "pending");
});

test("a full channel is told up front: every way in is off, and only that it is full", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  // The host, seedWorld's Guest and these: one slot left.
  await seedGuests(world, world.room.id, EXTERNAL_CHANNEL_MAX_SLOTS - 3);
  const late = await outsider(app.baseUrl, "ext-full");
  const invite = await seedInvite(world, { email: late.user.email });
  // Open invites hold no slot here: the accept is the final check.
  await seedInvite(world, { email: "someone-else@example.com" });

  const open = await expectStatus(await inviteePage(app.baseUrl, late.token, invite.token), 200) as unknown as { channelFull: boolean; options: { guest: boolean } };
  assert.deepEqual({ full: open.channelFull, guest: open.options.guest }, { full: false, guest: true });

  await seedGuests(world, world.room.id, 1);
  const full = await expectStatus(await inviteePage(app.baseUrl, late.token, invite.token), 200) as unknown as { channelFull: boolean; options: unknown; status: string };
  assert.equal(full.status, "pending");
  assert.equal(full.channelFull, true);
  assert.deepEqual(full.options, { guest: false, connect: { servers: [] }, newServer: false });
  await expectStatus(await acceptAsGuest(app.baseUrl, late.token, invite.token), 409, "channel_full");
});

test("a free host is in one external channel: a second is refused, the first keeps admitting, a paid host is not limited", async ({ app }) => {
  // seedWorld's room already has a Guest: it is the free host's external channel.
  const world = await seedWorld(app.baseUrl);
  const fresh = await createChannel(world.server.id, `ext-fresh-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });
  const first = await outsider(app.baseUrl, "ext-first");
  const second = await outsider(app.baseUrl, "ext-second");
  const third = await outsider(app.baseUrl, "ext-third");

  // Open invites do not make a channel external: a second one changes nothing.
  await seedInvite(world, { email: "someone-else@example.com", channelId: fresh.id });
  const toFresh = await seedInvite(world, { email: first.user.email, channelId: fresh.id });
  const body = await expectStatus(await acceptAsGuest(app.baseUrl, first.token, toFresh.token), 409, "free_external_limit") as Record<string, unknown>;
  assert.equal(/free|plan|upgrade/i.test(String(body.error)), false, "the invitee is not told the host's plan");
  // Whose limit: the host's (a Guest has no server of their own in it).
  assert.deepEqual({ side: body.limitSide, server: body.limitServerId }, { side: "host", server: world.server.id });

  // The channel that already is external keeps admitting.
  await expectStatus(await acceptAsGuest(app.baseUrl, second.token, (await seedInvite(world, { email: second.user.email })).token), 200);

  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, world.server.id));
  await expectStatus(await acceptAsGuest(app.baseUrl, first.token, toFresh.token), 200);
  assert.deepEqual(await membership(world.server.id, first.user.id), { role: "guest", guestChannelId: fresh.id });
  // And a third channel on the paid host too.
  const another = await createChannel(world.server.id, `ext-another-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });
  await expectStatus(await acceptAsGuest(app.baseUrl, third.token, (await seedInvite(world, { email: third.user.email, channelId: another.id })).token), 200);
});

// PGlite runs one transaction at a time, so these show the outcome of two
// requests sent together, not the lock waits; externalInviteAccept.realPg.test.ts
// shows those on real PostgreSQL.
test("one person's two invites at once: one channel takes them, the other answers guest_elsewhere", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, world.server.id));
  const a = await createChannel(world.server.id, `ext-a-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });
  const b = await createChannel(world.server.id, `ext-b-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });
  const person = await outsider(app.baseUrl, "ext-twice");
  const [toA, toB] = await Promise.all([seedInvite(world, { email: person.user.email, channelId: a.id }), seedInvite(world, { email: person.user.email, channelId: b.id })]);
  const responses = await Promise.all([acceptAsGuest(app.baseUrl, person.token, toA.token), acceptAsGuest(app.baseUrl, person.token, toB.token)]);
  const outcomes = await Promise.all(responses.map(async (response) => [response.status, ((await response.json()) as { code?: string }).code ?? null]));
  assert.deepEqual(outcomes.map(([status]) => status).sort(), [200, 409]);
  assert.deepEqual(outcomes.find(([status]) => status === 409), [409, "guest_elsewhere"]);
  const bound = (await membership(world.server.id, person.user.id))!;
  assert.equal(bound.role, "guest");
  assert.equal(await isChannelMember(a.id, person.user.id), bound.guestChannelId === a.id);
  assert.equal(await isChannelMember(b.id, person.user.id), bound.guestChannelId === b.id);
});

test("two people at once for the last slot: exactly one gets it", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  await seedGuests(world, world.room.id, EXTERNAL_CHANNEL_MAX_SLOTS - 3);
  const one = await outsider(app.baseUrl, "ext-race-one");
  const two = await outsider(app.baseUrl, "ext-race-two");
  const [inviteOne, inviteTwo] = await Promise.all([seedInvite(world, { email: one.user.email }), seedInvite(world, { email: two.user.email })]);
  const responses = await Promise.all([acceptAsGuest(app.baseUrl, one.token, inviteOne.token), acceptAsGuest(app.baseUrl, two.token, inviteTwo.token)]);
  const outcomes = await Promise.all(responses.map(async (response) => [response.status, ((await response.json()) as { code?: string }).code ?? null]));
  assert.deepEqual(outcomes.map(([status]) => status).sort(), [200, 409]);
  assert.deepEqual(outcomes.find(([status]) => status === 409), [409, "channel_full"]);
  const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, world.server.id), eq(serverMembers.guestChannelId, world.room.id)));
  assert.equal(n + 1, EXTERNAL_CHANNEL_MAX_SLOTS);
});

// ── A Guest promoted by a normal server invite or join link (Cody) ──

async function seedServerInvite(world: World, email: string, invitedByUserId = world.owner.id): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await getDb().insert(serverInvites).values({
    serverId: world.server.id,
    invitedEmail: email,
    invitedByUserId,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + 7 * DAY_MS),
  });
  return token;
}

function acceptServerInvite(baseUrl: string, as: string, token: string) {
  return fetch(`${baseUrl}/api/auth/accept-invite`, {
    method: "POST",
    headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

test("a Guest accepting a server invite becomes a member, unbound, still in its channel; a member is still already a member", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const guestToken = await login(app.baseUrl, world.guest.email);
  const memberToken = await login(app.baseUrl, world.member.email);
  const ownerHeaders = { Authorization: `Bearer ${await login(app.baseUrl, world.owner.email)}`, "Content-Type": "application/json", "X-Server-Id": world.server.id };

  // A Guest's address may be invited; a member's still may not.
  const mail = captureEmails();
  try {
    const toGuest = await fetch(`${app.baseUrl}/api/servers/${world.server.id}/invites`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ email: world.guest.email }) });
    assert.equal(toGuest.status, 200, await toGuest.clone().text());
    const toMember = await fetch(`${app.baseUrl}/api/servers/${world.server.id}/invites`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ email: world.member.email }) });
    assert.equal(toMember.status, 409);
  } finally {
    mail.stop();
  }
  const token = /[?&]invite=([0-9a-f]{64})/.exec(mail.deliveries[0]!.html);
  assert.ok(token, "the invite email carries its token");

  const accepted = await acceptServerInvite(app.baseUrl, guestToken, token[1]!);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.deepEqual(await membership(world.server.id, world.guest.id), { role: "member", guestChannelId: null });
  assert.equal(await isChannelMember(world.room.id, world.guest.id), true, "channel memberships stay");
  const [used] = await getDb().select({ status: serverInvites.status }).from(serverInvites).where(eq(serverInvites.invitedEmail, world.guest.email));
  assert.equal(used?.status, "accepted");

  const memberInvite = await seedServerInvite(world, world.member.email);
  const refused = await acceptServerInvite(app.baseUrl, memberToken, memberInvite);
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: "You are already a member of this server" });
  const [unused] = await getDb().select({ status: serverInvites.status }).from(serverInvites).where(eq(serverInvites.tokenHash, sha256(memberInvite)));
  assert.equal(unused?.status, "pending", "a member's refused invite is not used");
});

test("a Guest's promotion is made as the inviter: refused once they can no longer promote", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const guestToken = await login(app.baseUrl, world.guest.email);
  const fromAdmin = await seedServerInvite(world, world.guest.email, world.admin.id);
  await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, world.server.id), eq(serverMembers.userId, world.admin.id)));

  const refused = await acceptServerInvite(app.baseUrl, guestToken, fromAdmin);
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: "This invite is no longer valid" });
  assert.deepEqual(await membership(world.server.id, world.guest.id), { role: "guest", guestChannelId: world.room.id });
  const [invite] = await getDb().select({ status: serverInvites.status }).from(serverInvites).where(eq(serverInvites.tokenHash, sha256(fromAdmin)));
  assert.equal(invite?.status, "pending");
});

test("a Guest opening a join link is promoted as its creator, and the link counts the use", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const guestToken = await login(app.baseUrl, world.guest.email);
  const { token, link } = await createJoinLink(world.server.id, world.owner.id);
  const accepted = await acceptServerInvite(app.baseUrl, guestToken, token);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.deepEqual(await membership(world.server.id, world.guest.id), { role: "member", guestChannelId: null });
  assert.equal(await isChannelMember(world.room.id, world.guest.id), true);
  const [after] = await getDb().select({ useCount: serverJoinLinks.useCount }).from(serverJoinLinks).where(eq(serverJoinLinks.id, link.id));
  assert.equal(after?.useCount, 1);

  // A member opening it again is let through as before: nothing changes, no use counted.
  const memberToken = await login(app.baseUrl, world.member.email);
  assert.equal((await acceptServerInvite(app.baseUrl, memberToken, token)).status, 200);
  assert.deepEqual(await membership(world.server.id, world.member.id), { role: "member", guestChannelId: null });
  const [still] = await getDb().select({ useCount: serverJoinLinks.useCount }).from(serverJoinLinks).where(eq(serverJoinLinks.id, link.id));
  assert.equal(still?.useCount, 1);

  // A link made by an admin who is no longer one lets no Guest in.
  const other = await seedWorld(app.baseUrl);
  const otherGuestToken = await login(app.baseUrl, other.guest.email);
  const fromAdmin = await createJoinLink(other.server.id, other.admin.id);
  await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, other.server.id), eq(serverMembers.userId, other.admin.id)));
  const refused = await acceptServerInvite(app.baseUrl, otherGuestToken, fromAdmin.token);
  assert.equal(refused.status, 400);
  assert.deepEqual(await membership(other.server.id, other.guest.id), { role: "guest", guestChannelId: other.room.id });
});

// ── A channel with an external relation stays private (cindyz, #wg-rbac:0829b5df) ──

test("a channel with a bound Guest or an open external invite cannot be made public until both are gone", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const makePublic = () => world.call("owner", "PATCH", world.room.id, { visibility: "public" });
  const typeOf = async () => (await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, world.room.id)))[0]?.type;

  const withGuest = await expectStatus(await makePublic(), 409, "external_members_keep_private");
  assert.equal(withGuest.error, "This channel has external members or pending external invites, so it stays private.");
  assert.equal(await typeOf(), "private");

  // Removing the Guest from its channel ends its membership.
  assert.equal((await world.call("owner", "DELETE", `${world.room.id}/members/user/${world.guest.id}`)).status, 200);
  assert.equal(await membership(world.server.id, world.guest.id), null);

  const open = await seedInvite(world, { email: "pending@example.com" });
  await expectStatus(await makePublic(), 409, "external_members_keep_private");
  await getDb().update(channelExternalInvites).set({ status: "awaiting_approval" }).where(eq(channelExternalInvites.id, open.id));
  await expectStatus(await makePublic(), 409, "external_members_keep_private");
  assert.equal((await world.call("owner", "DELETE", `${world.room.id}/external-invites/${open.id}`)).status, 200);
  await expectStatus(await makePublic(), 200);
  assert.equal(await typeOf(), "channel");

  // An invite past its expiry no longer holds the channel private.
  assert.equal((await world.call("owner", "PATCH", world.room.id, { visibility: "private" })).status, 200);
  await seedInvite(world, { email: "lapsed@example.com", expiresAt: new Date(Date.now() - 1000) });
  await expectStatus(await makePublic(), 200);
});

test("an invite to a channel that is public anyway is not valid, and makes no Guest", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { user, token: as } = await outsider(app.baseUrl, "ext-public");
  const invite = await seedInvite(world, { email: user.email });
  // Forced in the database: updateChannel refuses it.
  await getDb().update(channels).set({ type: "channel" }).where(eq(channels.id, world.room.id));
  const page = await inviteePage(app.baseUrl, as, invite.token);
  assert.equal(page.status, 404);
  assert.deepEqual(await page.json(), NEUTRAL);
  const accepted = await acceptAsGuest(app.baseUrl, as, invite.token);
  assert.equal(accepted.status, 404);
  assert.deepEqual(await accepted.json(), NEUTRAL);
  assert.equal(await membership(world.server.id, user.id), null);
  assert.equal(await isChannelMember(world.room.id, user.id), false);
  assert.equal((await inviteRow(invite.id)).status, "pending");
});

// #wg-rbac:#60 (Nova's contract): external_invite_page_viewed, the signed-in
// invitee's view of an open invite's page. No server on the row.
test("the invitee's page view is one external_invite_page_viewed per invite and day: the ways offered, no server, and nothing for anyone else or an unusable invite", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const invitee = await outsider(app.baseUrl, "ext-viewer");
  const stranger = await outsider(app.baseUrl, "ext-onlooker");
  const spare = await createChannel(world.server.id, `ext-spare-${randomBytes(4).toString("hex")}`, undefined, "private", { type: "user", id: world.owner.id });
  const invite = await seedInvite(world, { email: invitee.user.email });
  const second = await seedInvite(world, { email: invitee.user.email, channelId: spare.id });
  const revoked = await seedInvite(world, { email: invitee.user.email, channelId: (await createChannel(world.server.id, `ext-gone-${randomBytes(4).toString("hex")}`, undefined, "private", { type: "user", id: world.owner.id })).id, status: "revoked" });
  const events = captureProductEvents(app, "external_invite_page_viewed");

  const page = await inviteePage(app.baseUrl, invitee.token, invite.token);
  assert.equal(page.status, 200);
  const body = await page.json() as { options: { guest: boolean; connect: { servers: unknown[] }; newServer: boolean } };
  assert.deepEqual(body, JSON.parse(JSON.stringify(await getExternalInviteForInvitee(invite.token, invitee.user.id))), "the answer is the page, unchanged");
  assert.deepEqual(body.options, { guest: true, connect: { servers: [] }, newServer: true });
  const [first] = await events.expect(1, "the first view");
  // A person with no server: a Guest or a new server; an account made minutes ago is new.
  assert.deepEqual(first!.properties, { guest_offered: true, connect_offered: false, request_approval_offered: false, new_server_offered: true, new_account: true });
  const [analytics] = await getDb().select({ id: userAnalyticsIds.analyticsId }).from(userAnalyticsIds).where(eq(userAnalyticsIds.userId, invitee.user.id));
  assert.deepEqual({ source: first!.source, server: first!.server_id, who: first!.analytics_id }, { source: "server", server: null, who: analytics!.id }, "the viewer's, under no server");

  assert.equal((await inviteePage(app.baseUrl, invitee.token, invite.token)).status, 200);
  await events.expect(1, "a second view the same day");

  assert.equal((await inviteePage(app.baseUrl, invitee.token, second.token)).status, 200);
  await events.expect(2, "another invite to the same person");

  // Signed out (the preview, and the page without a session), and another account holding the link.
  assert.equal((await fetch(`${app.baseUrl}/api/external-invites/${invite.token}/preview`)).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/api/external-invites/${invite.token}`)).status, 401);
  const theirs = await inviteePage(app.baseUrl, stranger.token, invite.token);
  assert.equal(theirs.status, 200);
  assert.equal((await theirs.json() as { addressedToYou: boolean }).addressedToYou, false);

  // An invite that cannot be used: the one 404, byte for byte, whatever the reason.
  const bodies: string[] = [];
  for (const token of [revoked.token, randomBytes(32).toString("hex")]) {
    const gone = await inviteePage(app.baseUrl, invitee.token, token);
    assert.equal(gone.status, 404);
    bodies.push(await gone.text());
  }
  assert.deepEqual(bodies, [JSON.stringify(NEUTRAL), JSON.stringify(NEUTRAL)]);

  const rows = await events.expect(2, "the preview, a signed-out caller, another account and unusable invites record nothing");
  const raw = JSON.stringify(rows);
  for (const secret of [world.server.id, world.room.id, spare.id, world.owner.id, invitee.user.id, invite.id, second.id, invite.token, second.token, sha256(invite.id), "slock.test"]) {
    assert.equal(raw.includes(secret), false, "no host server, channel, inviter, user, invite, token, hash or address in a row");
  }
});

test("external_invite_page_viewed says which of the invitee's servers could connect, and an account older than a day is not new", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const invitee = await outsider(app.baseUrl, "ext-served");
  const boss = await seedUser(`ext-boss-${randomBytes(4).toString("hex")}`);
  await getDb().update(users).set({ createdAt: new Date(Date.now() - 2 * DAY_MS) }).where(eq(users.id, invitee.user.id));
  const owned = await createServer("Viewer Owned", `ext-owned-${randomBytes(4).toString("hex")}`, invitee.user.id);
  const joined = await createServer("Viewer Joined", `ext-joined-${randomBytes(4).toString("hex")}`, boss.id);
  await getDb().insert(serverMembers).values({ serverId: joined.id, userId: invitee.user.id, role: "member" });
  const invite = await seedInvite(world, { email: invitee.user.email });
  const events = captureProductEvents(app, "external_invite_page_viewed");

  const page = await inviteePage(app.baseUrl, invitee.token, invite.token);
  assert.equal(page.status, 200);
  const body = await page.json() as { options: { connect: { servers: Array<{ id: string; canConnectDirectly: boolean; needsApproval: boolean; atLimit: boolean }> } } };
  assert.deepEqual(
    body.options.connect.servers.map((server) => [server.id, server.canConnectDirectly, server.needsApproval, server.atLimit]).sort(),
    [[owned.id, true, false, false], [joined.id, false, true, false]].sort(),
  );
  const [row] = await events.expect(1, "the view");
  assert.deepEqual(row!.properties, { guest_offered: true, connect_offered: true, request_approval_offered: true, new_server_offered: true, new_account: false });
  assert.equal(row!.server_id, null);
  const raw = JSON.stringify(row);
  for (const secret of [owned.id, joined.id, world.server.id]) assert.equal(raw.includes(secret), false, "none of the servers");
});

test("external_invite_page_viewed of a viewer who does not share usage data names nobody: no analytics id, no server", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const invitee = await outsider(app.baseUrl, "ext-private");
  await getDb().update(users).set({ shareUsageData: false }).where(eq(users.id, invitee.user.id));
  const invite = await seedInvite(world, { email: invitee.user.email });
  const events = captureProductEvents(app, "external_invite_page_viewed");
  assert.equal((await inviteePage(app.baseUrl, invitee.token, invite.token)).status, 200);
  const [row] = await events.expect(1, "the view");
  assert.deepEqual({ server: row!.server_id, who: row!.analytics_id }, { server: null, who: null });
});

// Tenny, #wg-rbac:#60 (from the release that ships #14526): a host with product analytics off records nothing about its invites.
test("external_invite_page_viewed of an invite whose host turned product analytics off is not recorded; the viewer's own choice still applies on top", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const invitee = await outsider(app.baseUrl, "ext-host-off");
  const invite = await seedInvite(world, { email: invitee.user.email });
  const events = captureProductEvents(app, "external_invite_page_viewed");
  await getDb().update(servers).set({ productAnalyticsEnabled: false }).where(eq(servers.id, world.server.id));
  assert.equal((await inviteePage(app.baseUrl, invitee.token, invite.token)).status, 200, "the page itself is unchanged");
  await events.expect(0, "the host's switch is off");

  // Back on: recorded (the day's first recorded view; the skipped one took no once-a-day key).
  await getDb().update(servers).set({ productAnalyticsEnabled: true }).where(eq(servers.id, world.server.id));
  assert.equal((await inviteePage(app.baseUrl, invitee.token, invite.token)).status, 200);
  await events.expect(1, "the host's switch is on");

  // Both must allow it: the host on, the viewer not sharing, still a row but naming nobody (as before).
  const quiet = await outsider(app.baseUrl, "ext-host-on-quiet");
  await getDb().update(users).set({ shareUsageData: false }).where(eq(users.id, quiet.user.id));
  assert.equal((await inviteePage(app.baseUrl, quiet.token, (await seedInvite(world, { email: quiet.user.email, channelId: (await createChannel(world.server.id, `ext-q-${randomBytes(4).toString("hex")}`, undefined, "private", { type: "user", id: world.owner.id })).id })).token)).status, 200);
  const rows = await events.expect(2, "the quiet viewer");
  assert.equal(rows[1]!.analytics_id, null);
});

test("a server at its own plan's limit is listed on the invite page but not offered", () => {
  const server = (over: Partial<ConnectableServer>): ConnectableServer => ({
    id: "s", name: "S", slug: "s", avatarUrl: null, canConnectDirectly: true, needsApproval: false, approvers: [], atLimit: false, canUpgrade: false, owners: [], ...over,
  });
  const ways = (servers: ConnectableServer[]) => externalInvitePageWays({ guest: false, connect: { servers }, newServer: false });
  const none = { guest_offered: false, connect_offered: false, request_approval_offered: false, new_server_offered: false };
  assert.deepEqual(ways([]), none);
  assert.deepEqual(ways([server({ atLimit: true, canUpgrade: true }), server({ canConnectDirectly: false, needsApproval: true, atLimit: true })]), none);
  assert.deepEqual(ways([server({}), server({ canConnectDirectly: false, needsApproval: true, atLimit: true })]), { ...none, connect_offered: true });
  assert.deepEqual(ways([server({ canConnectDirectly: false, needsApproval: true })]), { ...none, request_approval_offered: true });
  assert.deepEqual(externalInvitePageWays({ guest: true, connect: { servers: [] }, newServer: true }), { ...none, guest_offered: true, new_server_offered: true });
});
