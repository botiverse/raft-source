import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { dbTest } from "../test/integration/dbTest";
import { apiTest } from "../test/integration/apiTest";
import { jointHumanReadFixture as fixture } from "../test/jointHumanReadFixture";
import {
  channelHumans, jointChannelMembers,
  jointChannelServers, jointMembershipDepartures, jointMembershipRemovals,
  messages, serverMembers, servers, userChannelReadCursors,
} from "../db/schema";
import {
  admitReadMutation, claimNextReadMutation, executeCompatibilityReadMutation,
  executeReadMutationClaim, getReadMutationFrontier, ReadMutationError,
  resolveReadMutationUnreadBoundary,
} from "./readMutationSequencer";


apiTest("a computed member without local CH can POST /read from the new server entry", async ({ db, seed, http }) => {
  const x = await fixture({ db, seed });
  const response = await http.as(x.peer, x.b).request(`/api/channels/${x.target.id}/read`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seq: 10 }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).maxReadSeq, 10);
  assert.equal((await db.select().from(channelHumans).where(and(
    eq(channelHumans.channelId, x.target.id), eq(channelHumans.userId, x.peer.id),
  ))).length, 0, "reading does not manufacture a legacy join or source");
});

dbTest("computed joint read authority covers root, thread, task, bulk and frontier recovery", async ({ db, seed }) => {
  const x = await fixture({ db, seed });
  for (const scopeId of [x.target.id, ...x.children.map((child) => child.local.id)]) {
    const ack = await x.run({ kind: "row_read", scopeId, throughSeq: 1 });
    assert.equal(ack.scopes[0]?.maxReadSeq, 1);
    assert.ok((await resolveReadMutationUnreadBoundary({ serverId: x.b.id, principalId: x.peer.id, scopeId })).throughSeq > 1);
    const latest = await x.run({ kind: "channel_read_all", scopeId });
    assert.ok(latest.scopes[0]!.maxReadSeq >= 10);
  }
  const conversation = await x.run({ kind: "conversation_read_all", scopeId: x.target.id });
  assert.deepEqual(new Set(conversation.scopes.map((scope) => scope.scopeId)), new Set([x.target.id, x.children[0]!.local.id]));
  const all = await x.run({ kind: "global_read_all" });
  for (const scopeId of [x.target.id, ...x.children.map((child) => child.local.id)]) {
    assert.ok(all.scopes.some((scope) => scope.scopeId === scopeId), "all read includes computed entries and followed children");
  }
  const frontier = await getReadMutationFrontier({ serverId: x.b.id, principalId: x.peer.id, scopeIds: [x.target.id] });
  assert.equal(frontier.scopes[0]?.maxReadSeq, 10);
  assert.equal((await db.select().from(userChannelReadCursors).where(eq(userChannelReadCursors.channelId, x.joint.jointChannel.canonicalChannelId))).length, 0,
    "canonical message storage is not a cursor entry");
});

dbTest("computed root can be marked unread for both counted content and own-only content", async ({ db, seed }) => {
  const x = await fixture({ db, seed });
  await x.run({ kind: "row_read", scopeId: x.target.id, throughSeq: 10 });
  const counted = await x.run({ kind: "row_unread", scopeId: x.target.id, throughSeq: 9 });
  assert.equal(counted.scopes[0]?.unreadOutcome, "counted");
  await db.update(messages).set({ senderId: x.peer.id }).where(eq(messages.channelId, x.joint.jointChannel.canonicalChannelId));
  await x.run({ kind: "row_read", scopeId: x.target.id, throughSeq: 10 });
  const marked = await x.run({ kind: "row_unread", scopeId: x.target.id, throughSeq: 0 });
  assert.equal(marked.scopes[0]?.unreadOutcome, "marked");
  assert.equal(marked.scopes[0]?.markedUnread, true);
});

for (const revocation of ["joint_member", "server_member", "guest", "disconnect", "deleted_server", "pending_removal"] as const) {
  dbTest(`queued computed read loses live authority after ${revocation}, even with stale CH`, async ({ db, seed }) => {
    const x = await fixture({ db, seed });
    const scopeId = x.target.id;
    await db.insert(channelHumans).values({ channelId: scopeId, userId: x.peer.id });
    await admitReadMutation({ serverId: x.b.id, principalId: x.peer.id, mutationId: randomUUID(), mutation: { kind: "row_read", scopeId, throughSeq: 10 } });
    if (revocation === "joint_member") await db.delete(jointChannelMembers).where(and(eq(jointChannelMembers.jointChannelId, x.joint.jointChannel.id), eq(jointChannelMembers.userId, x.peer.id)));
    if (revocation === "server_member") await db.delete(serverMembers).where(and(eq(serverMembers.serverId, x.b.id), eq(serverMembers.userId, x.peer.id)));
    if (revocation === "guest") await db.update(serverMembers).set({ role: "guest", guestChannelId: scopeId }).where(and(eq(serverMembers.serverId, x.b.id), eq(serverMembers.userId, x.peer.id)));
    if (revocation === "disconnect") await db.update(jointChannelServers).set({ status: "disconnected" }).where(eq(jointChannelServers.localChannelId, scopeId));
    if (revocation === "deleted_server") await db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, x.b.id));
    if (revocation === "pending_removal") {
      const [departure] = await db.insert(jointMembershipDepartures).values({ jointChannelId: x.joint.jointChannel.id, serverId: x.b.id, localChannelId: scopeId }).returning();
      await db.insert(jointMembershipRemovals).values({ departureId: departure.id, userId: x.peer.id, removeMembership: true });
    }
    const claim = await claimNextReadMutation({ serverId: x.b.id, principalId: x.peer.id, leaseOwner: "joint-auth-test" });
    assert.ok(claim);
    const ack = await executeReadMutationClaim({ claim });
    assert.equal(ack.terminalReason, "authorization_revoked");
    assert.deepEqual(ack.scopes, []);
    assert.equal((await db.select().from(userChannelReadCursors).where(and(eq(userChannelReadCursors.channelId, scopeId), eq(userChannelReadCursors.userId, x.peer.id)))).length, 0);
  });
}

dbTest("wrong-server or storage inputs cannot borrow computed membership", async ({ db, seed }) => {
  const x = await fixture({ db, seed });
  const rejectsScope = (serverId: string, scopeId: string) => assert.rejects(
    admitReadMutation({ serverId, principalId: x.peer.id, mutationId: randomUUID(), mutation: { kind: "row_read", scopeId, throughSeq: 10 } }),
    (error: unknown) => error instanceof ReadMutationError && error.code === "SCOPE_NOT_FOUND",
  );
  await rejectsScope(x.a.id, x.target.id);
  await rejectsScope(x.a.id, x.joint.jointChannel.canonicalChannelId);
});
