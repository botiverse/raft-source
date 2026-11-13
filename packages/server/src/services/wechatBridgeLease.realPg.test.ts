// Real-PostgreSQL teeth for the WeChat bridge worker's single poller per
// binding (services/wechatBridgeWorker.ts). PGlite serializes every
// transaction on one connection, so racing claims and a stale replica's
// writes against the current holder's can only be proven against a real
// multi-connection Postgres. CI runs this through the hosted Test workflow
// (`pnpm --filter @botiverse/raft-server test:wechat-bridge-lease-real-pg`);
// locally: a scratch postgres + the same env.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import {
  agents,
  channelHumans,
  channels,
  featureFlagRules,
  featureFlags,
  integrationAuditEvents,
  serverMembers,
  servers,
  users,
  wechatBridgeBindings,
  wechatBridgeInboundMessages,
  wechatBridgeOutboundMessages,
} from "../db/schema";
import { ASSISTANT_WECHAT_FEATURE_FLAG_KEY, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY } from "./featureFlagService";
import { parseSyncHorizon, type SyncHorizon } from "./syncHorizon";
import { WECHAT_BRIDGE_CREDENTIAL_KEY_ENV, wechatBridgeCredentialCipher } from "./wechatBridgeCredentialCipher";
import {
  advanceWeChatOutboundCursor,
  advanceWeChatUpdatesCursor,
  claimWeChatBindingLease,
  claimWeChatGreeting,
  claimWeChatNoReplyNotice,
  failStaleWeChatOutbound,
  recordWeChatOutbound,
  releaseWeChatBindingLease,
  renewWeChatBindingLease,
  tagWeChatInbound,
  takeWeChatUnmirroredCount,
  WECHAT_BRIDGE_LEASE_MS,
  WeChatBindingRunner,
  weChatBindingGateOpen,
} from "./wechatBridgeWorker";
import { createWeChatILinkClient, type ILinkBotId, type ILinkBotToken, type ILinkUserId, type WeChatContextToken } from "./wechatILinkClient";

const REAL_PG_URL = process.env.WECHAT_BRIDGE_LEASE_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.WECHAT_BRIDGE_LEASE_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

function horizon(value: string): SyncHorizon {
  const parsed = parseSyncHorizon(value);
  assert.ok(parsed);
  return parsed;
}

async function withRealPg(run: (pool: pg.Pool) => Promise<void>): Promise<void> {
  if (!REAL_PG_URL) {
    if (REAL_PG_REQUIRED) throw new Error("WECHAT_BRIDGE_LEASE_REAL_PG_REQUIRED=1 but WECHAT_BRIDGE_LEASE_REAL_PG_URL is unset");
    return;
  }
  const savedKey = process.env[WECHAT_BRIDGE_CREDENTIAL_KEY_ENV];
  process.env[WECHAT_BRIDGE_CREDENTIAL_KEY_ENV] = Buffer.alloc(32, 9).toString("base64");
  const pool = new pg.Pool({ connectionString: REAL_PG_URL, max: 12 });
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  await initDatabase(REAL_PG_URL);
  try {
    await run(pool);
  } finally {
    await closeDatabase();
    await pool.end();
    if (savedKey === undefined) delete process.env[WECHAT_BRIDGE_CREDENTIAL_KEY_ENV]; else process.env[WECHAT_BRIDGE_CREDENTIAL_KEY_ENV] = savedKey;
  }
}

async function seedBinding(): Promise<string> {
  return (await seedBindingWithParties()).bindingId;
}

