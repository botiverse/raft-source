// A migration receipt is posted to a hidden DM whose only member is the
// migrated agent, so the inbox names it `dm:@migration-receipt-<ref>`. Before
// this, that name resolved to no one: every migrated agent's first wake read
// or replied to it and got "Channel not found" (R8, task #16).
//
// Pins: the owning agent reads it under the name its inbox prints; another
// agent gets the neutral 404; a reply is a clear 409 MIGRATION_RECEIPT_READ_ONLY
// that names the next step, and nothing lands in the receipt DM.
import assert from "node:assert/strict";
import { refusalBody } from "../lib/refusal";
import { AGENT_CHANNEL_NOT_FOUND_REFUSAL } from "./agentRouteRefusals";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agentMigrations, messages, users } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { agentApi } from "../test/appAgentReminderFixture";
import {
  beginTestAgentMigration,
  flipTestAgentMigration,
  markTestAgentMigrationReady,
  startTestAgentMigrationTransfer,
} from "../test/agentMigrationFixture";
import {
  agentMigrationGeneration,
  completeAgentMigrationAutoStart,
  markAgentMigrationTargetImportArrived,
  recordAgentMigrationSourceWorkspaceArchived,
} from "../services/agentMigrationService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { MIGRATION_RECEIPT_CHANNEL_PREFIX, resolveAgentFacingChannelRef, resolveAgentFacingDmRefs } from "../services/channelService";
import { registerMachine } from "../services/machineService";
import { createServer } from "../services/serverService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

/** A completed Computer migration: its receipt sits in the agent-only receipt DM. */
async function seedCompletedMigration() {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `receipt-dm-${suffix}@slock.test`, name: `receipt-dm-${suffix}`, passwordHash: "hash", emailVerified: true,
  }).returning();
  const server = await createServer("Receipt DM", `receipt-dm-${suffix}`, owner.id);
  const { machine: source } = await registerMachine(server.id, owner.id, "Receipt Source");
  const { machine: target } = await registerMachine(server.id, owner.id, "Receipt Target");
  const agent = await createAgent(server.id, `mover${suffix}`, { runtime: "codex", machineId: source.id });
  const other = await createAgent(server.id, `bystander${suffix}`, { runtime: "codex", machineId: source.id });
  const provisioning = await beginTestAgentMigration({
    agentId: agent.id, targetMachineId: target.id, initiatedByUserId: owner.id, now: new Date("2026-07-20T12:00:00.000Z"),
  });
  const { migration } = provisioning;
  await markTestAgentMigrationReady(provisioning, { now: new Date("2026-07-20T12:01:00.000Z") });
  await startTestAgentMigrationTransfer(migration.id, new Date("2026-07-20T12:02:00.000Z"));
  const arriving = await flipTestAgentMigration(migration.id, new Date("2026-07-20T12:03:00.000Z"));
  const archived = await recordAgentMigrationSourceWorkspaceArchived({
    migrationId: arriving.id, migrationGeneration: agentMigrationGeneration(arriving), serverId: server.id,
    targetMachineId: target.id, now: new Date("2026-07-20T12:03:30.000Z"),
  });
  await markAgentMigrationTargetImportArrived({
    migrationId: arriving.id, migrationGeneration: archived.migrationGeneration, serverId: server.id,
    targetMachineId: target.id, now: new Date("2026-07-20T12:04:00.000Z"),
  });
  await completeAgentMigrationAutoStart({ migrationId: migration.id, agentId: agent.id, targetMachineId: target.id });
  const [completed] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.equal(completed.state, "completed");
  const agentKey = (await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "receipt-dm", issuedVia: "computer", createdByUserId: null })).apiKey;
  const otherKey = (await mintAgentCredential({ agentId: other.id, scopes: ["send", "read"], name: "receipt-dm", issuedVia: "computer", createdByUserId: null })).apiKey;
  return { server, agent, other, agentKey, otherKey, migration: completed, receiptChannelId: completed.receiptChannelId! };
}

test("the migrated agent reads its receipt under the name its inbox prints; another agent cannot", async ({ app }) => {
  const world = await seedCompletedMigration();
  const target = await resolveAgentFacingChannelRef(world.server.id, world.agent.id, world.receiptChannelId);
  assert.equal(target, `dm:@${MIGRATION_RECEIPT_CHANNEL_PREFIX}${world.migration.supportRef}`);
  // The inbox list (batched) prints the same name, so the row is listed and readable.
  assert.equal((await resolveAgentFacingDmRefs(world.server.id, world.agent.id, [world.receiptChannelId])).get(world.receiptChannelId), target);
  // Another agent gets no name for it.
  assert.equal(await resolveAgentFacingChannelRef(world.server.id, world.other.id, world.receiptChannelId), null);

  const history = await agentApi(app.baseUrl, world.agentKey, "GET", `/history?${new URLSearchParams({ channel: target! })}`);
  assert.equal(history.status, 200, history.raw);
  assert.match(history.raw, /Migration completed/);
  assert.ok(history.raw.includes(world.migration.supportRef), history.raw);

  // Same neutral answer as any channel the caller cannot see.
  const other = await agentApi(app.baseUrl, world.otherKey, "GET", `/history?${new URLSearchParams({ channel: target! })}`);
  assert.equal(other.status, 404, other.raw);
  assert.deepEqual(other.body, refusalBody(AGENT_CHANNEL_NOT_FOUND_REFUSAL));
  assert.ok(!other.raw.includes("Migration completed"));
});

test("a reply to the receipt is a clear 409 with the next step, and nothing is posted", async ({ app }) => {
  const world = await seedCompletedMigration();
  const target = `dm:@${MIGRATION_RECEIPT_CHANNEL_PREFIX}${world.migration.supportRef}`;
  const before = await getDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, world.receiptChannelId));

  for (const route of ["/send", "/v2/send"]) {
    const sent = await agentApi(app.baseUrl, world.agentKey, "POST", route, { target, content: "thanks!" });
    assert.equal(sent.status, 409, `${route}: ${sent.raw}`);
    assert.equal(sent.body.code, "MIGRATION_RECEIPT_READ_ONLY");
    assert.match(sent.body.error, /one-way notice/);
    assert.match(sent.body.suggestedNextAction, /owner's DM/);
  }
  const after = await getDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, world.receiptChannelId));
  assert.equal(after.length, before.length, "no agent message landed in the receipt DM");

  // Another agent naming someone else's receipt still learns nothing.
  const other = await agentApi(app.baseUrl, world.otherKey, "POST", "/send", { target, content: "hi" });
  assert.equal(other.status, 404, other.raw);
});
