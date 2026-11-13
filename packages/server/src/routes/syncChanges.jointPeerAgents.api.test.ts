import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { ServerId, SyncChange, SyncChangesResponse } from "@botiverse/raft-shared";
import { apiTest } from "../test/integration/apiTest";
import { servers } from "../db/schema";
import { createAgent } from "../services/agentService";
import { acceptJointChannelInvite, addAgent, createJointChannel, disconnectJointChannel, removeAgent } from "../services/channelService";
import { parseSyncChangesCursor, readSyncChanges } from "../services/syncChanges";
import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";

type AgentRow = { id: string } & Record<string, unknown>;

// A joint roster lists every projection's agents, but the channel_agents
// trigger (0450) logs an agent's member row under its own server's
// projection. GET /api/sync/changes reads those rows for each other active
// projection of a joint the viewer sees and names them under the viewer's
// projection, so a peer server's agent syncs as GET /members lists it
// (redacted to its activity state, #14564).
apiTest("joint channel: another server's agent joining and leaving syncs as GET /members shows it", async ({ db, seed, http, app }) => {
  const ownerA = await seed.human(), ownerB = await seed.human();
  const a = await seed.server({ owner: ownerA, name: "Alpha" });
  const b = await seed.server({ owner: ownerB, name: "Bravo" });
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, a.id));
  const made = await createJointChannel({
    hostServerId: a.id,
    createdByUserId: ownerA.id,
    name: "peer-agents",
    jointInvites: [{ targetServerSlug: b.slug, invitedPeople: [`@${ownerB.name}`] }],
  });
  const inviteId = made.invites.find((invite) => invite.toServerId === b.id)!.id;
  const entryB = await acceptJointChannelInvite({ inviteId, targetServerId: b.id, acceptedByUserId: ownerB.id });
  await fillJointMembersFromChannelHumans([made.jointChannel.id]);
  const hostLocal = made.channel.id;

  const orchestrator = app.app.get("agentOrchestrator") as {
    getActivities: (rows: ReadonlyArray<{ id: string }>) => Promise<unknown[]>;
  };
  let activity = { activity: "working", activityDetail: "Drafting the Q3 acquisition memo", spawnFailure: { reason: "x", model: "secret-model-v9" } };
  orchestrator.getActivities = async (rows) => rows.map(() => ({ ...activity }));

  const sync = async (viewer: { id: string }, server: { id: string }, since?: string) => {
    const res = await http.as(viewer, server).get(`/api/sync/changes${since ? `?since=${encodeURIComponent(since)}` : ""}`);
    assert.equal(res.status, 200, await res.clone().text());
    return await res.json() as SyncChangesResponse;
  };
  const roster = async (viewer: { id: string }, server: { id: string }, channelId: string, agentId: string) => {
    const res = await http.as(viewer, server).get(`/api/channels/${channelId}/members`);
    assert.equal(res.status, 200, await res.clone().text());
    return ((await res.json()) as { agents: AgentRow[] }).agents.find((agent) => agent.id === agentId);
  };
  const memberChanges = (round: SyncChangesResponse) => round.changes.filter((c): c is SyncChange & { entity: "channel_member" } => c.entity === "channel_member");

  const hostAgent = await createAgent(a.id, "HostAgent", { runtime: "claude", model: "secret-model-v9" });
  const bravoAgent = await createAgent(b.id, "BravoAgent", { runtime: "claude" });
  let startA = await sync(ownerA, a);
  let startB = await sync(ownerB, b);

  // Added on the host: Bravo's pull carries the row /members shows Bravo.
  await addAgent(hostLocal, hostAgent.id);
  const listed = await roster(ownerB, b, entryB.id, hostAgent.id);
  assert.ok(listed, "Bravo's roster lists the host's agent");
  assert.equal(listed.activityDetail, "", "redacted to its state");
  let round = await sync(ownerB, b, startB.cursor);
  const added = memberChanges(round).find((c) => c.id === `${entryB.id}:agent:${hostAgent.id}`);
  assert.ok(added?.op === "upsert", JSON.stringify(round.changes.map((c) => [c.entity, c.id, c.op])));
  assert.deepEqual(added.row, listed, "/sync/changes and /members return the same row");
  assert.ok(!JSON.stringify(round).includes(hostLocal), "no change names the host's projection");
  assert.ok(!JSON.stringify(round).includes("secret-model-v9"));

  // The host's own view of its agent is unchanged (full activity, own projection id).
  round = await sync(ownerA, a, startA.cursor);
  const hostSide = memberChanges(round).find((c) => c.id === `${hostLocal}:agent:${hostAgent.id}`);
  assert.ok(hostSide?.op === "upsert");
  assert.deepEqual(hostSide.row, await roster(ownerA, a, hostLocal, hostAgent.id));
  assert.equal((hostSide.row as AgentRow).activityDetail, activity.activityDetail);
  assert.equal(memberChanges(round).length, 1, "only the host's own member row");

  // The other direction: Bravo's agent on Bravo's projection reaches the host.
  startA = await sync(ownerA, a);
  await addAgent(entryB.id, bravoAgent.id);
  round = await sync(ownerA, a, startA.cursor);
  const fromBravo = memberChanges(round).find((c) => c.id === `${hostLocal}:agent:${bravoAgent.id}`);
  assert.ok(fromBravo?.op === "upsert", JSON.stringify(round.changes.map((c) => [c.entity, c.id, c.op])));
  assert.deepEqual(fromBravo.row, await roster(ownerA, a, hostLocal, bravoAgent.id));

  // A rebuilt row carries the activity /members shows at that time.
  activity = { activity: "idle", activityDetail: "Reviewing the merger file", spawnFailure: { reason: "x", model: "secret-model-v9" } };
  startB = await sync(ownerB, b);
  await removeAgent(hostLocal, hostAgent.id);
  await addAgent(hostLocal, hostAgent.id);
  round = await sync(ownerB, b, startB.cursor);
  const readded = memberChanges(round).find((c) => c.id === `${entryB.id}:agent:${hostAgent.id}`);
  assert.ok(readded?.op === "upsert");
  assert.deepEqual(readded.row, await roster(ownerB, b, entryB.id, hostAgent.id));
  assert.equal((readded.row as AgentRow).activity, "idle");
  assert.equal((readded.row as AgentRow).activityDetail, "");

  // Removed on the host: a delete under Bravo's projection, as /members drops it.
  startB = await sync(ownerB, b);
  await removeAgent(hostLocal, hostAgent.id);
  assert.equal(await roster(ownerB, b, entryB.id, hostAgent.id), undefined);
  round = await sync(ownerB, b, startB.cursor);
  assert.deepEqual(
    memberChanges(round).map((c) => [c.id, c.op]),
    [[`${entryB.id}:agent:${hostAgent.id}`, "delete"]],
  );

  // Bravo disconnects: later host agent changes never reach Bravo.
  await disconnectJointChannel(entryB.id, ownerB.id);
  startB = await sync(ownerB, b);
  await addAgent(hostLocal, hostAgent.id);
  round = await sync(ownerB, b, startB.cursor);
  assert.equal(round.reset, null);
  assert.ok(!JSON.stringify(round).includes(hostAgent.id), JSON.stringify(round.changes.map((c) => [c.entity, c.id, c.op])));
  // Not even read: the route's access check would drop it, but the read
  // itself takes no peer rows for a joint whose projection on S is gone.
  const read = await readSyncChanges({ viewer: { userId: ownerB.id, serverId: b.id as ServerId, isGuest: false }, since: parseSyncChangesCursor(startB.cursor), limit: 100 });
  assert.ok(!JSON.stringify(read.changes).includes(hostAgent.id), JSON.stringify(read.changes));
});
