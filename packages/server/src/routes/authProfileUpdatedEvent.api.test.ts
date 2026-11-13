// A person's avatar or name change reaches other viewers live and small: the
// viewers who may see the person in a server's member list hear
// `user:profile-updated` with only the public profile, and patch that one
// member in place. No `server:member-updated` (that reloads the whole member
// list on every client). A hidden human directory, or a Guest person, is
// announced only to the server's owners and admins and the person (#triage:#26).
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { serverMembers, servers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { installFakeIo } from "./channels.api.fixtures";
import { seedBoundGuest } from "../test/guestFixture";

const test = createApiTest();

const ONE_BY_ONE_GIF = Buffer.from("R0lGODdhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");

async function seedUser(name: string) {
  const [user] = await getDb().insert(users).values({
    email: `${name}@slock.test`,
    name,
    passwordHash: "x",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

/**
 * The person owns `owned` and is a member of `joined` (both with a visible
 * directory), a member of `hidden` (directory hidden from members), and a
 * Guest in `guested`. `elsewhere` they are not in. `owner` owns the rest;
 * `admin` is an admin and `member` an ordinary member of `hidden` and `guested`.
 */
async function seed(slug: string) {
  const person = await seedUser(`${slug}-person`);
  const owner = await seedUser(`${slug}-owner`);
  const admin = await seedUser(`${slug}-admin`);
  const member = await seedUser(`${slug}-member`);
  const owned = await createServer("Owned", `${slug}-owned`, person.id);
  const joined = await createServer("Joined", `${slug}-joined`, owner.id);
  const hidden = await createServer("Hidden", `${slug}-hidden`, owner.id);
  const guested = await createServer("Guested", `${slug}-guested`, owner.id);
  const elsewhere = await createServer("Elsewhere", `${slug}-elsewhere`, owner.id);
  await getDb().update(servers).set({ hideHumansFromMembers: true }).where(eq(servers.id, hidden.id));
  await getDb().insert(serverMembers).values([
    { serverId: joined.id, userId: person.id, role: "member" },
    { serverId: hidden.id, userId: person.id, role: "member" },
    { serverId: hidden.id, userId: admin.id, role: "admin" },
    { serverId: hidden.id, userId: member.id, role: "member" },
    { serverId: guested.id, userId: admin.id, role: "admin" },
    { serverId: guested.id, userId: member.id, role: "member" },
  ]);
  // A Guest's own channel, with no one else in it: no co-member to hear the change.
  await seedBoundGuest({ serverId: guested.id, userId: person.id });
  return { person, owner, admin, member, owned, joined, hidden, guested, elsewhere };
}

type Emitted = { room: string; event: string; payload: unknown };
type Seeded = Awaited<ReturnType<typeof seed>>;

function sorted(entries: { room: string; payload: unknown }[]) {
  return [...entries].sort((a, b) => a.room.localeCompare(b.room));
}

function profileUpdates(events: Emitted[]) {
  return sorted(events.filter((entry) => entry.event === "user:profile-updated").map(({ room, payload }) => ({ room, payload })));
}

/** Exactly who must hear the change, with exactly the public profile. */
function expected(seeded: Seeded, profile: { name: string; displayName: string | null; avatarUrl: string | null }) {
  const { person, owner, admin, owned, joined, hidden, guested } = seeded;
  const payload = (serverId: string) => ({
    serverId,
    userId: person.id,
    name: profile.name,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    // Deprecated and always empty, but present: released web/desktop bundles
    // parse this event strictly and require the key.
    gravatarHash: "",
  });
  const perViewer = (serverId: string, viewers: { id: string }[]) =>
    viewers.map((viewer) => ({ room: `user:${viewer.id}:server:${serverId}`, payload: payload(serverId) }));
  return sorted([
    // Visible directory: the server room.
    { room: `server:${owned.id}`, payload: payload(owned.id) },
    { room: `server:${joined.id}`, payload: payload(joined.id) },
    // Hidden directory, or a Guest person: owners, admins and the person only.
    ...perViewer(hidden.id, [person, owner, admin]),
    ...perViewer(guested.id, [person, owner, admin]),
  ]);
}

function assertNoOtherAnnouncements(events: Emitted[], seeded: Seeded) {
  const { member, hidden, guested, elsewhere } = seeded;
  assert.deepEqual(events.filter((entry) => entry.event === "server:member-updated"), [], "no member-list reload event");
  for (const entry of events) {
    assert.notEqual(entry.room, `server:${hidden.id}`, "a hidden directory's room hears nothing");
    assert.notEqual(entry.room, `server:${guested.id}`, "a Guest's server room hears nothing");
    assert.ok(!entry.room.startsWith(`user:${member.id}:`), `an ordinary member hears nothing: ${entry.room}`);
    assert.ok(!entry.room.includes(elsewhere.id), "a server the person is not in hears nothing");
  }
}

test("uploading an avatar sends user:profile-updated to the viewers who may see the person, and nobody else", async ({ app, http }) => {
  const events = installFakeIo(app.app);
  const seeded = await seed("avatar-upload-announce");
  const form = new FormData();
  form.set("avatar", new Blob([ONE_BY_ONE_GIF], { type: "image/gif" }), "avatar.gif");

  const res = await http.as(seeded.person).request("/api/auth/me/avatar", { method: "POST", body: form });
  assert.equal(res.status, 200);
  const { avatarUrl } = await res.json() as { avatarUrl: string };

  assert.deepEqual(profileUpdates(events), expected(seeded, { name: seeded.person.name, displayName: null, avatarUrl }));
  assertNoOtherAnnouncements(events, seeded);
});

test("resetting the avatar or renaming sends user:profile-updated; a private setting sends nothing", async ({ app, http }) => {
  const events = installFakeIo(app.app);
  const seeded = await seed("avatar-reset-announce");
  const patch = (body: unknown) => http.as(seeded.person).request("/api/auth/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal((await patch({ avatarUrl: null })).status, 200);
  assert.deepEqual(profileUpdates(events), expected(seeded, { name: seeded.person.name, displayName: null, avatarUrl: null }), "an avatar reset");
  assertNoOtherAnnouncements(events, seeded);

  events.length = 0;
  assert.equal((await patch({ displayName: "New Name" })).status, 200);
  assert.deepEqual(profileUpdates(events), expected(seeded, { name: seeded.person.name, displayName: "New Name", avatarUrl: null }), "a new display name");
  assertNoOtherAnnouncements(events, seeded);

  events.length = 0;
  assert.equal((await patch({ preferredTimeFormat: "24h" })).status, 200);
  assert.deepEqual(profileUpdates(events), []);
});
