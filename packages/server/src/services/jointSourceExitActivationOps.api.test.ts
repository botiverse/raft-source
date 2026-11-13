import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db";
import { channels, featureFlags, jointChannels, jointChannelServers, servers } from "../db/schema";
import { dbTest } from "../test/integration/dbTest";
import { setJointFlags, sourceExitJoint } from "../test/jointSourceExitScenario";
import { removeHuman } from "./channelService";
import { evaluateFeatureFlag, getFeatureFlagConfigVersion } from "./featureFlagService";
import { JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY } from "./jointHumanMembershipAccess";
import { removeMember } from "./serverService";
import { activationAuditEventId, activationHostsDigest, parseActivationActor, parseActivationHostsFile, parseActivationHostsFileText,
  runActivationApply, runActivationDryRun } from "../../scripts/activate-joint-source-exit";

/** Every table activation reads or writes, by row count and full-row hash. */
async function touchedTables(db: Database) {
  const tables = ["feature_flags", "feature_flag_rules", "feature_flag_config_versions", "joint_channels", "joint_channel_members",
    "joint_channel_admissions", "joint_channel_servers", "servers", "channels"];
  const out: Record<string, unknown> = {};
  for (const table of tables) out[table] = (await db.execute(sql.raw(`SELECT count(*)::int n,
    md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY to_jsonb(t)::text), '')) h FROM ${table} t`))).rows[0];
  return out;
}

/** A raw joint record created by `creator`: canonical channel of `type` on the
 * creator, and a role='host' projection on `roleHost` (default the creator; null: none). */
async function rawJoint(db: Database, creator: string, shape: { type?: "joint" | "thread" | "channel"; status?: "active" | "closed"; roleHost?: string | null }) {
  const [canonical] = await db.insert(channels).values({ serverId: creator, name: `act-${randomUUID().slice(0, 8)}`, type: shape.type ?? "joint" }).returning();
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical!.id, createdByServerId: creator,
    status: shape.status ?? "active" }).returning();
  const roleHost = shape.roleHost === undefined ? creator : shape.roleHost;
  if (roleHost) {
    const local = roleHost === creator ? canonical! : (await db.insert(channels).values({ serverId: roleHost, name: `act-${randomUUID().slice(0, 8)}`, type: shape.type ?? "joint" }).returning())[0]!;
    await db.insert(jointChannelServers).values({ jointChannelId: joint!.id, serverId: roleHost, localChannelId: local.id, role: "host" });
  }
  return joint!.id;
}

