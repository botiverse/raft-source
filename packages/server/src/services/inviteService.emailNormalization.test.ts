import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { serverInvites, serverMembers, servers, users } from "../db/schema.js";
import { acceptInvite, createInvite } from "./inviteService.js";


afterEach(async () => {
  await closeTestDatabase();
});

test("createInvite canonicalizes email and dedupes case-insensitively", async ({ db: database }) => {

  const db = getDb();

  const [owner] = await db.insert(users).values({
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    email: "owner@example.com",
    name: "owner",
    displayName: "owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();

  const [server] = await db.insert(servers).values({
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    name: "Acme",
    slug: "acme-email-case",
    ownerId: owner.id,
  }).returning();

  const created = await createInvite(server.id, "Invitee@Example.COM", owner.id);
  assert.equal(created.invitedEmail, "invitee@example.com");

  const [stored] = await db
    .select({ invitedEmail: serverInvites.invitedEmail })
    .from(serverInvites);
  assert.equal(stored?.invitedEmail, "invitee@example.com");

  await assert.rejects(
    createInvite(server.id, "INVITEE@example.com", owner.id),
    /already been sent/i,
  );
});

test("createInvite rejects malformed email addresses before storing an invite", async ({ db: database }) => {

  const db = getDb();

  const [owner] = await db.insert(users).values({
    id: "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1",
    email: "owner-invalid-invite@example.com",
    name: "ownerinvalidinvite",
    displayName: "ownerinvalidinvite",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();

  const [server] = await db.insert(servers).values({
    id: "b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1",
    name: "Acme Invalid Invite",
    slug: "acme-invalid-invite",
    ownerId: owner.id,
  }).returning();

  await assert.rejects(
    createInvite(server.id, "not-an-email", owner.id),
    /valid email address/i,
  );

  const rows = await db.select({ id: serverInvites.id }).from(serverInvites);
  assert.deepEqual(rows, []);
});

test("createInvite detects existing member after input normalization", async ({ db: database }) => {

  const db = getDb();

  const [owner] = await db.insert(users).values({
    id: "f4f4f4f4-f4f4-f4f4-f4f4-f4f4f4f4f4f4",
    email: "owner-member-check@example.com",
    name: "ownermembercheck",
    displayName: "ownermembercheck",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();

  const [member] = await db.insert(users).values({
    id: "f5f5f5f5-f5f5-f5f5-f5f5-f5f5f5f5f5f5",
    email: "existingmember@example.com",
    name: "existingmember",
    displayName: "existingmember",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();

  const [server] = await db.insert(servers).values({
    id: "f6f6f6f6-f6f6-f6f6-f6f6-f6f6f6f6f6f6",
    name: "Acme Existing Member",
    slug: "acme-existing-member",
    ownerId: owner.id,
  }).returning();

  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);

  await assert.rejects(
    createInvite(server.id, "ExistingMember@Example.COM", owner.id),
    /already a member/i,
  );
});

test("acceptInvite compares invite email case-insensitively for legacy mixed-case rows", async ({ db: database }) => {

  const db = getDb();

  const [owner] = await db.insert(users).values({
    id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    email: "owner2@example.com",
    name: "owner2",
    displayName: "owner2",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();

  const [invitee] = await db.insert(users).values({
    id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    email: "invitee@example.com",
    name: "invitee",
    displayName: "invitee",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();

  const [server] = await db.insert(servers).values({
    id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
    name: "Acme Legacy",
    slug: "acme-legacy-invite",
    ownerId: owner.id,
  }).returning();

  const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const tokenHash = createHash("sha256").update(token).digest("hex");

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const [invite] = await db.insert(serverInvites).values({
    serverId: server.id,
    invitedByUserId: owner.id,
    invitedEmail: "Invitee@Example.COM",
    tokenHash,
    status: "pending",
    expiresAt,
  }).returning();

  const result = await acceptInvite(token, invitee.id);
  assert.equal(result.serverId, server.id);
  assert.equal(result.serverName, server.name);

  const [memberRow] = await db
    .select()
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, invitee.id)));
  assert.ok(memberRow);

  const [updatedInvite] = await db
    .select({ status: serverInvites.status })
    .from(serverInvites)
    .where(eq(serverInvites.id, invite.id));
  assert.equal(updatedInvite?.status, "accepted");
});

// Provenance: task #69. Storing the invited role is only half of it — accepting
// has to honour it. Before this, acceptInvite passed a hardcoded "member", so a
// Guest invite would have produced a full member and nothing would have said so.
test("acceptInvite grants the role stored on the invite, not a hardcoded member", async ({ db: database }) => {
  const db = getDb();

  const mk = async (id: string, email: string, name: string) => (await db.insert(users).values({
    id, email, name, displayName: name, passwordHash: "hash", emailVerified: true,
  }).returning())[0];

  const owner = await mk("11111111-2222-3333-4444-555555555555", "role-owner@example.com", "role-owner");
  const guestInvitee = await mk("22222222-3333-4444-5555-666666666666", "role-guest@example.com", "role-guest");
  const memberInvitee = await mk("33333333-4444-5555-6666-777777777777", "role-member@example.com", "role-member");
  const legacyInvitee = await mk("55555555-6666-7777-8888-999999999999", "role-legacy@example.com", "role-legacy");

  const [server] = await db.insert(servers).values({
    id: "44444444-5555-6666-7777-888888888888",
    name: "Acme Invite Role",
    slug: "acme-invite-role",
    ownerId: owner.id,
  }).returning();

  const accept = async (token: string, invitee: { id: string; email: string }, role?: "member" | "guest") => {
    await db.insert(serverInvites).values({
      serverId: server.id,
      invitedByUserId: owner.id,
      invitedEmail: invitee.email,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      status: "pending",
      // Omitting the key entirely is the legacy-row shape: rows written before
      // this column existed carry the schema default, not an explicit choice.
      ...(role === undefined ? {} : { role }),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await acceptInvite(token, invitee.id);
    const [row] = await db
      .select({ role: serverMembers.role })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, invitee.id)));
    return row?.role;
  };

  assert.equal(
    await accept("a".repeat(64), guestInvitee, "guest"),
    "guest",
    "a Guest invite must produce a Guest, or the inviter gave away more access than they chose",
  );
  assert.equal(
    await accept("b".repeat(64), memberInvitee, "member"),
    "member",
    "a member invite must still produce a member",
  );
  assert.equal(
    await accept("c".repeat(64), legacyInvitee),
    "member",
    "an invite carrying no role at all (every row written before this column) must still "
      + "produce a member; if the default ever moves, existing pending invites would silently "
      + "start granting a different level of access than the inviter chose",
  );
});
