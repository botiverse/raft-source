import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { test } from "vitest";
import { evaluateParity, summarizeGrowth, type ParityRow } from "../../scripts/rw-joint-member-parity";
import { dbTest } from "../test/integration/dbTest";
import { connected } from "../test/jointHumanMembershipScenarios";
import { channelHumans, jointChannelAdmissions, jointChannelMembers, jointChannelServers, jointMembershipDepartures, jointMembershipRemovals, serverMembers } from "../db/schema";
import { filterJointHumanMemberEntries, jointEntryIdentitySql, resolveJointHumanMembershipScopes } from "./jointHumanMembershipAccess";
import { asChannelId } from "@botiverse/raft-shared";

// Execute the committed RW membership definition as a PostgreSQL view over the
// same fixture rows as the real access predicate. This proves row semantics,
// not CDC freshness or RisingWave's optimizer/runtime (staging parity does that).
dbTest("RW joint membership is a subset of canonical access in every flag mode; equal for non-guests with source exit on", async ({ db, seed }) => {
  const x = await connected({ db, seed });
  const constraints = (await db.execute<{ table_name: string; is_nullable: string }>(sql`
    SELECT table_name,is_nullable FROM information_schema.columns WHERE table_schema='public'
      AND column_name='joined_at' AND table_name IN ('joint_channel_members','server_members','joint_channel_servers')
    ORDER BY table_name
  `)).rows;
  assert.deepEqual(constraints, ["joint_channel_members", "joint_channel_servers", "server_members"].map((name) => ({ table_name: name, is_nullable: "NO" })), "all three cutoff inputs are NOT NULL in the migrated database");
  const tables = {
    rw_joint_channel_members_v1: "SELECT joint_channel_id::text,user_id::text,generation,joined_at FROM joint_channel_members",
    rw_joint_channel_admissions_v1: "SELECT joint_channel_id::text,user_id::text,server_id::text,generation,ended_at FROM joint_channel_admissions",
    rw_joint_membership_departures_v1: "SELECT id::text,joint_channel_id::text,completed_at FROM joint_membership_departures",
    rw_joint_membership_removals_v1: "SELECT id::text,departure_id::text,user_id::text,remove_membership FROM joint_membership_removals",
    rw_joint_entry_server_members_v1: "SELECT server_id::text,user_id::text,role,guest_channel_id::text,joined_at FROM server_members",
    rw_joint_entry_projections_v1: "SELECT joint_channel_id::text,server_id::text,local_channel_id::text,role,status,joined_at FROM joint_channel_servers",
    rw_joint_channels: "SELECT id::text,canonical_channel_id::text,status FROM joint_channels",
    rw_channels: "SELECT id::text,server_id::text,type,deleted_at FROM channels",
    rw_servers: "SELECT id::text,deleted_at FROM servers",
    rw_channel_humans: "SELECT channel_id::text,user_id::text,joined_at FROM channel_humans",
  };
  for (const [name, query] of Object.entries(tables)) await db.execute(sql.raw(`CREATE TEMP VIEW ${name} AS ${query}`));
  const artifact = readFileSync(new URL("../../../../infra/risingwave/sql/081-computed-joint-members/07-rw_joint_human_entries_v1.sql", import.meta.url), "utf8");
  const definition = artifact.slice(artifact.indexOf("CREATE MATERIALIZED VIEW")).replace("CREATE MATERIALIZED VIEW", "CREATE TEMP VIEW");
  await db.execute(sql.raw(definition));
  const sharedArtifact = readFileSync(new URL("../../../../infra/risingwave/sql/081-computed-joint-members/08-rw_human_channel_members_v1.sql", import.meta.url), "utf8");
  await db.execute(sql.raw(sharedArtifact.slice(sharedArtifact.indexOf("CREATE MATERIALIZED VIEW")).replace("CREATE MATERIALIZED VIEW", "CREATE TEMP VIEW")));
  const scopes = [...(await resolveJointHumanMembershipScopes({ localChannelIds: [x.joint.channel.id, x.target.id] })).values()];
  const check = async (label: string, expected: readonly string[], nonGuest = true) => {
    const rows = (await db.execute<{ channel_id: string }>(sql`SELECT channel_id FROM rw_joint_human_entries_v1 WHERE user_id=${x.peer.id}`)).rows;
    const rw = new Set(rows.map((row) => asChannelId(row.channel_id)));
    assert.deepEqual([...rw].sort(), [...expected].sort(), label);
    for (const sourceExit of [false, true]) for (const guestEntryEnabled of [false, true]) {
      const pg = await filterJointHumanMemberEntries(scopes.map((scope) => ({ ...scope, sourceExit, guestEntryEnabled })), x.peer.id);
      assert.ok([...rw].every((id) => pg.has(id)), `${label}: RW never widens canonical access (${sourceExit}/${guestEntryEnabled})`);
      if (sourceExit && nonGuest) assert.deepEqual([...rw].sort(), [...pg].sort(), `${label}: non-guest equality with source exit on`);
    }
  };
  const both = [x.joint.channel.id, x.target.id];
  assert.equal((await db.select().from(channelHumans).where(and(eq(channelHumans.channelId, x.target.id), eq(channelHumans.userId, x.peer.id)))).length, 0);
  await check("computed target has no legacy CH row", both);
  await db.insert(channelHumans).values({ channelId: x.target.id, userId: x.peer.id }).onConflictDoNothing();
  await db.update(jointChannelAdmissions).set({ endedAt: new Date() }).where(eq(jointChannelAdmissions.userId, x.peer.id));
  await check("ended sources never authorize", []);
  assert.equal((await db.execute(sql`SELECT channel_id FROM rw_human_channel_members_v1 WHERE user_id=${x.peer.id} AND channel_id IN (${x.joint.channel.id},${x.target.id})`)).rows.length, 0, "legacy non-guest joint CH cannot bypass source denial");
  await db.update(jointChannelAdmissions).set({ endedAt: null }).where(eq(jointChannelAdmissions.userId, x.peer.id));
  await db.update(jointChannelMembers).set({ generation: 2 }).where(eq(jointChannelMembers.userId, x.peer.id));
  await check("an earlier episode cannot authorize", []);
  await db.update(jointChannelMembers).set({ generation: 1 }).where(eq(jointChannelMembers.userId, x.peer.id));
  await db.update(jointChannelServers).set({ status: "disconnected" }).where(eq(jointChannelServers.localChannelId, x.target.id));
  await check("a disconnected entry is absent", [x.joint.channel.id]);
  await db.update(jointChannelServers).set({ status: "active" }).where(eq(jointChannelServers.localChannelId, x.target.id));
  const [departure] = await db.insert(jointMembershipDepartures).values({
    jointChannelId: x.joint.jointChannel.id, serverId: x.a.id, localChannelId: x.joint.channel.id,
  }).returning();
  await db.insert(jointMembershipRemovals).values({ departureId: departure.id, userId: x.peer.id, removeMembership: true, completedAt: new Date() });
  await check("pending departure denies even a completed physical removal row", []);
  await db.update(jointMembershipDepartures).set({ completedAt: new Date() }).where(eq(jointMembershipDepartures.id, departure.id));
  await check("completed departure history is not a perpetual denial", both);
  await db.delete(serverMembers).where(and(eq(serverMembers.serverId, x.b.id), eq(serverMembers.userId, x.peer.id)));
  await check("server departure removes that entry", [x.joint.channel.id]);

  // An entry guest keeps exactly the CH behaviour it had before this move.
  // Its potential flag-off exposure is existing behaviour, explicitly retained
  // by Warden/Tenny; only the computed non-guest arm promises the subset rule.
  await db.update(serverMembers).set({ role: "guest", guestChannelId: x.joint.channel.id }).where(and(eq(serverMembers.serverId, x.a.id), eq(serverMembers.userId, x.peer.id)));
  await db.insert(channelHumans).values({ channelId: x.joint.channel.id, userId: x.peer.id }).onConflictDoNothing();
  await check("guest excluded from strict computed arm", [], false);
  const guestRows = (await db.execute<{ channel_id: string }>(sql`SELECT channel_id FROM rw_human_channel_members_v1 WHERE user_id=${x.peer.id} AND channel_id IN (${x.joint.channel.id},${x.target.id})`)).rows;
  assert.deepEqual(guestRows.map((r) => r.channel_id), [x.joint.channel.id], "host guest retains its existing CH row; stale non-guest copy does not");
  await db.delete(channelHumans).where(and(eq(channelHumans.channelId, x.joint.channel.id), eq(channelHumans.userId, x.peer.id)));
  assert.equal((await db.execute(sql`SELECT channel_id FROM rw_human_channel_members_v1 WHERE user_id=${x.peer.id} AND channel_id IN (${x.joint.channel.id},${x.target.id})`)).rows.length, 0, "guest without legacy CH gains no new entry");

  // Identity comparison uses the production predicate, including its host-bound
  // guest exception; only the strict computed arm excludes entry guests. The
  // separate compatibility arm above deliberately preserves guest CH rows.
  const identity = (await db.execute<{ ordinary: boolean; guest_on: boolean; guest_off: boolean }>(sql`
    SELECT ${jointEntryIdentitySql("sm", "p", [])} ordinary,
      ${jointEntryIdentitySql("g", "p", "ungated")} guest_on,
      ${jointEntryIdentitySql("g", "p", [])} guest_off
    FROM (SELECT 'member'::text role, NULL::uuid guest_channel_id) sm,
      (SELECT 'guest'::text role, ${x.joint.channel.id}::uuid guest_channel_id) g,
      (SELECT 'host'::text role, ${x.joint.channel.id}::uuid local_channel_id, ${x.joint.jointChannel.id}::uuid joint_channel_id) p
  `)).rows[0];
  assert.deepEqual(identity, { ordinary: true, guest_on: true, guest_off: false });
});


