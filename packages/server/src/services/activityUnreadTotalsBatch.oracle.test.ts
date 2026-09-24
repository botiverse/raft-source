import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
/**
 * task #235 DoD 9c/9d: oracle equality for the set-based Activity unread batch.
 *
 * The retired per-server authority path — `getInboxItems(filter=all)` — stays
 * alive as the TEST ORACLE. Every fixture state runs through BOTH the oracle
 * (per server) and `getActivityUnreadTotalsBatch` (one call, all servers), and
 * the per-server numbers must be equal. Any predicate drift between the batch
 * SQL and the authority chain turns this file red.
 *
 * Backend coverage (contract v2.3.1 §2 reachability, DoD 9d):
 * - **PG serving-rows (Sink B)** — EXERCISED here. `isHumanActivityMuteEnabled`
 *   is unconditionally true (channelService.ts:1072-1084, code-level launch
 *   2026-06-30), so the authority call `getInboxItems(serverId, userId,
 *   {filter:"all", historyCutoff})` always satisfies the serving-rows entry
 *   predicate `(humanActivityMuteEnabled || historyCutoff)`; this pglite
 *   harness has no RisingWave pool, so the serving-rows branch is the branch
 *   the oracle actually runs below.
 * - **RisingWave direct-query builder** — NOT EXERCISED (declared, not
 *   skipped silently): no RW harness exists in this repo's test setup
 *   (`getRisingWaveInboxPool()` is null under pglite). RW/PG row parity is
 *   owned by `risingwave:verify-inbox-parity` per the rfcs/024 contract.
 * - **PG legacy inline** — NOT EXERCISED (declared): unreachable for this
 *   authority computation. Entry requires `!(humanActivityMuteEnabled ||
 *   historyCutoff) || forceCanonicalPostgres`; mute is unconditionally true
 *   and the unread-summary loader never sets `forceCanonicalPostgres`, so no
 *   route-reachable configuration selects it (channelService.ts:9262-9283).
 */
import assert from "node:assert/strict";

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { serverMembers, users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import {
  __testRisingWaveInboxFailSoft,
  addHuman,
  createChannel,
  getActivityUnreadTotalsBatch,
  getInboxItems,
  isHumanActivityMuteEnabled,
  markReadLatest,
} from "../services/channelService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email: `${name}@slock.test`,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}



type Totals = { totalUnreadCount: number; activeUnreadCount: number };

/**
 * Seed messages through the HTTP route: serving rows are projected from the
 * notification pipeline, which the full send path runs and the bare
 * `createMessage` service deliberately does not. The oracle and the batch
 * read the same serving rows either way — but route-seeded fixtures are the
 * ones that actually produce nonzero unread states.
 */
async function postMessage(
  baseUrl: string,
  token: string,
  serverId: string,
  channelId: string,
  content: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Server-Id": serverId,
    },
    body: JSON.stringify({ channelId, content }),
  });
  assert.equal(res.status, 200);
}

async function oracleTotals(
  serverId: string,
  userId: string,
  historyCutoff?: Date,
  limit = 1,
): Promise<Totals> {
  const result = await getInboxItems(serverId, userId, {
    filter: "all",
    limit,
    offset: 0,
    historyCutoff,
  });
  return {
    totalUnreadCount: result.totalUnreadCount,
    activeUnreadCount: result.activeUnreadCount,
  };
}

