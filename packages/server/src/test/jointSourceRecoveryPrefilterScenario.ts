import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../db";
import { channelExternalInvites, channelHumans, featureFlagRules, featureFlags, jointChannelAdmissions, jointChannelInvites,
  jointChannelMembers, jointMembershipGenerations } from "../db/schema";
import { addMember } from "../services/serverService";
import { connected } from "./jointHumanMembershipScenarios";
import { createSeed } from "./integration/seed";
import { RECOVERY_PREFILTER_BATCH, runJointSourceRecoveryPlan, runJointSourceRecoveryPrefilter } from "../../scripts/joint-human-membership-ops";

type Fixture = { db: Database; seed: ReturnType<typeof createSeed> };

/** Every active joint in the database: the prefilter keeps each joint whose
 * recovery plan has an occurrence (superset), checked batch by batch. */
export async function assertRecoveryPrefilterSuperset(db: Database) {
  const ids = (await db.execute<{ id: string }>(sql`SELECT id FROM joint_channels WHERE status='active' ORDER BY id`)).rows.map(row => row.id);
  const occurrences = new Map<string, number>();
  for (let i = 0; i < ids.length; i += RECOVERY_PREFILTER_BATCH) {
    const batch = ids.slice(i, i + RECOVERY_PREFILTER_BATCH);
    const candidates = new Set((await runJointSourceRecoveryPrefilter(db, batch)).candidates);
    for (const id of batch) {
      const plan = await runJointSourceRecoveryPlan(db, id);
      const count = plan.planned ? plan.plan.occurrences.length : 0;
      occurrences.set(id, count);
      if (count > 0) assert.ok(candidates.has(id), `prefilter dropped joint ${id} with ${count} occurrence(s)`);
    }
  }
  return occurrences;
}

/** Fixtures for each way a joint gets a recovery occurrence (R1, R4 computed_ch,
 * R4 invite_evidence from a joint invite and from an external invite) and a
 * clean joint (live sources, an ended tuple beside CH evidence), which must be
 * skipped. */
