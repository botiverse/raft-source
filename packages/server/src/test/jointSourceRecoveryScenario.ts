import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db";
import { channelHumans, channels, jointAdmissionRecoveries, jointChannelAdmissions, jointChannelInvites,
  jointChannelMembers, jointChannelServers, jointMembershipGenerations, serverMembers } from "../db/schema";
import { addMember } from "../services/serverService";
import { addHuman } from "../services/channelService";
import { recordOrdinaryJointAdmissions } from "../services/jointAdmissionKind";
import { jointHumanCurrentSourceSql } from "../services/jointHumanMembershipAccess";
import { connected } from "./jointHumanMembershipScenarios";
import { createSeed } from "./integration/seed";
import { seedBoundGuest } from "./guestFixture";
import { JOINT_RECOVERY_FORMAT, JOINT_RECOVERY_RELEASE_FORMAT, assertRecoveryApplyAuthority, bindJointRecoveryReleases,
  jointRecoveryPlanDigest, parseJointRecoveryPlans,
  runJointSourcePreview, runJointSourceRecoveryApply, runJointSourceRecoveryPlan, runJointSourceRecoveryPreview,
  runJointSourceVerify, type JointRecoveryPlan, type JointSourceTupleKey } from "../../scripts/joint-human-membership-ops";

type Fixture = { db: Database; seed: ReturnType<typeof createSeed> };
type Outcomes = Array<{ userId: string; serverId: string; outcome: string; reason: string }>;

/** Every table the recovery modes read or write, by row count and full-row hash. */
async function touchedTables(db: Database) {
  const tables = ["joint_channels", "joint_channel_members", "joint_membership_generations", "joint_channel_admissions",
    "joint_admission_recoveries", "channel_humans", "joint_channel_servers", "joint_channel_invites", "server_members",
    "servers", "channels", "feature_flags", "feature_flag_rules"];
  const out: Record<string, unknown> = {};
  for (const table of tables) out[table] = (await db.execute(sql.raw(`SELECT count(*)::int n,
    md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY to_jsonb(t)::text), '')) h FROM ${table} t`))).rows[0];
  return out;
}

