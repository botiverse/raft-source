import assert from "node:assert/strict";
import type { Server as SocketServer } from "socket.io";
import { NOTIFICATION_RETRACT_EVENT, type NotificationRetractPayload } from "@botiverse/raft-shared";
import { isRedisAvailable } from "../../redis";
import { socketClientKindRoom } from "../../socket/platformScope";
import { __resetHeldPhoneAlertMarkersForTests, markHeldPhoneAlerts } from "./mobileDeferral";
import {
  RETRACTION_COALESCE_MS,
  SHOWN_GROUPS_TTL_SECONDS,
  __resetRetractionForTests,
  __setRetractionRuntimeForTests,
  flushPendingRetractionsForTests,
  onConversationsRead,
  recordShownGroups,
  takeShownGroups,
} from "./retraction";

// Phone retract pushes (a group that alerted on a phone) load registrations and
// the badge from the database: covered by the dispatcher / enqueue DB tests.
// Here the database is never initialized, so reaching it fails the flush.

type Emitted = { room: string; event: string; payload: NotificationRetractPayload };

function createIo(): { io: SocketServer; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const io = {
    to(room: string) {
      return {
        emit(event: string, payload: NotificationRetractPayload) {
          emitted.push({ room, event, payload });
          return true;
        },
      };
    },
  };
  return { io: io as unknown as SocketServer, emitted };
}

type Timer = { fn: () => void; ms: number; cleared: boolean };
let timers: Timer[] = [];
let cancelled: Array<{ userId: string; scopes: unknown }> = [];
let consoleError: { mock: { calls: unknown[][] }; mockRestore(): void };

beforeEach(() => {
  __resetRetractionForTests();
  timers = [];
  cancelled = [];
  __setRetractionRuntimeForTests({
    cancelReadDeferrals: async (userId, scopes) => {
      cancelled.push({ userId, scopes });
      return 0;
    },
    setTimer: (fn, ms) => {
      const timer: Timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as Timer).cleared = true;
    },
  });
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
  __resetRetractionForTests();
});

/** Fire every armed timer (the 2 s window elapsed) and wait for the flushes. */
async function elapse(): Promise<void> {
  const armed = timers.filter((timer) => !timer.cleared);
  timers = [];
  for (const timer of armed) timer.fn();
  await flushPendingRetractionsForTests();
}

const ROOMS = (userId: string) => [
  socketClientKindRoom(userId, "desktop"),
  socketClientKindRoom(userId, "web"),
  socketClientKindRoom(userId, "mobile"),
];

test("unit tests run on the local (no Redis) fallback", () => {
  assert.equal(isRedisAvailable(), false);
});