export async function jointSourceRecoveryPrefilterScenario(f: Fixture) {
  const { db, seed } = f;
  // Each host gets a server allow rule of the retired joint_human_membership_v1
  // flag, read only as history: it bounds when the host's CH rows stopped
  // being sources (computed_pre_flag_ch).
  const clean = await connected(f), r1 = await connected(f), r4ch = await connected(f), r4inv = await connected(f),
    r4ext = await connected(f), preFlag = await connected(f);
  const preFlagJoinedAt = new Date(Date.now() - 86_400_000);
  await db.insert(featureFlags).values({ key: "joint_human_membership_v1", enabled: true, defaultEnabled: false,
    randomizationUnit: "server", salt: "source-recovery-prefilter" })
    .onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true, killSwitch: false } });
  for (const x of [clean, r1, r4ch, r4inv, r4ext, preFlag])
    await db.insert(featureFlagRules).values({ flagKey: "joint_human_membership_v1", stage: "server", decision: "allow", values: [x.a.id] });

  type Joint = typeof clean;
  const id = (x: Joint) => x.joint.jointChannel.id;
  /** A current member (generation 1) of J who is a member of the given servers. */
  const person = async (x: Joint, servers: string[], liveOn: string[] = []) => {
    const human = await seed.human();
    for (const serverId of servers) await addMember(serverId, human.id);
    await db.insert(jointChannelMembers).values({ jointChannelId: id(x), userId: human.id, generation: 1 });
    await db.insert(jointMembershipGenerations).values({ jointChannelId: id(x), principalKind: "user", principalId: human.id, lastGeneration: 1 });
    for (const serverId of liveOn) await db.insert(jointChannelAdmissions).values({ jointChannelId: id(x), userId: human.id, serverId, generation: 1 });
    return human.id;
  };
  // clean: live on A, a CH row on B whose current-generation B admission is ended (category ended, no trace).
  const endedB = await person(clean, [clean.a.id, clean.b.id], [clean.a.id]);
  await db.insert(channelHumans).values({ channelId: clean.target.id, userId: endedB });
  await db.insert(jointChannelAdmissions).values({ jointChannelId: id(clean), userId: endedB, serverId: clean.b.id, generation: 1, endedAt: new Date() });
  // R1: a member with no admission at all.
  await person(r1, [r1.a.id]);
  // R4 computed_ch: live on A, CH on B (after the host's rule), no B admission.
  const chB = await person(r4ch, [r4ch.a.id, r4ch.b.id], [r4ch.a.id]);
  await db.insert(channelHumans).values({ channelId: r4ch.target.id, userId: chB });
  // R4 invite_evidence: live on A, an accepted same_admin joint invite A -> B.
  const invB = await person(r4inv, [r4inv.a.id, r4inv.b.id], [r4inv.a.id]);
  await db.insert(jointChannelInvites).values({ jointChannelId: id(r4inv), fromServerId: r4inv.a.id, toServerId: r4inv.b.id,
    invitedUserId: invB, acceptedByUserId: invB, status: "accepted", acceptedVia: "same_admin", acceptedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000) });
  // R4 invite_evidence: live on A, an external invite of A's channel that connected B.
  const extB = await person(r4ext, [r4ext.a.id, r4ext.b.id], [r4ext.a.id]);
  await db.insert(channelExternalInvites).values({ channelId: r4ext.joint.channel.id, hostServerId: r4ext.a.id,
    email: `${randomUUID()}@test.invalid`, tokenHash: randomUUID(), status: "accepted", outcome: "server",
    acceptedUserId: extB, acceptedServerId: r4ext.b.id, connectedServerIds: [r4ext.b.id],
    expiresAt: new Date(Date.now() + 86_400_000), decidedAt: new Date() });
  // Wider on purpose: a pre-flag CH row is no trace, but the prefilter keeps the joint.
  const preB = await person(preFlag, [preFlag.a.id, preFlag.b.id], [preFlag.a.id]);
  await db.insert(channelHumans).values({ channelId: preFlag.target.id, userId: preB, joinedAt: preFlagJoinedAt });

  const all = { clean, r1, r4ch, r4inv, r4ext, preFlag };
  const name = new Map(Object.entries(all).map(([key, x]) => [id(x), key]));
  const plans: Record<string, Awaited<ReturnType<typeof runJointSourceRecoveryPlan>>> = {};
  for (const [key, x] of Object.entries(all)) plans[key] = await runJointSourceRecoveryPlan(db, id(x));
  const shape = (key: keyof typeof all) => {
    const plan = plans[key]!;
    return plan.planned ? plan.plan.occurrences.map(row => row.traces.map(trace => trace.category).join(",") || "no_live_source").sort() : [`not_planned_${plan.status}`];
  };
  // The fixtures exercise the branch they are named after.
  assert.deepEqual(Object.keys(all).map(key => [key, shape(key as keyof typeof all)]), [
    ["clean", []], ["r1", ["no_live_source"]], ["r4ch", ["computed_ch"]], ["r4inv", ["invite_evidence"]],
    ["r4ext", ["invite_evidence"]], ["preFlag", []]]);

  const ids = [...name.keys()].sort();
  const prefiltered = await runJointSourceRecoveryPrefilter(db, ids);
  assert.deepEqual(prefiltered.snapshot, { isolation: "repeatable read", readOnly: true });
  assert.deepEqual(prefiltered.candidates.map(jointId => name.get(jointId)).sort(), ["preFlag", "r1", "r4ch", "r4ext", "r4inv"]);
  assert.deepEqual((await runJointSourceRecoveryPrefilter(db, [randomUUID()])).candidates, [], "an unknown joint has nothing to plan");
  await assert.rejects(runJointSourceRecoveryPrefilter(db, ids, { requireReplica: true }), /requires a read replica/);
  await assert.rejects(runJointSourceRecoveryPrefilter(db, Array.from({ length: RECOVERY_PREFILTER_BATCH + 1 }, () => randomUUID())), /per prefilter batch/);
  const occurrences = await assertRecoveryPrefilterSuperset(db);
  return { ids: Object.fromEntries(Object.entries(all).map(([key, x]) => [key, id(x)])), occurrences };
}
