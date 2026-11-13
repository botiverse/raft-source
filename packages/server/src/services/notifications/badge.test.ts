import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { serverMembers } from "../../db/schema";
import { isRedisAvailable } from "../../redis";
import { dbTest } from "../../test/integration/dbTest";
import {
  NOTIFICATION_BADGE_MAX,
  __resetNotificationBadgesForTests,
  __setNotificationBadgeLoaderForTests,
  alertBadge,
  loadLastSentBadges,
  loadNotificationBadges,
  rememberSentBadge,
  serverBadgeOf,
} from "./badge";

beforeEach(() => {
  __resetNotificationBadgesForTests();
});

afterEach(() => {
  __resetNotificationBadgesForTests();
});

describe("alertBadge", () => {
  test("an unknown badge stays unknown; an alert never carries 0", () => {
    assert.equal(alertBadge(undefined), undefined);
    assert.equal(alertBadge(0), 1);
    assert.equal(alertBadge(1), 1);
    assert.equal(alertBadge(42), 42);
  });
});

describe("last sent badge (local fallback)", () => {
  test("runs without Redis in unit tests", () => {
    assert.equal(isRedisAvailable(), false);
  });

  test("remembers per user; unknown users and undefined badges are absent", async () => {
    assert.deepEqual([...await loadLastSentBadges(["u1", "u2"])], []);
    await rememberSentBadge("u1", 3);
    await rememberSentBadge("u2", undefined);
    assert.deepEqual([...await loadLastSentBadges(["u1", "u2", "u1"])], [["u1", 3]]);
    await rememberSentBadge("u1", 0);
    assert.deepEqual([...await loadLastSentBadges(["u1"])], [["u1", 0]]);
    assert.deepEqual([...await loadLastSentBadges([])], []);
  });
});

dbTest("loadNotificationBadges sums servers not at none, caps at 9999, and isolates a failing user", async ({ db, seed }) => {
  const owner = await seed.human();
  const capped = await seed.human();
  const failing = await seed.human();
  const loner = await seed.human();
  const counted = await seed.server({ owner, members: [capped, failing], name: "Counted" });
  const silenced = await seed.server({ owner, members: [capped], name: "Silenced" });
  await db.update(serverMembers)
    .set({ serverPushMode: "none" })
    .where(and(eq(serverMembers.serverId, silenced.id), eq(serverMembers.userId, owner.id)));
  await db.update(serverMembers)
    .set({ serverPushMode: "mentions" })
    .where(and(eq(serverMembers.serverId, silenced.id), eq(serverMembers.userId, capped.id)));

  const calls = new Map<string, string[]>();
  __setNotificationBadgeLoaderForTests(async (userId, serverIds) => {
    calls.set(userId, [...serverIds].sort());
    if (userId === failing.id) throw new Error("risingwave down");
    const first = (value: number) => new Map(serverIds.slice(0, 1).map((serverId) => [serverId, value]));
    if (userId === capped.id) return first(20_000);
    if (userId === owner.id) return first(4.7);
    return first(-3);
  });

  const badges = await loadNotificationBadges([owner.id, capped.id, failing.id, loner.id, owner.id], db);

  // The owner's `none` server is left out; a `mentions` server still counts.
  assert.deepEqual(calls.get(owner.id), [counted.id]);
  assert.deepEqual(calls.get(capped.id), [counted.id, silenced.id].sort());
  assert.deepEqual(calls.get(loner.id), []);
  assert.equal(calls.size, 4, "each user loaded once");

  assert.equal(badges.get(owner.id)?.total, 4);
  // serverBadge: the push's server's own term; a server at none reads 0.
  assert.equal(serverBadgeOf(badges.get(owner.id), counted.id), 4);
  assert.equal(serverBadgeOf(badges.get(owner.id), silenced.id), 0);
  assert.equal(serverBadgeOf(undefined, counted.id), undefined);
  assert.equal(badges.get(capped.id)?.total, NOTIFICATION_BADGE_MAX);
  assert.equal(NOTIFICATION_BADGE_MAX, 9_999);
  assert.equal(badges.has(failing.id), true);
  assert.equal(badges.get(failing.id), undefined, "an unreadable badge is undefined for that user only");
  assert.equal(badges.get(loner.id)?.total, 0);

  assert.deepEqual([...await loadNotificationBadges([], db)], []);
});