async function seedBindingWithParties() {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [user] = await db.insert(users).values({
    email: `wxl-realpg-${suffix}@raft.test`,
    name: `wxl-realpg-${suffix}`,
    displayName: "wechat lease",
    passwordHash: "x",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const [server] = await db.insert(servers).values({ name: `wxl-${suffix}`, slug: `wxl-${suffix}`, ownerId: user!.id }).returning();
  const [agent] = await db.insert(agents).values({ serverId: server!.id, name: `wxl-${suffix}`, runtime: "external", model: "external", assistantOwnerUserId: user!.id }).returning();
  const [dm] = await db.insert(channels).values({ serverId: server!.id, name: `dm-wxl-${suffix}`, type: "dm" }).returning();
  const bindingId = randomUUID();
  const ilinkBotId = `bot-${suffix}@im.bot` as ILinkBotId;
  const sealed = wechatBridgeCredentialCipher()!.seal({ bindingId, userId: user!.id, ilinkBotId, botToken: `token-${suffix}` as ILinkBotToken });
  await db.insert(wechatBridgeBindings).values({
    id: bindingId,
    serverId: server!.id,
    userId: user!.id,
    agentId: agent!.id,
    dmChannelId: dm!.id,
    ilinkBotId,
    ilinkUserId: `user-${suffix}@im.wechat` as ILinkUserId,
    baseUrl: "https://ilinkai.weixin.qq.com",
    ...sealed,
    state: "active",
    outboundSeq: 0,
  });
  return { bindingId, ownerId: user!.id, serverId: server!.id, agentId: agent!.id, dmChannelId: dm!.id };
}

async function row(bindingId: string) {
  const [binding] = await getDb().select().from(wechatBridgeBindings).where(eq(wechatBridgeBindings.id, bindingId));
  return binding!;
}

test("racing claims on separate connections elect exactly one poller per binding", async () => {
  await withRealPg(async () => {
    const bindingId = await seedBinding();
    const now = new Date();
    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => claimWeChatBindingLease({ bindingId, owner: `replica-${i}`, now })));
    const winners = claims.filter((claim) => claim !== null);
    assert.equal(winners.length, 1);
    const current = await row(bindingId);
    assert.equal(current.leaseOwner, winners[0]!.owner);
    assert.equal(current.leaseGeneration, 1);
    assert.equal(winners[0]!.generation, 1);
    // Held and unexpired: nobody else gets it, the holder included.
    assert.equal(await claimWeChatBindingLease({ bindingId, owner: "late-replica", now: new Date(now.getTime() + 1_000) }), null);
  });
});

test("a replica whose lease was taken over cannot move get_updates_buf or outbound_seq, even racing the new holder", async () => {
  await withRealPg(async () => {
    const bindingId = await seedBinding();
    const t0 = new Date();
    const stale = await claimWeChatBindingLease({ bindingId, owner: "replica-a", now: t0 });
    assert.ok(stale);
    assert.equal(await advanceWeChatUpdatesCursor(stale, "buf-a-1", t0), true);
    assert.equal(await advanceWeChatOutboundCursor(stale, { seq: 10, horizon: horizon("100") }), true);

    // replica-a stalls past its lease; replica-b takes the binding over.
    const later = new Date(t0.getTime() + WECHAT_BRIDGE_LEASE_MS + 1_000);
    const current = await claimWeChatBindingLease({ bindingId, owner: "replica-b", now: later });
    assert.ok(current);
    assert.equal(current.generation, stale.generation + 1);

    // The stale holder's writes all miss, alone and racing the holder's on other connections.
    const [aBuf, bBuf, aSeq, bSeq] = await Promise.all([
      advanceWeChatUpdatesCursor(stale, "buf-a-2", later),
      advanceWeChatUpdatesCursor(current, "buf-b-1", later),
      advanceWeChatOutboundCursor(stale, { seq: 99, horizon: horizon("999") }),
      advanceWeChatOutboundCursor(current, { seq: 20, horizon: horizon("200") }),
    ]);
    assert.deepEqual([aBuf, bBuf, aSeq, bSeq], [false, true, false, true]);
    assert.equal(await renewWeChatBindingLease(stale, later), null, "the stale holder cannot renew either");
    await releaseWeChatBindingLease(stale);
    const after = await row(bindingId);
    assert.deepEqual(
      { buf: after.getUpdatesBuf, seq: after.outboundSeq, horizon: after.outboundHorizon, owner: after.leaseOwner, generation: after.leaseGeneration },
      { buf: "buf-b-1", seq: 20, horizon: "200", owner: "replica-b", generation: current.generation },
    );

    // Many rounds of both racing: the stale holder never lands one.
    for (let round = 0; round < 20; round += 1) {
      const results: boolean[] = await Promise.all([
        advanceWeChatUpdatesCursor(stale, `stale-${round}`, later),
        advanceWeChatUpdatesCursor(current, `current-${round}`, later),
      ]);
      assert.deepEqual(results, [false, true]);
    }
    assert.equal((await row(bindingId)).getUpdatesBuf, "current-19");

    // Once released, the next claim moves the generation on again.
    await releaseWeChatBindingLease(current);
    const next = await claimWeChatBindingLease({ bindingId, owner: "replica-c", now: later });
    assert.equal(next?.generation, current.generation + 1);
  });
});

