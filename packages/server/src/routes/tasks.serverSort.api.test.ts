import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
/**
 * The Tasks page's sorted board reads (GET /api/tasks/server?sort=) and its
 * "today" summary filter (created_since on /server and /server/counts):
 *  - sort=activity orders by COALESCE(last_activity_at, updated_at) DESC (a row
 *    from before the column sorts by updated_at), created by created_at DESC,
 *    number by task number DESC; ties by task id DESC;
 *  - sort=activity_asc ("least recently updated") is exactly the reverse of
 *    activity: oldest activity first, ties by task id ASC, its keyset walk
 *    exact at every page size;
 *  - each sort's keyset walk returns every row exactly once at any page size,
 *    including rows a microsecond apart (the cursor keeps the stored precision);
 *  - a cursor resumes only the walk that produced it: another sort, or no
 *    sort, answers 400; the (channel, number) walk without sort is unchanged;
 *  - created_since narrows the list and the counts; malformed params are 400.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { getDb } from "../db/index";
import { tasks, users } from "../db/schema";
import { addHuman, createChannel } from "../services/channelService";
import { createServer } from "../services/serverService";
import * as taskService from "../services/taskService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

function authHeaders(token: string, serverId: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": serverId };
}

type Times = { createdAt: string; updatedAt?: string; lastActivityAt: string | null };

/**
 * Two channels, six tasks whose times are written directly (microsecond
 * literals through SQL, so the walk's precision is exercised):
 *   activity: a2 = b1 (2026-06-01, a2 through updated_at) > a1 > a4 (1 µs
 *   below a1) > a3 > b2
 *   created:  b2 > b1 > a3 > a2 > a4 > a1
 */
