import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { CURRENT_LEGAL_ACCEPTANCE, DEPLOYMENT_USER_LIMIT_REACHED_CODE } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { channelExternalInvites, serverMembers, users } from "../db/schema";
import { HUMAN_USER_LIMIT } from "../edition";
import { createChannel } from "../services/channelService";
import { countHumanUserAccounts } from "../services/deploymentUserLimit";
import { createJoinLink } from "../services/inviteService";
import { createServer, deleteServer } from "../services/serverService";
import { createApiTest } from "../test/integration/apiTest";
import { enableExternalChannelsFlag, seedUser, sha256 } from "../test/externalInviteFixture";
import { seedBoundGuest } from "../test/guestFixture";

// The Raft License's user limit (Part I §2; edition.ts HUMAN_USER_LIMIT,
// services/deploymentUserLimit.ts): a source-available deployment has at most
// 5 people who count, and every way one more starts to count is refused with
// deployment_user_limit_reached (403). The cloud edition is unchanged.
const test = createApiTest();

// The edition line export-snapshot rewrites (edition.ts), switched per test.
const edition = vi.hoisted(() => ({ value: "source-available" as "cloud" | "source-available" }));
vi.mock("../edition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../edition")>();
  return { ...actual, humanUserLimit: () => actual.humanUserLimit(edition.value) };
});

afterEach(() => {
  edition.value = "source-available";
});

const DAY_MS = 24 * 60 * 60 * 1000;
type User = Awaited<ReturnType<typeof seedUser>>;
type Server = Awaited<ReturnType<typeof createServer>>;

function person(label: string): Promise<User> {
  return seedUser(`${label}-${randomBytes(4).toString("hex")}`);
}

/**
 * A deployment with `count` people who count: the first owns `home` (made by
 * createServer, so the bootstrap path runs), the rest are its members
 * (written directly, as a deployment already over the limit would have them).
 */
async function seedCounted(count: number): Promise<{ owner: User; others: User[]; home: Server }> {
  const owner = await person("counted-owner");
  const home = await createServer("Home", `home-${randomUUID().slice(0, 8)}`, owner.id);
  const others: User[] = [];
  for (let i = 1; i < count; i += 1) {
    const user = await person(`counted-${i}`);
    await getDb().insert(serverMembers).values({ serverId: home.id, userId: user.id, role: "member" });
    others.push(user);
  }
  assert.equal(await countHumanUserAccounts(), count);
  return { owner, others, home };
}

type Http = ReturnType<typeof import("../test/integration/http").createHttpClient>;