test("a binding that needs a reconnect is not claimed and its cursor does not move", async () => {
  await withRealPg(async () => {
    const bindingId = await seedBinding();
    const lease = await claimWeChatBindingLease({ bindingId, owner: "replica-a", now: new Date() });
    assert.ok(lease);
    await getDb().update(wechatBridgeBindings).set({ state: "reconnect_required" }).where(eq(wechatBridgeBindings.id, bindingId));
    assert.equal(await advanceWeChatUpdatesCursor(lease, "buf-x", new Date()), false);
    assert.equal(await advanceWeChatOutboundCursor(lease, { seq: 5, horizon: null }), false);
    await releaseWeChatBindingLease(lease);
    assert.equal(await claimWeChatBindingLease({ bindingId, owner: "replica-b", now: new Date(Date.now() + WECHAT_BRIDGE_LEASE_MS * 2) }), null);
  });
});

test("an assistant message whose transaction commits after the mirror read past its seq is still mirrored (the read horizon)", async () => {
  await withRealPg(async (pool) => {
    const parties = await seedBindingWithParties();
    const db = getDb();
    // The gate: both flags on for the owner, who is a member of the server and of the DM.
    await db.insert(serverMembers).values({ serverId: parties.serverId, userId: parties.ownerId, role: "owner" }).onConflictDoNothing();
    await db.insert(channelHumans).values({ channelId: parties.dmChannelId, userId: parties.ownerId }).onConflictDoNothing();
    await db.insert(featureFlags).values([
      { key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false },
      { key: ASSISTANT_WECHAT_FEATURE_FLAG_KEY, randomizationUnit: "user", salt: "test", defaultEnabled: false },
    ]).onConflictDoNothing();
    await db.insert(featureFlagRules).values([
      { flagKey: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [parties.serverId] },
      { flagKey: ASSISTANT_WECHAT_FEATURE_FLAG_KEY, stage: "user", priority: 0, decision: "allow", values: [parties.ownerId] },
    ]);
    // A WeChat message the replies answer.
    const inboundRandomId = `wechat:${randomUUID()}`;
    await db.insert(wechatBridgeInboundMessages).values({
      bindingId: parties.bindingId, ownerUserId: parties.ownerId, dmChannelId: parties.dmChannelId,
      wechatMessageKey: "id:1", randomId: inboundRandomId, contextToken: "ctx-1" as WeChatContextToken,
    });

    assert.equal(await weChatBindingGateOpen({ serverId: parties.serverId, userId: parties.ownerId, agentId: parties.agentId, dmChannelId: parties.dmChannelId }), true, "the gate is open");
    const sent: string[] = [];
    const lease = await claimWeChatBindingLease({ bindingId: parties.bindingId, owner: "replica-a", now: new Date() });
    assert.ok(lease);
    const runner = new WeChatBindingRunner(lease, {
      client: createWeChatILinkClient({
        transport: async (_url, init) => {
          sent.push((JSON.parse(init.body ?? "{}") as { msg: { client_id: string } }).msg.client_id);
          return Response.json({ ret: 0 });
        },
      }),
      now: () => new Date(),
      leaseMs: WECHAT_BRIDGE_LEASE_MS,
      outboundIntervalMs: 2_000,
      noReplyAfterMs: 10 * 60_000,
      minPollIntervalMs: 0,
    });

    // The assistant's reply sent in two transactions: `early` takes its transaction id first,
    // `slow` takes the smaller seq but commits last (as concurrent sends may).
    const insertReply = async (client: pg.PoolClient, content: string) => {
      const { rows } = await client.query<{ id: string; seq: string }>(
        `INSERT INTO messages (id, channel_id, sender_type, sender_id, content) VALUES (gen_random_uuid(), $1, 'agent', $2, $3) RETURNING id, seq::text AS seq`,
        [parties.dmChannelId, parties.agentId, content],
      );
      await client.query(
        `INSERT INTO assistant_wechat_mirror_marks (message_id, agent_id, turn_id, inbound_random_id) VALUES ($1, $2, $3, $4)`,
        [rows[0]!.id, parties.agentId, randomUUID(), inboundRandomId],
      );
      return { id: rows[0]!.id, seq: Number(rows[0]!.seq) };
    };
    // The owner's message just before (committed): channel_last_posts is fresh, so the
    // replies' last-post trigger writes nothing and the two sends do not queue on its row.
    await pool.query(
      `INSERT INTO messages (id, channel_id, sender_type, sender_id, content) VALUES (gen_random_uuid(), $1, 'user', $2, 'from WeChat')`,
      [parties.dmChannelId, parties.ownerId],
    );
    const early = await pool.connect();
    const slow = await pool.connect();
    try {
      // Fail instead of hanging should the two transactions ever queue on a lock.
      await early.query("SET lock_timeout = '5s'");
      await slow.query("SET lock_timeout = '5s'");
      await early.query("BEGIN");
      await early.query("SELECT pg_current_xact_id()");
      await slow.query("BEGIN");
      const late = await insertReply(slow, "the reply that commits last");
      const first = await insertReply(early, "the reply that commits first");
      assert.ok(late.seq < first.seq, "the slow transaction holds the smaller seq");
      await early.query("COMMIT");

      await runner.outboundOnce();
      assert.deepEqual(sent, [first.id], "only the committed reply so far");
      const [afterFirst] = await db.select().from(wechatBridgeBindings).where(eq(wechatBridgeBindings.id, parties.bindingId));
      assert.ok(afterFirst!.outboundSeq! >= first.seq, "the cursor passed the slow reply's seq");

      await slow.query("COMMIT");
      await runner.outboundOnce();
      await runner.outboundOnce();
      assert.deepEqual(sent, [first.id, late.id], "the late commit is found below the cursor, once");
      const states = await db.select({ messageId: wechatBridgeOutboundMessages.messageId, state: wechatBridgeOutboundMessages.state })
        .from(wechatBridgeOutboundMessages).where(eq(wechatBridgeOutboundMessages.bindingId, parties.bindingId));
      assert.deepEqual(states.map((r) => r.state), ["sent", "sent"]);
    } finally {
      await early.query("ROLLBACK").catch(() => undefined);
      await slow.query("ROLLBACK").catch(() => undefined);
      early.release();
      slow.release();
      runner.abort();
    }
  });
});