describe("onConversationsRead", () => {
  test("one read emits one retract per conversation to desktop, web and mobile after the 2 s window", async () => {
    const { io, emitted } = createIo();
    onConversationsRead(io, "u1", "srv-1", [{ conversationId: "ch-1", throughSeq: 9 }]);
    assert.equal(timers.length, 1);
    assert.equal(timers[0]!.ms, RETRACTION_COALESCE_MS);
    assert.equal(RETRACTION_COALESCE_MS, 2_000);
    assert.equal(emitted.length, 0, "nothing before the window elapses");

    await elapse();
    const payload: NotificationRetractPayload = { serverId: "srv-1", groupKey: "srv-1:ch-1", conversationId: "ch-1", throughSeq: 9 };
    assert.deepEqual(emitted, ROOMS("u1").map((room) => ({ room, event: NOTIFICATION_RETRACT_EVENT, payload })));
    assert.equal(NOTIFICATION_RETRACT_EVENT, "notification:retract");
    assert.equal(consoleError.mock.calls.length, 0, "no shown group: the database is not touched");
  });

  test("reads of one user in the window coalesce per conversation (max seq; null = all)", async () => {
    const { io, emitted } = createIo();
    onConversationsRead(io, "u1", "srv-1", [{ conversationId: "ch-1", throughSeq: 3 }, { conversationId: "ch-2", throughSeq: 10 }]);
    onConversationsRead(io, "u1", "srv-1", [{ conversationId: "ch-1", throughSeq: 5 }]);
    onConversationsRead(io, "u1", "srv-1", [{ conversationId: "ch-2", throughSeq: 4 }]);
    onConversationsRead(io, "u1", "srv-1", [{ conversationId: "ch-3", throughSeq: 2 }]);
    onConversationsRead(io, "u1", "srv-1", [{ conversationId: "ch-3", throughSeq: null }, { conversationId: "ch-3", throughSeq: 8 }]);
    assert.equal(timers.length, 1, "one window per user");

    await elapse();
    const desktop = emitted.filter((entry) => entry.room === socketClientKindRoom("u1", "desktop")).map((entry) => entry.payload);
    assert.deepEqual(desktop, [
      { serverId: "srv-1", groupKey: "srv-1:ch-1", conversationId: "ch-1", throughSeq: 5 },
      { serverId: "srv-1", groupKey: "srv-1:ch-2", conversationId: "ch-2", throughSeq: 10 },
      { serverId: "srv-1", groupKey: "srv-1:ch-3", conversationId: "ch-3", throughSeq: null },
    ]);
    assert.equal(emitted.length, 9);
  });

  test("the same conversation id in two servers stays two groups", async () => {
    const { io, emitted } = createIo();
    onConversationsRead(io, "u1", "srv-1", [{ conversationId: "ch-1", throughSeq: 1 }]);
    onConversationsRead(io, "u1", "srv-2", [{ conversationId: "ch-1", throughSeq: 2 }]);
    await elapse();
    const groups = emitted.filter((entry) => entry.room === socketClientKindRoom("u1", "web")).map((entry) => entry.payload.groupKey);
    assert.deepEqual(groups, ["srv-1:ch-1", "srv-2:ch-1"]);
  });

  test("different users are independent", async () => {
    const { io, emitted } = createIo();
    onConversationsRead(io, "u1", "srv-1", [{ conversationId: "ch-1", throughSeq: 3 }]);
    onConversationsRead(io, "u2", "srv-1", [{ conversationId: "ch-1", throughSeq: 7 }]);
    assert.equal(timers.length, 2);

    timers[1]!.fn();
    // u2's window ran; u1's is still pending.
    assert.deepEqual(
      emitted.filter((entry) => entry.room === socketClientKindRoom("u2", "desktop")).map((entry) => entry.payload.throughSeq),
      [7],
    );
    assert.equal(emitted.some((entry) => entry.room.startsWith("user:u1:")), false);
    timers = [timers[0]!];
    await elapse();
    assert.deepEqual(
      emitted.filter((entry) => entry.room === socketClientKindRoom("u1", "desktop")).map((entry) => entry.payload.throughSeq),
      [3],
    );
  });

  test("a new window starts after a flush", async () => {
    const { io, emitted } = createIo();
    onConversationsRead(io, "u1", "srv-1", [{ conversationId: "ch-1", throughSeq: 3 }]);
    await elapse();
    onConversationsRead(io, "u1", "srv-1", [{ conversationId: "ch-1", throughSeq: 4 }]);
    assert.equal(timers.length, 1);
    await elapse();
    assert.deepEqual(
      emitted.filter((entry) => entry.room === socketClientKindRoom("u1", "mobile")).map((entry) => entry.payload.throughSeq),
      [3, 4],
    );
  });

  test("no io or no scopes: nothing is scheduled", async () => {
    onConversationsRead(undefined, "u1", "srv-1", [{ conversationId: "ch-1", throughSeq: 1 }]);
    const { io, emitted } = createIo();
    onConversationsRead(io, "u1", "srv-1", []);
    assert.equal(timers.length, 0);
    await elapse();
    assert.equal(emitted.length, 0);
  });

  test("a group that alerted on a phone goes on to the phone retract path (database; not available here)", async () => {
    const { io, emitted } = createIo();
    await recordShownGroups("u1", ["srv-1:ch-1"]);
    onConversationsRead(io, "u1", "srv-1", [{ conversationId: "ch-1", throughSeq: 2 }]);
    await elapse();
    assert.equal(emitted.length, 3, "sockets are retracted before the phone path");
    assert.equal(consoleError.mock.calls.length, 1, "the phone path reached the (uninitialized) database");
    assert.deepEqual(await takeShownGroups("u1", ["srv-1:ch-1"]), [], "the shown group was taken");
  });
});