/** Pure guards: the file format, the 100-joint batch bound, run id and approval reference. */
export function jointSourceRecoveryPolicyScenario() {
  const joint = () => ({ jointId: randomUUID(), sourcePreviewDigest: "a".repeat(64), occurrences: [] });
  assert.equal(parseJointRecoveryPlans({ format: JOINT_RECOVERY_FORMAT, joints: Array.from({ length: 100 }, joint) }).length, 100);
  assert.throws(() => parseJointRecoveryPlans({ format: JOINT_RECOVERY_FORMAT, joints: Array.from({ length: 101 }, joint) }), /at most 100 joints/);
  assert.throws(() => parseJointRecoveryPlans({ joints: [joint()] }), /format must be/);
  assert.throws(() => parseJointRecoveryPlans({ format: "joint-source-recovery/v1", joints: [joint()] }), /format must be/, "v1 files carry no frozen hold");
  const okTrace = { serverId: randomUUID(), category: "computed_ch", projection: null, serverMemberJoinedAt: null };
  assert.throws(() => parseJointRecoveryPlans({ format: JOINT_RECOVERY_FORMAT, joints: [{ ...joint(),
    occurrences: [{ userId: randomUUID(), generation: 1, traces: [okTrace] }] }] }), /hold is required/);
  assert.throws(() => parseJointRecoveryPlans({ format: JOINT_RECOVERY_FORMAT, joints: [{ ...joint(),
    occurrences: [{ userId: randomUUID(), generation: 1, hold: { reason: "ended_source", endedServerIds: [], endedAt: [] }, traces: [okTrace] }] }] }), /hold must be/);
  const one = joint();
  assert.throws(() => parseJointRecoveryPlans({ format: JOINT_RECOVERY_FORMAT, joints: [one, one] }), /duplicate joint/);
  const trace = { serverId: randomUUID(), category: "computed_pre_flag_ch", projection: null, serverMemberJoinedAt: null };
  assert.throws(() => parseJointRecoveryPlans({ format: JOINT_RECOVERY_FORMAT, joints: [{ ...joint(),
    occurrences: [{ userId: randomUUID(), generation: 1, hold: null, traces: [trace] }] }] }), /computed_ch or invite_evidence/);
  assert.throws(() => parseJointRecoveryPlans({ format: JOINT_RECOVERY_FORMAT, joints: [{ ...joint(),
    occurrences: [{ userId: randomUUID(), generation: 1, hold: null, traces: Array.from({ length: 1001 }, () => ({ ...trace, category: "computed_ch", serverId: randomUUID() })) }] }] }), /at most 1000 tuples/);
  for (const input of [{}, { runId: "run" }, { approvalRef: "ref" }, { runId: " ", approvalRef: "ref" }])
    assert.throws(() => assertRecoveryApplyAuthority(input), /requires --run-id and --approval-reference/);
  assertRecoveryApplyAuthority({ runId: "run", approvalRef: "ref" });

  // Release files: only a frozen hold, only one of its trace servers, never S.
  const S = randomUUID(), T = randomUUID(), userId = randomUUID(), free = randomUUID();
  const traceOn = (serverId: string) => ({ serverId, category: "computed_ch", projection: null, serverMemberJoinedAt: null });
  const [plan] = parseJointRecoveryPlans({ format: JOINT_RECOVERY_FORMAT, joints: [{ ...joint(), occurrences: [
    { userId, generation: 1, hold: { reason: "ended_source", endedServerIds: [S], endedAt: ["2026-11-01T00:00:00.000000Z"] }, traces: [traceOn(T)] },
    { userId: free, generation: 1, hold: null, traces: [traceOn(T)] }] }] });
  const release = (entry: Record<string, unknown>) => ({ format: JOINT_RECOVERY_RELEASE_FORMAT,
    releases: [{ jointId: plan!.jointId, userId, generation: 1, serverId: T, ...entry }] });
  const bound = bindJointRecoveryReleases(release({}), [plan!], " decision-1 ");
  assert.equal(bound.decisionRef, "decision-1");
  assert.deepEqual([...bound.keys.get(plan!.jointId)!], [`${userId}/1/${T}`]);
  assert.throws(() => bindJointRecoveryReleases(release({}), [plan!], " "), /requires --decision-reference/);
  assert.throws(() => bindJointRecoveryReleases({ ...release({}), format: "v0" }, [plan!], "d"), /format must be/);
  assert.throws(() => bindJointRecoveryReleases({ format: JOINT_RECOVERY_RELEASE_FORMAT, releases: [] }, [plan!], "d"), /non-empty/);
  assert.throws(() => bindJointRecoveryReleases(release({ serverId: S }), [plan!], "d"), /ended source is never revived/);
  assert.throws(() => bindJointRecoveryReleases(release({ serverId: randomUUID() }), [plan!], "d"), /no trace/);
  assert.throws(() => bindJointRecoveryReleases(release({ userId: free }), [plan!], "d"), /not held/);
  assert.throws(() => bindJointRecoveryReleases(release({ generation: 2 }), [plan!], "d"), /no occurrence/);
  assert.throws(() => bindJointRecoveryReleases(release({ jointId: randomUUID() }), [plan!], "d"), /no occurrence/);
  const twice = release({});
  assert.throws(() => bindJointRecoveryReleases({ ...twice, releases: [...twice.releases, ...twice.releases] }, [plan!], "d"), /duplicate release/);
}

