import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import argon2 from "argon2";
import { and, eq } from "drizzle-orm";
import {
  ACTIVITY_DOMAIN,
  createActivityDomain,
  createSyncCore,
  type ActivityDomainState,
  type SyncDomainConfig,
} from "@botiverse/raft-sync-core";
import { getDb } from "../db/index.js";
import {
  activitySyncChanges,
  activitySyncPrincipalAuthorities,
  activitySyncRows,
  activitySyncScopes,
  channelHumans,
  channels,
  messages,
  serverMembers,
  servers,
  users,
  userChannelReadCursors,
} from "../db/schema.js";
import {
  markChannelInboxActive,
  markChannelInboxDone,
  markReadLatest,
} from "./channelService.js";
import {
  exactDatabaseInt8,
  getActivityDifference,
  getActivitySnapshot,
  setActivityExactMutationForTest,
  setActivitySyncTestHooksForTest,
  type ActivityExactMutationForTest,
} from "./activitySyncService.js";
import { openTestApp } from "../test/integration/app.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const here = dirname(fileURLToPath(import.meta.url));
test("exact int8 mapper preserves adjacent values and rejects number paths", () => {
  const low = exactDatabaseInt8("9007199254740992", "low");
  const high = exactDatabaseInt8("9007199254740993", "high");
  assert.equal(low.toString(), "9007199254740992");
  assert.equal(high.toString(), "9007199254740993");
  assert.equal(high - low, 1n);
  assert.throws(
    () => exactDatabaseInt8(Number("9007199254740993"), "mutated"),
    /canonical decimal text/,
  );
});