test("parity gate rejects an empty sample, guest regression, non-joint drift and inconsistent totals", () => {
  const row: ParityRow = { surface: "conversation", receiver_id: "human", server_id: "server", target_id: "joint", joint_family: true, guest_entry: false, copy_channel_id: "joint", copy_cursor_present: false, old_unread: null, new_unread: "2", old_mentions: null, new_mentions: "0", old_present: false, new_present: true };
  const expectation = { metric: "unread" as const, receiverId: "human", serverId: "server", targetId: "joint" };
  assert.equal(evaluateParity([], [expectation]).passed, false, "an empty comparison is not proof of the reported fix");
  assert.equal(evaluateParity([row], []).passed, false, "an unspecified positive target is not a gate");
  assert.equal(evaluateParity([row], [expectation]).passed, false, "sidebar counts alone do not prove Activity was fixed");
  const withActivity = [row, { ...row, surface: "activity" }];
  assert.equal(evaluateParity(withActivity, [expectation]).passed, true);
  const ordinaryDrift = evaluateParity([...withActivity, { ...row, target_id: "ordinary", joint_family: false }], [expectation]);
  assert.equal(ordinaryDrift.nonJointChanges.length, 1);
  assert.equal(ordinaryDrift.passed, false);
  const guestDrift = evaluateParity([...withActivity, { ...row, target_id: "guest-copy", guest_entry: true }], [expectation]);
  assert.equal(guestDrift.guestChanges.length, 1);
  assert.equal(guestDrift.passed, false);
  const wrongTotal = evaluateParity([...withActivity,
    { ...row, surface: "totals", target_id: "server", old_present: true, old_unread: "0", new_unread: "3" },
    { ...row, surface: "totals-derived", target_id: "server", old_unread: "0" },
  ], [expectation]);
  assert.equal(wrongTotal.expectationFailures.length, 0);
  assert.equal(wrongTotal.totalsMismatches.length, 1, "the badge must equal its served rows");
  assert.equal(wrongTotal.passed, false);
  const missingTotal = evaluateParity([...withActivity, { ...row, surface: "totals-derived", target_id: "server" }], [expectation]);
  assert.equal(missingTotal.totalsMismatches.length, 1, "missing totals cannot match nonzero served rows");
  assert.equal(missingTotal.passed, false);
  const mention = { ...row, surface: "mention", new_mentions: "1" };
  const mentionExpectation = { ...expectation, metric: "mention" as const };
  assert.equal(evaluateParity([mention], [mentionExpectation]).passed, false);
  assert.equal(evaluateParity([mention, { ...mention, surface: "activity" }], [mentionExpectation]).passed, true);
});


