import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
/**
 * The server task board's filters and counts (GET /api/tasks/server board
 * filters, GET /api/tasks/server/counts). The board used to count the rows it
 * had loaded (at most a page per column, 0 for a folded one) and filtered
 * "assigned to me" over that partial list; these pin the server-side numbers:
 *  - a status list, with stored in_review rows inside in_progress;
 *  - the three relation tabs, each exclusive of the one before it;
 *  - Assignee (incl. unassigned) / Creator in the `<type>:<id>` encoding;
 *  - counts per column and per relation over exactly the board's visible
 *    rows: a task in a channel the reader cannot read is never listed or
 *    counted, even when it is theirs;
 *  - q (the Tasks page's search): title words, case-insensitive and literal,
 *    or one task number, on the list and the counts alike;
 *  - every malformed param is a 400.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { messages, serverMembers, tasks, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { addHuman, createChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
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

type TaskFields = Partial<typeof tasks.$inferInsert>;

/**
 * One reader ("me") on a server with two readable channels and a private one
 * they cannot read. Each task's state is written directly: these tests read
 * the board, they do not exercise the status / claim rules.
 */
async function buildBoard() {
  const me = await seedUser("board-me");
  const other = await seedUser("board-other");
  const server = await createServer("Task Board Filters", `task-board-filters-${randomUUID().slice(0, 8)}`, me.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: other.id, role: "member" }).onConflictDoNothing();
  const agent = await createAgent(server.id, `board-agent-${randomUUID().slice(0, 6)}`, { runtime: "claude", model: "sonnet" });

  const alpha = await createChannel(server.id, "alpha-board");
  const beta = await createChannel(server.id, "beta-board");
  const secret = await createChannel(server.id, "secret-board", undefined, "private");
  await addHuman(alpha.id, me.id);
  await addHuman(alpha.id, other.id);
  await addHuman(beta.id, me.id);
  await addHuman(beta.id, other.id);
  await addHuman(secret.id, other.id);

  const seed = async (channelId: string, title: string, fields: TaskFields) => {
    const { tasks: [task] } = await taskService.createTasks(channelId, "user", other.id, [{ title }]);
    await getDb().update(tasks).set({ createdByType: "user", createdById: other.id, ...fields }).where(eq(tasks.id, task!.id));
    return task!.id;
  };
  const claimedBy = (type: "user" | "agent", id: string): TaskFields => ({ claimedByType: type, claimedById: id, claimedAt: new Date() });
  const byMe: TaskFields = { createdByType: "user", createdById: me.id };

  const myMessage = await createMessage(alpha.id, "user", me.id, "can someone pick this up?");
  const myOtherMessage = await createMessage(alpha.id, "user", me.id, "and this one");
  const theirMessage = await createMessage(alpha.id, "user", other.id, "their ask");
  const mySecretMessage = await createMessage(secret.id, "user", me.id, "posted before I left");

  const ids = {
    myTodo: await seed(alpha.id, "my todo", { ...byMe }),
    myClaimed: await seed(alpha.id, "my claimed", { ...byMe, status: "in_progress", ...claimedBy("user", me.id) }),
    inReview: await seed(alpha.id, "in review", { status: "in_review", ...claimedBy("agent", agent.id) }),
    fromMyMessage: await seed(alpha.id, "from my message", { sourceMessageId: myMessage.id }),
    mineFromMyMessage: await seed(alpha.id, "mine from my message", { ...byMe, sourceMessageId: myOtherMessage.id }),
    fromTheirMessage: await seed(alpha.id, "from their message", { sourceMessageId: theirMessage.id }),
    doneOld: await seed(alpha.id, "done old", { status: "done", completedAt: new Date("2026-01-01T00:00:00.000Z") }),
    doneNew: await seed(alpha.id, "done new", { status: "done", completedAt: new Date(), ...claimedBy("user", other.id) }),
    agentBacklog: await seed(alpha.id, "agent backlog", { status: "backlog", createdByType: "agent", createdById: agent.id }),
    closed: await seed(alpha.id, "closed", { status: "closed" }),
    betaClaimed: await seed(beta.id, "beta claimed", { status: "in_progress", ...claimedBy("user", me.id) }),
    // Mine in every way, but in a channel I cannot read: never listed or counted.
    secretMine: await seed(secret.id, "secret mine", { ...byMe, status: "in_progress", ...claimedBy("user", me.id) }),
    secretFromMyMessage: await seed(secret.id, "secret from my message", { sourceMessageId: mySecretMessage.id }),
  };

  const headers = authHeaders(await tokenForHuman(me.email), server.id);
  return { me, other, agent, server, alpha, beta, secret, ids, headers, myMessage };
}