test("batch equals per-server oracle across contract states (DoD 9d) and empty server is present-0 (DoD 9c)", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("orc-owner");
  const member = await seedUser("orc-member");

  // Serving-rows is the branch the oracle takes (see file header): assert
  // the predicate input so a future re-flag of mute turns this file red
  // instead of silently moving the oracle onto an unexercised backend.
  assert.equal(await isHumanActivityMuteEnabled("any", member.id), true,
    "mute flag expected unconditionally true; oracle backend assumption broken");

  // Server A (positive): one joined channel with unread, plus a mention in
  // a channel the member did NOT join (mention-only fallback row: visible,
  // but contributes 0 to both aggregates on the serving backend).
  const serverA = await createServer("Oracle A", "oracle-a-srv", owner.id);
  await db.insert(serverMembers).values({ serverId: serverA.id, userId: member.id, role: "member" });
  const joinedA = await createChannel(serverA.id, "a-joined");
  await addHuman(joinedA.id, owner.id);
  await addHuman(joinedA.id, member.id);
  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);
  // The member's own message goes FIRST: sending born-reads the channel for
  // the sender, so posting after the owner's messages would zero the state.
  // Ordered this way, the fixture pins both semantics at once: the member's
  // own message never counts, the owner's two later messages do.
  await postMessage(app.baseUrl, memberToken, serverA.id, joinedA.id, "a own first");
  await postMessage(app.baseUrl, ownerToken, serverA.id, joinedA.id, "a unread 1");
  await postMessage(app.baseUrl, ownerToken, serverA.id, joinedA.id, "a unread 2");
  const mentionRoomA = await createChannel(serverA.id, "a-mention-room");
  await addHuman(mentionRoomA.id, owner.id);
  await postMessage(app.baseUrl, ownerToken, serverA.id, mentionRoomA.id, `@${member.name} ping`);

  // Server B (known zero): activity exists but the member is caught up.
  const serverB = await createServer("Oracle B", "oracle-b-srv", owner.id);
  await db.insert(serverMembers).values({ serverId: serverB.id, userId: member.id, role: "member" });
  const joinedB = await createChannel(serverB.id, "b-joined");
  await addHuman(joinedB.id, owner.id);
  await addHuman(joinedB.id, member.id);
  await postMessage(app.baseUrl, ownerToken, serverB.id, joinedB.id, "b read later");
  await markReadLatest(member.id, joinedB.id);

  // Server C (empty, DoD 9c): membership exists, zero channels/serving rows.
  // The batch must anchor on the INPUT list and return present-0, never drop
  // the group into false absence.
  const serverC = await createServer("Oracle C", "oracle-c-srv", owner.id);
  await db.insert(serverMembers).values({ serverId: serverC.id, userId: member.id, role: "member" });

  // Server D (history cutoff): one channel whose whole activity predates the
  // cutoff (excluded row-wise), one with activity after it (included).
  const serverD = await createServer("Oracle D", "oracle-d-srv", owner.id);
  await db.insert(serverMembers).values({ serverId: serverD.id, userId: member.id, role: "member" });
  const oldRoomD = await createChannel(serverD.id, "d-old");
  await addHuman(oldRoomD.id, owner.id);
  await addHuman(oldRoomD.id, member.id);
  await postMessage(app.baseUrl, ownerToken, serverD.id, oldRoomD.id, "d before cutoff");
  const newRoomD = await createChannel(serverD.id, "d-new");
  await addHuman(newRoomD.id, owner.id);
  await addHuman(newRoomD.id, member.id);
  await postMessage(app.baseUrl, ownerToken, serverD.id, newRoomD.id, "d after cutoff");
  // Shift the old room's activity deterministically before the cutoff; the
  // oracle and the batch read the same shifted rows, so equality still
  // proves predicate parity while the cutoff provably bites.
  await db.execute(sql`
    UPDATE inbox_serving_rows
    SET last_activity_at = last_activity_at - interval '1 hour'
    WHERE source_channel_id = ${oldRoomD.id}
  `);
  const cutoffD = new Date(Date.now() - 5 * 60_000);

  const inputs = [
    { serverId: serverA.id },
    { serverId: serverB.id },
    { serverId: serverC.id },
    { serverId: serverD.id, historyCutoff: cutoffD },
  ];

  // ONE batch call over all four servers.
  const batch = await getActivityUnreadTotalsBatch(inputs, member.id);

  // 9d: per-server equality against the oracle, at limit=1 AND limit=100
  // (the oracle aggregate is pagination-invariant; comparing both windows
  // pins that the batch matched the aggregate, not a page artifact).
  for (const input of inputs) {
    const oracle1 = await oracleTotals(input.serverId, member.id, input.historyCutoff, 1);
    const oracle100 = await oracleTotals(input.serverId, member.id, input.historyCutoff, 100);
    assert.deepEqual(oracle1, oracle100,
      `oracle aggregates must be pagination-invariant (server ${input.serverId})`);
    const batched = batch.get(input.serverId);
    assert.ok(batched, `batch must return an entry for input server ${input.serverId}`);
    assert.deepEqual(batched, oracle1,
      `batch totals must equal oracle totals (server ${input.serverId})`);
  }

  // State sanity (the fixtures really produced the states the contract
  // names — equality between two zeros proves less than equality between
  // two nonzero states).
  assert.equal(batch.get(serverA.id)!.totalUnreadCount > 0, true,
    "server A fixture must be a positive state");
  assert.equal(batch.get(serverB.id)!.totalUnreadCount, 0,
    "server B fixture must be known zero");
  assert.deepEqual(batch.get(serverC.id), { totalUnreadCount: 0, activeUnreadCount: 0 },
    "empty member server must be present-0 (9c), never absent");
  const dNoCutoff = await oracleTotals(serverD.id, member.id, undefined, 100);
  assert.equal(batch.get(serverD.id)!.totalUnreadCount < dNoCutoff.totalUnreadCount, true,
    "server D cutoff must exclude pre-cutoff activity (cutoff fixture must bite)");

  // Batch with a single server behaves identically (N=1 degenerate form).
  const single = await getActivityUnreadTotalsBatch([{ serverId: serverA.id }], member.id);
  assert.deepEqual(single.get(serverA.id), batch.get(serverA.id));

  // A server the user has no relationship to still yields a row (the query
  // anchors on input): totals are 0 — route-level membership listing is what
  // keeps non-members out of the response, not this computation.
  const strangerBatch = await getActivityUnreadTotalsBatch(
    [{ serverId: serverA.id }],
    owner.id,
  );
  const ownerOracle = await oracleTotals(serverA.id, owner.id, undefined, 100);
  assert.deepEqual(strangerBatch.get(serverA.id), ownerOracle,
    "batch must equal oracle for a different principal too");

  // Empty input: no rows, no query surprises.
  const empty = await getActivityUnreadTotalsBatch([], member.id);
  assert.equal(empty.size, 0);

  // Unauthorized fail-closed (§5): membership revoked between the route's
  // listing and the computation. The in-statement server_members join drops
  // the revoked group — unknown/absent, never a count and never a fake 0 —
  // while sibling servers are untouched.
  await db.delete(serverMembers).where(and(
    eq(serverMembers.serverId, serverB.id),
    eq(serverMembers.userId, member.id),
  ));
  const revoked = await getActivityUnreadTotalsBatch(inputs, member.id);
  assert.equal(revoked.has(serverB.id), false,
    "revoked membership must drop the group (absent), not report a number");
  assert.deepEqual(revoked.get(serverA.id), batch.get(serverA.id),
    "sibling servers unaffected by one revocation");
  assert.deepEqual(revoked.get(serverC.id), batch.get(serverC.id));

  // Backend-consistency guard: with RFC056 serving mode "on" AND an RW pool
  // configured, Home's inbox authority can serve RW-computed totals, so the
  // PG batch must fail closed (whole batch unknown) rather than assert a
  // number Home might not show. "shadow" keeps Postgres authoritative and
  // must stay computable.
  try {
    __testRisingWaveInboxFailSoft.setDeps({
      getRfc056ServingMode: () => "on",
      getPool: () => ({} as never),
    });
    const rwLive = await getActivityUnreadTotalsBatch(inputs, member.id);
    assert.equal(rwLive.size, 0,
      "RW live serving mode + pool present must fail closed to all-unknown");
    __testRisingWaveInboxFailSoft.setDeps({
      getRfc056ServingMode: () => "shadow",
    });
    const rwShadow = await getActivityUnreadTotalsBatch(inputs, member.id);
    assert.deepEqual(rwShadow.get(serverA.id), batch.get(serverA.id),
      "shadow mode keeps Postgres authoritative — batch must compute");
  } finally {
    __testRisingWaveInboxFailSoft.reset();
  }
});