test("switch growth reports per-person additions, removal separately, distribution and maximum", () => {
  const row: ParityRow = { surface: "conversation", receiver_id: "human", server_id: "server", target_id: "joint", joint_family: true, guest_entry: false, copy_channel_id: "joint", copy_cursor_present: false, old_unread: "0", new_unread: "200", old_mentions: "0", new_mentions: "0", old_present: false, new_present: true };
  const report = summarizeGrowth([row,
    { ...row, target_id: "other-copy", old_unread: "600", new_unread: "0" },
    { ...row, surface: "mention", new_mentions: "8" },
    { ...row, joint_family: false, new_unread: "9000" },
    { ...row, surface: "activity", new_unread: "200" },
  ], ["human", "unaffected"]);
  assert.deepEqual(report.users[0], { receiverId: "human", unreadAdded: "200", unreadRemoved: "600", mentionsAdded: "8", mentionsRemoved: "0", affectedCopyCount: 1, copiesWithoutCursor: ["joint"] });
  assert.equal(report.affectedPeopleWithoutCopyCursor, 1);
  assert.equal(report.affectedCopiesWithoutCursor, 1);
  assert.equal(report.unread.maximum, "200");
  assert.equal(report.unread.hundredTo499, 1);
  assert.equal(report.unread.zero, 1);
  assert.equal(report.mentions.maximum, "8");
  assert.equal(report.mentions.oneToNine, 1);
});
