// Task #102 reachability reproduction (candidate read-state privacy leak; design owner Tenny).
//
// Question: can a former member of a private channel, who still owns a read cursor for it, learn the channel's live
// latest message seq through POST /api/read-mutations kind=channel_read_all?
//
// Invariant (Tenny's ruling): the boundary of any admitted residue scope is derived only from receiver-owned data and
// never from the channel's live state. This test asserts that invariant for the lost-access residue kind, so it is RED
// while the exposure exists. It is reproduction evidence, not a merge candidate on #102.
//
// The resolver is not exported, so the residue kind is pinned by preconditions checked immediately before admission:
// the channel is live (not deletedInboxResidue), it is the private channel itself rather than a thread
// (not unavailableThreadParentResidue), the receiver has no channel_humans row, and the receiver owns a read cursor.
import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { channelHumans, channels, serverMembers, userChannelReadCursors, users } from "../db/schema";
import { createMessage } from "../services/messageService";
import { claimNextReadMutation, executeReadMutationClaim } from "../services/readMutationSequencer";
import { createServer } from "../services/serverService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `residue-boundary-${label}-${randomUUID()}@test.invalid`,
    name: `Residue${label}${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

test("task #102: a former private-channel member with a receiver-owned cursor must not learn the channel's live latest seq via POST /api/read-mutations", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("owner");
  const former = await seedUser("former");
  const server = await createServer("Residue Boundary", `residue-boundary-${randomUUID()}`, owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: former.id, role: "member" });
  const [privateChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: `residue-private-${randomUUID().slice(0, 8)}`,
    type: "private",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: privateChannel.id, userId: owner.id, role: "admin" },
    { channelId: privateChannel.id, userId: former.id },
  ]);

  // While a member, the receiver reads up to the second message: that cursor is the receiver-owned residue.
  await createMessage(privateChannel.id, "user", owner.id, "before removal 1");
  const lastSeenWhileMember = await createMessage(privateChannel.id, "user", owner.id, "before removal 2");
  await db.insert(userChannelReadCursors).values({
    userId: former.id,
    channelId: privateChannel.id,
    lastReadSeq: Number(lastSeenWhileMember.seq),
  });

  // Removed from the private channel only; still a Server member, so requireServer and the principal check pass.
  await db.delete(channelHumans).where(and(eq(channelHumans.channelId, privateChannel.id), eq(channelHumans.userId, former.id)));

  // Activity after the removal: the channel's live max now differs from anything the receiver owns.
  await createMessage(privateChannel.id, "user", owner.id, "after removal 1");
  await createMessage(privateChannel.id, "user", owner.id, "after removal 2");
  await createMessage(privateChannel.id, "user", owner.id, "after removal 3");

  // Preconditions that pin the lost-access residue branch.
  const [channelRow] = await db.select({ deletedAt: channels.deletedAt, type: channels.type })
    .from(channels).where(eq(channels.id, privateChannel.id));
  assert.equal(channelRow?.deletedAt, null, "channel is live, so the scope is not deletedInboxResidue");
  assert.equal(channelRow?.type, "private", "the scope is the private channel itself, not a thread (not unavailableThreadParentResidue)");
  const membership = await db.select().from(channelHumans)
    .where(and(eq(channelHumans.channelId, privateChannel.id), eq(channelHumans.userId, former.id)));
  assert.equal(membership.length, 0, "the receiver is no longer a channel participant");
  const [cursor] = await db.select({ lastReadSeq: userChannelReadCursors.lastReadSeq }).from(userChannelReadCursors)
    .where(and(eq(userChannelReadCursors.userId, former.id), eq(userChannelReadCursors.channelId, privateChannel.id)));
  assert.ok(cursor, "the receiver owns a read cursor (lost-access residue evidence)");
  const receiverOwnedMax = cursor.lastReadSeq;
  const liveMaxResult = await db.execute(sql`SELECT COALESCE(MAX(seq), 0)::int AS "liveMax" FROM messages WHERE channel_id = ${privateChannel.id}`);
  const liveMax = Number((liveMaxResult.rows[0] as { liveMax: unknown }).liveMax);
  assert.ok(liveMax > receiverOwnedMax, `live max (${liveMax}) must exceed the receiver-owned max (${receiverOwnedMax}) for the test to be informative`);

  const token = await login(app.baseUrl, former.email);
  const headers = { Authorization: `Bearer ${token}`, "X-Server-Id": server.id, "Content-Type": "application/json" };
  const mutationId = randomUUID();

  const admission = await fetch(`${app.baseUrl}/api/read-mutations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mutationId, kind: "channel_read_all", scopeId: privateChannel.id }),
  });
  const admissionText = await admission.text();
  console.log(`[task102] admission status=${admission.status} body=${admissionText}`);
  assert.equal(admission.status, 201, "reachability: the lost-access receiver is admitted through the read-mutations route");

  const claim = await claimNextReadMutation({ serverId: server.id, principalId: former.id, leaseOwner: "task102-repro", leaseMs: 60_000 });
  assert.ok(claim, "the admitted mutation is claimable");
  await executeReadMutationClaim({ claim });

  const replay = await fetch(`${app.baseUrl}/api/read-mutations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mutationId, kind: "channel_read_all", scopeId: privateChannel.id }),
  });
  const replayBody = await replay.json() as {
    outcome: string;
    ack: null | { terminalReason: string; capturedBoundary: Array<{ scopeId: string; throughSeq: number | string }>; scopes: Array<{ scopeId: string; maxReadSeq: number }> };
  };
  console.log(`[task102] replay status=${replay.status} body=${JSON.stringify(replayBody)}`);
  assert.equal(replay.status, 200);
  assert.equal(replayBody.outcome, "ALREADY_TERMINAL");
  assert.ok(replayBody.ack, "the replay returns the stored ack");

  const frontier = await fetch(`${app.baseUrl}/api/read-mutations/frontier?scopeIds=${privateChannel.id}`, { headers });
  const frontierBody = await frontier.json() as { scopes?: Array<{ scopeId: string; maxReadSeq: number }> };
  console.log(`[task102] frontier status=${frontier.status} scopes=${JSON.stringify(frontierBody.scopes)}`);

  const boundarySeq = Number(replayBody.ack.capturedBoundary[0]?.throughSeq ?? 0);
  const ackMaxReadSeq = replayBody.ack.scopes[0]?.maxReadSeq ?? 0;
  const frontierMaxReadSeq = frontierBody.scopes?.find((scope) => scope.scopeId === privateChannel.id)?.maxReadSeq ?? 0;
  console.log(`[task102] receiverOwnedMax=${receiverOwnedMax} liveMax=${liveMax} ackBoundary=${boundarySeq} ackMaxReadSeq=${ackMaxReadSeq} frontierMaxReadSeq=${frontierMaxReadSeq}`);

  // The invariant: nothing returned to the former member may exceed what the receiver already owned.
  assert.ok(boundarySeq <= receiverOwnedMax, `ack capturedBoundary.throughSeq ${boundarySeq} exceeds the receiver-owned max ${receiverOwnedMax} (live max ${liveMax})`);
  assert.ok(ackMaxReadSeq <= receiverOwnedMax, `ack scopes[].maxReadSeq ${ackMaxReadSeq} exceeds the receiver-owned max ${receiverOwnedMax} (live max ${liveMax})`);
  assert.ok(frontierMaxReadSeq <= receiverOwnedMax, `frontier scopes[].maxReadSeq ${frontierMaxReadSeq} exceeds the receiver-owned max ${receiverOwnedMax} (live max ${liveMax})`);
});
