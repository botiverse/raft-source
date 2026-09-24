import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { channels, serverMembers, users } from "../db/schema.js";
import { createChannel, addHuman } from "../services/channelService.js";
import { createServer } from "../services/serverService.js";
import * as taskService from "../services/taskService.js";
import { TASKS_SERVER_RESPONSE_WARN_BYTES } from "./tasks.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}



function authHeaders(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

/** Walk `?limit=...` to exhaustion and return every item plus the page count. */
async function fetchAllPages(baseUrl: string, headers: Record<string, string>, query: string) {
  const items: Array<{ id: string }> = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const url: string = `${baseUrl}/api/tasks/server?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res: Response = await fetch(url, { headers });
    assert.equal(res.status, 200, `page fetch failed with ${res.status}`);
    const body = await res.json() as { tasks: Array<{ id: string }>; next_cursor: string | null };
    items.push(...body.tasks);
    cursor = body.next_cursor;
    pages++;
    assert.ok(pages < 50, "pagination did not terminate");
  } while (cursor);
  return { items, pages };
}

test("GET /api/tasks/server paginates every task exactly once in stable order", async ({ app }) => {
  const owner = await seedUser("page-owner@slock.test", "page-owner");
  const server = await createServer("Task Pagination", "task-pagination", owner.id);
  // Channels created out of alphabetical order: ordering must follow channel
  // NAME (the legacy channel ordering), not creation order. The server also
  // has the auto-created empty "all" channel, and gamma stays empty — both
  // must be skipped without breaking the walk.
  const gamma = await createChannel(server.id, "gamma");
  const beta = await createChannel(server.id, "beta");
  const alpha = await createChannel(server.id, "alpha");
  await addHuman(alpha.id, owner.id);
  await addHuman(beta.id, owner.id);
  await addHuman(gamma.id, owner.id);

  const { tasks: alphaTasks } = await taskService.createTasks(alpha.id, "user", owner.id, [
    { title: "alpha-1", description: "alpha body 1" },
    { title: "alpha-2" },
    { title: "alpha-3" },
  ]);
  const { tasks: betaTasks } = await taskService.createTasks(beta.id, "user", owner.id, [
    { title: "beta-1" },
    { title: "beta-2" },
  ]);
  const expectedIds = [...alphaTasks, ...betaTasks].map((task) => task.id);

  const token = await tokenForHuman(owner.email);
  const headers = authHeaders(token, server.id);

  // 5 tasks with limit=2 must take exactly 3 pages: [2, 2, 1].
  const pageSizes: number[] = [];
  let cursor: string | null = null;
  const seenIds: string[] = [];
  do {
    const url: string = `${app.baseUrl}/api/tasks/server?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res: Response = await fetch(url, { headers });
    assert.equal(res.status, 200, `page fetch failed with ${res.status}`);
    const body = await res.json() as {
      tasks: Array<{ id: string; taskNumber: number; channelName: string; description: string | null }>;
      next_cursor: string | null;
    };
    pageSizes.push(body.tasks.length);
    seenIds.push(...body.tasks.map((task) => task.id));
    // Default detail stays full even when paginating.
    for (const task of body.tasks) {
      assert.equal("description" in task, true, "paginated full detail must keep the description key");
    }
    cursor = body.next_cursor;
  } while (cursor);

  assert.deepEqual(pageSizes, [2, 2, 1]);
  assert.deepEqual(seenIds, expectedIds, "every task exactly once, in channel-name/taskNumber order");
  assert.equal(new Set(seenIds).size, expectedIds.length, "no task repeated across pages");
});