async function buildBoard() {
  const me = await seedUser("sort-me");
  const server = await createServer("Task Board Sort", `task-board-sort-${randomUUID().slice(0, 8)}`, me.id);
  const alpha = await createChannel(server.id, "alpha-sort");
  const beta = await createChannel(server.id, "beta-sort");
  await addHuman(alpha.id, me.id);
  await addHuman(beta.id, me.id);

  const { tasks: [a1, a2, a3, a4] } = await taskService.createTasks(alpha.id, "user", me.id, [
    { title: "a1" }, { title: "a2" }, { title: "a3" }, { title: "a4" },
  ]);
  const { tasks: [b1, b2] } = await taskService.createTasks(beta.id, "user", me.id, [{ title: "b1" }, { title: "b2" }]);
  const set = async (id: string, times: Times) => {
    await getDb().update(tasks).set({
      createdAt: sql`${times.createdAt}::timestamptz`,
      updatedAt: sql`${times.updatedAt ?? times.createdAt}::timestamptz`,
      lastActivityAt: times.lastActivityAt === null ? null : sql`${times.lastActivityAt}::timestamptz`,
    }).where(eq(tasks.id, id));
  };
  await set(a1!.id, { createdAt: "2026-01-01T00:00:00Z", lastActivityAt: "2026-05-01T00:00:00.000002Z" });
  await set(a2!.id, { createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z", lastActivityAt: null });
  await set(a3!.id, { createdAt: "2026-03-01T00:00:00Z", lastActivityAt: "2026-04-01T00:00:00Z" });
  await set(a4!.id, { createdAt: "2026-01-15T00:00:00Z", lastActivityAt: "2026-05-01T00:00:00.000001Z" });
  await set(b1!.id, { createdAt: "2026-04-01T00:00:00Z", lastActivityAt: "2026-06-01T00:00:00Z" });
  await set(b2!.id, { createdAt: "2026-05-01T00:00:00Z", lastActivityAt: "2026-03-01T00:00:00Z" });

  const headers = authHeaders(await tokenForHuman(me.email), server.id);
  const ids = { a1: a1!.id, a2: a2!.id, a3: a3!.id, a4: a4!.id, b1: b1!.id, b2: b2!.id };
  return { me, server, alpha, beta, ids, headers };
}

type Board = Awaited<ReturnType<typeof buildBoard>>;

/** Ties on the sort key break by task id DESC. */
const byIdDesc = (...ids: string[]) => [...ids].sort().reverse();
/** activity_asc: ties by task id ASC. */
const byIdAsc = (...ids: string[]) => [...ids].sort();

async function getJson(baseUrl: string, board: Board, query: string) {
  const res = await fetch(`${baseUrl}/api/tasks/server?${query}`, { headers: board.headers });
  return { status: res.status, body: await res.json() as { tasks: Array<Record<string, unknown> & { id: string }>; next_cursor?: string | null; error?: string; code?: string } };
}

/** Walk `query` page by page; every page's next_cursor feeds the next request. */
async function walk(baseUrl: string, board: Board, query: string, limit: number) {
  const ids: string[] = [];
  const cursors: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; ; pages++) {
    assert.ok(pages < 50, "pagination did not terminate");
    const { status, body } = await getJson(baseUrl, board, `${query}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    assert.equal(status, 200, `${query} limit=${limit}: ${JSON.stringify(body)}`);
    ids.push(...body.tasks.map((task) => task.id));
    cursor = body.next_cursor ?? null;
    if (!cursor) break;
    cursors.push(cursor);
  }
  return { ids, cursors };
}

test("GET /api/tasks/server?sort= orders by activity, created and number, newest first, ties by task id", async ({ app }) => {
  const board = await buildBoard();
  const { ids } = board;
  const expected = {
    activity: [...byIdDesc(ids.a2, ids.b1), ids.a1, ids.a4, ids.a3, ids.b2],
    // The reverse of activity, a4 a microsecond before a1 included.
    activity_asc: [ids.b2, ids.a3, ids.a4, ids.a1, ...byIdAsc(ids.a2, ids.b1)],
    created: [ids.b2, ids.b1, ids.a3, ids.a2, ids.a4, ids.a1],
    number: [ids.a4, ids.a3, ...byIdDesc(ids.a2, ids.b2), ...byIdDesc(ids.a1, ids.b1)],
  };
  for (const sort of taskService.SERVER_TASK_SORTS) {
    // Unpaginated: the whole board in the sort's order.
    const all = await getJson(app.baseUrl, board, `sort=${sort}&detail=summary`);
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.deepEqual(all.body.tasks.map((task) => task.id), expected[sort], `sort=${sort}`);
    assert.equal("next_cursor" in all.body, false, "no limit, no cursor key");
    // Every page size walks the same order, each row exactly once.
    for (const limit of [1, 2, 4, 6]) {
      const { ids: walked } = await walk(app.baseUrl, board, `sort=${sort}&detail=summary`, limit);
      assert.deepEqual(walked, expected[sort], `sort=${sort} limit=${limit}`);
    }
    // Full detail walks the same rows.
    assert.deepEqual((await walk(app.baseUrl, board, `sort=${sort}`, 4)).ids, expected[sort], `sort=${sort} full detail`);
  }

  // Sorts compose with the board filters.
  assert.deepEqual(
    (await walk(app.baseUrl, board, `sort=activity&channel=${board.beta.id}`, 1)).ids,
    [ids.b1, ids.b2],
  );
  assert.deepEqual(
    (await walk(app.baseUrl, board, `sort=activity_asc&channel=${board.alpha.id}`, 1)).ids,
    [ids.a3, ids.a4, ids.a1, ids.a2],
  );
  // No sort: the (channel name, task number) walk is unchanged.
  assert.deepEqual(
    (await walk(app.baseUrl, board, "detail=summary", 4)).ids,
    [ids.a1, ids.a2, ids.a3, ids.a4, ids.b1, ids.b2],
  );
});

test("GET /api/tasks/server?sort=activity: a write moves a task to the front; activityAt falls back to updatedAt", async ({ app }) => {
  const board = await buildBoard();
  const { ids } = board;
  const before = await getJson(app.baseUrl, board, "sort=activity&detail=summary");
  const a2 = before.body.tasks.find((task) => task.id === ids.a2)!;
  assert.equal(a2.lastActivityAt, null, "a row from before the column has no stamp");
  assert.equal(a2.activityAt, a2.updatedAt, "and reads its updated_at as its activity time");
  const a1 = before.body.tasks.find((task) => task.id === ids.a1)!;
  assert.equal(a1.lastActivityAt, "2026-05-01T00:00:00.000Z", "the DTO carries milliseconds");
  assert.equal(a1.activityAt, a1.lastActivityAt);

  // A status change is activity: b2 (last) jumps to the front.
  const result = await taskService.updateTaskStatus(ids.b2, "done", board.me.id, "user");
  assert.notEqual(typeof result, "string", String(result));
  const after = await getJson(app.baseUrl, board, "sort=activity&detail=summary");
  assert.equal(after.body.tasks[0]!.id, ids.b2);
  assert.equal(typeof after.body.tasks[0]!.lastActivityAt, "string");
});

test("GET /api/tasks/server: a cursor resumes only the walk that produced it", async ({ app }) => {
  const board = await buildBoard();
  const firstPage = async (query: string) => {
    const { status, body } = await getJson(app.baseUrl, board, `${query}&limit=2`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(body.next_cursor, `${query}: a next page`);
    return body.next_cursor!;
  };
  const activityCursor = await firstPage("sort=activity");
  const activityAscCursor = await firstPage("sort=activity_asc");
  const createdCursor = await firstPage("sort=created");
  const numberCursor = await firstPage("sort=number");
  const defaultCursor = await firstPage("detail=summary");

  const expectInvalid = async (query: string, label: string) => {
    const { status, body } = await getJson(app.baseUrl, board, `${query}&limit=2`);
    assert.equal(status, 400, `${label}: ${JSON.stringify(body)}`);
    assert.equal(body.error, "Invalid cursor", label);
  };
  await expectInvalid(`sort=created&cursor=${activityCursor}`, "activity cursor under sort=created");
  await expectInvalid(`sort=number&cursor=${createdCursor}`, "created cursor under sort=number");
  await expectInvalid(`sort=activity&cursor=${numberCursor}`, "number cursor under sort=activity");
  await expectInvalid(`sort=activity_asc&cursor=${activityCursor}`, "activity cursor under sort=activity_asc");
  await expectInvalid(`sort=activity&cursor=${activityAscCursor}`, "activity_asc cursor under sort=activity");
  await expectInvalid(`cursor=${activityCursor}`, "a sorted cursor without sort");
  await expectInvalid(`sort=activity&cursor=${defaultCursor}`, "a (channel, number) cursor under a sort");

  // Each still resumes its own walk.
  for (const [query, cursor] of [["sort=activity", activityCursor], ["sort=activity_asc", activityAscCursor], ["sort=created", createdCursor], ["sort=number", numberCursor], ["detail=summary", defaultCursor]] as const) {
    const { status } = await getJson(app.baseUrl, board, `${query}&limit=2&cursor=${cursor}`);
    assert.equal(status, 200, query);
  }

  // The sorted cursor's wire shape: { s, k, i, c }, k in microseconds for instants.
  const decoded = JSON.parse(Buffer.from(activityCursor, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(decoded).sort(), ["c", "i", "k", "s"]);
  assert.equal(decoded.s, "activity");
  assert.match(String(decoded.k), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  const numberDecoded = JSON.parse(Buffer.from(numberCursor, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.equal(typeof numberDecoded.k, "number");

  // Malformed sorted cursors.
  const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString("base64url");
  const c = board.alpha.id;
  const i = board.ids.a1;
  for (const [payload, label] of [
    [{ s: "activity", k: "2026-05-01T00:00:00.000Z", i, c }, "millisecond instant"],
    [{ s: "activity", k: 3, i, c }, "number key for an instant sort"],
    [{ s: "number", k: "3", i, c }, "string key for the number sort"],
    [{ s: "number", k: 0, i, c }, "task number below 1"],
    [{ s: "activity", k: "2026-05-01T00:00:00.000000Z", i: "nope", c }, "task id not a uuid"],
    [{ s: "bogus", k: 3, i, c }, "unknown sort"],
  ] as const) {
    await expectInvalid(`sort=${payload.s === "number" ? "number" : "activity"}&cursor=${encode(payload)}`, label);
  }
});

test("GET /api/tasks/server rejects an unknown sort; /counts takes no sort", async ({ app }) => {
  const board = await buildBoard();
  for (const query of ["sort=bogus", "sort=", "sort=activity&sort=created", "sort=ACTIVITY", "sort=activity_desc"]) {
    const { status, body } = await getJson(app.baseUrl, board, query);
    assert.equal(status, 400, query);
    assert.deepEqual([body.code, body.error], ["INVALID_TASK_SORT", "Invalid sort value"], query);
  }
  const res = await fetch(`${app.baseUrl}/api/tasks/server/counts?sort=activity`, { headers: board.headers });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { code: string }).code, "UNSUPPORTED_PARAMETER");
});

test("created_since narrows GET /api/tasks/server and /counts to tasks created at or after it", async ({ app }) => {
  const board = await buildBoard();
  const { ids } = board;
  const listed = await getJson(app.baseUrl, board, "detail=summary&limit=100&created_since=2026-03-15T00:00:00Z");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.tasks.map((task) => task.id).sort(), [ids.b1, ids.b2].sort());
  // Boundary is inclusive.
  const inclusive = await getJson(app.baseUrl, board, "sort=created&created_since=2026-03-01");
  assert.deepEqual(inclusive.body.tasks.map((task) => task.id), [ids.b2, ids.b1, ids.a3]);

  // The Tasks page's "today" summary: created / completed since one instant.
  await taskService.updateTaskStatus(ids.b2, "done", board.me.id, "user");
  const counts = async (query: string) => {
    const res = await fetch(`${app.baseUrl}/api/tasks/server/counts?${query}`, { headers: board.headers });
    assert.equal(res.status, 200, query);
    return ((await res.json()) as taskService.ServerTaskCounts).counts;
  };
  assert.deepEqual(await counts("created_since=2026-03-15"), { backlog: 0, todo: 1, in_progress: 0, done: 1, closed: 0 });
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  assert.equal((await counts(`completed_since=${startOfToday.toISOString()}`)).done, 1, "completed today");
  assert.deepEqual(await counts(`created_since=${startOfToday.toISOString()}`), { backlog: 0, todo: 0, in_progress: 0, done: 0, closed: 0 }, "the fixture's tasks were all created in the past");

  for (const path of ["/api/tasks/server?detail=summary&", "/api/tasks/server?", "/api/tasks/server/counts?"]) {
    for (const value of ["yesterday", "2026-13-45", "2026-06-01T00:00:00"]) {
      const res = await fetch(`${app.baseUrl}${path}created_since=${value}`, { headers: board.headers });
      assert.equal(res.status, 400, `${path}created_since=${value}`);
      const body = await res.json() as { error: string; code: string };
      assert.deepEqual([body.code, body.error], ["INVALID_TASK_FILTER", "Invalid created_since value"]);
    }
  }
});