dbTest("activate-joint-source-exit: dry-run selects active top-level hosts and writes nothing; apply binds the reviewed list and refuses or activates once", async ({ db, seed }) => {
  await setJointFlags(db, false);
  const x = await sourceExitJoint({ db, seed }, "activation-ops-x"), y = await sourceExitJoint({ db, seed }, "activation-ops-y");
  const server = () => seed.server({ owner: x.hostOwner });
  const threadOnly = await server(), closed = await server(), deletedServer = await server();
  const creator = await server(), roleHostOnly = await server(), noProjection = await server(), converting = await server();
  await rawJoint(db, threadOnly.id, { type: "thread" });
  await rawJoint(db, closed.id, { status: "closed" });
  await rawJoint(db, deletedServer.id, {});
  await db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, deletedServer.id));
  const moved = await rawJoint(db, creator.id, { roleHost: roleHostOnly.id });
  const orphanJoint = await rawJoint(db, noProjection.id, { roleHost: null });
  await rawJoint(db, converting.id, { type: "channel" }); // in-flight conversion: canonical/host channel not yet 'joint'
  const hosts = [x.h.id, y.h.id, creator.id, noProjection.id, converting.id].sort();

  // ---- dry-run: selection, digest, flag state; read-only.
  const untouched = await touchedTables(db);
  const all = await runActivationDryRun(db, { allActiveHosts: true });
  assert.deepEqual(all.hostIds, hosts, "creators of active top-level joints: not a role-host-only server, participant, thread record, closed joint or deleted server");
  assert.deepEqual(all.hosts.map((host) => [host.id, host.activeTopLevelJoints, host.exists, host.deleted]), hosts.map((id) => [id, 1, true, false]));
  assert.deepEqual([all.withoutLiveSource, all.withoutLiveSourceTotal, all.wouldActivate, all.blockers], [[], 0, true, []]);
  assert.deepEqual(all.hostMismatch.joints, [
    { jointId: moved, creatorServerId: creator.id, roleHostServerIds: [roleHostOnly.id] },
    { jointId: orphanJoint, creatorServerId: noProjection.id, roleHostServerIds: [] },
  ].sort((a, b) => a.jointId.localeCompare(b.jointId)));
  assert.deepEqual([all.hostMismatch.creatorNotRoleHost, all.hostMismatch.roleHostNotCreator, all.hostMismatch.truncated],
    [[creator.id, noProjection.id].sort(), [roleHostOnly.id], false]);
  assert.ok(all.warnings.some((warning) => warning.startsWith("creator_role_host_mismatch")));
  assert.deepEqual([all.flag.exists, all.flag.enabled, all.flag.defaultEnabled, all.flag.killSwitch, all.flag.rules],
    [true, true, false, false, []]);
  assert.equal(all.expectedConfigVersion, await getFeatureFlagConfigVersion());
  assert.equal(all.hostsDigest, activationHostsDigest([...hosts].reverse().map((id, i) => i === 0 ? id.toUpperCase() : id).concat(x.h.id)), "digest is order, case and duplicate independent");
  assert.notEqual(all.hostsDigest, activationHostsDigest([x.h.id]));
  const explicit = await runActivationDryRun(db, { hostIds: [...hosts].reverse() });
  assert.equal(explicit.hostsDigest, all.hostsDigest);
  const odd = await runActivationDryRun(db, { hostIds: [x.h.id, threadOnly.id, randomUUID()] });
  assert.deepEqual(odd.blockers, ["unknown_or_deleted_hosts"]);
  assert.ok(odd.warnings.some((warning) => warning.startsWith("host_without_active_top_level_joint")));
  await assert.rejects(runActivationDryRun(db, { allActiveHosts: true, requireReplica: true }), /requires a read replica/);
  await assert.rejects(runActivationDryRun(db, { allActiveHosts: true, hostIds: hosts }), /either explicit hosts or --all-active-hosts/);
  assert.deepEqual(parseActivationHostsFile([...hosts].reverse()), hosts);
  assert.throws(() => parseActivationHostsFile({ hosts }), /JSON array/);
  // Not JSON at all (a JSON-lines dump): a message that says what to give, not operation_failed.
  assert.throws(() => parseActivationHostsFileText(`${JSON.stringify(hosts[0])}\n${JSON.stringify(hosts[1])}\n`), /not valid JSON: give a JSON array of host server UUIDs/);
  assert.throws(() => parseActivationHostsFileText(JSON.stringify({ event: "end", hostIds: hosts })), /JSON array of host server UUID strings/);
  assert.deepEqual(parseActivationHostsFileText(JSON.stringify([...hosts].reverse())), hosts);
  assert.throws(() => parseActivationHostsFile(["not-a-uuid"]), /Invalid host/);
  assert.throws(() => parseActivationActor("system:x"), /--actor must be/);
  assert.deepEqual(await touchedTables(db), untouched, "dry-run writes nothing");

  // ---- A member without a live source: dry-run reports it, apply refuses with the counts.
  const orphan = await x.viaB();
  await removeMember(x.b.id, orphan.id, { reason: "left" });
  const blocked = await runActivationDryRun(db, { allActiveHosts: true });
  assert.deepEqual(blocked.withoutLiveSource, [{ hostServerId: x.h.id, jointId: x.J, members: 1 }]);
  assert.deepEqual([blocked.withoutLiveSourceTotal, blocked.wouldActivate, blocked.blockers], [1, false, ["members_without_live_source"]]);

  const base = { hostIds: hosts, hostsDigest: all.hostsDigest!, expectedConfigVersion: blocked.expectedConfigVersion,
    runId: "run-1", approvalRef: "approval-1", actor: { type: "agent" as const, id: "warden" } };
  const before = await touchedTables(db);
  await assert.rejects(runActivationApply(db, { ...base, hostsDigest: activationHostsDigest([x.h.id]) }), /does not match the host list/);
  await assert.rejects(runActivationApply(db, { ...base, hostsDigest: "f".repeat(64) }), /does not match the host list/);
  await assert.rejects(runActivationApply(db, { ...base, runId: "" }), /requires --run-id and --approval-reference/);
  await assert.rejects(runActivationApply(db, { ...base, approvalRef: " " }), /requires --run-id and --approval-reference/);
  await assert.rejects(runActivationApply(db, { ...base, expectedConfigVersion: -1 }), /expected-config-version/);
  await db.execute(sql`SET default_transaction_read_only = on`);
  try { await assert.rejects(runActivationApply(db, base), /requires a writable primary/); }
  finally { await db.execute(sql`SET default_transaction_read_only = off`); }
  await assert.rejects(runActivationApply(db, { ...base, checkWindow: () => { throw new Error("window closed"); } }), /Approved write window/);
  assert.deepEqual(await runActivationApply(db, { ...base, expectedConfigVersion: base.expectedConfigVersion + 1 }),
    { status: "config_version_conflict", currentVersion: base.expectedConfigVersion });
  const stranger = [x.h.id, randomUUID()];
  const unknown = await runActivationApply(db, { ...base, hostIds: stranger, hostsDigest: activationHostsDigest(stranger) });
  assert.equal(unknown.status, "unknown_or_deleted_hosts");
  assert.deepEqual(await runActivationApply(db, base), { status: "refused_members_without_live_source",
    withoutLiveSource: [{ hostServerId: x.h.id, jointId: x.J, members: 1 }], total: 1 });
  assert.deepEqual(await touchedTables(db), before, "every refusal writes nothing");
  assert.equal((await evaluateFeatureFlag({ key: JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY, serverId: x.h.id }, db)).enabled, false);

  // ---- Success: exactly the listed hosts, config version bumped, audit id recorded, read back.
  await removeHuman(x.hLocal, orphan.id, { self: true });
  const ready = await runActivationDryRun(db, { hostIds: hosts });
  assert.equal(ready.wouldActivate, true);
  const activated = await runActivationApply(db, { ...base, expectedConfigVersion: ready.expectedConfigVersion });
  assert.equal(activated.status, "activated");
  if (activated.status !== "activated" || "error" in activated.readBack) throw new Error("expected an activation with a read-back");
  const auditEventId = activationAuditEventId({ runId: "run-1", approvalRef: "approval-1", hostsDigest: base.hostsDigest });
  assert.deepEqual([activated.auditEventId, activated.values, activated.configVersion], [auditEventId, hosts, ready.expectedConfigVersion + 1]);
  assert.deepEqual(activated.readBack.rule, { id: activated.ruleId, stage: "server", decision: "allow", values: hosts });
  assert.deepEqual([activated.readBack.configVersion, activated.readBack.configUpdatedBy, activated.readBack.configLastAuditEventId],
    [ready.expectedConfigVersion + 1, "operator:agent:warden#run=run-1", auditEventId], "the config-version audit row names the run");
  assert.deepEqual(activated.readBack.evaluations, hosts.map((hostServerId) => ({ hostServerId, enabled: true, reason: "server_rule" })));
  assert.equal((await evaluateFeatureFlag({ key: JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY, serverId: x.b.id }, db)).enabled, false, "an unlisted server stays off");

  // ---- A second run: dry-run shows the rule, apply refuses (first rule only) and writes nothing.
  const again = await runActivationDryRun(db, { hostIds: hosts });
  assert.deepEqual(again.blockers, ["server_rule_exists"]);
  assert.deepEqual(again.flag.rules.map((rule) => [rule.id, rule.stage, rule.values]), [[activated.ruleId, "server", hosts]]);
  const after = await touchedTables(db);
  assert.deepEqual(await runActivationApply(db, { ...base, expectedConfigVersion: again.expectedConfigVersion }), { status: "server_rule_exists" });
  assert.deepEqual(await touchedTables(db), after);
});

dbTest("activate-joint-source-exit: a missing flag row is reported, never created, and nothing is written", async ({ db, seed }) => {
  await setJointFlags(db, false);
  const x = await sourceExitJoint({ db, seed }, "activation-ops-missing");
  await db.delete(featureFlags).where(eq(featureFlags.key, JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY));
  const dry = await runActivationDryRun(db, { allActiveHosts: true });
  assert.deepEqual([dry.hostIds, dry.flag.exists, dry.wouldActivate, dry.blockers], [[x.h.id], false, false, ["flag_row_missing"]]);
  const before = await touchedTables(db);
  assert.deepEqual(await runActivationApply(db, { hostIds: [x.h.id], hostsDigest: dry.hostsDigest!, expectedConfigVersion: dry.expectedConfigVersion,
    runId: "run-2", approvalRef: "approval-2", actor: { type: "human", id: "operator" } }), { status: "flag_row_missing" });
  assert.deepEqual(await touchedTables(db), before);
});