test("GET /api/tasks/server rejects invalid limit, cursor and detail params", async ({ app }) => {
  const owner = await seedUser("page-400-owner@slock.test", "page-400-owner");
  const server = await createServer("Task Pagination 400", "task-pagination-400", owner.id);
  const token = await tokenForHuman(owner.email);
  const headers = authHeaders(token, server.id);
  const base = `${app.baseUrl}/api/tasks/server`;

  const expect400 = async (query: string, label: string) => {
    const res = await fetch(`${base}?${query}`, { headers });
    assert.equal(res.status, 400, `${label}: expected 400, got ${res.status}`);
  };

  await expect400("limit=0", "limit below range");
  await expect400("limit=501", "limit above range");
  await expect400("limit=abc", "non-numeric limit");
  await expect400("limit=2&limit=3", "repeated limit (array)");
  await expect400("detail=bogus", "unknown detail value");
  await expect400("cursor=abc", "cursor without limit");
  await expect400("limit=2&cursor=%%%not-base64%%%", "undecodable cursor");
  const wrongShape = Buffer.from(JSON.stringify({ c: "not-a-uuid", n: 1 })).toString("base64url");
  await expect400(`limit=2&cursor=${wrongShape}`, "cursor with wrong payload shape");
  // Well-formed cursor naming a channel outside the visible set: its position
  // in the total order is unknowable, so the walk refuses it.
  const staleChannel = Buffer.from(JSON.stringify({ c: randomUUID(), n: 1 })).toString("base64url");
  await expect400(`limit=2&cursor=${staleChannel}`, "cursor for an unknown channel");
});

test("GET /api/tasks/server?detail=summary omits description bodies and keeps name enrichment", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("summary-owner@slock.test", "summary-owner");
  // Separate display name from handle so the two enrichment maps are
  // distinguishable: createdByName renders displayName, claimedByName the handle.
  await db.update(users).set({ displayName: "Summary Owner" }).where(eq(users.id, owner.id));
  const server = await createServer("Task Summary", "task-summary", owner.id);
  const channel = await createChannel(server.id, "summary-room");
  await addHuman(channel.id, owner.id);

  const description = "héllo summary world";
  const { tasks: [withDesc, withoutDesc] } = await taskService.createTasks(channel.id, "user", owner.id, [
    { title: "has a body", description },
    { title: "bodiless" },
  ]);
  const claim = await taskService.claimTask(withDesc!.id, "user", owner.id);
  assert.equal(typeof claim === "string", false, "fixture claim must succeed");

  const token = await tokenForHuman(owner.email);
  const headers = authHeaders(token, server.id);

  const res = await fetch(`${app.baseUrl}/api/tasks/server?detail=summary&limit=10`, { headers });
  assert.equal(res.status, 200, `summary fetch failed with ${res.status}`);
  const body = await res.json() as { tasks: Array<Record<string, unknown>>; next_cursor: string | null };
  assert.equal(body.next_cursor, null, "single page must close the cursor");
  assert.equal(body.tasks.length, 2);

  const expectedKeys = [
    "channelId", "channelName", "channelType", "claimedAt", "claimedById",
    "claimedByName", "claimedByType", "completedAt", "createdAt", "createdById",
    "createdByName", "createdByType", "descriptionBytes", "hasDescription", "id",
    "isLegacy", "messageId", "revision", "source", "status", "taskNumber", "title",
    "updatedAt",
  ];
  for (const item of body.tasks) {
    assert.deepEqual(Object.keys(item).sort(), expectedKeys, "summary item carries exactly the contracted keys");
    assert.equal("description" in item, false, "summary item must not carry a description body");
    assert.equal(item.source, "tasks");
    assert.equal(item.channelName, "summary-room");
    assert.equal(item.channelType, "channel");
    assert.equal(item.createdById, owner.id);
    assert.equal(item.createdByType, "user");
    assert.equal(item.createdByName, "Summary Owner");
    assert.equal(typeof item.messageId, "string");
    assert.equal(typeof item.revision, "number");
    assert.equal(item.isLegacy, false);
  }

  const summaryWithDesc = body.tasks.find((item) => item.id === withDesc!.id)!;
  assert.equal(summaryWithDesc.hasDescription, true);
  assert.equal(summaryWithDesc.descriptionBytes, Buffer.byteLength(description, "utf8"));
  assert.equal(summaryWithDesc.claimedById, owner.id);
  assert.equal(summaryWithDesc.claimedByType, "user");
  assert.equal(summaryWithDesc.claimedByName, "summary-owner");
  assert.equal(typeof summaryWithDesc.claimedAt, "string");

  const summaryWithoutDesc = body.tasks.find((item) => item.id === withoutDesc!.id)!;
  assert.equal(summaryWithoutDesc.hasDescription, false);
  assert.equal(summaryWithoutDesc.descriptionBytes, 0);
  assert.equal(summaryWithoutDesc.claimedById, null);
  assert.equal(summaryWithoutDesc.claimedByType, null);
  assert.equal(summaryWithoutDesc.claimedByName, null);
  assert.equal(summaryWithoutDesc.claimedAt, null);

  // detail=summary without pagination: summary items, no next_cursor key.
  const unpaginated = await fetch(`${app.baseUrl}/api/tasks/server?detail=summary`, { headers });
  assert.equal(unpaginated.status, 200, `unpaginated summary failed with ${unpaginated.status}`);
  const unpaginatedBody = await unpaginated.json() as { tasks: Array<Record<string, unknown>>; next_cursor?: string | null };
  assert.equal("next_cursor" in unpaginatedBody, false, "next_cursor belongs to pagination mode only");
  assert.equal(unpaginatedBody.tasks.length, 2);
  assert.equal("description" in unpaginatedBody.tasks[0]!, false);
});

