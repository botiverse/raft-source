import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
/**
 * task #235 Phase 1 contract tests: additive per-server `activityUnreadCount`
 * in GET /api/servers/unread-summary.
 *
 * Frozen contract (v2.3.1, SHA 95c1c8f1…, thread #反馈:b861e68f): present ⟺
 * known (0 = known zero), absent ⟺ unknown; authority = /channels/inbox?
 * filter=all `totalUnreadCount` (pagination-independent aggregate, NOT
 * `activeUnreadCount`); serverPushMuted orthogonal to the count; counts come
 * from ONE set-based batch query (whole-batch unknown on failure; empty
 * member server present-0); canonical five-state fixture emitted for
 * Mobile/Web. Oracle equality vs the retired per-server path lives in
 * services/activityUnreadTotalsBatch.oracle.test.ts (DoD 9c/9d).
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { serverMembers, users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { addHuman, createChannel } from "../services/channelService.js";
import { createMessage } from "../services/messageService.js";
import { computeActivityUnreadCounts } from "../services/activityUnreadSummaryService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "test-contracts", "unread-summary-activity.v1.json",
);

interface SummaryEntry {
  serverId: string;
  unreadCount: number;
  serverPushMuted: boolean;
  activityUnreadCount?: number;
}

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



async function fetchSummary(baseUrl: string, token: string): Promise<SummaryEntry[]> {
  const res = await fetch(`${baseUrl}/api/servers/unread-summary`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  return await res.json() as SummaryEntry[];
}

async function fetchInboxTotals(
  baseUrl: string,
  token: string,
  serverId: string,
  limit: number,
): Promise<{ totalUnreadCount: number; activeUnreadCount: number }> {
  const url = new URL(`${baseUrl}/api/channels/inbox`);
  url.searchParams.set("filter", "all");
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverId },
  });
  assert.equal(res.status, 200);
  return await res.json() as { totalUnreadCount: number; activeUnreadCount: number };
}

test("unread-summary activityUnreadCount: wire semantics, invariant, divergence, zero-vs-absent", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("act-owner");
  const member = await seedUser("act-member");

  // Server A: member joined one channel with 2 unread, and is @mentioned in
  // a channel they did NOT join (a mention-only row: counted by
  // totalUnreadCount, excluded from activeUnreadCount).
  const serverA = await createServer("Activity A", "activity-a-srv", owner.id);
  await db.insert(serverMembers).values({ serverId: serverA.id, userId: member.id, role: "member" });
  const joined = await createChannel(serverA.id, "joined-room");
  await addHuman(joined.id, owner.id);
  await addHuman(joined.id, member.id);
  await createMessage(joined.id, "user", owner.id, "unread one");
  await createMessage(joined.id, "user", owner.id, "unread two");
  const notJoined = await createChannel(serverA.id, "mention-room");
  await addHuman(notJoined.id, owner.id);
  // Mentions resolve on the message ROUTE (structured @handle plumbing), so
  // the mention-only row must be seeded through HTTP, not the bare service.
  const ownerToken = await tokenForHuman(owner.email);
  const mentionRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ownerToken}`,
      "X-Server-Id": serverA.id,
    },
    body: JSON.stringify({ channelId: notJoined.id, content: `@${member.name} ping` }),
  });
  assert.equal(mentionRes.status, 200);

  // Server B: member joined, fully caught up — the contract's "known zero".
  const serverB = await createServer("Activity B", "activity-b-srv", owner.id);
  await db.insert(serverMembers).values({ serverId: serverB.id, userId: member.id, role: "member" });
  const quiet = await createChannel(serverB.id, "quiet-room");
  await addHuman(quiet.id, member.id);

  const token = await tokenForHuman(member.email);
  const summary = await fetchSummary(app.baseUrl, token);
  const entryA = summary.find((entry) => entry.serverId === serverA.id);
  const entryB = summary.find((entry) => entry.serverId === serverB.id);
  assert.ok(entryA, "member must get an entry for server A");
  assert.ok(entryB, "member must get an entry for server B");

  // Wire: non-negative safe integer when present; known zero is PRESENT.
  assert.ok(Number.isSafeInteger(entryA.activityUnreadCount), "A count must be a safe integer");
  assert.ok((entryA.activityUnreadCount as number) >= 0);
  assert.equal(entryB.activityUnreadCount, 0, "caught-up server must report known zero, not absent");
  assert.ok("activityUnreadCount" in entryB, "known zero must be present on the wire");

  // Invariant (DoD #7): the field equals the Home authority
  // totalUnreadCount, closed-book on a quiesced test database.
  const totalsA = await fetchInboxTotals(app.baseUrl, token, serverA.id, 100);
  assert.equal(entryA.activityUnreadCount, totalsA.totalUnreadCount,
    "switcher count must equal Home's totalUnreadCount");
  // Aggregate provenance (DoD #11): the mention-only divergence between
  // totalUnreadCount and activeUnreadCount only exists on inbox contract v2
  // backends — pglite runs the v1 contract where mention_only is forced
  // false and the two aggregates are equal by construction
  // (channelService.ts:7524). The seeded non-member @mention makes them
  // diverge on v2; assert it whenever this suite runs against such a
  // backend, and record the explicit gap otherwise (no silent green).
  if (totalsA.totalUnreadCount !== totalsA.activeUnreadCount) {
    assert.equal(entryA.activityUnreadCount, totalsA.totalUnreadCount);
    assert.notEqual(entryA.activityUnreadCount, totalsA.activeUnreadCount,
      "field must NOT come from activeUnreadCount");
  } else {
    assert.equal(process.env.INBOX_CONTRACT_V2 ?? "", "",
      "backend claims contract v2 but aggregates did not diverge — divergence tooth failed");
    console.warn("[task235] divergence tooth NOT exercised: v1 backend (aggregates equal by construction); covered on contract-v2 backends");
  }

  // Pagination independence (DoD #9): limit=1 and limit=100 agree, and the
  // summary field agrees with both.
  const totalsAPage = await fetchInboxTotals(app.baseUrl, token, serverA.id, 1);
  assert.equal(totalsAPage.totalUnreadCount, totalsA.totalUnreadCount,
    "totalUnreadCount must not vary with limit");
  assert.equal(entryA.activityUnreadCount, totalsAPage.totalUnreadCount);

  // Unauthorized / not-member (DoD fixture state): the owner-only server
  // list for a third user contains no entry at all for these servers.
  const outsider = await seedUser("act-outsider");
  const outsiderToken = await tokenForHuman(outsider.email);
  const outsiderSummary = await fetchSummary(app.baseUrl, outsiderToken);
  assert.equal(outsiderSummary.find((entry) => entry.serverId === serverA.id), undefined,
    "non-member gets no entry (absent entry = not a member, never zero)");

  // Legacy regression (DoD #3): stripping the new field yields exactly the
  // legacy shape, and legacy values are未受影响.
  for (const entry of summary) {
    const { activityUnreadCount: _stripped, ...legacy } = entry;
    assert.deepEqual(Object.keys(legacy).sort(), ["serverId", "serverPushMuted", "unreadCount"]);
    assert.equal(typeof legacy.unreadCount, "number");
    assert.equal(typeof legacy.serverPushMuted, "boolean");
  }

  // Mute orthogonality (DoD #5): muting server A must not change the count.
  await db.update(serverMembers)
    .set({ serverPushMuted: true })
    .where(and(eq(serverMembers.serverId, serverA.id), eq(serverMembers.userId, member.id)));
  const mutedSummary = await fetchSummary(app.baseUrl, token);
  const mutedEntryA = mutedSummary.find((entry) => entry.serverId === serverA.id);
  assert.ok(mutedEntryA);
  assert.equal(mutedEntryA.serverPushMuted, true);
  assert.equal(mutedEntryA.activityUnreadCount, entryA.activityUnreadCount,
    "mute must not change the fact count");
});

test("computeActivityUnreadCounts: batch failure makes the WHOLE batch unknown (DoD #4, contract §5)", async () => {
  // One set-based query = one failure domain. A batch query failure must not
  // pretend per-server isolation: every server's field becomes absent.
  const counts = await computeActivityUnreadCounts(
    [{ serverId: "srv-a" }, { serverId: "srv-b" }],
    "user-1",
    async () => { throw new Error("batch boom"); },
  );
  assert.equal(counts.size, 0, "batch failure → all servers unknown, none zero");
});

test("computeActivityUnreadCounts: provable per-server causes yield mixed known/unknown (contract §5/§7)", async () => {
  // The mixed state arises ONLY from provable per-server causes — here,
  // per-group validation of the batch result (a non-integer or missing
  // group), never a pretended isolatable per-server SQL failure.
  const counts = await computeActivityUnreadCounts(
    [{ serverId: "srv-ok" }, { serverId: "srv-nonint" }, { serverId: "srv-missing" }],
    "user-1",
    async () => new Map([
      ["srv-ok", { totalUnreadCount: 7, activeUnreadCount: 7 }],
      ["srv-nonint", { totalUnreadCount: Number.NaN, activeUnreadCount: 1 }],
    ]),
  );
  assert.equal(counts.get("srv-ok"), 7, "valid group stays known");
  assert.equal(counts.has("srv-nonint"), false, "non-integer group treated as unknown");
  assert.equal(counts.has("srv-missing"), false, "group absent from batch result stays unknown");
});

test("computeActivityUnreadCounts: provenance selects totalUnreadCount, never activeUnreadCount (DoD #11)", async () => {
  // Deterministic divergence: the injected batch result carries both
  // aggregates with different values, so an implementation that read
  // activeUnreadCount would produce 2 and fail. This proves the provenance
  // choice independently of any backend's ability to create mention-only
  // rows (the pglite v1 contract cannot; the API-level divergence assertion
  // in the wire test above executes on contract-v2 backends as
  // defense-in-depth).
  const server = "srv-diverge";
  const counts = await computeActivityUnreadCounts(
    [{ serverId: server }],
    "user-1",
    async () => new Map([[server, { totalUnreadCount: 5, activeUnreadCount: 2 }]]),
  );
  assert.equal(counts.get(server), 5, "field must equal totalUnreadCount");
  assert.notEqual(counts.get(server), 2, "field must not equal activeUnreadCount");
});

test("canonical five-state contract fixture is committed and current (DoD #8)", () => {
  // The fixture is the cross-client contract artifact: Web consumes it
  // in-repo; Mobile mirrors it pinned to an exact upstream commit and its
  // Hosted gate byte-compares against that commit (contract §7). It is
  // deterministic by construction (symbolic ids, no runtime values).
  const fixture = {
    schema: "unread-summary-activity.v1",
    contract: "task #235 Phase 1 v2.3.1",
    endpoint: "GET /api/servers/unread-summary",
    authority: "GET /api/channels/inbox?filter=all → totalUnreadCount",
    states: [
      {
        state: "zero",
        request: { user: "MEMBER", server: "SERVER_CAUGHT_UP" },
        entry: { serverId: "SERVER_CAUGHT_UP", unreadCount: 0, serverPushMuted: false, activityUnreadCount: 0 },
        expect: "render exact numeric badge 0-state (present means known; empty member server is also present-0, never absent)",
      },
      {
        state: "positive",
        request: { user: "MEMBER", server: "SERVER_WITH_UNREAD" },
        entry: { serverId: "SERVER_WITH_UNREAD", unreadCount: 2, serverPushMuted: false, activityUnreadCount: 3 },
        expect: "render exact numeric badge 3; never substitute broader unreadCount",
      },
      {
        state: "batch-failure-all-unknown",
        request: { user: "MEMBER", server: "ALL" },
        entries: [
          { serverId: "SERVER_WITH_UNREAD", unreadCount: 2, serverPushMuted: false },
          { serverId: "SERVER_CAUGHT_UP", unreadCount: 0, serverPushMuted: false },
        ],
        expect: "the ONE set-based batch query failed → HTTP 200, every entry keeps legacy fields, activityUnreadCount absent on ALL entries (single failure domain; no pretended per-server isolation)",
      },
      {
        state: "unauthorized",
        request: { user: "NON_MEMBER", server: "SERVER_NOT_JOINED" },
        entry: null,
        expect: "entry absent entirely → same unknown fallback as an absent field; clients must not render a third state",
      },
      {
        state: "mixed-known-unknown",
        request: { user: "MEMBER", server: "ALL" },
        entries: [
          { serverId: "SERVER_WITH_UNREAD", unreadCount: 2, serverPushMuted: false, activityUnreadCount: 3 },
          { serverId: "SERVER_GROUP_INVALID", unreadCount: 5, serverPushMuted: false },
        ],
        expect: "mixed state arises ONLY from provable per-server causes (per-group validation failure, permission loss, feature gate) — never from a pretended isolatable per-server SQL compute failure; unknown entries fall back to dot/hidden",
      },
    ],
    muteRule: "serverPushMuted never alters activityUnreadCount; muted servers show the exact number (weakened style allowed); dot/hidden only for absent/unknown",
    freshness: "count may lag ≤30s; Activity snapshot is the reconciliation authority on server entry",
  };
  const rendered = `${JSON.stringify(fixture, null, 2)}\n`;
  if (process.env.REGENERATE_CONTRACT_FIXTURES === "1" || !existsSync(FIXTURE_PATH)) {
    mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
    writeFileSync(FIXTURE_PATH, rendered);
  }
  const committed = readFileSync(FIXTURE_PATH, "utf8");
  assert.equal(committed, rendered,
    "committed canonical fixture must match the contract emission (drift red; REGENERATE_CONTRACT_FIXTURES=1 to update)");
});
