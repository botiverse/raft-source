import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// The action card funnel is copied to ScopeDB (`action_card_action`) while its
// readers move off the Postgres `product_events` table (cindyz, 2026-10-26,
// #proj-analytics:69ac4304): one copy per Postgres row that is written, none
// for a duplicate and none for an attempt whose transaction rolls back.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { asServerId, type ActionCardAction } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { actionCards, productEvents, servers, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { prepareActionCard } from "../services/actionCardsService";
import type { ProductEventRow, ProductEventSink } from "../services/productEventScopeDbWriter";
import { setActionCardScopeDbSink } from "../services/productEventsService";
import { createServer } from "../services/serverService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

function memorySink() {
  const rows: ProductEventRow[] = [];
  const sink: ProductEventSink = { enqueue: (batch) => { rows.push(...batch); }, flush: async () => {} };
  return { rows, sink };
}

/** The copy is written after the response; wait for `count` rows, then a little longer for strays. */
async function settle(rows: readonly ProductEventRow[], count: number): Promise<void> {
  for (let i = 0; i < 200 && rows.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function seedCard(slug: string, channelName: string, cardAction?: ActionCardAction) {
  const [owner] = await getDb().insert(users).values({
    email: `${slug}-${randomUUID().slice(0, 8)}@slock.test`,
    name: `${slug}-owner`,
    displayName: `${slug} owner`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer(`Card copy ${slug}`, `card-copy-${slug}-${randomUUID().slice(0, 8)}`, owner!.id);
  const agent = await createAgent(server.id, `${slug}-agent-${randomUUID().slice(0, 6)}`, { runtime: "codex" });
  const carrier = await createChannel(server.id, `${slug}-carrier`, undefined, "channel", { type: "user", id: owner!.id });
  await addHuman(carrier.id, owner!.id);
  await addAgent(carrier.id, agent.id);
  const card = await prepareActionCard({
    serverId: asServerId(server.id),
    requesterAgentId: agent.id,
    targetChannelId: carrier.id,
    action: cardAction ?? { type: "channel:create", name: channelName, visibility: "public" },
  });
  const headers = {
    Authorization: `Bearer ${await tokenForHuman(owner!.email)}`,
    "Content-Type": "application/json",
    "X-Server-Id": server.id,
  };
  return { owner: owner!, server, agent, carrier, card, headers };
}

/** Copies in a fixed order: the test does not depend on which write finished first. */
function byAction(rows: readonly ProductEventRow[]) {
  return rows.map((row) => row.properties).sort((a, b) => String(a.action).localeCompare(String(b.action)));
}

async function pgEvents(messageId: string): Promise<string[]> {
  const [card] = await getDb().select({ id: actionCards.id }).from(actionCards).where(eq(actionCards.messageId, messageId));
  const rows = await getDb().select({ eventType: productEvents.eventType })
    .from(productEvents)
    .where(and(eq(productEvents.subjectType, "action_card"), eq(productEvents.subjectId, card!.id)));
  return rows.map((row) => row.eventType).sort();
}

test("a client-reported step is copied once, with the client it came from", async ({ app }) => {
  const { rows, sink } = memorySink();
  setActionCardScopeDbSink(sink);
  try {
    const { server, card, headers } = await seedCard("client", `client-${randomUUID().slice(0, 8)}`);
    const open = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/event`, {
      method: "POST",
      headers: { ...headers, "X-Raft-Client-Platform": "pwa" },
      body: JSON.stringify({ eventType: "action_card.open" }),
    });
    assert.equal(open.status, 204);
    // The same dismiss twice: Postgres keeps one row, so ScopeDB gets one copy.
    for (let i = 0; i < 2; i += 1) {
      const dismiss = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/event`, {
        method: "POST",
        headers,
        body: JSON.stringify({ eventType: "action_card.dismiss", idempotencyKey: "dismiss-once" }),
      });
      assert.equal(dismiss.status, 204);
    }
    await settle(rows, 2);

    assert.deepEqual(await pgEvents(card.messageId), ["action_card.dismiss", "action_card.open"]);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.event, "action_card_action");
      assert.equal(row.source, "server");
      assert.equal(row.server_id, server.id);
    }
    assert.deepEqual(byAction(rows), [
      // No X-Raft-Client-Platform header (an older client).
      { action: "dismiss", action_type: "channel:create", reported_by: "client", platform: "unknown" },
      { action: "open", action_type: "channel:create", reported_by: "client", platform: "pwa" },
    ]);
  } finally {
    setActionCardScopeDbSink(null);
  }
});

