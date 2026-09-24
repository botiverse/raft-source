import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  __clearSessionServiceLocalReplayCacheForTests,
  __getSessionServiceLocalReplayCacheSizeForTests,
  __resetSessionServiceDbForTests,
  __setSessionServiceDbForTests,
  __setSessionServiceReplayStoreForTests,
  refreshSession,
  refreshSessionWithTrace,
  rotateSession,
} from "./sessionService.js";
import { sessionFamilies, sessions, sessionTokenPredecessors } from "../db/schema.js";

type DeleteCapture = { table?: unknown };
type InsertCapture = { table?: unknown; values?: Record<string, unknown> };
type ReplayPayload = { userId: string; familyId: string; refreshToken: string; expiresAt: Date };

function makeDeleteBuilder<T>(result: T, capture?: DeleteCapture) {
  const afterWhere: any = {
    returning() {
      return afterWhere;
    },
    then(resolve: (value: T) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };

  return {
    where() {
      return afterWhere;
    },
  };
}

function makeInsertBuilder(capture?: InsertCapture) {
  const afterValues: any = {
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(undefined).then(resolve, reject);
    },
  };

  return {
    values(values: Record<string, unknown>) {
      if (capture) capture.values = values;
      return afterValues;
    },
  };
}

function makeSelectBuilder<T>(result: T) {
  const afterWhere: any = {
    then(resolve: (value: T) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };

  return {
    from() {
      return {
        where() {
          return afterWhere;
        },
      };
    },
  };
}

function makeDb(options: {
  deleteResults: unknown[][];
  selectResults?: unknown[][];
  insertCaptures?: InsertCapture[];
}) {
  const deleteResults = [...options.deleteResults];
  const selectResults = [...(options.selectResults ?? [])];
  const insertCaptures = [...(options.insertCaptures ?? [])];

  return {
    select() {
      const result = selectResults.shift();
      if (!result) throw new Error("Unexpected select");
      return makeSelectBuilder(result);
    },
    transaction: async (fn: (tx: any) => Promise<unknown>) => {
      const tx = {
        select() {
          return { from: () => ({ where: () => ({ limit: () => ({
            for: async () => [{ retiredAt: null }],
          }) }) }) };
        },
        delete(table: unknown) {
          const result = deleteResults.shift();
          if (!result) throw new Error("Unexpected delete");
          return makeDeleteBuilder(result, { table });
        },
        insert(table: unknown) {
          const capture = table === sessionTokenPredecessors ? undefined : insertCaptures.shift();
          if (capture) capture.table = table;
          return makeInsertBuilder(capture);
        },
      };

      return fn(tx);
    },
  };
}

function makeReplayStore() {
  const rotations = new Map<string, ReplayPayload>();
  return {
    rotations,
    store: {
      async remember(oldTokenHash: string, rotation: ReplayPayload) {
        rotations.set(oldTokenHash, rotation);
      },
      async replay(oldTokenHash: string) {
        return rotations.get(oldTokenHash) ?? null;
      },
    },
  };
}

afterEach(() => {
  __resetSessionServiceDbForTests();
});

test("rotateSession consumes a refresh token only once", async () => {
  const insertCapture: InsertCapture = {};
  const db = makeDb({
    deleteResults: [[{ userId: "user-1", familyId: "family-1" }], []],
    insertCaptures: [insertCapture],
  });
  __setSessionServiceDbForTests(() => db as any);

  const first = await rotateSession("refresh-token-1", "user-1");
  const second = await rotateSession("refresh-token-1", "user-1");

  assert.ok(first?.refreshToken);
  assert.ok(first?.expiresAt instanceof Date);
  assert.equal(second, null);
  assert.equal(insertCapture.table, sessions);
  assert.equal(insertCapture.values?.userId, "user-1");
  assert.equal(insertCapture.values?.familyId, "family-1", "refresh rotation must inherit the consumed session family");
  assert.equal(first.familyId, "family-1");
});

test("refresh interleaving cannot fork one validated token into two child sessions", async () => {
  const firstInsertCapture: InsertCapture = {};
  const secondInsertCapture: InsertCapture = {};
  const db = makeDb({
    deleteResults: [[{ userId: "user-1", familyId: "family-1" }], []],
    insertCaptures: [firstInsertCapture, secondInsertCapture],
  });
  __setSessionServiceDbForTests(() => db as any);

  // This models two /auth/refresh handlers that both validated the same old
  // refresh token before either handler attempted rotation.
  const validatedUserIdFromRequestA = "user-1";
  const validatedUserIdFromRequestB = "user-1";

  const first = await rotateSession("refresh-token-1", validatedUserIdFromRequestA);
  const second = await rotateSession("refresh-token-1", validatedUserIdFromRequestB);

  assert.ok(first?.refreshToken);
  assert.equal(second, null);
  assert.equal(firstInsertCapture.table, sessions);
  assert.equal(firstInsertCapture.values?.userId, "user-1");
  assert.equal(secondInsertCapture.values, undefined);
});

test("rotateSession does not create a child token when no session row is consumed", async () => {
  const db = makeDb({
    deleteResults: [[]],
    insertCaptures: [],
  });
  __setSessionServiceDbForTests(() => db as any);

  const rotated = await rotateSession("refresh-token-1", "user-1");

  assert.equal(rotated, null);
});

test("rotateSession adopts a mixed-version legacy session that has no family", async () => {
  const familyInsert: InsertCapture = {};
  const sessionInsert: InsertCapture = {};
  const db = makeDb({
    deleteResults: [[{ userId: "user-1", familyId: null }]],
    insertCaptures: [familyInsert, sessionInsert],
  });
  __setSessionServiceDbForTests(() => db as any);

  const rotated = await rotateSession("legacy-refresh-token", "user-1");

  assert.ok(rotated?.familyId);
  assert.equal(familyInsert.table, sessionFamilies);
  assert.equal(familyInsert.values?.id, rotated.familyId);
  assert.equal(sessionInsert.table, sessions);
  assert.equal(sessionInsert.values?.familyId, rotated.familyId);
});

test("refreshSession replays a just-rotated token for an old refresh token", async () => {
  const expiresAt = new Date(Date.now() + 60_000);
  const db = makeDb({
    deleteResults: [[{ userId: "user-1", familyId: "family-1" }]],
    selectResults: [[], [{ id: "session-2", userId: "user-1", expiresAt }]],
  });
  __setSessionServiceDbForTests(() => db as any);

  const first = await rotateSession("refresh-token-1", "user-1");
  assert.ok(first?.refreshToken);

  const replay = await refreshSession("refresh-token-1");

  assert.equal(replay?.userId, "user-1");
  assert.equal(replay?.refreshToken, first.refreshToken);
  assert.equal(replay?.expiresAt, first.expiresAt);
  assert.equal(replay?.replayedRotation, true);
});

test("refreshSessionWithTrace attributes same-replica replay as local_hit", async () => {
  const expiresAt = new Date(Date.now() + 60_000);
  const db = makeDb({
    deleteResults: [[{ userId: "user-1", familyId: "family-1" }]],
    selectResults: [[], [{ id: "session-2", userId: "user-1", expiresAt }]],
  });
  __setSessionServiceDbForTests(() => db as any);
  __setSessionServiceReplayStoreForTests(null);

  const first = await rotateSession("refresh-token-1", "user-1");
  assert.ok(first?.refreshToken);

  const result = await refreshSessionWithTrace("refresh-token-1");

  assert.equal(result.refreshed?.refreshToken, first.refreshToken);
  assert.equal(result.refreshed?.replayedRotation, true);
  assert.equal(result.replayTrace.replayLookupResult, "local_hit");
  assert.equal(result.replayTrace.redisAvailable, false);
  assert.equal(result.replayTrace.graceAgeBucket, "<1s");
});

test("refreshSession replays a just-rotated token from shared store when local replica cache misses", async () => {
  const shared = makeReplayStore();
  const expiresAt = new Date(Date.now() + 60_000);
  const db = makeDb({
    deleteResults: [[{ userId: "user-1", familyId: "family-1" }]],
    selectResults: [[], [{ id: "session-2", userId: "user-1", expiresAt }]],
  });
  __setSessionServiceDbForTests(() => db as any);
  __setSessionServiceReplayStoreForTests(shared.store);

  const first = await rotateSession("refresh-token-1", "user-1");
  assert.ok(first?.refreshToken);

  // Models loser refresh landing on a different server replica: DB is shared,
  // but this process has no local `recentRotationsByOldHash` entry.
  __clearSessionServiceLocalReplayCacheForTests();
  const replay = await refreshSession("refresh-token-1");

  assert.equal(shared.rotations.size, 1);
  assert.equal(replay?.userId, "user-1");
  assert.equal(replay?.refreshToken, first.refreshToken);
  assert.equal(replay?.expiresAt, first.expiresAt);
  assert.equal(replay?.replayedRotation, true);
});

test("refreshSessionWithTrace attributes cross-replica replay as shared_hit", async () => {
  const shared = makeReplayStore();
  const expiresAt = new Date(Date.now() + 60_000);
  const db = makeDb({
    deleteResults: [[{ userId: "user-1", familyId: "family-1" }]],
    selectResults: [[], [{ id: "session-2", userId: "user-1", expiresAt }]],
  });
  __setSessionServiceDbForTests(() => db as any);
  __setSessionServiceReplayStoreForTests(shared.store);

  const first = await rotateSession("refresh-token-1", "user-1");
  assert.ok(first?.refreshToken);

  __clearSessionServiceLocalReplayCacheForTests();
  const result = await refreshSessionWithTrace("refresh-token-1");

  assert.equal(result.refreshed?.refreshToken, first.refreshToken);
  assert.equal(result.refreshed?.replayedRotation, true);
  assert.equal(result.replayTrace.replayLookupResult, "shared_hit");
  assert.equal(result.replayTrace.redisAvailable, true);
  assert.equal(result.replayTrace.graceAgeBucket, "<1s");
});

test("refreshSession replays an adopted child token that was already rotated on another replica", async () => {
  const shared = makeReplayStore();
  const expiresAt = new Date(Date.now() + 60_000);
  const db = makeDb({
    deleteResults: [[{ userId: "user-1", familyId: "family-1" }], [{ userId: "user-1", familyId: "family-1" }]],
    selectResults: [[], [{ id: "session-3", userId: "user-1", expiresAt }]],
  });
  __setSessionServiceDbForTests(() => db as any);
  __setSessionServiceReplayStoreForTests(shared.store);

  const first = await rotateSession("refresh-token-0", "user-1");
  assert.ok(first?.refreshToken);
  const second = await rotateSession(first.refreshToken, "user-1");
  assert.ok(second?.refreshToken);

  // Models a tab that adopted RT1 from cross-tab sync, but another replica
  // already rotated RT1 to RT2 before this tab refreshed.
  __clearSessionServiceLocalReplayCacheForTests();
  const replay = await refreshSession(first.refreshToken);

  assert.equal(shared.rotations.size, 2);
  assert.equal(replay?.userId, "user-1");
  assert.equal(replay?.refreshToken, second.refreshToken);
  assert.equal(replay?.expiresAt, second.expiresAt);
  assert.equal(replay?.replayedRotation, true);
});

test("refreshSession preserves same-replica replay when shared store write fails", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  const expiresAt = new Date(Date.now() + 60_000);
  const db = makeDb({
    deleteResults: [[{ userId: "user-1", familyId: "family-1" }]],
    selectResults: [[], [{ id: "session-2", userId: "user-1", expiresAt }]],
  });
  try {
    __setSessionServiceDbForTests(() => db as any);
    __setSessionServiceReplayStoreForTests({
      async remember() {
        throw new Error("redis down");
      },
      async replay() {
        throw new Error("redis down");
      },
    });

    const first = await rotateSession("refresh-token-1", "user-1");
    assert.ok(first?.refreshToken);
    const replay = await refreshSession("refresh-token-1");

    assert.equal(replay?.refreshToken, first.refreshToken);
    assert.equal(replay?.replayedRotation, true);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /failed to persist refresh replay grace/);
  } finally {
    console.warn = originalWarn;
  }
});