test("a replica whose lease was taken over tags nothing, records nothing and claims nothing, even racing the holder", async () => {
  await withRealPg(async () => {
    const parties = await seedBindingWithParties();
    const binding = { id: parties.bindingId, serverId: parties.serverId, userId: parties.ownerId, agentId: parties.agentId, dmChannelId: parties.dmChannelId };
    const db = getDb();
    const t0 = new Date();
    const stale = await claimWeChatBindingLease({ bindingId: binding.id, owner: "replica-a", now: t0 });
    assert.ok(stale);
    const later = new Date(t0.getTime() + WECHAT_BRIDGE_LEASE_MS + 1_000);
    const current = await claimWeChatBindingLease({ bindingId: binding.id, owner: "replica-b", now: later });
    assert.ok(current);
    // Three replies left in Raft, and one reply a crash left `sending` long ago.
    const crashed = randomUUID();
    await db.update(wechatBridgeBindings).set({ unmirroredCount: 3 }).where(eq(wechatBridgeBindings.id, binding.id));
    await db.insert(wechatBridgeOutboundMessages).values({ messageId: crashed, bindingId: binding.id, state: "sending", createdAt: t0, updatedAt: t0 });

    const tag = { key: "id:1", contextToken: "ctx-1" as WeChatContextToken, receivedAt: later, sentAt: null };
    const reply = randomUUID();
    const staleWrites = () => [
      tagWeChatInbound(stale, { binding, accepted: [tag], dropped: 2, now: later }),
      recordWeChatOutbound(stale, { messageId: reply, state: "not_mirrored", now: later }),
      claimWeChatGreeting(stale, later),
      claimWeChatNoReplyNotice(stale, { lastMirroredAt: null, noReplyNoticeAt: null, now: later }),
      takeWeChatUnmirroredCount(stale),
      failStaleWeChatOutbound(stale, { now: later, olderThanMs: 1_000 }),
    ] as const;
    assert.deepEqual(await Promise.all(staleWrites()), [null, "lost", false, false, null, null]);
    const untouched = async () => {
      const [row] = await db.select().from(wechatBridgeBindings).where(eq(wechatBridgeBindings.id, binding.id));
      assert.deepEqual(
        { greetedAt: row!.greetedAt, noReplyNoticeAt: row!.noReplyNoticeAt, unmirroredCount: row!.unmirroredCount, owner: row!.leaseOwner },
        { greetedAt: null, noReplyNoticeAt: null, unmirroredCount: 3, owner: "replica-b" },
      );
      assert.deepEqual(await db.select().from(wechatBridgeInboundMessages).where(eq(wechatBridgeInboundMessages.bindingId, binding.id)), []);
      assert.deepEqual(await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.targetId, binding.id)), []);
      const outbound = await db.select({ messageId: wechatBridgeOutboundMessages.messageId, state: wechatBridgeOutboundMessages.state })
        .from(wechatBridgeOutboundMessages).where(eq(wechatBridgeOutboundMessages.bindingId, binding.id));
      assert.deepEqual(outbound, [{ messageId: crashed, state: "sending" }]);
    };
    await untouched();

    // The holder's go through; the stale replica's, racing them on other connections, still do not.
    const [holderResults, staleResults] = await Promise.all([
      (async () => [
        (await tagWeChatInbound(current, { binding, accepted: [tag], dropped: 2, now: later }))?.length,
        await takeWeChatUnmirroredCount(current),
        await recordWeChatOutbound(current, { messageId: reply, state: "not_mirrored", now: later }),
        await claimWeChatGreeting(current, later),
        await claimWeChatNoReplyNotice(current, { lastMirroredAt: null, noReplyNoticeAt: null, now: later }),
        await failStaleWeChatOutbound(current, { now: later, olderThanMs: 1_000 }),
      ])(),
      Promise.all(staleWrites()),
    ]);
    assert.deepEqual(holderResults, [1, 3, "recorded", true, true, 1]);
    assert.deepEqual(staleResults, [null, "lost", false, false, null, null]);
    const [after] = await db.select().from(wechatBridgeBindings).where(eq(wechatBridgeBindings.id, binding.id));
    assert.equal(after!.unmirroredCount, 2, "the not-mirrored reply and the crashed one, after the count was taken");
    assert.equal((await db.select().from(wechatBridgeInboundMessages).where(eq(wechatBridgeInboundMessages.bindingId, binding.id))).length, 1);
    assert.equal((await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.targetId, binding.id))).length, 1, "the drops audited once, by the holder");
  });
});

test("the image still serving during a deploy can make a binding: its insert names no outbound_seq", async () => {
  await withRealPg(async (pool) => {
    const parties = await seedBindingWithParties();
    await getDb().delete(wechatBridgeBindings).where(eq(wechatBridgeBindings.id, parties.bindingId));
    // PR 1's insert (wechatBridgeService.confirmAttempt before this migration): no outbound_seq.
    const { rows } = await pool.query<{ outbound_seq: string }>(
      `INSERT INTO wechat_bridge_bindings (id, server_id, user_id, agent_id, dm_channel_id, ilink_bot_id, ilink_user_id, base_url,
         encrypted_bot_token, envelope_key_id, aad_version, state, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'bot@im.bot', $5, 'https://ilinkai.weixin.qq.com', 'sealed', 'env:test:v1', 1, 'active', now(), now())
       RETURNING outbound_seq::text`,
      [parties.serverId, parties.ownerId, parties.agentId, parties.dmChannelId, `old-image-${randomUUID()}@im.wechat`],
    );
    assert.equal(rows[0]!.outbound_seq, "0");
  });
});