function post(http: Http, as: User, path: string, body: unknown = {}) {
  return http.as(as).request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function register(app: { baseUrl: string }, email: string) {
  return fetch(`${app.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "password-123456",
      acceptTerms: true,
      termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
    }),
  });
}

async function assertLimitRefusal(response: Response): Promise<void> {
  const text = await response.text();
  assert.equal(response.status, 403, text);
  const body = JSON.parse(text) as { code?: string; error?: string };
  assert.equal(body.code, DEPLOYMENT_USER_LIMIT_REACHED_CODE);
  assert.equal(
    body.error,
    `This Raft Community Edition deployment already has ${HUMAN_USER_LIMIT} people, the Raft License limit. To go above it, email contact@raft.build for a separate license.`,
  );
}

async function roleIn(serverId: string, userId: string) {
  const [row] = await getDb().select({ role: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
  return row?.role ?? null;
}

async function acceptJoinLink(http: Http, server: Server, inviter: User, joiner: User) {
  const { token } = await createJoinLink(server.id, inviter.id);
  return http.as(joiner).request("/api/auth/accept-invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

/** An external invite to a private channel of a new host server (owned by `hostOwner`) for `invitee`'s address. */
async function seedExternalInvite(hostOwner: User, invitee: User): Promise<{ token: string; hostId: string }> {
  const host = await createServer("Host", `host-${randomUUID().slice(0, 8)}`, hostOwner.id);
  await enableExternalChannelsFlag(host.id);
  const room = await createChannel(host.id, `room-${randomUUID().slice(0, 8)}`, undefined, "private", { type: "user", id: hostOwner.id });
  const token = randomBytes(32).toString("hex");
  await getDb().insert(channelExternalInvites).values({
    channelId: room.id,
    hostServerId: host.id,
    email: invitee.email,
    tokenHash: sha256(token),
    invitedByUserId: hostOwner.id,
    status: "pending",
    expiresAt: new Date(Date.now() + 14 * DAY_MS),
  });
  return { token, hostId: host.id };
}

function acceptAsGuest(http: Http, as: User, token: string) {
  return http.as(as).request(`/api/external-invites/${token}/accept-as-guest`, { method: "POST" });
}

test("a fresh deployment: the first account signs up, creates its server and owns it", async ({ app }) => {
  const before = await (await fetch(`${app.baseUrl}/api/auth/providers`)).json() as { deploymentUserLimitReached?: unknown };
  assert.equal(before.deploymentUserLimitReached, false);
  const signedUp = await register(app, `first-${randomBytes(4).toString("hex")}@slock.test`);
  assert.equal(signedUp.status, 200, await signedUp.clone().text());
  const { user, accessToken } = await signedUp.json() as { user: { id: string }; accessToken: string };
  // The email check and profile step the web walks through after sign-up.
  await getDb().update(users).set({ emailVerified: true }).where(eq(users.id, user.id));
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` };
  const profile = await fetch(`${app.baseUrl}/api/auth/me/complete-profile`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: `first${randomBytes(3).toString("hex")}`, displayName: "First" }),
  });
  assert.equal(profile.status, 200, await profile.clone().text());
  const created = await fetch(`${app.baseUrl}/api/servers`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "First", slug: `first-${randomUUID().slice(0, 8)}` }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const server = await created.json() as { id: string };
  assert.equal(await roleIn(server.id, user.id), "owner");
  assert.equal(await countHumanUserAccounts(), 1);
});

test("at the limit, a sixth person joining by invite link, the community or creating a server is refused", async ({ app, http }) => {
  const { owner, home } = await seedCounted(HUMAN_USER_LIMIT);
  const sixth = await person("sixth");

  await assertLimitRefusal(await acceptJoinLink(http, home, owner, sixth));
  assert.equal(await roleIn(home.id, sixth.id), null, "nothing written");

  const community = await createServer("The Community", "community", owner.id);
  await assertLimitRefusal(await post(http, sixth, "/api/servers/join-community"));
  assert.equal(await roleIn(community.id, sixth.id), null);

  await assertLimitRefusal(await post(http, sixth, "/api/servers", { name: "Sixth", slug: `sixth-${randomUUID().slice(0, 8)}` }));
  const owned = await getDb().select().from(serverMembers).where(eq(serverMembers.userId, sixth.id));
  assert.deepEqual(owned, [], "the refused server rolled back with its owner seat");

  // Someone who already counts still joins and creates servers.
  const already = await post(http, owner, "/api/servers", { name: "Another", slug: `another-${randomUUID().slice(0, 8)}` });
  assert.equal(already.status, 200, await already.clone().text());
  assert.equal(await countHumanUserAccounts(), HUMAN_USER_LIMIT);

  // invite-info and the sign-up page's read say so.
  const { token } = await createJoinLink(home.id, owner.id);
  const info = await (await fetch(`${app.baseUrl}/api/auth/invite-info?token=${token}`)).json() as { deploymentUserLimitReached?: unknown };
  assert.equal(info.deploymentUserLimitReached, true);
  const providers = await (await fetch(`${app.baseUrl}/api/auth/providers`)).json() as { deploymentUserLimitReached?: unknown };
  assert.equal(providers.deploymentUserLimitReached, true);
});