test("GET /api/tasks/server without the new params keeps the legacy full-row shape", async ({ app }) => {
  const owner = await seedUser("legacy-owner@slock.test", "legacy-owner");
  const server = await createServer("Task Legacy Shape", "task-legacy-shape", owner.id);
  const channel = await createChannel(server.id, "legacy-room");
  await addHuman(channel.id, owner.id);
  // An amended card: multi-KB description that must survive untouched.
  const description = `## Amended card\n\n${"lorem ipsum dolor sit amet ".repeat(200)}`;
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [
    { title: "amended card", description },
  ]);

  const token = await tokenForHuman(owner.email);
  const headers = authHeaders(token, server.id);

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  let res: Response;
  try {
    res = await fetch(`${app.baseUrl}/api/tasks/server`, { headers });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(res.status, 200, `legacy fetch failed with ${res.status}`);
  const raw = await res.text();
  const body = JSON.parse(raw) as { tasks: Array<Record<string, unknown>>; next_cursor?: string | null };

  assert.deepEqual(Object.keys(body), ["tasks"], "legacy shape has exactly the tasks key");
  assert.equal("next_cursor" in body, false);
  const item = body.tasks.find((candidate) => candidate.id === task!.id)!;
  assert.equal(item.description, description, "legacy mode returns the full description body");
  assert.equal(typeof item.revision, "number", "legacy full row keeps its enrichment fields");
  assert.equal(item.channelName, "legacy-room");

  // Small response: header present and byte-accurate, no warning.
  assert.equal(res.headers.get("x-response-bytes"), String(Buffer.byteLength(raw, "utf8")));
  assert.equal(
    warnings.filter((warning) => warning.includes("[tasks/server]")).length,
    0,
    "sub-threshold responses must not warn",
  );
});

test("GET /api/tasks/server composes the status filter with pagination", async ({ app }) => {
  const owner = await seedUser("status-page-owner@slock.test", "status-page-owner");
  const server = await createServer("Task Status Pagination", "task-status-pagination", owner.id);
  const channel = await createChannel(server.id, "status-room");
  await addHuman(channel.id, owner.id);
  const { tasks: created } = await taskService.createTasks(channel.id, "user", owner.id, [
    { title: "s-1" }, { title: "s-2" }, { title: "s-3" }, { title: "s-4" }, { title: "s-5" },
  ]);
  // Two tasks move to in_progress; three stay todo.
  for (const index of [1, 3]) {
    const claim = await taskService.claimTask(created[index]!.id, "user", owner.id);
    assert.equal(typeof claim === "string", false, "fixture claim must succeed");
  }
  const todoIds = [created[0]!, created[2]!, created[4]!].map((task) => task.id);
  const inProgressIds = [created[1]!, created[3]!].map((task) => task.id);

  const token = await tokenForHuman(owner.email);
  const headers = authHeaders(token, server.id);

  const todos = await fetchAllPages(app.baseUrl, headers, "status=todo&limit=2");
  assert.deepEqual(todos.items.map((task) => task.id), todoIds);
  assert.equal(todos.pages, 2, "3 todos at limit 2 must take 2 pages");

  const inProgress = await fetchAllPages(app.baseUrl, headers, "status=in_progress&limit=1");
  assert.deepEqual(inProgress.items.map((task) => task.id), inProgressIds);
  assert.equal(inProgress.pages, 2, "2 in_progress at limit 1 must take 2 pages");
});

