import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AgentMessage } from "@botiverse/raft-shared";
import type { Database } from "../db/index";
import { agents, machines, onboardingHeldWakes, thirdPartyAgentEvents } from "../db/schema";
import { dbTest as test } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { appEventInboxItemTarget, inboxItemsLaunch } from "./inboxItemsLaunch";
import {
  ONBOARDING_ALL_CHANNEL_GREETING_TTL_MS,
  ONBOARDING_OWNER_BRIEFING_TTL_MS,
  allChannelGreetingObjectRef,
  onboardingInboxItemsAllowedFor,
  onboardingInstructionsAsInboxItems,
  ownerBriefingObjectRef,
  sendOnboardingInboxItem,
} from "./onboardingInboxItems";
import { isSystemAppDeliveryGuarded } from "./systemAppDeliveryGuards";

async function seedAgent(db: Database, seed: ReturnType<typeof createSeed>, computerVersion: string | null = "1.0.68") {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const [machine] = await db.insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: `m-${randomUUID().slice(0, 8)}`,
    apiKeyHash: randomUUID(),
    computerVersion,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: `a-${randomUUID().slice(0, 8)}`,
    runtime: "cursor",
    machineId: machine.id,
  }).returning();
  return { serverId: server.id, agentId: agent.id, machineId: machine.id };
}

function recordingDeliverer() {
  const delivered: Array<{ agentId: string; message: AgentMessage }> = [];
  return {
    delivered,
    deliverer: {
      deliverMessage: async (agentId: string, message: AgentMessage) => {
        delivered.push({ agentId, message });
        return { status: "queued" as const, reason: "direct_dispatch" as const };
      },
    },
  };
}

test("the Computer version gate: 1.0.68 and newer releases only; older, a prerelease of 1.0.68, unknown or no Computer keep the message path", async ({ db, seed }) => {
  const cases: Array<[string | null, boolean]> = [
    ["1.0.68", true],
    ["1.0.69", true],
    ["1.25.3", true],
    ["1.0.67", false],
    ["1.0.68-rc.1", false],
    ["not-a-version", false],
    [null, false],
  ];
  for (const [version, expected] of cases) {
    const { agentId } = await seedAgent(db, seed, version);
    assert.equal(await onboardingInstructionsAsInboxItems(agentId, { perTurnRuntime: false }), expected, `Computer ${version}`);
  }
  // A hosted agent (no Computer at all).
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const [hosted] = await db.insert(agents).values({ serverId: server.id, name: `h-${randomUUID().slice(0, 8)}` }).returning();
  assert.equal(await onboardingInstructionsAsInboxItems(hosted.id, { perTurnRuntime: false }), false);
});

test("a per-turn runtime needs Computer 1.25.3 (the first with #14982); a 1.25.3 prerelease counts, it carries #14982", async ({ db, seed }) => {
  const cases: Array<[string | null, boolean, boolean]> = [
    // [Computer version, per-turn runtime, item path]
    ["1.25.2", true, false],
    ["1.25.2-rc.1", true, false],
    ["1.22.0", true, false],
    ["1.0.68", true, false],
    ["1.25.3-rc.1", true, true],
    ["1.25.3", true, true],
    ["1.26.0", true, true],
    [null, true, false],
    // Every other runtime stays at 1.0.68.
    ["1.0.68", false, true],
    ["1.25.2", false, true],
  ];
  for (const [version, perTurnRuntime, expected] of cases) {
    assert.equal(onboardingInboxItemsAllowedFor(version, { perTurnRuntime }), expected, `Computer ${version}, per-turn ${perTurnRuntime}`);
  }
  // From the agent's machine row.
  const { agentId: onOld } = await seedAgent(db, seed, "1.25.2");
  assert.equal(await onboardingInstructionsAsInboxItems(onOld, { perTurnRuntime: true }), false);
  const { agentId: onNew } = await seedAgent(db, seed, "1.25.3");
  assert.equal(await onboardingInstructionsAsInboxItems(onNew, { perTurnRuntime: true }), true);
  const { agentId: claude } = await seedAgent(db, seed, "1.0.68");
  assert.equal(await onboardingInstructionsAsInboxItems(claude, { perTurnRuntime: false }), true);
});

