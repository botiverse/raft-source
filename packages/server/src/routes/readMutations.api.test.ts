import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import {
  channelHumans,
  channels,
  inboxSuppressionStates,
  messages,
  readMutations,
  serverMembers,
  threadFollows,
  userChannelInboxStates,
  userChannelReadCursors,
  users,
} from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import {
  admitReadMutation,
  claimNextReadMutation,
  executeReadMutationClaim,
  getReadMutationFrontier,
  READ_MUTATION_COMPATIBILITY_WAIT_MS_ENV,
} from "../services/readMutationSequencer.js";
import { openTestApp } from "../test/integration/app.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { accessToken: string }).accessToken;
}

function authHeaders(token: string, serverId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-Server-Id": serverId,
    "Content-Type": "application/json",
  };
}

test("read mutation API derives authority from auth, enforces exact replay, and exposes the recovery frontier", async ({ app }) => {
  const [owner] = await getDb().insert(users).values({
    email: `read-api-${randomUUID()}@test.invalid`,
    name: `ReadApi${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Read Mutation API", `read-api-${randomUUID()}`, owner.id);
  const [scope] = await getDb().select().from(channels).where(eq(channels.serverId, server.id)).limit(1);
  assert.ok(scope);
  const token = await login(app.baseUrl, owner.email);
  const headers = authHeaders(token, server.id);
  const mutationId = randomUUID();

  const admitted = await fetch(`${app.baseUrl}/api/read-mutations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      mutationId,
      kind: "global_read_all",
      // These untrusted fields are deliberately ignored; middleware-derived
      // authority is the only accepted authority source.
      serverId: randomUUID(),
      principalId: randomUUID(),
    }),
  });
  assert.equal(admitted.status, 201, await admitted.clone().text());
  const admittedBody = (await admitted.json()) as {
    outcome: string;
    serverId: string;
    principalId: string;
    authoritySeq: number;
  };
  assert.equal(admittedBody.outcome, "ADMITTED");
  assert.equal(admittedBody.serverId, server.id);
  assert.equal(admittedBody.principalId, owner.id);
  assert.equal(admittedBody.authoritySeq, 1);

  const replay = await fetch(`${app.baseUrl}/api/read-mutations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mutationId, kind: "global_read_all" }),
  });
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { outcome: string }).outcome, "ALREADY_ADMITTED");

  const mismatch = await fetch(`${app.baseUrl}/api/read-mutations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mutationId, kind: "channel_read_all", scopeId: scope.id }),
  });
  assert.equal(mismatch.status, 409, await mismatch.clone().text());
  assert.equal(((await mismatch.json()) as { code: string }).code, "MUTATION_ID_PAYLOAD_MISMATCH");

  const frontier = await fetch(`${app.baseUrl}/api/read-mutations/frontier`, { headers });
  assert.equal(frontier.status, 200, await frontier.clone().text());
  const frontierBody = (await frontier.json()) as {
    nextAuthoritySeq: number;
    lastTerminalAuthoritySeq: number;
    snapshotUpperAuthoritySeq: number;
    items: Array<{ mutationId: string; authoritySeq: number; state: string }>;
  };
  assert.equal(frontierBody.nextAuthoritySeq, 2);
  assert.equal(frontierBody.lastTerminalAuthoritySeq, 0);
  assert.equal(frontierBody.snapshotUpperAuthoritySeq, 1);
  assert.deepEqual(frontierBody.items.map((row) => [row.mutationId, row.authoritySeq, row.state]), [[mutationId, 1, "admitted"]]);

  const invalidUuid = await fetch(`${app.baseUrl}/api/read-mutations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mutationId: "00000000-0000-1000-8000-000000000000", kind: "global_read_all" }),
  });
  assert.equal(invalidUuid.status, 400);
  assert.equal(((await invalidUuid.json()) as { code: string }).code, "INVALID_MUTATION_ID");

  const missingScope = await fetch(`${app.baseUrl}/api/read-mutations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mutationId: randomUUID(), kind: "channel_read_all", scopeId: randomUUID() }),
  });
  assert.equal(missingScope.status, 404);

  const internalDoneMustStayPrivate = await fetch(`${app.baseUrl}/api/read-mutations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      mutationId: randomUUID(),
      kind: "done",
      targetKind: "channel",
      scopeId: scope.id,
      throughSeq: "1",
    }),
  });
  assert.equal(internalDoneMustStayPrivate.status, 400);
  assert.equal(
    ((await internalDoneMustStayPrivate.json()) as { code: string }).code,
    "INVALID_MUTATION_PAYLOAD",
    "the public read-mutation ingress must not expose internal composite Done",
  );
});

test("API exact replay reaches identity dedupe after scope membership is revoked", async ({ app }) => {
  const [owner] = await getDb().insert(users).values({
    email: `read-replay-revoke-${randomUUID()}@test.invalid`,
    name: `ReadReplay${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Read Replay Revoke", `read-replay-revoke-${randomUUID()}`, owner.id);
  const [scope] = await getDb().insert(channels).values({
    serverId: server.id,
    name: `read-replay-private-${randomUUID()}`,
    type: "private",
  }).returning();
  await getDb().insert(channelHumans).values({ channelId: scope.id, userId: owner.id });
  const token = await login(app.baseUrl, owner.email);
  const headers = authHeaders(token, server.id);
  const mutationId = randomUUID();
  const first = await fetch(`${app.baseUrl}/api/read-mutations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mutationId, kind: "channel_read_all", scopeId: scope.id }),
  });
  assert.equal(first.status, 201, await first.clone().text());
  await getDb().delete(channelHumans).where(and(
    eq(channelHumans.channelId, scope.id),
    eq(channelHumans.userId, owner.id),
  ));

  const replay = await fetch(`${app.baseUrl}/api/read-mutations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mutationId, kind: "channel_read_all", scopeId: scope.id }),
  });
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.equal(((await replay.json()) as { outcome: string }).outcome, "ALREADY_ADMITTED");

  const mismatch = await fetch(`${app.baseUrl}/api/read-mutations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mutationId, kind: "row_read", scopeId: scope.id, throughSeq: 1 }),
  });
  assert.equal(mismatch.status, 409, await mismatch.clone().text());
  const fresh = await fetch(`${app.baseUrl}/api/read-mutations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mutationId: randomUUID(), kind: "channel_read_all", scopeId: scope.id }),
  });
  assert.equal(fresh.status, 404, await fresh.clone().text());
});

