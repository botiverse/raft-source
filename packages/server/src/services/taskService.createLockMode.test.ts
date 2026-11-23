import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { fixturePasswordHash } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { users } from "../db/schema";
import { createAgent } from "./agentService";
import { addAgent, addHuman, createChannel } from "./channelService";
import { addMember, createServer } from "./serverService";
import { createTasks, createTasksWithAssignmentReceipt } from "./taskService";

/**
 * Task creation locks the channel row and the assignee agents/users row FOR NO
 * KEY UPDATE, never FOR UPDATE (#proj-o11y:#39). FOR UPDATE conflicts with the
 * FOR KEY SHARE a concurrent message insert takes through its channel/sender
 * foreign keys: "send as task" inserted a message (KEY SHARE on the channel)
 * and then waited for pg_advisory_xact_lock(hashtext(channelId)), while task
 * creation held that advisory lock and waited for FOR UPDATE on the channel,
 * a 40P01 on POST /internal/agent-api/tasks. NO KEY UPDATE still conflicts with
 * the archive/delete/retype UPDATEs and DELETEs these locks guard against.
 * The FOR KEY SHARE first is the storage re-resolution every message writer
 * takes (lockAndResolveMessageStorage): it conflicts only with FOR UPDATE.
 */

type SqlCaptureClient = {
  query: (...args: unknown[]) => Promise<unknown>;
  transaction: <T>(fn: (tx: SqlCaptureClient) => Promise<T>, ...rest: unknown[]) => Promise<T>;
};

async function captureSql(work: () => Promise<unknown>): Promise<string[]> {
  const client = (getDb() as unknown as { $client: SqlCaptureClient }).$client;
  const originalQuery = client.query.bind(client);
  const originalTransaction = client.transaction.bind(client);
  const statements: string[] = [];
  const record = (args: unknown[]) => {
    if (typeof args[0] === "string") statements.push(args[0].toLowerCase());
  };
  client.query = ((...args: unknown[]) => {
    record(args);
    return originalQuery(...args);
  }) as SqlCaptureClient["query"];
  client.transaction = (async <T,>(fn: (tx: SqlCaptureClient) => Promise<T>, ...rest: unknown[]) =>
    originalTransaction(async (tx: SqlCaptureClient) => {
      const originalTxQuery = tx.query.bind(tx);
      tx.query = ((...args: unknown[]) => {
        record(args);
        return originalTxQuery(...args);
      }) as SqlCaptureClient["query"];
      return fn(tx);
    }, ...rest)) as SqlCaptureClient["transaction"];
  try {
    await work();
  } finally {
    client.query = originalQuery;
    client.transaction = originalTransaction;
  }
  return statements;
}

/** Row-lock clauses of the statements reading `table` directly. */
function rowLocksOn(statements: string[], table: string): string[] {
  return statements
    .filter((text) => new RegExp(`\\bfrom\\s+"${table}"`).test(text))
    .map((text) => /\bfor\s+(no\s+key\s+update|key\s+share|update|share)\b/.exec(text)?.[1]?.replace(/\s+/g, " "))
    .filter((lock): lock is string => Boolean(lock));
}

async function seedUser(name: string) {
  const [user] = await getDb().insert(users).values({
    email: `${name}-${randomUUID()}@slock.test`,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function seedChannel() {
  const owner = await seedUser("lockmode_owner");
  const assigneeUser = await seedUser("lockmode_assignee");
  const server = await createServer("Task lock mode", `task-lock-mode-${randomUUID()}`, owner.id);
  await addMember(server.id, assigneeUser.id);
  const channel = await createChannel(server.id, "task-lock-mode");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, assigneeUser.id);
  const agent = await createAgent(server.id, "lockmode_agent");
  await addAgent(channel.id, agent.id);
  return { owner, assigneeUser, agent, channel };
}

test("createTasks locks the channel FOR NO KEY UPDATE, not FOR UPDATE", async ({ db: _db }) => {
  const { owner, channel } = await seedChannel();
  const statements = await captureSql(() => createTasks(channel.id, "user", owner.id, [{ title: "unassigned" }]));
  assert.deepEqual(rowLocksOn(statements, "channels"), ["key share", "no key update"],
    "createTasks must lock the channel row FOR NO KEY UPDATE (#proj-o11y:#39)");
});

test("createTasksWithAssignmentReceipt locks channel and assignee FOR NO KEY UPDATE, not FOR UPDATE", async ({ db: _db }) => {
  const { owner, assigneeUser, agent, channel } = await seedChannel();

  const toAgent = await captureSql(() => createTasksWithAssignmentReceipt(
    channel.id, "user", owner.id, [{ title: "for agent" }],
    { type: "agent", id: agent.id }, { assigneeName: agent.name },
  ));
  assert.deepEqual(rowLocksOn(toAgent, "channels"), ["key share", "no key update"],
    "assigned creation must lock the channel row FOR NO KEY UPDATE (#proj-o11y:#39)");
  assert.deepEqual(rowLocksOn(toAgent, "agents"), ["no key update"],
    "assigned creation must lock the assignee agents row FOR NO KEY UPDATE (#proj-o11y:#39)");

  const toUser = await captureSql(() => createTasksWithAssignmentReceipt(
    channel.id, "user", owner.id, [{ title: "for user" }],
    { type: "user", id: assigneeUser.id }, { assigneeName: assigneeUser.name },
  ));
  assert.deepEqual(rowLocksOn(toUser, "channels"), ["key share", "no key update"],
    "assigned creation must lock the channel row FOR NO KEY UPDATE (#proj-o11y:#39)");
  assert.deepEqual(rowLocksOn(toUser, "users"), ["no key update"],
    "assigned creation must lock the assignee users row FOR NO KEY UPDATE (#proj-o11y:#39)");
});
