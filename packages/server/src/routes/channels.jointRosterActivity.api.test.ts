import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { SyncChangesResponse } from "@botiverse/raft-shared";
import { apiTest } from "../test/integration/apiTest";
import { servers } from "../db/schema";
import { createAgent } from "../services/agentService";
import { acceptJointChannelInvite, addAgent, createJointChannel } from "../services/channelService";
import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";

type AgentRow = { id: string } & Record<string, unknown>;
type Roster = { agents: AgentRow[] };

// A joint roster lists every server's agents; another server's agent shows
// its state only, as the joint projection rooms' `agent:activity` push does
// (`detail: ""`): never its work summary or typed diagnostics.
apiTest("joint roster: another server's agent shows its activity only, on /members and /sync/changes", async ({ db, seed, http, app }) => {
  const ownerA = await seed.human(), ownerB = await seed.human();
  const a = await seed.server({ owner: ownerA, name: "Alpha" });
  const b = await seed.server({ owner: ownerB, name: "Bravo" });
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, a.id));
  const made = await createJointChannel({
    hostServerId: a.id,
    createdByUserId: ownerA.id,
    name: "roster-activity",
    jointInvites: [{ targetServerSlug: b.slug, invitedPeople: [`@${ownerB.name}`] }],
  });
  const inviteId = made.invites.find((invite) => invite.toServerId === b.id)!.id;
  const entryB = await acceptJointChannelInvite({ inviteId, targetServerId: b.id, acceptedByUserId: ownerB.id });
  await fillJointMembersFromChannelHumans([made.jointChannel.id]);

  const full = {
    activity: "working",
    activityDetail: "Drafting the Q3 acquisition memo",
    activityDetailKind: "runtime_unavailable",
    spawnFailure: { reason: "model_unavailable", model: "secret-model-v9" },
    toolStuck: { toolName: "private_tool", sinceMs: 1 },
    credentialHold: { reason: "credential_missing" },
    deliveryConsumption: { pending: 3 },
    wakeCrashLoop: { blockedUntil: "2026-11-12T00:00:00.000Z" },
  };
  const orchestrator = app.app.get("agentOrchestrator") as {
    getActivities: (rows: ReadonlyArray<{ id: string }>) => Promise<unknown[]>;
  };
  orchestrator.getActivities = async (rows) => rows.map(() => ({ ...full }));

  const sync = async (viewer: { id: string }, server: { id: string }, since?: string) => {
    const res = await http.as(viewer, server).get(`/api/sync/changes${since ? `?since=${encodeURIComponent(since)}` : ""}`);
    assert.equal(res.status, 200, await res.clone().text());
    return await res.json() as SyncChangesResponse;
  };
  const startA = await sync(ownerA, a);
  const startB = await sync(ownerB, b);

  const alphaAgent = await createAgent(a.id, "AlphaAgent", { runtime: "claude", model: "secret-model-v9" });
  await addAgent(made.channel.id, alphaAgent.id);

  const roster = async (viewer: { id: string }, server: { id: string }, channelId: string) => {
    const res = await http.as(viewer, server).get(`/api/channels/${channelId}/members`);
    assert.equal(res.status, 200, await res.clone().text());
    const row = ((await res.json()) as Roster).agents.find((agent) => agent.id === alphaAgent.id);
    assert.ok(row, "the host's agent is listed");
    return row;
  };
  const synced = async (viewer: { id: string }, server: { id: string }, channelId: string, since: string) => {
    const round = await sync(viewer, server, since);
    const change = round.changes.find((c) => c.entity === "channel_member" && c.id === `${channelId}:agent:${alphaAgent.id}`);
    assert.ok(change?.op === "upsert", `the agent's member row is synced: ${JSON.stringify(round.changes.map((c) => c.id))}`);
    return change.row as AgentRow;
  };
  const diagnostics = ["activityDetailKind", "spawnFailure", "toolStuck", "credentialHold", "deliveryConsumption", "wakeCrashLoop", "activityErrorCode"] as const;

  // The host server's viewer: its own agent, everything as before.
  for (const row of [await roster(ownerA, a, made.channel.id), await synced(ownerA, a, made.channel.id, startA.cursor)]) {
    assert.equal(row.activity, "working");
    assert.equal(row.activityDetail, full.activityDetail);
    assert.deepEqual(row.spawnFailure, full.spawnFailure);
    assert.deepEqual(row.toolStuck, full.toolStuck);
    assert.deepEqual(row.credentialHold, full.credentialHold);
    assert.deepEqual(row.deliveryConsumption, full.deliveryConsumption);
    assert.deepEqual(row.wakeCrashLoop, full.wakeCrashLoop);
    assert.equal(row.activityDetailKind, full.activityDetailKind);
  }

  // The agent's row is logged under its own (host) projection; Bravo's pull
  // reads it as a peer projection's agent row, under Bravo's projection.
  // The other server's viewer: the state, no detail, no diagnostics.
  for (const row of [await roster(ownerB, b, entryB.id), await synced(ownerB, b, entryB.id, startB.cursor)]) {
    assert.equal(row.activity, "working");
    assert.equal(row.activityDetail, "");
    for (const key of diagnostics) assert.equal(key in row, false, `${key} is not shown to another server`);
    assert.ok(!JSON.stringify(row).includes("secret-model-v9"), "the agent's model is not shown to another server");
    assert.ok(!JSON.stringify(row).includes("private_tool"));
  }
});