async function snapshotValidator() {
  const bundle = JSON.parse(await readFile(resolve(
    here,
    "../../../sync-core/contracts/activity-v1/generated/json-schema/activity-sync.schema.json",
  ), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addSchema(bundle, "activity-sync.schema.json");
  const validate = ajv.getSchema("SnapshotIngress.json");
  assert.ok(validate);
  return validate;
}

async function seedActivity() {
  const db = getDb();
  const passwordHash = await argon2.hash("password123");
  const [owner, sender] = await db.insert(users).values([
    {
      email: `activity-owner-${randomUUID()}@test.invalid`,
      name: `ActivityOwner${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      passwordHash,
      emailVerified: true,
    },
    {
      email: `activity-sender-${randomUUID()}@test.invalid`,
      name: `ActivitySender${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      passwordHash,
      emailVerified: true,
    },
  ]).returning();
  const [server] = await db.insert(servers).values({
    name: "Activity Authority",
    slug: `activity-authority-${randomUUID()}`,
    ownerId: owner.id,
    plan: "founder",
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "activity",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id });
  await db.insert(userChannelReadCursors).values({
    userId: owner.id,
    channelId: channel.id,
    lastReadSeq: 0,
    readStateVersion: 0,
  });
  await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: sender.id,
    content: "one",
    seq: 1,
  });
  return { owner, sender, server, channel };
}

test("Activity authority is exact, transactional, dense, and generated-contract valid", async () => {
  const app = await openTestApp("pglite://", 0, { onboardingOpenerFlagDefaultEnabled: false, humanActivityMuteFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const fixture = await seedActivity();
    const input = {
      serverId: fixture.server.id,
      principalId: fixture.owner.id,
      filter: "all" as const,
      humanActivityMuteEnabled: false,
    };

    let serializationAttempts = 0;
    const transactionAttempts: number[] = [];
    setActivitySyncTestHooksForTest({
      onTransactionAttemptStart: (attempt) => {
        transactionAttempts.push(attempt);
      },
      beforePrincipalAuthorityInsert: async () => {
        serializationAttempts += 1;
        throw Object.assign(new Error("synthetic serialization failure"), { code: "40001" });
      },
    });
    await assert.rejects(
      getActivitySnapshot({ ...input, requestId: "bounded-serialization-retry" }),
      /synthetic serialization failure/,
    );
    assert.equal(serializationAttempts, 3, "serialization retries are bounded to three whole transactions");
    assert.deepEqual(
      transactionAttempts,
      [1, 2, 3],
      "each retry invokes a fresh transaction callback",
    );

    const nonSerializationFailure = Object.assign(
      new Error("synthetic non-serialization failure"),
      { code: "23505" },
    );
    let nonSerializationAttempts = 0;
    setActivitySyncTestHooksForTest({
      beforePrincipalAuthorityInsert: async () => {
        nonSerializationAttempts += 1;
        throw nonSerializationFailure;
      },
    });
    let caughtNonSerializationFailure: unknown;
    try {
      await getActivitySnapshot({ ...input, requestId: "non-serialization-no-retry" });
    } catch (error) {
      caughtNonSerializationFailure = error;
    }
    assert.equal(caughtNonSerializationFailure, nonSerializationFailure);
    assert.equal(nonSerializationAttempts, 1, "non-40001 errors are never retried");
    setActivitySyncTestHooksForTest(null);

    await assert.rejects(
      getActivitySnapshot({ ...input, requestId: "rollback", failAfterReconcileForTest: true }),
      /failpoint/,
    );
    assert.equal((await db.select().from(activitySyncScopes)).length, 0, "failed fold rolls back authority");

    const login = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: fixture.owner.email, password: "password123" }),
    });
    assert.equal(login.status, 200);
    const { accessToken } = await login.json() as { accessToken: string };
    const response = await fetch(
      `${app.baseUrl}/api/channels/activity/snapshot?requestId=first&filter=all&windowId=main`
        + `&principalId=${fixture.sender.id}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "X-Server-Id": fixture.server.id,
        },
      },
    );
    assert.equal(response.status, 200);
    const first = await response.json() as Awaited<ReturnType<typeof getActivitySnapshot>>;
    assert.equal(first.scope.principalId, fixture.owner.id, "principal comes only from authenticated req.userId");
    assert.equal(first.activityVersion, first.watermark, "activityVersion is exactly the scope watermark");
    assert.equal(first.window.rows.length, 1, JSON.stringify(first));
    const validateSnapshot = await snapshotValidator();
    assert.equal(validateSnapshot(first), true, JSON.stringify(validateSnapshot.errors));

    const endpoint = (path: string) => fetch(`${app.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Server-Id": fixture.server.id,
      },
    });
    const assertMutationDidNotCommit = async (mutation: string) => {
      const [scope] = await db.select().from(activitySyncScopes);
      assert.equal(
        scope?.watermark.toString(),
        first.watermark,
        `${mutation} must not commit a partial reconcile`,
      );
    };
    const snapshotMutations: ActivityExactMutationForTest[] = [
      "principalRowVersion",
      "rowAuthorityVersion",
      "scopeEpoch",
      "scopeWatermark",
      "scopeRowVersion",
      "maxReadSeq",
      "readStateVersion",
    ];
    for (const mutation of snapshotMutations) {
      setActivityExactMutationForTest(mutation);
      const mutated = await endpoint(
        `/api/channels/activity/snapshot?requestId=mutation-${mutation}&filter=all&windowId=main`,
      );
      assert.equal(mutated.status, 500, `${mutation} cast removal must dynamically RED`);
      setActivityExactMutationForTest(null);
      await assertMutationDidNotCommit(mutation);
    }
    for (const mutation of ["changeSeq", "changeRowVersion"] as const) {
      setActivityExactMutationForTest(mutation);
      const mutated = await endpoint(
        `/api/channels/activity/difference?requestId=mutation-${mutation}`
          + `&filter=all&windowId=main&epoch=${first.epoch}&afterWatermark=0`,
      );
      assert.equal(mutated.status, 500, `${mutation} cast removal must dynamically RED`);
      setActivityExactMutationForTest(null);
      await assertMutationDidNotCommit(mutation);
    }
    setActivityExactMutationForTest("wireNumber");
    const numberized = await endpoint(
      "/api/channels/activity/snapshot?requestId=mutation-wire&filter=all&windowId=main",
    );
    assert.equal(numberized.status, 200);
    assert.equal(
      validateSnapshot(await numberized.json()),
      false,
      "Number(...) downstream mutation must be rejected by the generated validator",
    );
    setActivityExactMutationForTest(null);
    await assertMutationDidNotCommit("wireNumber");

    const core = createSyncCore({
      domains: [createActivityDomain() as SyncDomainConfig<unknown, unknown>],
    });
    core.ingestSnapshot(ACTIVITY_DOMAIN, {
      scopeId: `${fixture.server.id}:${fixture.owner.id}:all:main`,
      watermark: BigInt(first.watermark),
      epoch: first.epoch,
      state: first,
    });
    assert.doesNotThrow(() => core.ingestFrame(ACTIVITY_DOMAIN, {
      scopeId: `${fixture.server.id}:${fixture.owner.id}:all:main`,
      seq: BigInt(first.watermark) + 1n,
      epoch: first.epoch,
      event: {
        type: "readStateUpdated",
        activityVersion: (BigInt(first.watermark) + 1n).toString(),
        updates: [{
          scopeId: fixture.channel.id,
          channelId: fixture.channel.id,
          maxReadSeq: "1",
          readStateVersion: "1",
        }],
      },
    }));
    const folded = core.state<ActivityDomainState>(
      ACTIVITY_DOMAIN,
      `${fixture.server.id}:${fixture.owner.id}:all:main`,
    )!;
    assert.equal(folded.rows.length, 1);
    assert.equal(folded.rows[0]!.readStateVersion, "1");

    const noOp = await getActivitySnapshot({ ...input, requestId: "noop" });
    assert.equal(noOp.watermark, first.watermark, "a no-op reconcile allocates no scope seq");
    assert.equal(noOp.window.rows[0]!.rowVersion, first.window.rows[0]!.rowVersion);

    await db.update(activitySyncPrincipalAuthorities)
      .set({ rowVersion: 9_007_199_254_740_992n })
      .where(and(
        eq(activitySyncPrincipalAuthorities.serverId, fixture.server.id),
        eq(activitySyncPrincipalAuthorities.principalId, fixture.owner.id),
      ));
    await db.insert(messages).values({
      channelId: fixture.channel.id,
      senderType: "user",
      senderId: fixture.sender.id,
      content: "two",
      seq: 2,
    });
    const exact = await getActivitySnapshot({ ...input, requestId: "exact" });
    assert.equal(exact.window.rows[0]!.rowVersion, "9007199254740993");
    assert.equal(validateSnapshot(exact), true, JSON.stringify(validateSnapshot.errors));
    const adjacent = {
      ...exact,
      window: {
        ...exact.window,
        totalCount: 2,
        rows: [
          {
            ...exact.window.rows[0]!,
            rowId: randomUUID(),
            channelId: randomUUID(),
            rowVersion: exactDatabaseInt8("9007199254740992", "adjacent.low").toString(),
          },
          {
            ...exact.window.rows[0]!,
            rowVersion: exactDatabaseInt8("9007199254740993", "adjacent.high").toString(),
          },
        ],
      },
    };
    assert.equal(validateSnapshot(adjacent), true, JSON.stringify(validateSnapshot.errors));
    const adjacentCore = createSyncCore({
      domains: [createActivityDomain() as SyncDomainConfig<unknown, unknown>],
    });
    adjacentCore.ingestSnapshot(ACTIVITY_DOMAIN, {
      scopeId: "adjacent",
      watermark: BigInt(adjacent.watermark),
      epoch: adjacent.epoch,
      state: adjacent,
    });
    assert.deepEqual(
      adjacentCore.state<ActivityDomainState>(ACTIVITY_DOMAIN, "adjacent")!.rows
        .map((row) => row.rowVersion)
        .sort(),
      ["9007199254740992", "9007199254740993"],
    );
    const repaired = await getActivityDifference({
      ...input,
      requestId: "repair",
      epoch: first.epoch,
      afterWatermark: first.watermark,
    });
    assert.equal(repaired.status, 200);
    assert.equal(repaired.body.type, "difference");
    if (repaired.body.type === "difference") {
      assert.equal(repaired.body.fromSeq, (BigInt(first.watermark) + 1n).toString());
      assert.equal(repaired.body.toSeq, exact.watermark);
      assert.equal(repaired.body.rows[0]!.rowVersion, "9007199254740993");
    }

    await db.insert(messages).values({
      channelId: fixture.channel.id,
      senderType: "user",
      senderId: fixture.sender.id,
      content: "three",
      seq: 3,
    });
    const concurrent = await Promise.all([
      getActivitySnapshot({ ...input, requestId: "concurrent-a" }),
      getActivitySnapshot({ ...input, requestId: "concurrent-b" }),
    ]);
    assert.equal(
      concurrent[0].window.rows[0]!.rowVersion,
      concurrent[1].window.rows[0]!.rowVersion,
      "two concurrent reconciles allocate one row successor",
    );

    const beforeDoneVersion = BigInt(concurrent[0].window.rows[0]!.rowVersion);
    await markChannelInboxDone(fixture.owner.id, fixture.channel.id, "3");
    const done = await getActivitySnapshot({ ...input, requestId: "done" });
    assert.equal(done.window.rows.length, 0);
    assert.equal(done.window.tombstones[0]!.reason, "done");
    assert.ok(BigInt(done.window.tombstones[0]!.rowVersion) > beforeDoneVersion);

    setActivityExactMutationForTest("wireNumber");
    const numberizedTombstoneResponse = await endpoint(
      "/api/channels/activity/snapshot?requestId=mutation-wire-tombstone&filter=all&windowId=main",
    );
    assert.equal(numberizedTombstoneResponse.status, 200);
    const numberizedTombstone = await numberizedTombstoneResponse.json() as Record<string, any>;
    assert.equal(typeof numberizedTombstone.window.tombstones[0].rowVersion, "number");
    assert.equal(validateSnapshot(numberizedTombstone), false);
    setActivityExactMutationForTest(null);
    const [scopeAfterWireMutation] = await db.select().from(activitySyncScopes);
    assert.equal(
      scopeAfterWireMutation?.watermark.toString(),
      done.watermark,
      "outbound Number mutation must not touch the canonical tombstone digest",
    );

    const oldEpoch = await getActivityDifference({
      ...input,
      requestId: "old-epoch",
      epoch: (BigInt(done.epoch) + 1n).toString(),
      afterWatermark: done.watermark,
    });
    assert.equal(oldEpoch.status, 409);
    assert.equal(oldEpoch.body.snapshotRequired, true);

    await markChannelInboxActive(fixture.owner.id, fixture.channel.id);
    await db.insert(messages).values({
      channelId: fixture.channel.id,
      senderType: "user",
      senderId: fixture.sender.id,
      content: "four",
      seq: 4,
    });
    const unreadInput = { ...input, filter: "unread" as const };
    const unread = await getActivitySnapshot({ ...unreadInput, requestId: "unread" });
    assert.equal(unread.window.rows.length, 1);
    await markReadLatest(fixture.owner.id, fixture.channel.id);
    const outOfWindow = await getActivitySnapshot({ ...unreadInput, requestId: "out" });
    assert.equal(outOfWindow.window.tombstones[0]!.reason, "outOfWindow");
    const stoneVersion = BigInt(outOfWindow.window.tombstones[0]!.rowVersion);
    await db.insert(messages).values({
      channelId: fixture.channel.id,
      senderType: "user",
      senderId: fixture.sender.id,
      content: "five",
      seq: 5,
    });
    const reentry = await getActivitySnapshot({ ...unreadInput, requestId: "reentry" });
    assert.ok(BigInt(reentry.window.rows[0]!.rowVersion) > stoneVersion);

    const retainedPadding = Array.from(
      { length: 2048 - Number(done.watermark) },
      (_, index) => ({
        serverId: fixture.server.id,
        principalId: fixture.owner.id,
        filter: "all" as const,
        windowId: "main" as const,
        seq: BigInt(done.watermark) + BigInt(index) + 1n,
        rowId: null,
        rowVersion: null,
        kind: "scope" as const,
        payload: {},
        tombstoneReason: null,
      }),
    );
    for (let offset = 0; offset < retainedPadding.length; offset += 400) {
      await db.insert(activitySyncChanges).values(retainedPadding.slice(offset, offset + 400));
    }
    await db.update(activitySyncScopes)
      .set({ watermark: 2048n })
      .where(and(
        eq(activitySyncScopes.serverId, fixture.server.id),
        eq(activitySyncScopes.principalId, fixture.owner.id),
        eq(activitySyncScopes.filter, "all"),
        eq(activitySyncScopes.windowId, "main"),
      ));
    const rolled = await getActivitySnapshot({ ...input, requestId: "rollover" });
    assert.equal(rolled.epoch, (BigInt(done.epoch) + 1n).toString());
    assert.equal(rolled.window.rows.length, 1);
    assert.equal(rolled.window.tombstones.length, 0);
    const retainedAfterRollover = await db.select().from(activitySyncChanges).where(and(
      eq(activitySyncChanges.serverId, fixture.server.id),
      eq(activitySyncChanges.principalId, fixture.owner.id),
      eq(activitySyncChanges.filter, "all"),
      eq(activitySyncChanges.windowId, "main"),
    ));
    assert.equal(retainedAfterRollover.length, Number(rolled.watermark));
    assert.ok(retainedAfterRollover.length < 2048, "epoch rollover bounds the repair journal");

    const numericVersionMutation = structuredClone(reentry) as Record<string, any>;
    numericVersionMutation.window.rows[0].rowVersion = 9_007_199_254_740_992;
    assert.equal(validateSnapshot(numericVersionMutation), false, "wire validator rejects lossy row versions");

    const authorities = await db.select().from(activitySyncPrincipalAuthorities);
    assert.equal(typeof authorities[0]!.rowVersion, "bigint");
    const persistedRows = await db.select().from(activitySyncRows);
    assert.ok(persistedRows.every((row) => typeof row.rowVersion === "bigint"));
  } finally {
    setActivityExactMutationForTest(null);
    setActivitySyncTestHooksForTest(null);
    await app.close();
  }
});