test("refreshSession does not replay a rotated child session after revocation", async () => {
  const db = makeDb({
    deleteResults: [[{ userId: "user-1", familyId: "family-1" }]],
    selectResults: [[], []],
  });
  __setSessionServiceDbForTests(() => db as any);

  const first = await rotateSession("refresh-token-1", "user-1");
  assert.ok(first?.refreshToken);

  const replay = await refreshSession("refresh-token-1");

  assert.equal(replay, null);
});

test("refreshSession replays when validation won the race but rotation was already consumed", async () => {
  const expiresAt = new Date(Date.now() + 60_000);
  const db = makeDb({
    deleteResults: [[{ userId: "user-1", familyId: "family-1" }], []],
    selectResults: [[{ id: "session-1", userId: "user-1", expiresAt }], [{ id: "session-2", userId: "user-1", expiresAt }]],
  });
  __setSessionServiceDbForTests(() => db as any);

  const first = await rotateSession("refresh-token-1", "user-1");
  assert.ok(first?.refreshToken);

  const replay = await refreshSession("refresh-token-1");

  assert.equal(replay?.userId, "user-1");
  assert.equal(replay?.refreshToken, first.refreshToken);
  assert.equal(replay?.replayedRotation, true);
});

test("refreshSession still rejects an invalid token with no recent rotation", async () => {
  const db = makeDb({
    deleteResults: [],
    selectResults: [[]],
  });
  __setSessionServiceDbForTests(() => db as any);

  const replay = await refreshSession("unknown-refresh-token");

  assert.equal(replay, null);
});

test("refreshSessionWithTrace attributes invalid token with no replay as miss", async () => {
  const db = makeDb({
    deleteResults: [],
    selectResults: [[]],
  });
  __setSessionServiceDbForTests(() => db as any);
  __setSessionServiceReplayStoreForTests(null);

  const result = await refreshSessionWithTrace("unknown-refresh-token");

  assert.equal(result.refreshed, null);
  assert.deepEqual(result.replayTrace, {
    replayLookupResult: "miss",
    redisAvailable: false,
    graceAgeBucket: null,
  });
});

test("idle refresh replay entries expire without another lookup", async () => {
  vi.useFakeTimers();
  try {
    const db = makeDb({ deleteResults: [[{ userId: "user-1", familyId: "family-1" }]] });
    __setSessionServiceDbForTests(() => db as any);
    __setSessionServiceReplayStoreForTests(null);
    await rotateSession("audit-predecessor", "user-1");
    assert.equal(__getSessionServiceLocalReplayCacheSizeForTests(), 1);
    await vi.advanceTimersByTimeAsync(10_001);
    assert.equal(__getSessionServiceLocalReplayCacheSizeForTests(), 0);
  } finally { vi.useRealTimers(); }
});