test("frontier failure returns an explicit HOLD-worthy 503 rather than an empty frontier", async ({ app }) => {
  const [owner] = await getDb().insert(users).values({
    email: `read-frontier-fail-${randomUUID()}@test.invalid`,
    name: `ReadFrontierFail${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Read Frontier Fail", `read-frontier-fail-${randomUUID()}`, owner.id);
  const token = await login(app.baseUrl, owner.email);
  app.app.set("readMutationRouteService", {
    admit: admitReadMutation,
    frontier: async () => {
      throw new Error("injected frontier outage");
    },
  } satisfies {
    admit: typeof admitReadMutation;
    frontier: typeof getReadMutationFrontier;
  });

  const response = await fetch(`${app.baseUrl}/api/read-mutations/frontier`, {
    headers: authHeaders(token, server.id),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Read mutation frontier is temporarily unavailable",
    code: "READ_MUTATION_FRONTIER_UNAVAILABLE",
  });
});

test("all five compatibility routes return recoverable 202 without fallback writes when a predecessor owns the authority", async () => {
  const previousWait = process.env[READ_MUTATION_COMPATIBILITY_WAIT_MS_ENV];
  process.env[READ_MUTATION_COMPATIBILITY_WAIT_MS_ENV] = "1";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const [owner, sender, outsider] = await getDb().insert(users).values([
      {
        email: `read-compat-owner-${randomUUID()}@test.invalid`,
        name: `ReadCompatOwner${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        passwordHash: await fixturePasswordHash("password123"),
        emailVerified: true,
        profileSetupCompletedAt: new Date(),
      },
      {
        email: `read-compat-sender-${randomUUID()}@test.invalid`,
        name: `ReadCompatSender${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        passwordHash: "x",
        emailVerified: true,
      },
      {
        email: `read-compat-outsider-${randomUUID()}@test.invalid`,
        name: `ReadCompatOutsider${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        passwordHash: await fixturePasswordHash("password123"),
        emailVerified: true,
        profileSetupCompletedAt: new Date(),
      },
    ]).returning();
    const token = await login(app.baseUrl, owner.email);
    const outsiderToken = await login(app.baseUrl, outsider.email);
    const routeSpecs = [
      { name: "inbox", path: (_scopeId: string) => "/api/channels/inbox/read-all", body: (_scopeId: string) => ({}) },
      {
        name: "inbox-done",
        path: (_scopeId: string) => "/api/channels/inbox/done",
        body: (scopeId: string) => ({
          channelId: scopeId,
          throughActivitySeq: "1",
          frontierSpace: "storage",
        }),
      },
      { name: "row-read", path: (scopeId: string) => `/api/channels/${scopeId}/read`, body: (_scopeId: string) => ({ seq: 1 }) },
      { name: "channel-read-all", path: (scopeId: string) => `/api/channels/${scopeId}/read-all`, body: (_scopeId: string) => ({}) },
      { name: "row-unread", path: (scopeId: string) => `/api/channels/${scopeId}/unread`, body: (_scopeId: string) => ({}) },
    ] as const;

    for (const [index, spec] of routeSpecs.entries()) {
      const server = await createServer(
        `Read Compatibility ${index}`,
        `read-compat-${index}-${randomUUID()}`,
        owner.id,
      );
      const [scope] = await getDb().select().from(channels).where(eq(channels.serverId, server.id)).limit(1);
      assert.ok(scope);
      await getDb().insert(messages).values({
        channelId: scope.id,
        senderType: "user",
        senderId: sender.id,
        content: `compatibility ${spec.name}`,
        seq: 1,
      });
      const blockerId = randomUUID();
      await admitReadMutation({
        serverId: server.id,
        principalId: owner.id,
        mutationId: blockerId,
        mutation: { kind: "global_read_all" },
      });
      const farFuture = new Date("2099-01-01T00:00:00.000Z");
      const blocker = await claimNextReadMutation({
        serverId: server.id,
        principalId: owner.id,
        leaseOwner: `blocker-${spec.name}`,
        leaseMs: 60_000,
        now: farFuture,
      });
      assert.ok(blocker);

      const response = await fetch(`${app.baseUrl}${spec.path(scope.id)}`, {
        method: "POST",
        headers: authHeaders(token, server.id),
        body: JSON.stringify(spec.body(scope.id)),
      });
      assert.equal(response.status, 202, `${spec.name}: ${await response.clone().text()}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("retry-after"), "1");
      const pending = (await response.json()) as {
        code: string;
        status: string;
        outcome: string;
        mutationId: string;
        authoritySeq: number;
        frontierUrl: string;
        primaryOutcome?: string;
      };
      assert.deepEqual({
        code: pending.code,
        status: pending.status,
        outcome: pending.outcome,
        authoritySeq: pending.authoritySeq,
        frontierUrl: pending.frontierUrl,
      }, {
        code: "READ_MUTATION_PENDING",
        status: "admitted",
        outcome: "unknown",
        authoritySeq: 2,
        frontierUrl: `/api/read-mutations/frontier?mutationId=${pending.mutationId}`,
      });
      assert.equal(
        pending.primaryOutcome,
        undefined,
        "a pending composite Done has committed no primary outcome",
      );
      assert.match(pending.mutationId, /^[0-9a-f-]{36}$/i);
      assert.equal((await getDb().select().from(userChannelReadCursors).where(eq(
        userChannelReadCursors.userId,
        owner.id,
      ))).filter((cursor) => cursor.channelId === scope.id).length, 0, `${spec.name}: timeout must not fallback-write`);

      let retryPending: { mutationId: string; authoritySeq: number } | null = null;
      if (spec.name === "inbox-done") {
        const inboxRows = await getDb().select().from(userChannelInboxStates).where(eq(
          userChannelInboxStates.channelId,
          scope.id,
        ));
        assert.equal(inboxRows.length, 0, "pending composite Done must not write legacy state first");
        const suppressionBeforeRetry = await getDb().select().from(inboxSuppressionStates).where(eq(
          inboxSuppressionStates.sourceChannelId,
          scope.id,
        ));
        assert.equal(suppressionBeforeRetry.length, 0, "pending composite Done must not write suppression first");

        const retry = await fetch(`${app.baseUrl}${spec.path(scope.id)}`, {
          method: "POST",
          headers: authHeaders(token, server.id),
          body: JSON.stringify(spec.body(scope.id)),
        });
        assert.equal(retry.status, 202, await retry.clone().text());
        retryPending = await retry.json() as { mutationId: string; authoritySeq: number };
        assert.equal(retryPending.authoritySeq, 3, "legacy retry is a new ordered intent behind the original mutation");
        assert.notEqual(retryPending.mutationId, pending.mutationId);

        const inboxRowsAfterRetry = await getDb().select().from(userChannelInboxStates).where(eq(
          userChannelInboxStates.channelId,
          scope.id,
        ));
        assert.equal(inboxRowsAfterRetry.length, 0, "retry remains a second ordered intent with zero early state");
        const suppressionAfterRetry = await getDb().select().from(inboxSuppressionStates).where(eq(
          inboxSuppressionStates.sourceChannelId,
          scope.id,
        ));
        assert.equal(suppressionAfterRetry.length, 0);
      }

      const pendingFrontier = await fetch(`${app.baseUrl}${pending.frontierUrl}`, {
        headers: authHeaders(token, server.id),
      });
      assert.equal(pendingFrontier.status, 200);
      const pendingFrontierBody = (await pendingFrontier.json()) as {
        items: Array<{ mutationId: string; authoritySeq: number; state: string }>;
      };
      assert.ok(pendingFrontierBody.items.some((row) => (
        row.mutationId === pending.mutationId && row.authoritySeq === pending.authoritySeq
      )));

      const afterExpiry = new Date(farFuture.getTime() + 60_001);
      const reclaimedBlocker = await claimNextReadMutation({
        serverId: server.id,
        principalId: owner.id,
        leaseOwner: `reclaimer-${spec.name}`,
        leaseMs: 60_000,
        now: afterExpiry,
      });
      assert.ok(reclaimedBlocker);
      await executeReadMutationClaim({ claim: reclaimedBlocker, now: new Date(afterExpiry.getTime() + 1) });
      const pendingClaim = await claimNextReadMutation({
        serverId: server.id,
        principalId: owner.id,
        leaseOwner: `pending-${spec.name}`,
        leaseMs: 60_000,
        now: new Date(afterExpiry.getTime() + 2),
      });
      assert.ok(pendingClaim);
      assert.equal(pendingClaim.mutationId, pending.mutationId);
      await executeReadMutationClaim({ claim: pendingClaim, now: new Date(afterExpiry.getTime() + 3) });
      if (retryPending) {
        const retryClaim = await claimNextReadMutation({
          serverId: server.id,
          principalId: owner.id,
          leaseOwner: `retry-${spec.name}`,
          leaseMs: 60_000,
          now: new Date(afterExpiry.getTime() + 4),
        });
        assert.ok(retryClaim);
        assert.equal(retryClaim.mutationId, retryPending.mutationId);
        await executeReadMutationClaim({ claim: retryClaim, now: new Date(afterExpiry.getTime() + 5) });
        const [doneState] = await getDb().select().from(userChannelInboxStates).where(and(
          eq(userChannelInboxStates.userId, owner.id),
          eq(userChannelInboxStates.channelId, scope.id),
        ));
        assert.ok(doneState?.doneAt, "worker atomically commits the Done marker after the predecessor clears");
        const suppression = await getDb().select().from(inboxSuppressionStates).where(and(
          eq(inboxSuppressionStates.receiverId, owner.id),
          eq(inboxSuppressionStates.sourceChannelId, scope.id),
        ));
        assert.ok(suppression.length > 0);
        assert.ok(suppression.every((row) => String(row.doneThroughSeq) === "1"));
      }

      const terminalFrontier = await fetch(`${app.baseUrl}${pending.frontierUrl}`, {
        headers: authHeaders(token, server.id),
      });
      const terminalBody = (await terminalFrontier.json()) as {
        items: Array<{ mutationId: string; authoritySeq: number; state: string }>;
      };
      assert.ok(terminalBody.items.some((row) => (
        row.mutationId === pending.mutationId && row.authoritySeq === pending.authoritySeq
          && (row.state === "applied" || row.state === "retired_no_effect")
      )));

      if (index === 0) {
        await getDb().insert(serverMembers).values({ serverId: server.id, userId: outsider.id, role: "member" });
        const outsiderFrontier = await fetch(`${app.baseUrl}/api/read-mutations/frontier`, {
          headers: authHeaders(outsiderToken, server.id),
        });
        assert.equal(outsiderFrontier.status, 200);
        const outsiderBody = (await outsiderFrontier.json()) as {
          nextAuthoritySeq: number;
          items: unknown[];
        };
        assert.equal(outsiderBody.nextAuthoritySeq, 1);
        assert.deepEqual(outsiderBody.items, []);
      }
    }

    const validationServer = await createServer(
      "Read Compatibility Validation",
      `read-compat-validation-${randomUUID()}`,
      owner.id,
    );
    const [validationScope] = await getDb().select().from(channels)
      .where(eq(channels.serverId, validationServer.id)).limit(1);
    assert.ok(validationScope);
    const invalid = await fetch(`${app.baseUrl}/api/channels/${validationScope.id}/read`, {
      method: "POST",
      headers: authHeaders(token, validationServer.id),
      body: JSON.stringify({ seq: 0 }),
    });
    assert.equal(invalid.status, 400, "pre-admission validation failure must not become 202");
    const validationFrontier = await fetch(`${app.baseUrl}/api/read-mutations/frontier`, {
      headers: authHeaders(token, validationServer.id),
    });
    assert.equal(((await validationFrontier.json()) as { nextAuthoritySeq: number }).nextAuthoritySeq, 1);
  } finally {
    if (previousWait === undefined) delete process.env[READ_MUTATION_COMPATIBILITY_WAIT_MS_ENV];
    else process.env[READ_MUTATION_COMPATIBILITY_WAIT_MS_ENV] = previousWait;
    await app.close();
  }
});

test("thread routes preserve legacy primary commits while composite Done stays wholly pending", async () => {
  const previousWait = process.env[READ_MUTATION_COMPATIBILITY_WAIT_MS_ENV];
  process.env[READ_MUTATION_COMPATIBILITY_WAIT_MS_ENV] = "1";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const [owner, sender] = await getDb().insert(users).values([
      {
        email: `read-composite-owner-${randomUUID()}@test.invalid`,
        name: `ReadCompositeOwner${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        passwordHash: await fixturePasswordHash("password123"),
        emailVerified: true,
        profileSetupCompletedAt: new Date(),
      },
      {
        email: `read-composite-sender-${randomUUID()}@test.invalid`,
        name: `ReadCompositeSender${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        passwordHash: "x",
        emailVerified: true,
      },
    ]).returning();
    const token = await login(app.baseUrl, owner.email);
    const specs = ["follow", "unfollow", "done"] as const;

    for (const spec of specs) {
      const server = await createServer(
        `Read Composite ${spec}`,
        `read-composite-${spec}-${randomUUID()}`,
        owner.id,
      );
      const [parentChannel] = await getDb().select().from(channels).where(eq(channels.serverId, server.id)).limit(1);
      assert.ok(parentChannel);
      const [parent] = await getDb().insert(messages).values({
        channelId: parentChannel.id,
        senderType: "user",
        senderId: sender.id,
        content: `composite ${spec}`,
        seq: 1,
      }).returning();
      let threadId: string | null = null;
      if (spec !== "follow") {
        const [thread] = await getDb().insert(channels).values({
          serverId: server.id,
          name: `thread-${spec}-${randomUUID()}`,
          type: "thread",
          parentMessageId: parent.id,
        }).returning();
        threadId = thread.id;
        await getDb().insert(threadFollows).values({
          threadChannelId: thread.id,
          followerType: "user",
          followerId: owner.id,
          parentMessageId: parent.id,
          reason: "manual",
        });
      }

      await admitReadMutation({
        serverId: server.id,
        principalId: owner.id,
        mutationId: randomUUID(),
        mutation: { kind: "global_read_all" },
      });
      const farFuture = new Date("2099-01-01T00:00:00.000Z");
      assert.ok(await claimNextReadMutation({
        serverId: server.id,
        principalId: owner.id,
        leaseOwner: `composite-blocker-${spec}`,
        leaseMs: 60_000,
        now: farFuture,
      }));

      const path = spec === "follow"
        ? "/api/channels/threads/follow"
        : `/api/channels/threads/${spec}`;
      const requestBody = spec === "follow"
        ? { parentMessageId: parent.id }
        : spec === "done"
          ? { threadChannelId: threadId, throughActivitySeq: "1", frontierSpace: "storage" }
          : { threadChannelId: threadId };
      const invoke = () => fetch(`${app.baseUrl}${path}`, {
        method: "POST",
        headers: authHeaders(token, server.id),
        body: JSON.stringify(requestBody),
      });

      const response = await invoke();
      assert.equal(response.status, 202, `${spec}: ${await response.clone().text()}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("retry-after"), "1");
      const firstPending = await response.json() as {
        code: string;
        primaryOutcome?: string;
        mutationId: string;
        authoritySeq: number;
      };
      assert.equal(firstPending.code, "READ_MUTATION_PENDING");
      assert.equal(firstPending.primaryOutcome, spec === "done" ? undefined : "committed");
      assert.equal(firstPending.authoritySeq, 2);

      const followRows = await getDb().select().from(threadFollows).where(and(
        eq(threadFollows.followerType, "user"),
        eq(threadFollows.followerId, owner.id),
        eq(threadFollows.parentMessageId, parent.id),
      ));
      assert.equal(followRows.length, 1, `${spec}: primary follow state must not duplicate`);
      threadId = followRows[0]!.threadChannelId;
      if (spec === "follow") {
        assert.equal(followRows[0]!.doneAt, null);
        assert.equal(followRows[0]!.unfollowedAt, null);
      } else if (spec === "unfollow") {
        assert.equal(followRows[0]!.doneAt, null, "Unfollow and Done are independent states");
        assert.ok(followRows[0]!.unfollowedAt);
      } else {
        assert.equal(followRows[0]!.doneAt, null, "pending Done commits no early marker");
        assert.equal(followRows[0]!.unfollowedAt, null);
      }
      assert.equal((await getDb().select().from(userChannelReadCursors).where(and(
        eq(userChannelReadCursors.userId, owner.id),
        eq(userChannelReadCursors.channelId, threadId),
      ))).length, 0, `${spec}: pending read must not fallback-write`);

      const retry = await invoke();
      assert.equal(retry.status, 202, `${spec} retry: ${await retry.clone().text()}`);
      const retryPending = await retry.json() as { mutationId: string; authoritySeq: number };
      assert.equal(retryPending.authoritySeq, 3);
      assert.notEqual(retryPending.mutationId, firstPending.mutationId);
      assert.equal((await getDb().select().from(threadFollows).where(and(
        eq(threadFollows.followerType, "user"),
        eq(threadFollows.followerId, owner.id),
        eq(threadFollows.parentMessageId, parent.id),
      ))).length, 1, `${spec}: retry must remain an idempotent primary upsert`);

      let now = new Date(farFuture.getTime() + 60_001);
      for (const expectedMutationId of [null, firstPending.mutationId, retryPending.mutationId]) {
        const claim = await claimNextReadMutation({
          serverId: server.id,
          principalId: owner.id,
          leaseOwner: `composite-recovery-${spec}`,
          leaseMs: 60_000,
          now,
        });
        assert.ok(claim);
        if (expectedMutationId) assert.equal(claim.mutationId, expectedMutationId);
        await executeReadMutationClaim({ claim, now: new Date(now.getTime() + 1) });
        now = new Date(now.getTime() + 2);
      }
      const frontier = await getReadMutationFrontier({ serverId: server.id, principalId: owner.id });
      assert.deepEqual(frontier.items.filter((item) => item.state === "admitted" || item.state === "executing"), []);
      assert.ok(frontier.items.some((row) => row.mutationId === firstPending.mutationId));
      assert.ok(frontier.items.some((row) => row.mutationId === retryPending.mutationId));
      if (spec === "done") {
        const [committedFollow] = await getDb().select().from(threadFollows).where(and(
          eq(threadFollows.followerType, "user"),
          eq(threadFollows.followerId, owner.id),
          eq(threadFollows.parentMessageId, parent.id),
        ));
        assert.ok(committedFollow?.doneAt, "the recovered composite worker commits the Done marker");
        const suppressions = await getDb().select().from(inboxSuppressionStates).where(and(
          eq(inboxSuppressionStates.receiverId, owner.id),
          eq(inboxSuppressionStates.targetChannelId, threadId!),
        ));
        assert.ok(suppressions.length > 0);
        assert.ok(suppressions.every((row) => String(row.doneThroughSeq) === "1"));
      }
    }
  } finally {
    if (previousWait === undefined) delete process.env[READ_MUTATION_COMPATIBILITY_WAIT_MS_ENV];
    else process.env[READ_MUTATION_COMPATIBILITY_WAIT_MS_ENV] = previousWait;
    await app.close();
  }
});

test("post-persist thread reply stays successful and exact when its read receipt is pending", async () => {
  const previousWait = process.env[READ_MUTATION_COMPATIBILITY_WAIT_MS_ENV];
  process.env[READ_MUTATION_COMPATIBILITY_WAIT_MS_ENV] = "1";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const [owner] = await getDb().insert(users).values({
      email: `read-message-owner-${randomUUID()}@test.invalid`,
      name: `ReadMessageOwner${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    const server = await createServer("Read Message Pending", `read-message-pending-${randomUUID()}`, owner.id);
    const [parentChannel] = await getDb().select().from(channels).where(eq(channels.serverId, server.id)).limit(1);
    assert.ok(parentChannel);
    const [parent] = await getDb().insert(messages).values({
      channelId: parentChannel.id,
      senderType: "user",
      senderId: owner.id,
      content: "pending read parent",
      seq: 1,
    }).returning();
    const [thread] = await getDb().insert(channels).values({
      serverId: server.id,
      name: `pending-read-thread-${randomUUID()}`,
      type: "thread",
      parentMessageId: parent.id,
    }).returning();
    await getDb().insert(threadFollows).values({
      threadChannelId: thread.id,
      followerType: "user",
      followerId: owner.id,
      parentMessageId: parent.id,
      reason: "manual",
    });
    await admitReadMutation({
      serverId: server.id,
      principalId: owner.id,
      mutationId: randomUUID(),
      mutation: { kind: "global_read_all" },
    });
    const farFuture = new Date("2099-01-01T00:00:00.000Z");
    assert.ok(await claimNextReadMutation({
      serverId: server.id,
      principalId: owner.id,
      leaseOwner: "message-read-blocker",
      leaseMs: 60_000,
      now: farFuture,
    }));
    const token = await login(app.baseUrl, owner.email);
    const body = {
      channelId: thread.id,
      content: "reply survives pending read",
      randomId: `read-pending-${randomUUID()}`,
    };
    const send = () => fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: authHeaders(token, server.id),
      body: JSON.stringify(body),
    });

    const response = await send();
    assert.equal(response.status, 200, await response.clone().text());
    const retry = await send();
    assert.equal(retry.status, 200, await retry.clone().text());
    const persisted = await getDb().select().from(messages).where(and(
      eq(messages.channelId, thread.id),
      eq(messages.randomId, body.randomId),
    ));
    assert.equal(persisted.length, 1, "pending read must not roll back or duplicate the persisted reply");

    const pendingRows = await getDb().select().from(readMutations).where(and(
      eq(readMutations.serverId, server.id),
      eq(readMutations.principalId, owner.id),
    ));
    assert.ok(pendingRows.some((row) => row.authoritySeq === 2 && row.state === "admitted"));

    let now = new Date(farFuture.getTime() + 60_001);
    while (true) {
      const claim = await claimNextReadMutation({
        serverId: server.id,
        principalId: owner.id,
        leaseOwner: "message-read-recovery",
        leaseMs: 60_000,
        now,
      });
      if (!claim) break;
      await executeReadMutationClaim({ claim, now: new Date(now.getTime() + 1) });
      now = new Date(now.getTime() + 2);
    }
    assert.deepEqual(
      (await getReadMutationFrontier({ serverId: server.id, principalId: owner.id })).items
        .filter((item) => item.state === "admitted" || item.state === "executing"),
      [],
    );
  } finally {
    if (previousWait === undefined) delete process.env[READ_MUTATION_COMPATIBILITY_WAIT_MS_ENV];
    else process.env[READ_MUTATION_COMPATIBILITY_WAIT_MS_ENV] = previousWait;
    await app.close();
  }
});
