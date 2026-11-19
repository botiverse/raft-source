import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { getDb } from "./index";
import { servers, tasks } from "./schema";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
import * as taskService from "../services/taskService";

// Task v2 (#wg-task-v2:#24): the migration that adds servers.task_v2_on_since
// seeds it, for servers already on, from their earliest task v2 task. This
// executes the seed statement of the MIGRATION FILE ITSELF, read off disk (the
// column already exists in the test database), so the shipped SQL and what is
// tested cannot drift apart.
const MIGRATION_FILE = "0707_servers_task_v2_on_since.sql";
const MIGRATION_PATH = fileURLToPath(new URL(`../../drizzle/${MIGRATION_FILE}`, import.meta.url));

function seedStatement(): string {
  const body = readFileSync(MIGRATION_PATH, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const statements = body.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  const seed = statements.filter((s) => /^UPDATE\s+"servers"/i.test(s));
  assert.equal(seed.length, 1, `${MIGRATION_FILE} seeds servers.task_v2_on_since in one statement`);
  return seed[0]!;
}

async function sinceOf(serverId: string) {
  const [row] = await getDb().select({ since: servers.taskV2OnSince }).from(servers).where(eq(servers.id, serverId));
  return row?.since ? new Date(row.since).toISOString() : null;
}

test("task_v2_on_since seed: an allowed server's earliest task v2 task; pre-v2 tasks don't count; a server with none, one the flag's server rules do not name, or one already set, is left alone", async ({ seed }) => {
  const db = getDb();
  const owner = await seed.human();
  const make = async () => {
    const server = await seed.server({ owner });
    const channel = await seed.channel({ server, members: [owner] });
    return { server, channel };
  };
  const at = (iso: string) => new Date(iso);
  async function taskAt(channelId: string, createdAt: Date, ownConversation: boolean) {
    const { tasks: [created] } = await taskService.createTasks(channelId, "user", owner.id, [{ title: `t ${createdAt.toISOString()}` }]);
    await db.update(tasks).set({ createdAt, ownConversation }).where(eq(tasks.id, created!.id));
  }

  const on = await make();
  await enableTaskV2ConversationsForServer(on.server.id);
  await taskAt(on.channel.id, at("2026-01-01T00:00:00Z"), false);
  await taskAt(on.channel.id, at("2026-10-20T08:00:00Z"), true);
  await taskAt(on.channel.id, at("2026-10-05T12:00:00Z"), true);
  const preV2Only = await make();
  await enableTaskV2ConversationsForServer(preV2Only.server.id);
  await taskAt(preV2Only.channel.id, at("2026-03-01T00:00:00Z"), false);
  // Task v2 tasks, but no `server` allow rule names it (turned off since, or on by another rule): the reminder sets it.
  const notNamed = await make();
  await taskAt(notNamed.channel.id, at("2026-10-02T00:00:00Z"), true);
  const alreadySet = await make();
  await enableTaskV2ConversationsForServer(alreadySet.server.id);
  await taskAt(alreadySet.channel.id, at("2026-10-01T00:00:00Z"), true);
  await db.update(servers).set({ taskV2OnSince: at("2026-11-01T00:00:00Z") }).where(eq(servers.id, alreadySet.server.id));

  await db.execute(sql.raw(seedStatement()));

  assert.equal(await sinceOf(on.server.id), "2026-10-05T12:00:00.000Z");
  assert.equal(await sinceOf(preV2Only.server.id), null);
  assert.equal(await sinceOf(notNamed.server.id), null);
  assert.equal(await sinceOf(alreadySet.server.id), "2026-11-01T00:00:00.000Z", "a value already written stays");
});