describe("shown groups (local fallback)", () => {
  const NOW = 1_000_000;

  test("only shown groups are taken, and taken groups are removed", async () => {
    await recordShownGroups("u1", ["srv-1:ch-1", "srv-1:ch-2"], NOW);
    assert.deepEqual(await takeShownGroups("u1", ["srv-1:ch-1", "srv-1:ch-3"], NOW), ["srv-1:ch-1"]);
    assert.deepEqual(await takeShownGroups("u1", ["srv-1:ch-1"], NOW), []);
    assert.deepEqual(await takeShownGroups("u1", ["srv-1:ch-2"], NOW), ["srv-1:ch-2"]);
  });

  test("groups are per user", async () => {
    await recordShownGroups("u1", ["srv-1:ch-1"], NOW);
    assert.deepEqual(await takeShownGroups("u2", ["srv-1:ch-1"], NOW), []);
    assert.deepEqual(await takeShownGroups("u1", ["srv-1:ch-1"], NOW), ["srv-1:ch-1"]);
  });

  test("a shown group expires after 3 days", async () => {
    assert.equal(SHOWN_GROUPS_TTL_SECONDS, 3 * 24 * 60 * 60);
    const ttlMs = SHOWN_GROUPS_TTL_SECONDS * 1000;
    await recordShownGroups("u1", ["srv-1:ch-1", "srv-1:ch-2"], NOW);
    assert.deepEqual(await takeShownGroups("u1", ["srv-1:ch-1"], NOW + ttlMs - 1), ["srv-1:ch-1"]);
    assert.deepEqual(await takeShownGroups("u1", ["srv-1:ch-2"], NOW + ttlMs), []);
  });

  test("recording again refreshes the expiry", async () => {
    const ttlMs = SHOWN_GROUPS_TTL_SECONDS * 1000;
    await recordShownGroups("u1", ["srv-1:ch-1"], NOW);
    await recordShownGroups("u1", ["srv-1:ch-1"], NOW + ttlMs - 10);
    assert.deepEqual(await takeShownGroups("u1", ["srv-1:ch-1"], NOW + ttlMs + 10), ["srv-1:ch-1"]);
  });

  test("empty inputs", async () => {
    await recordShownGroups("u1", [], NOW);
    assert.deepEqual(await takeShownGroups("u1", [], NOW), []);
    assert.deepEqual(await takeShownGroups("nobody", ["srv-1:ch-1"], NOW), []);
  });
});

test("every socket retract is counted (slock_notification_retracts_total)", async () => {
  const { notificationRetractsTotal } = await import("../../metrics");
  const value = async () => (await notificationRetractsTotal.get()).values
    .filter((v) => v.labels.transport === "socket").reduce((sum, v) => sum + v.value, 0);
  const before = await value();
  const { io } = createIo();
  onConversationsRead(io, "u1", "srv-1", [{ conversationId: "ch-1", throughSeq: 1 }, { conversationId: "ch-2", throughSeq: 1 }]);
  await elapse();
  assert.equal(await value(), before + 2);
});

describe("held phone alerts (Phone alerts delay) are cancelled on read", () => {
  test("at once, not after the 2 s coalescing, with the read positions as given; even without a socket server", async () => {
    const { io } = createIo();
    onConversationsRead(io, "u1", "srv-1", [{ conversationId: "ch-1", throughSeq: 9 }, { conversationId: "ch-2", throughSeq: null }]);
    assert.deepEqual(cancelled, [{ userId: "u1", scopes: [{ conversationId: "ch-1", throughSeq: 9 }, { conversationId: "ch-2", throughSeq: null }] }]);
    assert.equal(timers.length, 1, "the retraction itself still waits for the window");
    onConversationsRead(undefined, "u2", "srv-1", [{ conversationId: "ch-3", throughSeq: 1 }]);
    assert.equal(cancelled.length, 2, "no io: the held alert is still cancelled");
    onConversationsRead(io, "u1", "srv-1", []);
    assert.equal(cancelled.length, 2, "nothing read: nothing to cancel");
    await elapse();
  });

  test("a failed cancel is logged and never breaks the retraction (the fire-time read check remains)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    __setRetractionRuntimeForTests({
      setTimer: (fn, ms) => { const timer: Timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
      clearTimer: (handle) => { (handle as Timer).cleared = true; },
      cancelReadDeferrals: async () => { throw new Error("db down"); },
    });
    const { io, emitted } = createIo();
    onConversationsRead(io, "u1", "srv-1", [{ conversationId: "ch-1", throughSeq: 2 }]);
    await elapse();
    assert.equal(emitted.length, 3, "the sockets still hear the retract");
    assert.match(String(warn.mock.calls[0]?.[0]), /could not cancel held phone alerts/);
    warn.mockRestore();
  });
});

test("S6: a reader without held phone alerts (mobileDelay inactive / always) costs no query; one with a marker does", async () => {
  __resetHeldPhoneAlertMarkersForTests();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // The default cancel: the database is never initialized here, so reaching it warns.
  __setRetractionRuntimeForTests({
    setTimer: (fn, ms) => { const timer: Timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (handle) => { (handle as Timer).cleared = true; },
  });
  onConversationsRead(undefined, "quiet-reader", "srv-1", [{ conversationId: "ch-1", throughSeq: 1 }]);
  await flushPendingRetractionsForTests();
  assert.equal(warn.mock.calls.length, 0, "no marker: the query is skipped");
  await markHeldPhoneAlerts(["held-reader"]);
  onConversationsRead(undefined, "held-reader", "srv-1", [{ conversationId: "ch-1", throughSeq: 1 }]);
  await flushPendingRetractionsForTests();
  assert.match(String(warn.mock.calls[0]?.[0]), /could not cancel held phone alerts/, "marker: the query runs");
  warn.mockRestore();
  __resetHeldPhoneAlertMarkersForTests();
});