test("the owner briefing: one system.onboarding item, one wake; a replay writes nothing and wakes no one; nothing is held", async ({ db, seed }) => {
  const { serverId, agentId } = await seedAgent(db, seed);
  const channel = await seed.channel({ server: { id: serverId } as never, members: [] });
  const { delivered, deliverer } = recordingDeliverer();
  const input = {
    serverId,
    agentId,
    objectRef: ownerBriefingObjectRef(serverId),
    summary: "Onboarding briefing (system-triggered). Continue onboarding @Owner in #onboarding-owner channel from the owner's reply.",
    payload: { type: "owner_briefing", channel_id: channel.id, channel_name: "onboarding-owner" },
    ttlMs: ONBOARDING_OWNER_BRIEFING_TTL_MS,
    relatedChannelId: channel.id,
  };

  const before = Date.now();
  const first = await sendOnboardingInboxItem(deliverer, input);
  assert.equal(first.kind, "created");
  // Replays (a second activation, a retried trigger, two at once) join it.
  const replays = await Promise.all([sendOnboardingInboxItem(deliverer, input), sendOnboardingInboxItem(deliverer, input)]);
  assert.deepEqual(replays, [{ kind: "exists", eventId: first.eventId }, { kind: "exists", eventId: first.eventId }]);

  const rows = await db.select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.agentId, agentId));
  assert.equal(rows.length, 1, "one item, one event");
  const [row] = rows;
  assert.equal(row.systemApp, "system.onboarding");
  assert.equal(row.clientId, null);
  assert.equal(row.objectRef, `opener:${serverId}`);
  assert.equal(row.relatedChannelId, channel.id);
  const lifeMs = row.expiresAt.getTime() - row.createdAt.getTime();
  assert.equal(lifeMs, 7 * 24 * 60 * 60 * 1000, "the briefing lives 7 days");
  assert.ok(row.createdAt.getTime() >= before - 1000);

  assert.equal(delivered.length, 1, "one wake");
  const [{ message }] = delivered;
  assert.equal(message.message_id, row.id);
  assert.equal(message.third_party_event?.system_app, "system.onboarding");
  assert.equal(message.content.split("\n")[0], `System event: ${input.summary}`);
  assert.deepEqual(message.third_party_event?.payload, input.payload, "a system app's payload goes as written");

  // An inbox item (not one of NOT_ITEM_SYSTEM_APPS), with no delivery guard to withhold it.
  const launch = inboxItemsLaunch({ RAFT_INBOX_ITEMS_LAUNCH_AT: "2020-01-01T00:00:00Z" });
  assert.ok(launch);
  assert.equal(appEventInboxItemTarget(row, "system.onboarding", launch), `app:system.onboarding/opener:${serverId}`);
  assert.equal(isSystemAppDeliveryGuarded("system.onboarding"), false);

  // The per-turn hold of the message path is not used.
  assert.equal((await db.select().from(onboardingHeldWakes).where(eq(onboardingHeldWakes.agentId, agentId))).length, 0);
});

test("the #all greeting: its own item per agent, 1 day; a failed push still leaves the item queued for the sweep", async ({ db, seed }) => {
  const { serverId, agentId } = await seedAgent(db, seed);
  const errors: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { errors.push(args); };
  try {
    const outcome = await sendOnboardingInboxItem({ deliverMessage: async () => { throw new Error("push failed"); } }, {
      serverId,
      agentId,
      objectRef: allChannelGreetingObjectRef(serverId, agentId),
      summary: "Onboarding task (system-triggered): You have just joined #all.",
      payload: { type: "all_channel_greeting", channel_id: "c", channel_name: "all" },
      ttlMs: ONBOARDING_ALL_CHANNEL_GREETING_TTL_MS,
      relatedChannelId: null,
    });
    assert.equal(outcome.kind, "created");
  } finally {
    console.warn = warn;
  }
  assert.equal(errors.length, 1);
  const [row] = await db.select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.agentId, agentId));
  assert.equal(row.objectRef, `greeting:${serverId}:${agentId}`);
  assert.equal(row.status, "queued");
  assert.equal(row.expiresAt.getTime() - row.createdAt.getTime(), 24 * 60 * 60 * 1000, "the greeting lives 1 day");

  // Another agent's greeting on the same server is its own item.
  const other = await db.insert(agents).values({ serverId, name: `b-${randomUUID().slice(0, 8)}` }).returning();
  const { deliverer } = recordingDeliverer();
  const second = await sendOnboardingInboxItem(deliverer, {
    serverId,
    agentId: other[0].id,
    objectRef: allChannelGreetingObjectRef(serverId, other[0].id),
    summary: "hi",
    payload: {},
    ttlMs: ONBOARDING_ALL_CHANNEL_GREETING_TTL_MS,
    relatedChannelId: null,
  });
  assert.equal(second.kind, "created");
});