type Board = Awaited<ReturnType<typeof buildBoard>>;

async function listIds(baseUrl: string, board: Board, query: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/api/tasks/server?detail=summary&limit=100&${query}`, { headers: board.headers });
  assert.equal(res.status, 200, `${query}: ${await res.clone().text()}`);
  const body = await res.json() as { tasks: Array<{ id: string }>; next_cursor: string | null };
  assert.equal(body.next_cursor, null, `${query}: one page holds the fixture`);
  return body.tasks.map((task) => task.id).sort();
}

async function counts(baseUrl: string, board: Board, query = "") {
  const res = await fetch(`${baseUrl}/api/tasks/server/counts${query ? `?${query}` : ""}`, { headers: board.headers });
  assert.equal(res.status, 200, `${query}: ${await res.clone().text()}`);
  return res.json() as Promise<taskService.ServerTaskCounts>;
}

const sorted = (...ids: string[]) => [...ids].sort();

test("GET /api/tasks/server takes a status list; with a board filter in_progress includes stored in_review rows, a lone status stays exact", async ({ app }) => {
  const board = await buildBoard();
  const { ids } = board;
  const todo = [ids.myTodo, ids.fromMyMessage, ids.mineFromMyMessage, ids.fromTheirMessage];
  const inProgress = [ids.myClaimed, ids.inReview, ids.betaClaimed];

  assert.deepEqual(await listIds(app.baseUrl, board, "status=todo,in_progress"), sorted(...todo, ...inProgress));
  assert.deepEqual(await listIds(app.baseUrl, board, "status=todo&status=in_progress"), sorted(...todo, ...inProgress), "repeated keys equal a comma list");
  // One status and no board filter: the exact match shipped clients page by.
  assert.deepEqual(await listIds(app.baseUrl, board, "status=in_progress"), sorted(ids.myClaimed, ids.betaClaimed));
  // With a board filter, in_progress includes stored in_review rows.
  assert.deepEqual(await listIds(app.baseUrl, board, `status=in_progress&channel=${board.alpha.id},${board.beta.id}`), sorted(...inProgress));
  assert.deepEqual(await listIds(app.baseUrl, board, "status=in_review"), [ids.inReview]);
  assert.deepEqual(await listIds(app.baseUrl, board, "status=done&completed_since=2026-06-01"), [ids.doneNew]);
  assert.deepEqual(
    await listIds(app.baseUrl, board, "status=done,closed&completed_since=2026-06-01T00:00:00Z"),
    sorted(ids.doneNew, ids.closed),
    "completed_since bounds done tasks only",
  );

  // The legacy full shape (no new param) keeps its exact single-status match.
  const legacy = await fetch(`${app.baseUrl}/api/tasks/server?status=in_progress`, { headers: board.headers });
  assert.equal(legacy.status, 200);
  const legacyBody = await legacy.json() as Record<string, unknown> & { tasks: Array<{ id: string }> };
  assert.deepEqual(Object.keys(legacyBody), ["tasks"]);
  assert.deepEqual(legacyBody.tasks.map((task) => task.id).sort(), sorted(ids.myClaimed, ids.betaClaimed));
});

test("GET /api/tasks/server relation filters: assigned_to_me, created_by_me, from_my_message", async ({ app }) => {
  const board = await buildBoard();
  const { ids } = board;

  assert.deepEqual(await listIds(app.baseUrl, board, "relation=assigned_to_me"), sorted(ids.myClaimed, ids.betaClaimed));
  // Created by me AND not claimed by me: my claimed task is in assigned_to_me only.
  assert.deepEqual(await listIds(app.baseUrl, board, "relation=created_by_me"), sorted(ids.myTodo, ids.mineFromMyMessage));
  // My message, someone else's task: a task I created from my own message is created_by_me only.
  assert.deepEqual(await listIds(app.baseUrl, board, "relation=from_my_message"), [ids.fromMyMessage]);
  assert.deepEqual(await listIds(app.baseUrl, board, "relation=created_by_me&status=todo"), sorted(ids.myTodo, ids.mineFromMyMessage));
  assert.deepEqual(await listIds(app.baseUrl, board, `relation=assigned_to_me&channel=${board.beta.id}`), [ids.betaClaimed]);

  // A retracted source message no longer makes the task "from my message".
  await getDb().update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, board.myMessage.id));
  assert.deepEqual(await listIds(app.baseUrl, board, "relation=from_my_message"), []);
});

test("relations stay exclusive in order: a task from my message that is assigned to me is assigned_to_me only", async ({ app }) => {
  const board = await buildBoard();
  const { ids } = board;
  const before = await counts(app.baseUrl, board);
  const mine = await createMessage(board.alpha.id, "user", board.me.id, "please take this on yourself");
  const { tasks: [task] } = await taskService.createTasks(board.alpha.id, "user", board.other.id, [{ title: "from my message, mine to do" }]);
  await getDb().update(tasks).set({
    createdByType: "user", createdById: board.other.id, sourceMessageId: mine.id,
    status: "in_progress", claimedByType: "user", claimedById: board.me.id, claimedAt: new Date(),
  }).where(eq(tasks.id, task!.id));

  assert.deepEqual(await listIds(app.baseUrl, board, "relation=assigned_to_me"), sorted(ids.myClaimed, ids.betaClaimed, task!.id));
  assert.deepEqual(await listIds(app.baseUrl, board, "relation=from_my_message"), [ids.fromMyMessage], "not also under from_my_message");
  assert.deepEqual(await listIds(app.baseUrl, board, "relation=created_by_me"), sorted(ids.myTodo, ids.mineFromMyMessage));
  const after = await counts(app.baseUrl, board);
  assert.deepEqual(after.relations, {
    assigned_to_me: before.relations.assigned_to_me + 1,
    created_by_me: before.relations.created_by_me,
    from_my_message: before.relations.from_my_message,
  });
  // The relation narrows the columns the same way.
  assert.equal((await counts(app.baseUrl, board, "relation=from_my_message")).counts.in_progress, 0, "not in the from_my_message columns");
  assert.equal((await counts(app.baseUrl, board, "relation=assigned_to_me")).counts.in_progress, 3, "in the assigned_to_me ones: myClaimed, betaClaimed and this one");
});

test("GET /api/tasks/server assignee and creator filters in the <type>:<id> encoding, with unassigned", async ({ app }) => {
  const board = await buildBoard();
  const { ids, me, other, agent } = board;
  const unclaimed = [ids.myTodo, ids.fromMyMessage, ids.mineFromMyMessage, ids.fromTheirMessage, ids.doneOld, ids.agentBacklog, ids.closed];

  assert.deepEqual(await listIds(app.baseUrl, board, "assignee=unassigned"), sorted(...unclaimed));
  assert.deepEqual(await listIds(app.baseUrl, board, `assignee=unassigned&assignee=agent:${agent.id}`), sorted(...unclaimed, ids.inReview));
  assert.deepEqual(await listIds(app.baseUrl, board, `assignee=user:${me.id}`), sorted(ids.myClaimed, ids.betaClaimed));
  assert.deepEqual(await listIds(app.baseUrl, board, `assignee=user:${other.id}`), [ids.doneNew]);
  assert.deepEqual(await listIds(app.baseUrl, board, `creator=user:${me.id}`), sorted(ids.myTodo, ids.myClaimed, ids.mineFromMyMessage));
  assert.deepEqual(
    await listIds(app.baseUrl, board, `creator=user:${me.id.toUpperCase()},agent:${agent.id}`),
    sorted(ids.myTodo, ids.myClaimed, ids.mineFromMyMessage, ids.agentBacklog),
    "ids compare case-insensitively; a comma list is any of them",
  );
  assert.deepEqual(await listIds(app.baseUrl, board, `creator=user:${me.id}&assignee=unassigned`), sorted(ids.myTodo, ids.mineFromMyMessage));
  // A channel outside the reader's board matches nothing; it is not an error.
  assert.deepEqual(await listIds(app.baseUrl, board, `channel=${board.secret.id}`), []);
  assert.deepEqual(await listIds(app.baseUrl, board, `channel=${randomUUID()}`), []);
});

test("GET /api/tasks/server?q= searches titles word by word, or one task number, and /counts counts the same rows", async ({ app }) => {
  const board = await buildBoard();
  const { ids } = board;
  assert.deepEqual(await listIds(app.baseUrl, board, "q=done"), sorted(ids.doneOld, ids.doneNew));
  assert.deepEqual(await listIds(app.baseUrl, board, "q=NEW%20%20done"), [ids.doneNew], "every word, in any order, any case");
  assert.deepEqual(
    await listIds(app.baseUrl, board, "q=my%20message"),
    sorted(ids.fromMyMessage, ids.mineFromMyMessage),
    "a hidden channel's match is not listed",
  );
  assert.deepEqual(await listIds(app.baseUrl, board, "q=%25"), [], "% is literal");
  assert.deepEqual(await listIds(app.baseUrl, board, "q=_"), [], "_ is literal");
  assert.deepEqual(await listIds(app.baseUrl, board, "q=%20%20"), (await listIds(app.baseUrl, board, "")), "blank is no search");
  // A task number, with or without #, in any visible channel.
  const res = await fetch(`${app.baseUrl}/api/tasks/server?detail=summary&limit=100`, { headers: board.headers });
  const rows = (await res.json() as { tasks: Array<{ id: string; taskNumber: number }> }).tasks;
  const number = rows.find((row) => row.id === ids.myClaimed)!.taskNumber;
  const withNumber = sorted(...rows.filter((row) => row.taskNumber === number).map((row) => row.id));
  assert.ok(withNumber.includes(ids.myClaimed));
  assert.deepEqual(await listIds(app.baseUrl, board, `q=${encodeURIComponent(`#${number}`)}`), withNumber);
  assert.deepEqual(await listIds(app.baseUrl, board, `q=${number}`), withNumber);
  // Composes with the other filters and the counts.
  assert.deepEqual(await listIds(app.baseUrl, board, "q=done&status=done&completed_since=2026-06-01T00:00:00Z"), [ids.doneNew]);
  assert.equal((await counts(app.baseUrl, board, "q=done")).counts.done, 2);
  assert.deepEqual((await counts(app.baseUrl, board, "q=message")).relations, { assigned_to_me: 0, created_by_me: 1, from_my_message: 1 });
});

test("GET /api/tasks/server?detail=summary carries the source sender and reply count", async ({ app }) => {
  const board = await buildBoard();
  const res = await fetch(`${app.baseUrl}/api/tasks/server?detail=summary&limit=100&channel=${board.alpha.id}`, { headers: board.headers });
  assert.equal(res.status, 200);
  const items = new Map(((await res.json()) as { tasks: Array<Record<string, unknown> & { id: string }> }).tasks.map((task) => [task.id, task]));

  const fromMine = items.get(board.ids.fromMyMessage)!;
  assert.equal(fromMine.sourceMessageId, board.myMessage.id);
  assert.equal(fromMine.sourceSenderType, "user");
  assert.equal(fromMine.sourceSenderId, board.me.id);
  assert.equal(fromMine.conversationReplyCount, 0);
  // A pre-v2 task's source is the host message its creator posted (createTasks
  // ran as `other` here), so it names that sender; from_my_message still
  // never matches it for anyone but that poster, who is its creator.
  const hosted = items.get(board.ids.myTodo)!;
  assert.equal(hosted.sourceSenderType, "user");
  assert.equal(hosted.sourceSenderId, board.other.id);
  assert.equal(typeof hosted.conversationReplyCount, "number");

  await getDb().update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, board.myMessage.id));
  const after = await fetch(`${app.baseUrl}/api/tasks/server?detail=summary&channel=${board.alpha.id}`, { headers: board.headers });
  const retracted = ((await after.json()) as { tasks: Array<Record<string, unknown> & { id: string }> }).tasks.find((task) => task.id === board.ids.fromMyMessage)!;
  assert.equal(retracted.sourceSenderType, null, "a retracted source message names no sender");
  assert.equal(retracted.sourceSenderId, null);
});

test("GET /api/tasks/server/counts counts every visible row per column and per relation, never a hidden channel's", async ({ app }) => {
  const board = await buildBoard();

  // The secret channel's two tasks would be in_progress + assigned_to_me +
  // todo + from_my_message: none of them may show up anywhere.
  assert.deepEqual(await counts(app.baseUrl, board), {
    counts: { backlog: 1, todo: 4, in_progress: 3, done: 2, closed: 1 },
    relations: { assigned_to_me: 2, created_by_me: 2, from_my_message: 1 },
  });
  // The relation narrows the columns; the relation badges ignore it.
  assert.deepEqual(await counts(app.baseUrl, board, "relation=assigned_to_me"), {
    counts: { backlog: 0, todo: 0, in_progress: 2, done: 0, closed: 0 },
    relations: { assigned_to_me: 2, created_by_me: 2, from_my_message: 1 },
  });
  assert.deepEqual(await counts(app.baseUrl, board, "completed_since=2026-06-01"), {
    counts: { backlog: 1, todo: 4, in_progress: 3, done: 1, closed: 1 },
    relations: { assigned_to_me: 2, created_by_me: 2, from_my_message: 1 },
  });
  assert.deepEqual(await counts(app.baseUrl, board, `channel=${board.beta.id}`), {
    counts: { backlog: 0, todo: 0, in_progress: 1, done: 0, closed: 0 },
    relations: { assigned_to_me: 1, created_by_me: 0, from_my_message: 0 },
  });
  assert.deepEqual(await counts(app.baseUrl, board, `channel=${board.secret.id}`), {
    counts: { backlog: 0, todo: 0, in_progress: 0, done: 0, closed: 0 },
    relations: { assigned_to_me: 0, created_by_me: 0, from_my_message: 0 },
  });
  assert.deepEqual(await counts(app.baseUrl, board, `status=in_review&assignee=agent:${board.agent.id}`), {
    counts: { backlog: 0, todo: 0, in_progress: 1, done: 0, closed: 0 },
    relations: { assigned_to_me: 0, created_by_me: 0, from_my_message: 0 },
  });

  // Each column's count is the number of rows its filtered pages hold.
  const all = await counts(app.baseUrl, board);
  for (const status of ["backlog", "todo", "in_progress", "done", "closed"] as const) {
    // A board filter, so in_progress reads stored in_review rows as the count does.
    assert.equal((await listIds(app.baseUrl, board, `status=${status}&channel=${board.alpha.id},${board.beta.id}`)).length, all.counts[status], status);
  }

  // The private channel's member sees and counts its tasks.
  const otherHeaders = authHeaders(await tokenForHuman(board.other.email), board.server.id);
  const res = await fetch(`${app.baseUrl}/api/tasks/server/counts?channel=${board.secret.id}`, { headers: otherHeaders });
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as taskService.ServerTaskCounts).counts, { backlog: 0, todo: 1, in_progress: 1, done: 0, closed: 0 });
});

test("GET /api/tasks/server and /counts reject malformed filter params with 400", async ({ app }) => {
  const owner = await seedUser("board-400");
  const server = await createServer("Task Board 400", `task-board-400-${randomUUID().slice(0, 8)}`, owner.id);
  const headers = authHeaders(await tokenForHuman(owner.email), server.id);
  const uuid = randomUUID();
  const cases: Array<[string, string]> = [
    ["status=bogus", "Invalid status value"],
    ["status=todo,bogus", "Invalid status value"],
    ["status=", "Invalid status value"],
    ["channel=not-a-uuid", "Invalid channel value"],
    ["channel=", "Invalid channel value"],
    [`channel=${uuid},nope`, "Invalid channel value"],
    ["assignee=bob", "Invalid assignee value"],
    ["assignee=user:not-a-uuid", "Invalid assignee value"],
    [`assignee=team:${uuid}`, "Invalid assignee value"],
    [`assignee=${uuid}`, "Invalid assignee value"],
    ["creator=unassigned", "Invalid creator value"],
    [`creator=user:${uuid}:x`, "Invalid creator value"],
    ["relation=mine", "Invalid relation value"],
    ["relation=assigned_to_me&relation=created_by_me", "Invalid relation value"],
    ["completed_since=yesterday", "Invalid completed_since value"],
    ["completed_since=2026-13-45", "Invalid completed_since value"],
    ["completed_since=2026-06-01T00:00:00", "Invalid completed_since value"],
    [`q=${"x".repeat(201)}`, "Invalid q value"],
    ["q=a&q=b", "Invalid q value"],
  ];
  for (const [query, error] of cases) {
    for (const path of ["/api/tasks/server?detail=summary&", "/api/tasks/server?", "/api/tasks/server/counts?"]) {
      const res = await fetch(`${app.baseUrl}${path}${query}`, { headers });
      assert.equal(res.status, 400, `${path}${query}: expected 400, got ${res.status}`);
      const body = await res.json() as { error: string; code: string };
      assert.equal(body.error, error, `${path}${query}`);
      // A lone status on /server is still checked by the route's older status
      // check, whose body predates refusal codes; everything else is a board filter.
      const loneStatus = /^status=[^,]*$/.test(query) && path !== "/api/tasks/server/counts?";
      assert.equal(body.code, loneStatus ? undefined : "INVALID_TASK_FILTER", `${path}${query}`);
    }
  }
  const tooMany = Array.from({ length: 201 }, () => randomUUID()).join(",");
  const capped = await fetch(`${app.baseUrl}/api/tasks/server/counts?channel=${tooMany}`, { headers });
  assert.equal(capped.status, 400, "a list over the cap");
  for (const param of ["limit=10", "cursor=abc", "detail=summary"]) {
    const res = await fetch(`${app.baseUrl}/api/tasks/server/counts?${param}`, { headers });
    assert.equal(res.status, 400, `counts takes no ${param}`);
    assert.equal(((await res.json()) as { code: string }).code, "UNSUPPORTED_PARAMETER");
  }
});