test("signing up is never refused at the limit", async ({ app }) => {
  await seedCounted(HUMAN_USER_LIMIT);
  const email = `signup-${randomBytes(4).toString("hex")}@slock.test`;
  const response = await register(app, email);
  assert.equal(response.status, 200, await response.clone().text());
  const [row] = await getDb().select({ id: users.id }).from(users).where(eq(users.email, email));
  assert.ok(row, "the account exists");
  assert.equal(await countHumanUserAccounts(), HUMAN_USER_LIMIT, "an account in no server does not count");
});

test("at the limit, a Guest made a member is refused, by hand or by a server invite", async ({ http }) => {
  const { owner, home } = await seedCounted(HUMAN_USER_LIMIT);
  const guest = await person("guest");
  await seedBoundGuest({ serverId: home.id, userId: guest.id });
  assert.equal(await countHumanUserAccounts(), HUMAN_USER_LIMIT, "one Guest seat takes no place");

  const patched = await http.as(owner, home).request(`/api/servers/${home.id}/members/${guest.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "member" }),
  });
  await assertLimitRefusal(patched);
  assert.equal(await roleIn(home.id, guest.id), "guest");

  await assertLimitRefusal(await acceptJoinLink(http, home, owner, guest));
  assert.equal(await roleIn(home.id, guest.id), "guest");
});

test("at the limit, a second Guest seat is refused, and a first one is not", async ({ http }) => {
  const { owner } = await seedCounted(HUMAN_USER_LIMIT);

  // A sixth person still joins as a Guest of one channel: that takes no place.
  const sixth = await person("sixth-guest");
  const first = await seedExternalInvite(owner, sixth);
  const accepted = await acceptAsGuest(http, sixth, first.token);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal(await roleIn(first.hostId, sixth.id), "guest");
  assert.equal(await countHumanUserAccounts(), HUMAN_USER_LIMIT);

  // Their second Guest seat would make them count.
  const second = await seedExternalInvite(owner, sixth);
  await assertLimitRefusal(await acceptAsGuest(http, sixth, second.token));
  assert.equal(await roleIn(second.hostId, sixth.id), null);
});

test("a retired account or one that left every server frees its place", async ({ http }) => {
  const { owner, others, home } = await seedCounted(HUMAN_USER_LIMIT);
  const sixth = await person("sixth");
  await assertLimitRefusal(await acceptJoinLink(http, home, owner, sixth));

  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, others[0]!.id));
  const joined = await acceptJoinLink(http, home, owner, sixth);
  assert.equal(joined.status, 200, await joined.clone().text());
  assert.equal(await roleIn(home.id, sixth.id), "member");

  const seventh = await person("seventh");
  await assertLimitRefusal(await acceptJoinLink(http, home, owner, seventh));
  await getDb().delete(serverMembers).where(eq(serverMembers.userId, others[1]!.id));
  const rejoined = await acceptJoinLink(http, home, owner, seventh);
  assert.equal(rejoined.status, 200, await rejoined.clone().text());
});

test("deleting a server frees the places of the people who were only there, for both rules", async ({ http }) => {
  const { owner, others, home } = await seedCounted(HUMAN_USER_LIMIT - 1);
  // The fifth person counts only through their own server.
  const loner = await person("loner");
  const lonely = await createServer("Lonely", `lonely-${randomUUID().slice(0, 8)}`, loner.id);
  assert.equal(await countHumanUserAccounts(), HUMAN_USER_LIMIT);
  const sixth = await person("sixth");
  await assertLimitRefusal(await acceptJoinLink(http, home, owner, sixth));

  await deleteServer(lonely.id, { deletedByUserId: loner.id });
  assert.equal(await countHumanUserAccounts(), HUMAN_USER_LIMIT - 1, "the deleted server's owner seat no longer counts");
  const joined = await acceptJoinLink(http, home, owner, sixth);
  assert.equal(joined.status, 200, await joined.clone().text());
  assert.equal(await countHumanUserAccounts(), HUMAN_USER_LIMIT);
  // The deleted server's owner seat does not make its owner someone who already counts.
  await assertLimitRefusal(await acceptJoinLink(http, home, owner, loner));

  // Two Guest seats, one of them in a deleted server: one seat, so no place.
  const guest = await person("two-seat-guest");
  const gone = await createServer("Gone", `gone-${randomUUID().slice(0, 8)}`, others[0]!.id);
  await seedBoundGuest({ serverId: gone.id, userId: guest.id });
  await deleteServer(gone.id, { deletedByUserId: others[0]!.id });
  const invite = await seedExternalInvite(owner, guest);
  const accepted = await acceptAsGuest(http, guest, invite.token);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal(await countHumanUserAccounts(), HUMAN_USER_LIMIT, "a live Guest seat plus a deleted one is one seat");
});

test("over the limit already: the people there keep working, nobody new is added", async ({ app, http }) => {
  const { owner, others, home } = await seedCounted(HUMAN_USER_LIMIT + 2);
  const elsewhere = await post(http, others[0]!, "/api/servers", { name: "Elsewhere", slug: `elsewhere-${randomUUID().slice(0, 8)}` });
  assert.equal(elsewhere.status, 200, await elsewhere.clone().text());
  const elsewhereServer = await elsewhere.json() as Server;
  const joined = await acceptJoinLink(http, elsewhereServer, others[0]!, others[1]!);
  assert.equal(joined.status, 200, await joined.clone().text());
  const promoted = await http.as(owner, home).request(`/api/servers/${home.id}/members/${others[2]!.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "admin" }),
  });
  assert.equal(promoted.status, 200, await promoted.clone().text());

  const newcomer = await person("newcomer");
  await assertLimitRefusal(await acceptJoinLink(http, home, owner, newcomer));
});

