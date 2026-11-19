import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
import * as taskService from "../services/taskService";

// The task trigger (0710_change_log_tasks.sql) logs a change only for the
// columns in its WHEN list. A field the task list (GET /api/tasks/channel/:id,
// the row GET /api/sync/changes sends) shows from another column would go
// stale in clients without anyone noticing: every field of that row must be
// accounted for here, and every column it reads must be in the trigger.

const test = createApiTest();

const MIGRATION = fileURLToPath(new URL("../../drizzle/0710_change_log_tasks.sql", import.meta.url));

/** The columns the trigger's update WHEN list compares. */
function triggerColumns(): Set<string> {
  const sqlText = readFileSync(MIGRATION, "utf8");
  return new Set([...sqlText.matchAll(/OLD\.([a-z_]+) IS DISTINCT FROM NEW\.\1/g)].map((match) => match[1]!));
}

/**
 * Where each field of the task list's row comes from: `tasks` columns (each
 * must be logged by the trigger), or elsewhere, with what carries its change.
 */
const TASK_ROW_FIELDS: Record<string, { columns: string[] } | { elsewhere: string }> = {
  id: { columns: [] },
  messageId: { columns: ["message_id"] },
  hostMessageId: { columns: ["message_id"] },
  sourceMessageId: { columns: ["source_message_id", "message_id"] },
  sourceRecorded: { columns: ["source_message_id", "message_id"] },
  conversationChannelId: { columns: ["conversation_channel_id"] },
  conversationAnchored: { columns: ["conversation_channel_id", "own_conversation"] },
  isLegacy: { columns: ["message_id", "conversation_channel_id", "own_conversation"] },
  channelId: { columns: ["channel_id"] },
  taskNumber: { columns: ["task_number"] },
  title: { columns: ["title"] },
  description: { columns: ["description"] },
  status: { columns: ["status"] },
  createdByType: { columns: ["created_by_type"] },
  createdById: { columns: ["created_by_id"] },
  claimedByType: { columns: ["claimed_by_type"] },
  claimedById: { columns: ["claimed_by_id"] },
  claimedAt: { columns: ["claimed_at"] },
  completedAt: { columns: ["completed_at"] },
  requiresResourceReceipt: { columns: ["requires_resource_receipt"] },
  resourceReceipt: { columns: ["resource_receipt"] },
  resourceReceiptRecordedAt: { columns: ["resource_receipt_recorded_at"] },
  resourceTeardownOwnerAgentId: { columns: ["resource_teardown_owner_agent_id"] },
  resourceExpiryFollowupId: { columns: ["resource_expiry_followup_id"] },
  createdAt: { columns: ["created_at"] },
  revision: { columns: ["revision"] },
  taskCurrentProjection: { columns: ["title", "description", "revision"] },
  readOnlyReason: { columns: ["created_at"] },
  // Not logged on purpose (0710): bookkeeping and conversation activity. A
  // client gets their current value with the task's next logged change.
  updatedAt: { elsewhere: "not logged: bookkeeping" },
  lastActivityAt: { elsewhere: "not logged: conversation activity (the client sees the message)" },
  activityAt: { elsewhere: "not logged: lastActivityAt ?? updatedAt" },
  conversationReplyCount: { elsewhere: "conversation and message changes of the task conversation" },
  conversationFollowed: { elsewhere: "conversation changes (follow state)" },
  channelName: { elsewhere: "channel changes" },
  channelType: { elsewhere: "channel changes" },
  createdByName: { elsewhere: "agent / server_member changes" },
  createdByHandle: { elsewhere: "agent / server_member changes" },
  createdByMembershipStatus: { elsewhere: "server_member / channel_member changes" },
  claimedByName: { elsewhere: "agent / server_member changes" },
};

test("every field of the synced task row is accounted for, and every column it reads is logged by the trigger", async ({ seed, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  await enableTaskV2ConversationsForServer(server.id);
  const channel = await seed.channel({ server, members: [owner] });
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "Account for every field" }]);
  const res = await http.as(owner, server).get(`/api/tasks/channel/${channel.id}`);
  assert.equal(res.status, 200, await res.clone().text());
  const row = ((await res.json()) as { tasks: Array<Record<string, unknown>> }).tasks.find((item) => item.id === task!.id);
  assert.ok(row);

  const unaccounted = Object.keys(row).filter((key) => !(key in TASK_ROW_FIELDS));
  assert.deepEqual(unaccounted, [], "a new task row field: add it to TASK_ROW_FIELDS, and its column to the trigger in a new migration");

  const logged = triggerColumns();
  const missing = Object.values(TASK_ROW_FIELDS).flatMap((source) => ("columns" in source ? source.columns : [])).filter((column) => !logged.has(column));
  assert.deepEqual([...new Set(missing)], [], "a column the task row reads is not in the trigger's WHEN list");
});

/** Every file under `dir`, recursively, but node_modules. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test("no server code path sets the task status cleanup's switch: only the one-off script may (0710)", () => {
  const src = fileURLToPath(new URL("..", import.meta.url));
  const setters = filesUnder(src)
    .filter((path) => /\.(ts|js|sql)$/.test(path) && !/\.test\.ts$/.test(path))
    .filter((path) => readFileSync(path, "utf8").includes("task_status_cleanup"));
  assert.deepEqual(setters, []);
});