export async function jointSourceRecoveryScenario(f: Fixture) {
  const { db, seed } = f;
  const x = await connected(f), J = x.joint.jointChannel.id;
  const A = x.a.id, B = x.b.id, aLocal = x.joint.channel.id, bLocal = x.target.id;
  // Two more connected servers, C and D, with their own joint projections.
  const extra = async () => {
    const server = await seed.server({ owner: x.owner });
    const [local] = await db.insert(channels).values({ serverId: server.id, name: `joint-${randomUUID().slice(0, 8)}`, type: "joint" }).returning();
    await db.insert(jointChannelServers).values({ jointChannelId: J, serverId: server.id, localChannelId: local!.id, role: "participant" });
    return { id: server.id, local: local!.id };
  };
  const c = await extra(), d = await extra(), C = c.id, D = d.id;

  const person = async (servers: string[], ch: string[] = []) => {
    const human = await seed.human();
    for (const serverId of servers) await addMember(serverId, human.id);
    await db.insert(jointChannelMembers).values({ jointChannelId: J, userId: human.id, generation: 1 });
    await db.insert(jointMembershipGenerations).values({ jointChannelId: J, principalKind: "user", principalId: human.id, lastGeneration: 1 });
    for (const channelId of ch) await db.insert(channelHumans).values({ channelId, userId: human.id });
    return human.id;
  };
  const admit = (userId: string, serverId: string, values: Partial<typeof jointChannelAdmissions.$inferInsert> = {}) =>
    db.insert(jointChannelAdmissions).values({ jointChannelId: J, userId, serverId, generation: 1, ...values });

  // R1/C: no source at all, a CH trace on B.
  const orphan = await person([B], [bLocal]);
  // R3/D: an accepted same_admin invite FROM A TO C; member of both A and C.
  const r3 = await person([A, C]);
  await db.insert(jointChannelInvites).values({ jointChannelId: J, fromServerId: A, toServerId: C, invitedUserId: r3,
    acceptedByUserId: r3, status: "accepted", acceptedVia: "same_admin", acceptedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) });
  // R4: a live ordinary source on A and a CH trace on B.
  const r4 = await person([A, B], [bLocal]);
  await admit(r4, A);
  // R5: an ended source on A plus traces on B and C.
  const held = await person([A, B, C], [bLocal, c.local]);
  await admit(held, A, { endedAt: new Date() });
  // R3a: traces on servers that are not valid targets.
  const outsider = await person([A], [bLocal]);
  const guest = await person([B], [bLocal]);
  // A Guest of B, bound to a local channel of B rather than the joint projection (#wg-rbac:#15).
  await seedBoundGuest({ serverId: B, userId: guest }, db);
  // Writable at scan; an ended source on C appears before apply (R5 added at apply).
  const lateHeld = await person([B, C], [bLocal, c.local]);
  // E with no trace at all.
  const bare = await person([A]);
  // Changed after the scan (below).
  const conflictEnded = await person([B], [bLocal]);
  const conflictAdmission = await person([B], [bLocal]);
  const reconnected = await person([D], [d.local]);
  const rejoined = await person([B], [bLocal]);
  const gone = await person([B], [bLocal]);
  const name = new Map(Object.entries({ orphan, r3, r4, held, lateHeld, outsider, guest, bare, conflictEnded, conflictAdmission, reconnected, rejoined, gone })
    .map(([key, id]) => [id, key]));
  const server = new Map([[A, "A"], [B, "B"], [C, "C"], [D, "D"]]);
  const view = (rows: Outcomes) => rows.filter(row => name.has(row.userId))
    .map(row => `${name.get(row.userId)}@${server.get(row.serverId)}:${row.outcome}:${row.reason}`).sort();
  const people = (rows: Array<{ userId: string }>) => rows.map(row => name.get(row.userId) ?? row.userId).sort();

  // ---- Scan (read-only): plan + what apply would do now.
  const before = await touchedTables(db);
  const scan = await runJointSourceRecoveryPlan(db, J);
  assert.deepEqual(scan.snapshot, { isolation: "repeatable read", readOnly: true });
  assert.equal(scan.status, "active"); assert.equal(scan.planned, true);
  assert.deepEqual(view(scan.tuples), [
    "conflictAdmission@B:would_write:recoverable", "conflictEnded@B:would_write:recoverable",
    "gone@B:would_write:recoverable", "guest@B:skipped_invalid_target:guest",
    "held@B:held_for_host_admin:held_at_scan", "held@C:held_for_host_admin:held_at_scan",
    "lateHeld@B:would_write:recoverable", "lateHeld@C:would_write:recoverable",
    "orphan@B:would_write:recoverable", "outsider@B:skipped_invalid_target:not_server_member",
    "r3@C:would_write:recoverable", "r4@B:would_write:recoverable",
    "reconnected@D:would_write:recoverable", "rejoined@B:would_write:recoverable",
  ].sort());
  const heldPlan = scan.plan.occurrences.find(row => row.userId === held)!;
  assert.deepEqual([heldPlan.hold?.reason, heldPlan.hold?.endedServerIds, heldPlan.hold?.endedAt.length], ["ended_source", [A], 1], "R5 is frozen into the plan");
  assert.ok(scan.plan.occurrences.filter(row => row.userId !== held).every(row => row.hold === null));
  assert.ok(!scan.tuples.some(row => row.userId === r3 && row.serverId === A), "R3: the invite's from server is never a target");
  assert.equal(scan.plan.occurrences.find(row => row.userId === r3)?.traces[0]?.category, "invite_evidence");
  assert.deepEqual(people(scan.needsHostAdmin), ["bare", "guest", "outsider"]);
  assert.deepEqual(scan.heldForHostAdmin.filter(row => row.userId === held).map(row => [row.endedServerIds, [...row.traceServerIds].sort()]), [[[A], [B, C].sort()]]);
  assert.deepEqual(await touchedTables(db), before, "the scan writes nothing");
  await assert.rejects(runJointSourceRecoveryPlan(db, J, { requireReplica: true }), /requires a read replica/);

  // The tuples file is the scan's plan; it round-trips exactly.
  const file = { format: JOINT_RECOVERY_FORMAT, joints: [JSON.parse(JSON.stringify(scan.plan)) as unknown] };
  const [plan] = parseJointRecoveryPlans(file) as [JointRecoveryPlan];
  assert.deepEqual(plan, scan.plan);
  assert.equal(jointRecoveryPlanDigest(plan), scan.planDigest);

  // ---- Changes after the scan.
  await admit(conflictEnded, B, { kind: "recovery", endedAt: new Date() });
  await db.insert(jointAdmissionRecoveries).values({ jointChannelId: J, userId: conflictEnded, serverId: B, generation: 1, runId: "earlier", approvalRef: "earlier" });
  await admit(conflictAdmission, B, { admittedBy: x.owner.id });
  const endedRow = (await db.select().from(jointChannelAdmissions).where(and(eq(jointChannelAdmissions.userId, conflictEnded), eq(jointChannelAdmissions.serverId, B))))[0];
  const admissionRow = (await db.select().from(jointChannelAdmissions).where(and(eq(jointChannelAdmissions.userId, conflictAdmission), eq(jointChannelAdmissions.serverId, B))))[0];
  // D disconnected and reconnected (as acceptJointChannelInvite's upsert: new joined_at).
  const dProjection = and(eq(jointChannelServers.jointChannelId, J), eq(jointChannelServers.serverId, D));
  await db.update(jointChannelServers).set({ status: "disconnected", disconnectedAt: new Date() }).where(dProjection);
  await db.update(jointChannelServers).set({ status: "active", disconnectedAt: null, joinedAt: new Date(Date.now() + 1000) }).where(dProjection);
  // rejoined left B and joined it again.
  await db.delete(serverMembers).where(and(eq(serverMembers.serverId, B), eq(serverMembers.userId, rejoined)));
  await addMember(B, rejoined);
  await db.delete(jointChannelMembers).where(and(eq(jointChannelMembers.jointChannelId, J), eq(jointChannelMembers.userId, gone)));
  // The held occurrence's ended row is cleaned up: the frozen hold must still apply.
  await db.delete(jointChannelAdmissions).where(and(eq(jointChannelAdmissions.jointChannelId, J), eq(jointChannelAdmissions.userId, held)));
  await admit(lateHeld, C, { endedAt: new Date() });

  const expected = [
    "conflictAdmission@B:skipped_conflict:existing_admission", "conflictEnded@B:skipped_conflict:existing_recovery_ended",
    "gone@B:not_member:member_missing", "guest@B:skipped_invalid_target:guest",
    "held@B:held_for_host_admin:held_at_scan", "held@C:held_for_host_admin:held_at_scan",
    "lateHeld@B:held_for_host_admin:ended_source_with_trace_elsewhere", "lateHeld@C:held_for_host_admin:ended_source_with_trace_elsewhere",
    "orphan@B:WRITE:recoverable", "outsider@B:skipped_invalid_target:not_server_member",
    "r3@C:WRITE:recoverable", "r4@B:WRITE:recoverable",
    "reconnected@D:changed_since_scan:projection_changed", "rejoined@B:changed_since_scan:server_membership_changed",
  ];
  const changed = await touchedTables(db);
  const preview = await runJointSourceRecoveryPreview(db, plan);
  assert.deepEqual(view(preview.tuples), expected.map(row => row.replace("WRITE", "would_write")).sort());
  assert.deepEqual(people(preview.needsHostAdmin), ["bare", "conflictEnded", "guest", "outsider"]);
  assert.deepEqual(await touchedTables(db), changed, "the file preview writes nothing");
  await assert.rejects(runJointSourceRecoveryPreview(db, plan, { requireReplica: true }), /requires a read replica/);

  // ---- Apply guards: authority, read-only connection, window, and one transaction for both tables.
  const recoveryRows = async () => (await db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM joint_channel_admissions WHERE kind='recovery' AND ended_at IS NULL`)).rows[0]!.n;
  const options = { runId: "run-1", approvalRef: "approval-1" };
  await assert.rejects(runJointSourceRecoveryApply(db, plan, { runId: "", approvalRef: "approval-1" }), /requires --run-id and --approval-reference/);
  await assert.rejects(runJointSourceRecoveryApply(db, plan, { runId: "run-1", approvalRef: "" }), /requires --run-id and --approval-reference/);
  await db.execute(sql`SET default_transaction_read_only = on`);
  try { await assert.rejects(runJointSourceRecoveryApply(db, plan, options), /requires a writable primary/); }
  finally { await db.execute(sql`SET default_transaction_read_only = off`); }
  await assert.rejects(runJointSourceRecoveryApply(db, plan, { ...options, checkWindow: () => { throw new Error("window closed"); } }), /Approved write window/);
  await db.execute(sql`CREATE OR REPLACE FUNCTION fail_recovery_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected recovery provenance failure'; END $$`);
  await db.execute(sql`CREATE TRIGGER fail_recovery_provenance BEFORE INSERT ON joint_admission_recoveries FOR EACH ROW EXECUTE FUNCTION fail_recovery_provenance()`);
  try {
    await assert.rejects(runJointSourceRecoveryApply(db, plan, options),
      error => error instanceof Error && "phase" in error && error.phase === "recovery_insert");
  } finally { await db.execute(sql`DROP TRIGGER fail_recovery_provenance ON joint_admission_recoveries`); }
  assert.equal(await recoveryRows(), 0, "a failed provenance insert leaves no recovery source");
  assert.deepEqual(await touchedTables(db), changed, "every refused or failed apply wrote nothing");

  // ---- Apply.
  const applied = await runJointSourceRecoveryApply(db, plan, options);
  assert.deepEqual(view(applied.tuples), expected.map(row => row.replace("WRITE", "written")).sort(), "apply does what the preview said");
  assert.deepEqual(people(applied.needsHostAdmin), ["bare", "conflictEnded", "guest", "outsider"]);
  assert.equal(applied.counts.written, 3);
  assert.equal(applied.counts.held_for_host_admin, 4);
  assert.deepEqual(applied.heldForHostAdmin.filter(row => name.has(row.userId)).map(row => [name.get(row.userId), row.frozenAtScan]).sort(),
    [["held", true], ["lateHeld", false]]);
  assert.equal(applied.counts.needs_host_admin, 4);
  const written = [[orphan, B], [r3, C], [r4, B]] as const;
  const key = (userId: string, serverId: string) => `${userId}/${serverId}`;
  assert.deepEqual(applied.receipts.admissions.map(row => key(row.userId, row.serverId)).sort(), written.map(([u, s]) => key(u, s)).sort());
  assert.ok(applied.receipts.admissions.every(row => row.kind === "recovery" && row.admittedBy === null && row.generation === 1));
  assert.deepEqual(applied.receipts.recoveries.map(row => [key(row.userId, row.serverId), row.runId, row.approvalRef]).sort(),
    written.map(([u, s]) => [key(u, s), "run-1", "approval-1"]).sort());
  for (const [userId, serverId] of written) {
    const [row] = await db.select().from(jointChannelAdmissions).where(and(eq(jointChannelAdmissions.jointChannelId, J),
      eq(jointChannelAdmissions.userId, userId), eq(jointChannelAdmissions.serverId, serverId)));
    assert.equal(row?.kind, "recovery"); assert.equal(row?.admittedBy, null); assert.equal(row?.endedAt, null);
    const live = await db.execute<{ live: boolean }>(sql`SELECT ${jointHumanCurrentSourceSql(sql`${J}::uuid`, sql`${userId}::uuid`, sql`${serverId}::uuid`)} AS live`);
    assert.equal(live.rows[0]?.live, true, "a recovery source is a live source");
  }
  const rows = (userId: string) => db.select().from(jointChannelAdmissions).where(and(eq(jointChannelAdmissions.jointChannelId, J), eq(jointChannelAdmissions.userId, userId)));
  assert.deepEqual((await rows(r3)).map(row => row.serverId), [C], "R3: nothing on the invite's from server");
  assert.deepEqual(await rows(held), [], "R5 frozen at scan: nothing written even after its ended row is gone");
  assert.deepEqual((await rows(lateHeld)).map(row => row.serverId), [C], "R5 added at apply: only the new ended row");
  for (const userId of [outsider, guest, bare, reconnected, rejoined, gone]) assert.deepEqual(await rows(userId), [], name.get(userId));
  assert.deepEqual((await rows(conflictEnded))[0], endedRow, "an ended row is not revived");
  assert.deepEqual((await rows(conflictAdmission))[0], admissionRow, "an admission row is untouched");
  assert.equal((await db.select().from(jointAdmissionRecoveries).where(eq(jointAdmissionRecoveries.userId, conflictEnded)))[0]?.runId, "earlier");
  // R4: r4 keeps its ordinary A source and gains B.
  assert.deepEqual((await rows(r4)).map(row => [row.serverId, row.kind]).sort(), [[A, "admission"], [B, "recovery"]].sort());

  // The written tuples verify as live, and the source preview now shows them live.
  const tuples = written.map(([userId, serverId]) => ({ jointId: J, userId, serverId, generation: 1 }) as JointSourceTupleKey);
  assert.deepEqual((await runJointSourceVerify(db, tuples)).results.map(row => row.result), ["ok", "ok", "ok"]);
  const after = await runJointSourcePreview(db, J);
  assert.ok(written.every(([userId, serverId]) => after.tuples.live.some(row => row.userId === userId && row.serverId === serverId)));

  // Replay: every tuple now has a row; nothing new is written.
  const settled = await touchedTables(db);
  const replay = await runJointSourceRecoveryApply(db, plan, { runId: "run-2", approvalRef: "approval-2" });
  assert.equal(replay.counts.written, 0);
  assert.deepEqual(view(replay.tuples).filter(row => row.startsWith("orphan") || row.startsWith("r3") || row.startsWith("r4")),
    ["orphan@B:skipped_conflict:existing_recovery", "r3@C:skipped_conflict:existing_recovery", "r4@B:skipped_conflict:existing_recovery"]);
  assert.deepEqual(await touchedTables(db), settled);

  // #13330: re-adding someone who is already a member records no admission, so
  // the recovery row stays; an ordinary admission of that tuple upgrades it.
  await addHuman(aLocal, r3, { actorUserId: x.owner.id });
  assert.deepEqual((await rows(r3)).map(row => [row.serverId, row.kind]), [[C, "recovery"]], "re-add of a member does not upgrade");
  await db.transaction(tx => recordOrdinaryJointAdmissions(tx, sql`SELECT ${J}::uuid AS joint_channel_id,${r3}::uuid AS user_id,
    ${C}::uuid AS server_id,1 AS generation,now() AS admitted_at,${x.owner.id}::uuid AS admitted_by`));
  const [upgraded] = await rows(r3);
  assert.equal(upgraded?.kind, "admission"); assert.equal(upgraded?.admittedBy, x.owner.id);
  assert.equal((await db.select().from(jointAdmissionRecoveries).where(eq(jointAdmissionRecoveries.userId, r3)))[0]?.runId, "run-1", "the recovery record stays");

  const [heldMemberB] = await db.execute(sql`SELECT to_jsonb(sm) j FROM server_members sm WHERE server_id=${B}::uuid AND user_id=${held}::uuid`)
    .then(result => result.rows.map(row => (row as { j: unknown }).j));
  // ---- Release (cindyz 95c80f55): a host-side decision lifts the frozen hold
  // for trace server B only. C stays held; the ended A source is never revived.
  const releases = bindJointRecoveryReleases({ format: JOINT_RECOVERY_RELEASE_FORMAT,
    releases: [{ jointId: J, userId: held, generation: 1, serverId: B }] }, [plan], "decision-1");
  const heldView = (rows: Outcomes) => view(rows).filter(row => row.startsWith("held@"));
  const released = await runJointSourceRecoveryPreview(db, plan, { releases });
  assert.deepEqual(heldView(released.tuples), ["held@B:would_write:released_by_decision", "held@C:held_for_host_admin:held_at_scan"]);
  assert.equal(released.decisionRef, "decision-1");
  assert.deepEqual(released.heldForHostAdmin.find(row => row.userId === held)?.releasedServerIds, [B]);
  // A source that ended after the scan, on a server the decision was not about, re-holds the release.
  await admit(held, C, { endedAt: new Date() });
  assert.deepEqual(heldView((await runJointSourceRecoveryPreview(db, plan, { releases })).tuples),
    ["held@B:held_for_host_admin:ended_source_changed_since_decision", "held@C:held_for_host_admin:held_at_scan"]);
  await db.delete(jointChannelAdmissions).where(and(eq(jointChannelAdmissions.jointChannelId, J), eq(jointChannelAdmissions.userId, held)));
  // The released trace still passes every R2/R3a/R6 check: off B, it is not written.
  await db.delete(serverMembers).where(and(eq(serverMembers.serverId, B), eq(serverMembers.userId, held)));
  assert.deepEqual(heldView((await runJointSourceRecoveryPreview(db, plan, { releases })).tuples),
    ["held@B:skipped_invalid_target:not_server_member", "held@C:held_for_host_admin:held_at_scan"]);
  await db.execute(sql`INSERT INTO server_members SELECT * FROM jsonb_populate_record(NULL::server_members, ${JSON.stringify(heldMemberB)}::jsonb)`);
  // Without the release the same file still writes nothing for held.
  assert.deepEqual(heldView((await runJointSourceRecoveryApply(db, plan, { runId: "run-3", approvalRef: "approval-3" })).tuples),
    ["held@B:held_for_host_admin:held_at_scan", "held@C:held_for_host_admin:held_at_scan"]);
  assert.deepEqual(await rows(held), []);
  const releasedApply = await runJointSourceRecoveryApply(db, plan, { runId: "run-4", approvalRef: "approval-4", releases });
  assert.deepEqual(heldView(releasedApply.tuples), ["held@B:written:released_by_decision", "held@C:held_for_host_admin:held_at_scan"]);
  assert.equal(releasedApply.counts.written, 1, "only the released tuple is new");
  assert.deepEqual((await rows(held)).map(row => [row.serverId, row.kind, row.endedAt]), [[B, "recovery", null]]);
  assert.deepEqual((await db.select().from(jointAdmissionRecoveries).where(eq(jointAdmissionRecoveries.userId, held))).map(row => [row.serverId, row.runId, row.approvalRef]),
    [[B, "run-4", "approval-4"]]);
}