test("an executed card's attempt and success are copied once they commit, as server steps", async ({ app }) => {
  const { rows, sink } = memorySink();
  setActionCardScopeDbSink(sink);
  try {
    const { card, headers } = await seedCard("execute", `execute-${randomUUID().slice(0, 8)}`);
    const execute = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedState: "prepared" }),
    });
    assert.equal(execute.status, 200, await execute.clone().text());
    await settle(rows, 2);

    assert.deepEqual(await pgEvents(card.messageId), ["action_card.execute_attempt", "action_card.execute_success"]);
    assert.deepEqual(byAction(rows), [
      { action: "execute_attempt", action_type: "channel:create", reported_by: "server" },
      { action: "execute_success", action_type: "channel:create", reported_by: "server" },
    ]);
  } finally {
    setActionCardScopeDbSink(null);
  }
});

test("a failed execution copies only the failure: its attempt rolled back with the transaction", async ({ app }) => {
  const { rows, sink } = memorySink();
  setActionCardScopeDbSink(sink);
  try {
    const taken = `taken-${randomUUID().slice(0, 8)}`;
    const { server, owner, card, headers } = await seedCard("rollback", taken);
    // The card's channel name is already in use, so creating it fails inside the transaction.
    await createChannel(server.id, taken, undefined, "channel", { type: "user", id: owner.id });
    const execute = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedState: "prepared" }),
    });
    assert.notEqual(execute.status, 200);
    await settle(rows, 1);

    const pg = await pgEvents(card.messageId);
    assert.deepEqual(pg, ["action_card.execute_fail"]);
    assert.deepEqual(rows.map((row) => row.properties.action), ["execute_fail"]);
    assert.equal(rows[0]!.properties.reported_by, "server");
    assert.equal(typeof rows[0]!.properties.error_class, "string");
  } finally {
    setActionCardScopeDbSink(null);
  }
});

test("a card marked done after its dialog copies the success once it commits", async ({ app }) => {
  const { rows, sink } = memorySink();
  setActionCardScopeDbSink(sink);
  try {
    const name = `marked-${randomUUID().slice(0, 6)}`;
    const { agent, card, headers } = await seedCard("mark", name, { type: "agent:create", name });
    const marked = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/mark-executed`, {
      method: "POST",
      headers,
      body: JSON.stringify({ result: { kind: "agent", id: agent.id, name } }),
    });
    assert.equal(marked.status, 200, await marked.clone().text());
    await settle(rows, 1);

    assert.deepEqual(await pgEvents(card.messageId), ["action_card.execute_success"]);
    assert.deepEqual(byAction(rows), [{ action: "execute_success", action_type: "agent:create", reported_by: "server" }]);
  } finally {
    setActionCardScopeDbSink(null);
  }
});

test("a workspace with product analytics off gets the Postgres row but no copy", async ({ app }) => {
  const { rows, sink } = memorySink();
  setActionCardScopeDbSink(sink);
  try {
    const { server, card, headers } = await seedCard("off", `off-${randomUUID().slice(0, 8)}`);
    await getDb().update(servers).set({ productAnalyticsEnabled: false }).where(eq(servers.id, server.id));
    const open = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/event`, {
      method: "POST",
      headers,
      body: JSON.stringify({ eventType: "action_card.open" }),
    });
    assert.equal(open.status, 204);
    await settle(rows, 1);

    assert.deepEqual(await pgEvents(card.messageId), ["action_card.open"]);
    assert.equal(rows.length, 0);
  } finally {
    setActionCardScopeDbSink(null);
  }
});
