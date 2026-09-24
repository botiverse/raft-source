import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
  resolveServerPushSuppressionForPipeline,
  type ServerPushPipelineSurface,
} from "./messageService.js";
import { shouldSuppressServerPush } from "./serverService.js";

test("server push mode all delivers ordinary and mentioned messages", () => {
  assert.equal(shouldSuppressServerPush("all", false), false);
  assert.equal(shouldSuppressServerPush("all", true), false);
});

test("server push mode mentions suppresses ordinary messages but pierces for mentions", () => {
  assert.equal(shouldSuppressServerPush("mentions", false), true);
  assert.equal(shouldSuppressServerPush("mentions", true), false);
});

test("server push mode none suppresses both ordinary and mentioned messages", () => {
  assert.equal(shouldSuppressServerPush("none", false), true);
  assert.equal(shouldSuppressServerPush("none", true), true);
});

for (const surface of ["direct_or_local", "joint_channel", "joint_thread"] satisfies ServerPushPipelineSurface[]) {
  test(`${surface} pipeline passes only resolved target-visible mentions to mentions-only suppression`, async () => {
    const resolveSuppressedUserIds = async (
      _serverId: string,
      userIds: string[],
      targetVisibleMentionedUserIds: ReadonlySet<string>,
    ) => new Set(userIds.filter((userId) => shouldSuppressServerPush(
      "mentions",
      targetVisibleMentionedUserIds.has(userId),
    )));

    const ordinary = await resolveServerPushSuppressionForPipeline({
      surface,
      serverId: "server-target",
      targetUserIds: ["ordinary-user"],
      targetVisibleMentionedUserIds: new Set(),
      resolveSuppressedUserIds,
    });
    assert.deepEqual([...ordinary], ["ordinary-user"]);

    const resolvedVisibleMention = await resolveServerPushSuppressionForPipeline({
      surface,
      serverId: "server-target",
      targetUserIds: ["mentioned-user"],
      targetVisibleMentionedUserIds: new Set(["mentioned-user"]),
      resolveSuppressedUserIds,
    });
    assert.deepEqual([...resolvedVisibleMention], []);

    const unresolvedOrNonVisibleMention = await resolveServerPushSuppressionForPipeline({
      surface,
      serverId: "server-target",
      targetUserIds: ["unresolved-user"],
      targetVisibleMentionedUserIds: new Set(),
      resolveSuppressedUserIds,
    });
    assert.deepEqual([...unresolvedOrNonVisibleMention], ["unresolved-user"]);
  });
}

test("all three production push callsites bind the target-visible mention audience", () => {
  const source = readFileSync(new URL("./messageService.ts", import.meta.url), "utf8");
  assert.match(source, /surface: "direct_or_local",[\s\S]*?targetVisibleMentionedUserIds: mentionedUserIds,/);
  assert.match(source, /surface: "joint_channel",[\s\S]*?targetVisibleMentionedUserIds: mentionedUserIds,/);
  assert.match(source, /surface: "joint_thread",[\s\S]*?targetVisibleMentionedUserIds,/);
});

test("0183 backfills one canonical mode column and synchronizes rolling legacy writers", () => {
  const migration = readFileSync(
    new URL("../../drizzle/0183_brave_dragon_lord.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /ADD COLUMN "server_push_mode" text DEFAULT 'all' NOT NULL/);
  assert.match(migration, /CASE WHEN "server_push_muted" THEN 'none' ELSE 'all' END/);
  assert.match(migration, /CHECK \("server_members"\."server_push_mode" IN \('all', 'mentions', 'none'\)\)/);
  assert.match(migration, /CREATE TRIGGER "server_members_push_mode_sync"/);
  assert.match(migration, /ELSIF NEW\."server_push_muted" IS DISTINCT FROM OLD\."server_push_muted"/);
  assert.doesNotMatch(migration, /server_push_mentions_only/);
});
