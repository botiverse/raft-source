import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db";
import { channelExternalInvites, channelHumans, channels, featureFlagRules, featureFlags, jointChannelAdmissions,
  jointChannelInvites, jointChannelMembers, jointChannelServers, jointMembershipGenerations, serverMembers } from "../db/schema";
import { addMember } from "../services/serverService";
import { addHuman } from "../services/channelService";
import { connected } from "./jointHumanMembershipScenarios";
import { createSeed } from "./integration/seed";
import { seedBoundGuest } from "./guestFixture";
import { classifyJointSourceTuple, jointSourceRunReceipt, parseJointSourceTuples,
  runJointSourcePreview, runJointSourceVerify, type JointSourceCategory, type JointSourceFacts,
  type JointSourceTupleKey } from "../../scripts/joint-human-membership-ops";

type Fixture = { db: Database; seed: ReturnType<typeof createSeed> };
type Preview = Awaited<ReturnType<typeof runJointSourcePreview>>;

/** Pure rule table: admissions win, then invite evidence, then CH. */
export function jointSourcePolicyScenario() {
  const base: JointSourceFacts = { pending: false, admission: null,
    ch: { joinedAt: "2026-11-01T00:00:00.000000Z" }, preFlag: false, inviteEvidence: 0 };
  assert.equal(classifyJointSourceTuple(base), "computed_ch");
  assert.equal(classifyJointSourceTuple({ ...base, preFlag: true }), "computed_pre_flag_ch");
  assert.equal(classifyJointSourceTuple({ ...base, inviteEvidence: 2 }), "invite_evidence");
  assert.equal(classifyJointSourceTuple({ ...base, pending: true }), "removal_pending");
  assert.equal(classifyJointSourceTuple({ ...base, admission: { endedAt: null, live: true } }), "live");
  assert.equal(classifyJointSourceTuple({ ...base, admission: { endedAt: null, live: false } }), "stale_source");
  assert.equal(classifyJointSourceTuple({ ...base, admission: { endedAt: "2026-11-02T00:00:00.000000Z", live: false } }), "ended");
  assert.equal(classifyJointSourceTuple({ ...base, ch: null }), "other_generation_admission");
  assert.throws(() => parseJointSourceTuples([{ jointId: "x", userId: randomUUID(), serverId: randomUUID(), generation: 1 }]), /Invalid tuple/);
  const one = { jointId: randomUUID(), userId: randomUUID(), serverId: randomUUID(), generation: 1 };
  assert.throws(() => parseJointSourceTuples({ tuples: [one, one] }), /Duplicate/);
  assert.equal(parseJointSourceTuples({ tuples: [one] }).length, 1);
}

/** Every table the preview reads, by row count and full-row hash. */
async function touchedTables(db: Database) {
  const tables = ["joint_channels", "joint_channel_members", "joint_membership_generations", "joint_channel_admissions",
    "channel_humans", "joint_channel_servers", "channel_external_invites", "joint_channel_invites", "server_members",
    "servers", "channels", "feature_flags", "feature_flag_rules", "feature_flag_config_versions",
    "joint_membership_departures", "joint_membership_removals"];
  const out: Record<string, unknown> = {};
  for (const table of tables) out[table] = (await db.execute(sql.raw(`SELECT count(*)::int n,
    md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY to_jsonb(t)::text), '')) h FROM ${table} t`))).rows[0];
  return out;
}

const keysOf = (preview: Preview, category: JointSourceCategory) =>
  ("tuples" in preview ? (preview.tuples as Record<string, Array<{ userId: string; serverId: string; generation: number }>>)[category] ?? [] : [])
    .map(row => `${row.userId}/${row.serverId}/${row.generation}`).sort();