test("the cloud edition has no user limit", async ({ app, http }) => {
  const { owner, home } = await seedCounted(HUMAN_USER_LIMIT);
  edition.value = "cloud";
  const sixth = await person("sixth");
  const joined = await acceptJoinLink(http, home, owner, sixth);
  assert.equal(joined.status, 200, await joined.clone().text());

  const seventh = await person("seventh");
  const created = await post(http, seventh, "/api/servers", { name: "Seventh", slug: `seventh-${randomUUID().slice(0, 8)}` });
  assert.equal(created.status, 200, await created.clone().text());

  const community = await createServer("The Community", "community", owner.id);
  const eighth = await person("eighth");
  const communityJoin = await post(http, eighth, "/api/servers/join-community");
  assert.equal(communityJoin.status, 200, await communityJoin.clone().text());
  assert.equal(await roleIn(community.id, eighth.id), "member");

  const guest = await person("guest");
  await seedBoundGuest({ serverId: home.id, userId: guest.id });
  const patched = await http.as(owner, home).request(`/api/servers/${home.id}/members/${guest.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "member" }),
  });
  assert.equal(patched.status, 200, await patched.clone().text());

  const twoSeats = await person("two-seats");
  await seedBoundGuest({ serverId: home.id, userId: twoSeats.id });
  const invite = await seedExternalInvite(owner, twoSeats);
  const accepted = await acceptAsGuest(http, twoSeats, invite.token);
  assert.equal(accepted.status, 200, await accepted.clone().text());

  const { token } = await createJoinLink(home.id, owner.id);
  const info = await (await fetch(`${app.baseUrl}/api/auth/invite-info?token=${token}`)).json() as { deploymentUserLimitReached?: unknown };
  assert.equal(info.deploymentUserLimitReached, false);
  const providers = await (await fetch(`${app.baseUrl}/api/auth/providers`)).json() as { deploymentUserLimitReached?: unknown };
  assert.equal(providers.deploymentUserLimitReached, false);
});