test("GET /api/tasks/server pagination returns exactly the legacy visibility set", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("vis-owner@slock.test", "vis-owner");
  const reader = await seedUser("vis-reader@slock.test", "vis-reader");
  const server = await createServer("Task Visibility", "task-visibility", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: reader.id, role: "member" }).onConflictDoNothing();

  const open = await createChannel(server.id, "open-room");
  const closed = await createChannel(server.id, "closed-room", undefined, "private");
  const archived = await createChannel(server.id, "archived-room");
  await addHuman(open.id, owner.id);
  await addHuman(closed.id, owner.id);
  await addHuman(archived.id, owner.id);

  const { tasks: openTasks } = await taskService.createTasks(open.id, "user", owner.id, [{ title: "open-1" }, { title: "open-2" }]);
  await taskService.createTasks(closed.id, "user", owner.id, [{ title: "closed-1" }]);
  await taskService.createTasks(archived.id, "user", owner.id, [{ title: "archived-1" }]);
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, archived.id));

  const readerHeaders = authHeaders(await tokenForHuman(reader.email), server.id);
  const ownerHeaders = authHeaders(await tokenForHuman(owner.email), server.id);

  // A non-member reader sees only the public channel's tasks, archived excluded.
  const readerPages = await fetchAllPages(app.baseUrl, readerHeaders, "limit=1");
  assert.deepEqual(
    readerPages.items.map((task) => task.id).sort(),
    openTasks.map((task) => task.id).sort(),
  );

  // The legacy server-wide filter is type IN (channel, joint) + non-archived:
  // a private channel's tasks are invisible here even to its own member, and
  // pagination must reproduce that exactly (no leak, no new visibility).
  const legacyRes = await fetch(`${app.baseUrl}/api/tasks/server`, { headers: ownerHeaders });
  assert.equal(legacyRes.status, 200);
  const legacyBody = await legacyRes.json() as { tasks: Array<{ id: string }> };
  const ownerPages = await fetchAllPages(app.baseUrl, ownerHeaders, "limit=1");
  assert.equal(ownerPages.items.length, 2, "private and archived channel tasks stay invisible even to the owner");
  assert.deepEqual(
    ownerPages.items.map((task) => task.id).sort(),
    legacyBody.tasks.map((task) => task.id).sort(),
    "paginated visibility must equal legacy visibility",
  );
});

test("GET /api/tasks/server warns only for new-shape responses over 8 MiB; legacy stays header-only", async ({ app }) => {
  const owner = await seedUser("big-owner@slock.test", "big-owner");
  const server = await createServer("Task Big Response", "task-big-response", owner.id);
  const channel = await createChannel(server.id, "big-room");
  await addHuman(channel.id, owner.id);
  const description = "x".repeat(TASKS_SERVER_RESPONSE_WARN_BYTES + 4096);
  await taskService.createTasks(channel.id, "user", owner.id, [{ title: "huge card", description }]);

  const token = await tokenForHuman(owner.email);
  const headers = authHeaders(token, server.id);

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  let legacyRes: Response;
  let pagedRes: Response;
  try {
    legacyRes = await fetch(`${app.baseUrl}/api/tasks/server`, { headers });
    pagedRes = await fetch(`${app.baseUrl}/api/tasks/server?limit=1`, { headers });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(legacyRes.status, 200);
  assert.equal(pagedRes.status, 200);
  const legacyBytes = Buffer.byteLength(await legacyRes.text(), "utf8");
  assert.ok(legacyBytes > TASKS_SERVER_RESPONSE_WARN_BYTES, "fixture must actually cross the tripwire");

  // The legacy shape is already past the tripwire in production (21.7 MiB
  // measured 2026-09-01), so warning on it would be a standing noise floor
  // that teaches operators to raise the threshold. Only the NEW shapes warn:
  // a paginated/summary response past the wire means the new contract itself
  // is leaking size — the actionable signal.
  const tripwireWarnings = warnings.filter((warning) => warning.includes("[tasks/server]"));
  assert.equal(tripwireWarnings.length, 1, "the legacy request must not warn; the paginated one must");
  assert.ok(tripwireWarnings[0]!.includes("paginated/summary"), "the warning names the new shape");
  assert.ok(tripwireWarnings[0]!.includes(server.id), "warning names the server");

  assert.equal(legacyRes.headers.get("x-response-bytes"), String(legacyBytes), "legacy still reports exact bytes");
  assert.ok(pagedRes.headers.get("x-response-bytes"), "paginated reports bytes too");
});