export async function jointSourcePreviewScenario(f: Fixture) {
  const { db, seed } = f;
  const member = async (j: string, userId: string, generation = 1) => {
    await db.insert(jointChannelMembers).values({ jointChannelId: j, userId, generation });
    await db.insert(jointMembershipGenerations).values({ jointChannelId: j, principalKind: "user", principalId: userId, lastGeneration: generation });
  };

  // The retired joint_human_membership_v1 row, read only as history: a host's
  // one server allow rule bounds when its CH rows stopped being sources.
  await db.insert(featureFlags).values({ key: "joint_human_membership_v1", enabled: true, defaultEnabled: false,
    randomizationUnit: "server", salt: "source-preview" })
    .onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true, defaultEnabled: false, killSwitch: false } });

  // ---- A joint whose host has no rule (no known computed start).
  const x = await connected(f), lj = x.joint.jointChannel.id;
  const cand = await seed.human();
  await addMember(x.a.id, cand.id); await addHuman(x.joint.channel.id, cand.id);
  // The old backfill wrote members but no admissions; this member is in episode 2
  // and only holds an ENDED episode-1 admission on A.
  await db.delete(jointChannelAdmissions).where(and(eq(jointChannelAdmissions.jointChannelId, lj), eq(jointChannelAdmissions.userId, cand.id)));
  await db.update(jointChannelMembers).set({ generation: 2 }).where(and(eq(jointChannelMembers.jointChannelId, lj), eq(jointChannelMembers.userId, cand.id)));
  await db.update(jointMembershipGenerations).set({ lastGeneration: 2 }).where(and(eq(jointMembershipGenerations.jointChannelId, lj), eq(jointMembershipGenerations.principalId, cand.id)));
  await db.insert(jointChannelAdmissions).values({ jointChannelId: lj, userId: cand.id, serverId: x.a.id, generation: 1, endedAt: new Date() });
  const ended = await seed.human();
  await addMember(x.a.id, ended.id); await addHuman(x.joint.channel.id, ended.id);
  await db.update(jointChannelAdmissions).set({ endedAt: new Date() }).where(and(eq(jointChannelAdmissions.jointChannelId, lj), eq(jointChannelAdmissions.userId, ended.id)));
  const guest = await seed.human(), left = await seed.human();
  for (const person of [guest, left]) { await addMember(x.b.id, person.id); await addHuman(x.target.id, person.id); }
  // Direct identity edits, bypassing the revalidate writer: the admission stays unended.
  // The Guest is bound to a local channel of B, not the joint projection (#wg-rbac:#15).
  await seedBoundGuest({ serverId: x.b.id, userId: guest.id }, db);
  await db.delete(serverMembers).where(and(eq(serverMembers.serverId, x.b.id), eq(serverMembers.userId, left.id)));
  const ghost = await seed.human();
  await member(lj, ghost.id);

  // ---- A joint whose host had the retired flag on through one server rule (/raft-like).
  const y = await connected(f), yj = y.joint.jointChannel.id;
  const pre = await seed.human(), inv = await seed.human();
  await addMember(y.a.id, pre.id); await addMember(y.b.id, pre.id); await addHuman(y.joint.channel.id, pre.id);
  // A CH row on B from before the host's rule existed, no B admission.
  await db.insert(channelHumans).values({ channelId: y.target.id, userId: pre.id, joinedAt: new Date("2026-01-01T00:00:00Z") });
  // A multi-server external connect that recorded only its first server.
  await addMember(y.b.id, inv.id);
  const c = await seed.server({ owner: y.owner, members: [inv] });
  const [cLocal] = await db.insert(channels).values({ serverId: c.id, name: `joint-${randomUUID().slice(0, 8)}`, type: "joint" }).returning();
  await db.insert(jointChannelServers).values({ jointChannelId: yj, serverId: c.id, localChannelId: cLocal!.id, role: "participant" });
  await member(yj, inv.id);
  await db.insert(jointChannelAdmissions).values({ jointChannelId: yj, userId: inv.id, serverId: y.b.id, generation: 1 });
  const [invite] = await db.insert(channelExternalInvites).values({ channelId: y.joint.channel.id, hostServerId: y.a.id,
    email: `${randomUUID()}@test.invalid`, tokenHash: randomUUID(), status: "accepted", outcome: "server",
    acceptedUserId: inv.id, acceptedServerId: y.b.id, connectedServerIds: [y.b.id, c.id],
    expiresAt: new Date(Date.now() + 86_400_000), decidedAt: new Date() }).returning();
  // An external connect's approval: the joint invite row names the APPROVER
  // (already a J member) as accepter and invitee; the joiner (inv) is not stored.
  const [approval] = await db.insert(jointChannelInvites).values({ jointChannelId: yj, fromServerId: y.a.id, toServerId: c.id,
    invitedUserId: y.owner.id, acceptedByUserId: y.owner.id, status: "accepted", acceptedVia: "invitee",
    acceptedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) }).returning();
  const [rule] = await db.insert(featureFlagRules).values({ flagKey: "joint_human_membership_v1", stage: "server",
    decision: "allow", values: [y.a.id] }).returning();
  // Written after flag-on for an existing member (like the computed role
  // projection, channelService updateChannelMemberRole): not a source.
  await db.insert(channelHumans).values({ channelId: y.target.id, userId: y.peer.id });

  const before = await touchedTables(db);
  const legacy = await runJointSourcePreview(db, lj);
  const computed = await runJointSourcePreview(db, yj);
  assert.ok("tuples" in legacy && "tuples" in computed);
  assert.deepEqual(legacy.snapshot, { isolation: "repeatable read", readOnly: true }, "source modes run in a READ ONLY snapshot");

  // Classification on the joint with no known computed start.
  const t = (userId: string, serverId: string, generation = 1) => `${userId}/${serverId}/${generation}`;
  assert.deepEqual(keysOf(legacy, "computed_ch"), [t(cand.id, x.a.id, 2)], "a CH row without this episode's admission is CH evidence only");
  const candTuple = legacy.tuples.computed_ch[0]!;
  assert.deepEqual(candTuple.evidence.otherGenerationAdmissions.map(row => row.generation), [1], "the old episode's admission is evidence only");
  assert.ok(keysOf(legacy, "live").includes(t(x.owner.id, x.a.id)));
  assert.ok(!keysOf(legacy, "live").some(key => key.startsWith(cand.id)));
  assert.deepEqual(keysOf(legacy, "ended"), [t(ended.id, x.a.id)]);
  assert.deepEqual(keysOf(legacy, "stale_source"), [t(guest.id, x.b.id), t(left.id, x.b.id)].sort());
  const staleRoles = legacy.tuples.stale_source.map(row => row.evidence.entry.role).sort();
  assert.deepEqual(staleRoles, ["guest", null].sort());
  const legacyE = legacy.noLiveSource.map(row => row.userId).sort();
  assert.deepEqual(legacyE, [cand.id, ended.id, guest.id, left.id, ghost.id].sort());
  assert.deepEqual(legacy.noLiveSource.find(row => row.userId === ghost.id)?.categories, [], "zero-evidence member");
  assert.equal(legacy.counts.computed_ch, 1);

  // Classification on the joint with a known computed start.
  assert.deepEqual(keysOf(computed, "computed_ch"), [t(y.peer.id, y.b.id)]);
  assert.deepEqual(keysOf(computed, "computed_pre_flag_ch"), [t(pre.id, y.b.id)]);
  assert.deepEqual(keysOf(computed, "invite_evidence"), [t(inv.id, c.id)]);
  const d = computed.tuples.invite_evidence[0]!.evidence.externalInvites;
  assert.deepEqual(d.map(row => [row.inviteId, row.position, row.status]), [[invite!.id, 2, "accepted"]]);
  assert.ok(keysOf(computed, "live").includes(t(inv.id, y.b.id)), "the recorded first server stays live");
  assert.ok(legacy.tuples.live.some(row => row.userId === x.owner.id && row.serverId === x.b.id && row.evidence.jointInvites.length > 0),
    "a provable joint invite accept is the accepter's own evidence");
  // Approver != joiner: the approver gets no evidence from the approval; the
  // joiner's tuple shows it as authorizer-only, uncounted.
  const all = (preview: typeof computed) => Object.values(preview.tuples).flat();
  assert.ok(!all(computed).some(row => row.userId === y.owner.id && row.serverId === c.id), "approver gets no tuple from the approval");
  assert.ok(!all(computed).some(row => row.evidence.jointInvites.some(e => e.inviteId === approval!.id)));
  const joinerTuple = computed.tuples.invite_evidence[0]!;
  assert.deepEqual(joinerTuple.evidence.connectAuthorizerInviteIds, [approval!.id]);
  assert.deepEqual(joinerTuple.evidence.jointInvites, []);
  assert.deepEqual(computed.connectAuthorizerEvidence.map(row => [row.inviteId, row.serverId, row.authorizerUserId]).filter(row => row[0] === approval!.id),
    [[approval!.id, c.id, y.owner.id]]);
  // The original B accept is joiner-unknown too: an external invite of this J connected B.
  assert.ok(all(computed).filter(row => row.userId === y.owner.id && row.serverId === y.b.id).every(row => row.evidence.jointInvites.length === 0));
  assert.ok(computed.flag.flagOnAt?.startsWith(rule!.createdAt.toISOString().slice(0, 23)), "flag-on time is the host rule's created_at");
  assert.deepEqual(computed.flag.hostRules.map(row => row.id), [rule!.id]);
  assert.ok(!JSON.stringify([legacy, computed]).includes("@test.invalid"), "no emails in receipts");

  // Verification of frozen tuples, one by one.
  const key = (jointId: string, userId: string, serverId: string, generation: number) =>
    ({ jointId, userId, serverId, generation }) as JointSourceTupleKey;
  const verify = await runJointSourceVerify(db, [
    key(lj, x.owner.id, x.a.id, 1), key(lj, cand.id, x.a.id, 2), key(lj, cand.id, x.a.id, 1),
    key(lj, ended.id, x.a.id, 1), key(lj, guest.id, x.b.id, 1), key(lj, randomUUID(), x.a.id, 1)]);
  assert.deepEqual(verify.results.map(row => row.result),
    ["ok", "admission_missing", "generation_changed", "admission_ended", "source_not_live", "member_missing"]);
  assert.deepEqual(verify.snapshot, { isolation: "repeatable read", readOnly: true });

  // Nothing was written by either mode.
  assert.deepEqual(await touchedTables(db), before, "source preview/verify write nothing");

  // Digest: stable across runs, changes with one tuple.
  const again = await runJointSourcePreview(db, lj);
  assert.ok("digest" in again);
  assert.equal(again.digest, legacy.digest);
  const receipt = (digests: string[]) => jointSourceRunReceipt({ mode: "source-preview", after: null, through: null,
    joints: digests.map((value, i) => ({ jointId: [lj, yj][i]!, digest: value })), failures: [] });
  assert.equal(receipt([legacy.digest, computed.digest]), receipt([again.digest, computed.digest]));
  await db.insert(jointChannelAdmissions).values({ jointChannelId: lj, userId: cand.id, serverId: x.a.id, generation: 2 });
  const filled = await runJointSourcePreview(db, lj);
  assert.ok("tuples" in filled);
  assert.notEqual(filled.digest, legacy.digest, "one changed tuple changes the digest");
  assert.notEqual(receipt([filled.digest, computed.digest]), receipt([legacy.digest, computed.digest]));
  assert.deepEqual(keysOf(filled, "computed_ch"), []);
  assert.ok(keysOf(filled, "live").includes(t(cand.id, x.a.id, 2)));
  assert.equal((await runJointSourceVerify(db, [key(lj, cand.id, x.a.id, 2)])).results[0]?.result, "ok");

  // Replica-only enforcement in production (PGlite/primary is not in recovery).
  await assert.rejects(runJointSourcePreview(db, lj, { requireReplica: true }), /requires a read replica/);
  await assert.rejects(runJointSourceVerify(db, [key(lj, x.owner.id, x.a.id, 1)], { requireReplica: true }), /requires a read replica/);

  // CH + invite evidence: classified D, both raw evidences kept.
  await db.insert(channelHumans).values({ channelId: cLocal!.id, userId: inv.id });
  const both = await runJointSourcePreview(db, yj);
  const bothTuple = both.tuples.invite_evidence.find(row => row.userId === inv.id && row.serverId === c.id)!;
  assert.ok(bothTuple.evidence.ch && bothTuple.evidence.externalInvites.length === 1, "D keeps CH and invite evidence");

  // Oversized: every evidence query fetches at most cap+1 rows and fails the J.
  const oversized = (jointId: string, cap: number, what: string) => assert.rejects(runJointSourcePreview(db, jointId, { evidenceRowCap: cap }),
    error => error instanceof Error && "category" in error && error.category === "oversized"
      && error.message.includes(`Oversized ${what}`) && error.message.includes(`(fetched ${cap + 1})`));
  await oversized(lj, 2, "members");
  // A small J with a long admission history: only the history query exceeds 10.
  const z = await connected(f), zj = z.joint.jointChannel.id, history = await seed.human();
  await member(zj, history.id, 40);
  await db.insert(jointChannelAdmissions).values(Array.from({ length: 30 }, (_, i) =>
    ({ jointChannelId: zj, userId: history.id, serverId: z.a.id, generation: i + 1, endedAt: new Date() })));
  await oversized(zj, 10, "admission evidence");
  assert.ok("tuples" in await runJointSourcePreview(db, zj), "the default cap previews it");
}
