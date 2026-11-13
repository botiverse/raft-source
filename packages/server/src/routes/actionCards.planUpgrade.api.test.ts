import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// `plan:upgrade` (task #6 #proj-apps): an agent offers Pro to a person who
// needs it, with its own one-sentence reason and, when a Free limit was hit,
// that limit's gate. Agents only, on a Free server, never in a shared (joint)
// channel or a thread of one; a repeat for the same conversation and gate
// (none: `general`) within a day answers with the card already there;
// otherwise, after an agent's upgrade card there of any gate, deleted since or
// not, the conversation gets no other one for a cooldown (14 days, cindyz
// #proj-apps:5eafd481): 409 UPGRADE_CARD_COOLDOWN. No server action at all. No
// flag: `agent_upgrade_card` is retired (#raft-architecture:#32), and a
// leftover row, even off or with a variant, changes nothing.
// `agentUpgradeCardHint` is the line Till's read-limit messages offer agents,
// and an upload refusal's next action, for a client that can post the card,
// outside the cooldown.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import type { ActionCardMetadata } from "@botiverse/raft-shared";
import {
  BasicTracer,
  MemoryTraceSink,
  MANUAL_CONTEXT_CAPABILITY,
  PLAN_UPGRADE_CARD_CAPABILITY,
  PLAN_UPGRADE_EXTRA_FIELDS_MESSAGE,
  PLAN_UPGRADE_REASON_MESSAGE,
  PLAN_UPGRADE_REASON_PLACEHOLDER_MESSAGE,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { actionCards, featureFlags, messages, oauthClientInstalls, servers } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import * as channelService from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createOAuthClient } from "../services/oauthService";
import { createManagedAppBot } from "../services/appBotIdentityService";
import { agentSearchUpgradeCardHint, agentUpgradeCardHint, canClientPostUpgradeCard } from "../services/agentUpgradeCardService";
import { preparableActionCardTypes, prepareActionCard } from "../services/actionCardsService";
import { recordMachineComputerVersion, registerMachine } from "../services/machineService";
import { createMessage } from "../services/messageService";
import { seedJointChannel } from "../test/integration/jointFixture";
import { users } from "../db/schema";
import { useStripeBillingConfigured, withoutStripeBilling } from "../test/stripeBillingEnv";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
useStripeBillingConfigured();

// Generous: a loaded CI host can take far longer than a request normally does.
const REQUEST_TIMEOUT_MS = 120_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const REASON = "You asked for last quarter's launch notes, which are older than 30 days.";
const UPGRADE = { type: "plan:upgrade", reason: REASON, gate: "history_30d" } as const;
const JOINT_REFUSAL = "Upgrade cards can't be posted in a shared channel: upgrading is for this server's own people. Post it in one of this server's channels or a DM instead.";

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@test.invalid`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

/**
 * A leftover `agent_upgrade_card` row turned off, as Feature Flag Admin could
 * still hold it, with the cooldown variant it once read: the retired flag
 * must change nothing.
 */
async function seedRetiredFlagRowOff(defaultVariant: string | null = null) {
  await getDb().insert(featureFlags)
    .values({ key: "agent_upgrade_card", randomizationUnit: "server", salt: "test", defaultEnabled: false, enabled: false, killSwitch: true, defaultVariant })
    .onConflictDoUpdate({ target: featureFlags.key, set: { enabled: false, defaultEnabled: false, killSwitch: true, defaultVariant } });
}

async function setPlan(serverId: string, plan: "free" | "pro") {
  await getDb().update(servers).set({ plan }).where(eq(servers.id, serverId));
}

async function seedWorld() {
  const owner = await seedUser("upgrade-owner");
  const server = await createServer("Upgrade Cards", `upgrade-cards-${randomUUID().slice(0, 8)}`, owner.id);
  const agent = await createAgent(server.id, "upgrade-scout", { runtime: "claude" });
  const room = await channelService.createChannel(server.id, `upgrade-room-${randomUUID().slice(0, 6)}`);
  const other = await channelService.createChannel(server.id, `upgrade-other-${randomUUID().slice(0, 6)}`);
  for (const channel of [room, other]) {
    await channelService.addHuman(channel.id, owner.id);
    await channelService.addAgent(channel.id, agent.id);
  }
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read", "tasks"], name: "upgrade-card", issuedVia: "computer", createdByUserId: null });
  return { owner, server, agent, room, other, apiKey };
}

async function prepare(baseUrl: string, apiKey: string, target: string, action: Record<string, unknown> = UPGRADE) {
  return fetch(`${baseUrl}/internal/agent-api/prepare-action`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({ target, action }),
  });
}

type Prepared = { messageId: string; metadata: ActionCardMetadata; existing?: boolean };

async function prepared(response: Response, status: number): Promise<Prepared> {
  assert.equal(response.status, status, await response.clone().text());
  return await response.json() as Prepared;
}

async function codeOf(response: Response): Promise<string | undefined> {
  const body = await response.json() as { code?: string; errorCode?: string };
  return body.code ?? body.errorCode;
}

/**
 * A card prepareActionCard refused (the Agent API body leaves the card to it):
 * 400 INVALID_ACTION, `error` naming each field as `path: reason`; returns
 * those pairs.
 */
async function cardIssues(response: Response): Promise<Array<{ path: string; message: string }>> {
  assert.equal(response.status, 400, await response.clone().text());
  const body = await response.json() as { error: string; errorCode?: string };
  assert.equal(body.errorCode, "INVALID_ACTION", body.error);
  const fields = /^The action card failed validation: (.*)\.$/su.exec(body.error)?.[1];
  assert.ok(fields !== undefined, body.error);
  return fields.split("; ").map((pair) => {
    const at = pair.indexOf(": ");
    return { path: pair.slice(0, at), message: pair.slice(at + 2) };
  });
}

/** A schema message as an issue reason shows it (no trailing period). */
const reason = (message: string) => message.trim().replace(/\.+$/u, "");

async function upgradeCardCount(serverId: string): Promise<number> {
  return (await getDb().select().from(actionCards).where(and(eq(actionCards.serverId, serverId), eq(actionCards.actionType, "plan:upgrade")))).length;
}

const HOUR_MS = 60 * 60 * 1000;
const COOLDOWN_REFUSAL = "An upgrade card was already offered in this conversation in the last 14 days: don't offer another; say in the conversation what the limit is and why, without a card.";
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Pins a posted card's `created_at` to 09:30 UTC on the day the database
 * stamped it, so the dates the refusal gives are known; returns that time.
 */
async function pinCardTime(messageId: string): Promise<Date> {
  const db = getDb();
  const [card] = await db.select({ createdAt: actionCards.createdAt }).from(actionCards).where(eq(actionCards.messageId, messageId));
  const at = new Date(Math.floor(card!.createdAt.getTime() / DAY_MS) * DAY_MS + 9.5 * HOUR_MS);
  await db.update(actionCards).set({ createdAt: at }).where(eq(actionCards.messageId, messageId));
  return at;
}

/** The cooldown refusal's next action for a card offered at `offeredAt` (not midnight) with a cooldown of `days`: another may come from the day after it ends. */
function cooldownNextAction(offeredAt: Date, days: number): string {
  const offeredDay = Math.floor(offeredAt.getTime() / DAY_MS) * DAY_MS;
  return `An upgrade card was already offered here on ${isoDay(offeredDay)}. Don't offer another before ${isoDay(offeredDay + (days + 1) * DAY_MS)}; say in the conversation what the limit is and why, without a card.`;
}

type Refusal = { error?: string; errorCode?: string; suggestedNextAction?: string; retryable?: unknown; details?: unknown };

async function refused(response: Response, status: number): Promise<Refusal> {
  assert.equal(response.status, status, await response.clone().text());
  return await response.json() as Refusal;
}

/** The app's clock (currentDate) at `at`; the database's stays real. */
async function at<T>(time: Date, work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(time);
  try {
    return await work();
  } finally {
    vi.useRealTimers();
  }
}

test("upgrade cards are refused on a server that already pays", async ({ app }) => {
  const { server, room, apiKey } = await seedWorld();

  await setPlan(server.id, "pro");
  const paid = await prepare(app.baseUrl, apiKey, `#${room.name}`);
  assert.equal(paid.status, 409, await paid.clone().text());
  const body = await paid.json() as { error: string; errorCode: string };
  assert.equal(body.errorCode, "ALREADY_PRO");
  assert.equal(body.error, "This server is no longer on the Free plan; no upgrade card needed.");
  assert.equal(await upgradeCardCount(server.id), 0);

  // Strict: besides the reason and the gate, nothing rides the card. The
  // Server checks it (prepareActionCard), whatever the client knows.
  await setPlan(server.id, "free");
  const withText = await prepare(app.baseUrl, apiKey, `#${room.name}`, { ...UPGRADE, draftHint: "Pro is great" });
  // It says why, not only `Unrecognized key: "draftHint"`.
  assert.deepEqual(await cardIssues(withText), [{ path: "draftHint", message: reason(PLAN_UPGRADE_EXTRA_FIELDS_MESSAGE) }]);
  // The reason is required: one sentence of at most 200 characters.
  for (const action of [{ type: "plan:upgrade", gate: "history_30d" }, { ...UPGRADE, reason: "x".repeat(201) }]) {
    const noReason = await prepare(app.baseUrl, apiKey, `#${room.name}`, action);
    assert.deepEqual(await cardIssues(noReason), [{ path: "reason", message: reason(PLAN_UPGRADE_REASON_MESSAGE) }]);
  }
  // The hint's placeholder, posted as is, is refused.
  const placeholder = await prepare(app.baseUrl, apiKey, `#${room.name}`, { ...UPGRADE, reason: "<one sentence: why they need the older messages>" });
  assert.deepEqual(await cardIssues(placeholder), [{ path: "reason", message: reason(PLAN_UPGRADE_REASON_PLACEHOLDER_MESSAGE) }]);
  assert.equal(await upgradeCardCount(server.id), 0);
});

test("upgrade cards are refused in a shared channel and in its threads, saying why and where to post instead", async ({ app }) => {
  const { owner, server, agent, room, apiKey } = await seedWorld();
  const peer = await createServer("Upgrade Peer", `upgrade-peer-${randomUUID().slice(0, 8)}`, owner.id);
  const joint = await seedJointChannel({ name: `upgrade-joint-${randomUUID().slice(0, 6)}`, serverIds: [server.id, peer.id], createdByUserId: owner.id });
  const local = joint.projections[0]!;
  await channelService.addHuman(local.id, owner.id);
  await channelService.addAgent(local.id, agent.id);
  const root = await createMessage(joint.canonical.id, "user", owner.id, "Can we see last quarter's notes?");

  for (const target of [`#${local.name}`, `#${local.name}:${root.id.slice(0, 8)}`]) {
    for (const action of [UPGRADE, { type: "plan:upgrade", reason: REASON }]) {
      const refused = await prepare(app.baseUrl, apiKey, target, action);
      assert.equal(refused.status, 403, `${target}: ${await refused.clone().text()}`);
      const body = await refused.json() as { error: string; errorCode: string; suggestedNextAction?: string };
      assert.equal(body.errorCode, "JOINT_CHANNEL_NOT_ALLOWED", target);
      assert.equal(body.error, JOINT_REFUSAL, target);
      // raft-sdk shows the next action, never `error`: the same words reach hosted agents.
      assert.equal(body.suggestedNextAction, JOINT_REFUSAL, target);
    }
  }
  assert.equal(await upgradeCardCount(server.id), 0);
  const posted = await getDb().select().from(messages).where(eq(messages.channelId, joint.canonical.id));
  assert.deepEqual(posted.map((row) => row.id), [root.id], "nothing posted in the shared conversation");

  // This server's own channel still takes it.
  await prepared(await prepare(app.baseUrl, apiKey, `#${room.name}`), 201);
});

test("an app's bot cannot offer an upgrade card", async ({ app }) => {
  const { owner, server, room } = await seedWorld();
  const client = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `upgrade-bot-${randomUUID().slice(0, 8)}`,
    name: "Upgrade Bot App",
    enableBot: true,
  });
  const [install] = await getDb().insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.client.id,
    installedByUserId: owner.id,
    status: "active",
    botGrant: "granted",
  }).returning();
  const bot = await getDb().transaction((tx) => createManagedAppBot(tx, { installId: install!.id, serverId: server.id }));
  await channelService.addAgent(room.id, bot.agentId);
  const { apiKey } = await mintAgentCredential({ agentId: bot.agentId, scopes: ["send", "read", "tasks"], name: "upgrade-bot", issuedVia: "computer", createdByUserId: null });

  const refused = await prepare(app.baseUrl, apiKey, `#${room.name}`);
  assert.equal(refused.status, 403, await refused.clone().text());
  assert.equal(await codeOf(refused), "AGENT_ONLY");
  assert.equal(await upgradeCardCount(server.id), 0);
});

test("a repeat for the same conversation and gate within a day answers with the card already there", async ({ app }) => {
  const db = getDb();
  const { server, room, apiKey } = await seedWorld();

  const first = await prepared(await prepare(app.baseUrl, apiKey, `#${room.name}`), 201);
  assert.deepEqual(first.metadata.action, UPGRADE, "the agent's reason rides the card");
  assert.equal(first.metadata.presentation?.title, "Upgrade to Pro");
  assert.equal(first.existing, undefined);
  const [carrier] = await db.select().from(messages).where(eq(messages.id, first.messageId));
  assert.equal(carrier!.content, "Upgrade to Pro", "previews and notifications get the neutral title");

  // (b) Same conversation, same gate: nothing new, the posted card comes back flagged (the cooldown doesn't refuse it).
  const repeat = await prepared(await prepare(app.baseUrl, apiKey, `#${room.name}`), 200);
  assert.equal(repeat.messageId, first.messageId);
  assert.equal(repeat.existing, true);
  assert.equal(repeat.metadata.kind, "action-card");
  assert.deepEqual(repeat.metadata.action, UPGRADE);
  assert.equal(await upgradeCardCount(server.id), 1);

  // No gate: an upgrade no specific limit asks for, deduped as `general`.
  const { room: generalRoom, apiKey: generalKey, server: generalServer } = await seedWorld();
  const general = await prepared(await prepare(app.baseUrl, generalKey, `#${generalRoom.name}`, { type: "plan:upgrade", reason: "Your team keeps hitting Free limits." }), 201);
  assert.deepEqual(general.metadata.action, { type: "plan:upgrade", reason: "Your team keeps hitting Free limits." });
  assert.equal(general.metadata.presentation?.title, "Upgrade to Pro");
  const generalAgain = await prepared(await prepare(app.baseUrl, generalKey, `#${generalRoom.name}`, { type: "plan:upgrade", reason: "Another sentence.", gate: "general" }), 200);
  assert.equal(generalAgain.messageId, general.messageId);
  assert.equal(generalAgain.existing, true);
  assert.equal(await upgradeCardCount(generalServer.id), 1);
});

// #proj-analytics:42bee8a8: the request span names the card type, so
// plan:upgrade attempts and their refusal codes (error_code) can be counted.
// A type Raft doesn't know is `other`, never what the agent sent.
test("the prepare request's span names the card type, refused or not", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const prepareSpans = () => sink.getAllSpans().filter((span) =>
    span.name === "server.http.request" && span.attrs?.route_pattern === "/internal/agent-api/prepare-action");
  let seen = 0;
  const traced = async (response: Response, status: number) => {
    assert.equal(response.status, status, await response.clone().text());
    seen += 1;
    await vi.waitFor(() => assert.equal(prepareSpans().length, seen));
    const attrs = prepareSpans()[seen - 1]!.attrs ?? {};
    return [attrs.action_type, attrs.error_code];
  };
  const { server, agent, room, apiKey } = await seedWorld();

  await setPlan(server.id, "pro");
  assert.deepEqual(await traced(await prepare(app.baseUrl, apiKey, `#${room.name}`), 409), ["plan:upgrade", "already_pro"]);
  await setPlan(server.id, "free");
  assert.deepEqual(await traced(await prepare(app.baseUrl, apiKey, `#${room.name}`, { ...UPGRADE, type: " plan:upgrade " }), 201), ["plan:upgrade", undefined]);
  // Refused by the body check (no target), by the card check (a type Raft
  // doesn't know: `other`, never the text) and, ahead of both, by the
  // credential's capabilities.
  assert.deepEqual(await traced(await prepare(app.baseUrl, apiKey, " "), 400), ["plan:upgrade", "agent_api_contract_invalid"]);
  assert.deepEqual(await traced(await prepare(app.baseUrl, apiKey, `#${room.name}`, { type: "made-up:type", reason: REASON }), 400), ["other", "invalid_action"]);
  const { apiKey: noTasks } = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "upgrade-card-no-tasks", issuedVia: "computer", createdByUserId: null });
  assert.deepEqual(await traced(await prepare(app.baseUrl, noTasks, `#${room.name}`), 403), ["plan:upgrade", "capability_not_authorized"]);
});

test("after an agent's upgrade card, the conversation gets no other one for 14 days, of any gate; another conversation is unaffected", async ({ app }) => {
  const { owner, server, agent, room, other, apiKey } = await seedWorld();
  // A leftover agent_upgrade_card row, off: the card is offered all the same.
  await seedRetiredFlagRowOff();
  const first = await prepared(await prepare(app.baseUrl, apiKey, `#${room.name}`), 201);
  const offeredAt = await pinCardTime(first.messageId);
  const nextAction = cooldownNextAction(offeredAt, 14);

  // (a) Another gate, or none, in the same conversation: refused, saying when and what to do instead.
  for (const action of [{ ...UPGRADE, gate: "upload_file_size" }, { type: "plan:upgrade", reason: REASON }]) {
    const body = await refused(await prepare(app.baseUrl, apiKey, `#${room.name}`, action), 409);
    assert.deepEqual(body, { error: COOLDOWN_REFUSAL, errorCode: "UPGRADE_CARD_COOLDOWN", suggestedNextAction: nextAction }, "no retryable, no details");
    assert.doesNotMatch(body.suggestedNextAction ?? "", /raft action prepare/);
  }
  // (b) The same gate within the day is still the card already there.
  const repeat = await prepared(await prepare(app.baseUrl, apiKey, `#${room.name}`), 200);
  assert.equal(repeat.messageId, first.messageId);
  assert.equal(repeat.existing, true);
  assert.equal(await upgradeCardCount(server.id), 1);

  // (e) Another channel, a thread of this one, a DM: each its own conversation.
  await prepared(await prepare(app.baseUrl, apiKey, `#${other.name}`, { ...UPGRADE, gate: "upload_file_size" }), 201);
  const root = await createMessage(room.id, "user", owner.id, "Can we see last quarter's notes?");
  await prepared(await prepare(app.baseUrl, apiKey, `#${room.name}:${root.id.slice(0, 8)}`), 201);
  const dm = await channelService.findOrCreateDM(server.id, owner.id, agent.id);
  assert.ok(dm);
  await prepared(await prepare(app.baseUrl, apiKey, `dm:@${owner.name}`), 201);
  assert.equal(await upgradeCardCount(server.id), 4);
});

test("the same gate after a day but inside the cooldown is refused; after the cooldown a new card starts the next one", async ({ app }) => {
  const db = getDb();
  const { server, room, apiKey } = await seedWorld();
  const first = await prepared(await prepare(app.baseUrl, apiKey, `#${room.name}`), 201);
  const offeredAt = await pinCardTime(first.messageId);

  // (c) The same gate after the day (it used to post a fresh card): refused.
  await at(new Date(offeredAt.getTime() + 2 * DAY_MS), async () => {
    const body = await refused(await prepare(app.baseUrl, apiKey, `#${room.name}`), 409);
    assert.deepEqual(body, { error: COOLDOWN_REFUSAL, errorCode: "UPGRADE_CARD_COOLDOWN", suggestedNextAction: cooldownNextAction(offeredAt, 14) });
  });
  await at(new Date(offeredAt.getTime() + 14 * DAY_MS - 60_000), async () => {
    assert.equal((await refused(await prepare(app.baseUrl, apiKey, `#${room.name}`, { ...UPGRADE, gate: "agent_migration" }), 409)).errorCode, "UPGRADE_CARD_COOLDOWN", "a minute before it ends");
  });
  assert.equal(await upgradeCardCount(server.id), 1);

  // (d) After the cooldown: a new card, which starts the next one.
  const later = new Date(offeredAt.getTime() + 14 * DAY_MS + 60_000);
  await at(later, async () => {
    const next = await prepared(await prepare(app.baseUrl, apiKey, `#${room.name}`, { ...UPGRADE, gate: "upload_monthly_quota" }), 201);
    assert.notEqual(next.messageId, first.messageId);
    await db.update(actionCards).set({ createdAt: later }).where(eq(actionCards.messageId, next.messageId));
    const body = await refused(await prepare(app.baseUrl, apiKey, `#${room.name}`), 409);
    assert.match(body.suggestedNextAction ?? "", new RegExp(`offered here on ${isoDay(later.getTime())}\\.`));
  });
  assert.equal(await upgradeCardCount(server.id), 2);
});

test("a deleted upgrade card still holds its conversation's cooldown", async ({ app }) => {
  const db = getDb();
  const { server, room, apiKey } = await seedWorld();
  const first = await prepared(await prepare(app.baseUrl, apiKey, `#${room.name}`), 201);
  const offeredAt = await pinCardTime(first.messageId);
  await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, first.messageId));

  // (f) Not the deleted card back, and no fresh one: the same gate and another are both refused.
  for (const action of [UPGRADE, { ...UPGRADE, gate: "upload_file_size" }]) {
    const body = await refused(await prepare(app.baseUrl, apiKey, `#${room.name}`, action), 409);
    assert.equal(body.errorCode, "UPGRADE_CARD_COOLDOWN");
    assert.equal(body.suggestedNextAction, cooldownNextAction(offeredAt, 14));
  }
  assert.equal(await upgradeCardCount(server.id), 1);
});

test("the cooldown is 14 days whatever cooldown_days variant a leftover flag row still carries", async ({ app }) => {
  const { room, apiKey } = await seedWorld();
  // The retired flag's variant once tuned the cooldown (`cooldown_days:<n>`); production never set one, and it is read no more.
  await seedRetiredFlagRowOff("cooldown_days:3");
  const first = await prepared(await prepare(app.baseUrl, apiKey, `#${room.name}`), 201);
  const offeredAt = await pinCardTime(first.messageId);
  await at(new Date(offeredAt.getTime() + 3 * DAY_MS + 60_000), async () => {
    const body = await refused(await prepare(app.baseUrl, apiKey, `#${room.name}`), 409);
    assert.deepEqual(body, { error: COOLDOWN_REFUSAL, errorCode: "UPGRADE_CARD_COOLDOWN", suggestedNextAction: cooldownNextAction(offeredAt, 14) });
  });
});

test("an upgrade card has no server action: execute and mark-executed are refused", async ({ app }) => {
  const db = getDb();
  const { owner, server, room, apiKey } = await seedWorld();
  const { messageId } = await prepared(await prepare(app.baseUrl, apiKey, `#${room.name}`), 201);
  const token = await tokenForHuman(owner.email);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": server.id };

  const executed = await fetch(`${app.baseUrl}/api/actions/${messageId}/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedState: "prepared" }),
  });
  assert.equal(executed.status, 409, await executed.clone().text());
  assert.equal(await codeOf(executed), "NOT_EXECUTABLE");
  const marked = await fetch(`${app.baseUrl}/api/actions/${messageId}/mark-executed`, {
    method: "POST",
    headers,
    body: JSON.stringify({ result: { kind: "channel", id: randomUUID(), name: "pro" } }),
  });
  assert.equal(marked.status, 409, await marked.clone().text());
  assert.equal(await codeOf(marked), "NOT_EXECUTABLE");

  const [card] = await db.select().from(actionCards).where(eq(actionCards.messageId, messageId));
  assert.equal(card!.state, "prepared");
  const [carrier] = await db.select().from(messages).where(eq(messages.id, messageId));
  assert.equal((carrier!.actionMetadata as ActionCardMetadata).state, "prepared");
});

test("agentUpgradeCardHint offers the card only while the server is on Free and the conversation is not shared", async ({ db }) => {
  void db;
  const { owner, server, agent, room } = await seedWorld();
  const client = { capabilities: `${MANUAL_CONTEXT_CAPABILITY},${PLAN_UPGRADE_CARD_CAPABILITY}`, agentId: agent.id };
  const input = { serverId: server.id, gate: "history_30d" as const, target: "#general", channelId: room.id, client };

  // A leftover agent_upgrade_card row, off, changes nothing.
  await seedRetiredFlagRowOff();
  assert.equal(
    await agentUpgradeCardHint(input),
    `If someone here needs these older messages, you can offer an upgrade card: pipe {"type":"plan:upgrade","gate":"history_30d","reason":"<one sentence: why they need the older messages>"} into raft action prepare --target "#general" (a heredoc, as with raft message send).`,
  );
  // An upload a Free limit refused: the next action outright, with the command to run once the reason is written.
  assert.equal(
    await agentUpgradeCardHint({ ...input, gate: "upload_file_size", target: "dm:@alice" }),
    [
      `The file was not uploaded: this server is on the Free plan and the file is over the Free plan's per-file limit. Pro would take it. Say in the conversation that the file wasn't uploaded and why, then offer an upgrade card unless that is clearly out of place here (put what the file is for in place of the <…>):`,
      `raft action prepare --target "dm:@alice" <<'RAFTACTION'`,
      `{"type":"plan:upgrade","gate":"upload_file_size","reason":"<one sentence: what the file is for>"}`,
      `RAFTACTION`,
    ].join("\n"),
  );
  assert.equal(
    await agentUpgradeCardHint({ ...input, gate: "upload_monthly_quota" }),
    [
      `The file was not uploaded: this server is on the Free plan and has used this month's upload allowance. Pro would take it. Say in the conversation that the file wasn't uploaded and why, then offer an upgrade card unless that is clearly out of place here (put what the file is for in place of the <…>):`,
      `raft action prepare --target "#general" <<'RAFTACTION'`,
      `{"type":"plan:upgrade","gate":"upload_monthly_quota","reason":"<one sentence: what the file is for>"}`,
      `RAFTACTION`,
    ].join("\n"),
  );

  // A shared channel or a thread of one: prepare would refuse the card there, so no hint.
  const peer = await createServer("Hint Peer", `hint-peer-${randomUUID().slice(0, 8)}`, owner.id);
  const joint = await seedJointChannel({ name: `hint-joint-${randomUUID().slice(0, 6)}`, serverIds: [server.id, peer.id], createdByUserId: owner.id });
  const local = joint.projections[0]!;
  await channelService.addHuman(local.id, owner.id);
  await channelService.addAgent(local.id, agent.id);
  const root = await createMessage(joint.canonical.id, "user", owner.id, "Older notes?");
  const jointThread = await channelService.getOrCreateThreadForChannel(local.id, root.id, agent.id, "agent");
  assert.notEqual(jointThread.id, jointThread.canonicalThreadChannelId, "a local face of the joint thread");
  assert.equal(await agentUpgradeCardHint({ ...input, target: `#${local.name}`, channelId: local.id }), null, "joint channel");
  assert.equal(await agentUpgradeCardHint({ ...input, target: `#${local.name}:${root.id.slice(0, 8)}`, channelId: jointThread.id }), null, "joint thread");
  // A thread of this server's own channel still gets it.
  const ownRoot = await createMessage(room.id, "user", owner.id, "Older notes here?");
  const ownThread = await channelService.getOrCreateThreadForChannel(room.id, ownRoot.id, agent.id, "agent");
  assert.ok(await agentUpgradeCardHint({ ...input, target: `#${room.name}:${ownRoot.id.slice(0, 8)}`, channelId: ownThread.id }));

  // A client that can't post the card (no declaration, no known Computer): no hint.
  assert.equal(await agentUpgradeCardHint({ ...input, client: { capabilities: MANUAL_CONTEXT_CAPABILITY, agentId: agent.id } }), null, "an older client");

  await setPlan(server.id, "pro");
  assert.equal(await agentUpgradeCardHint(input), null, "a paid server needs no upgrade card");
});

test("agentUpgradeCardHint offers no card in a conversation in its cooldown, whatever the gate", async ({ db }) => {
  void db;
  const { server, agent, room, other } = await seedWorld();
  const client = { capabilities: `${MANUAL_CONTEXT_CAPABILITY},${PLAN_UPGRADE_CARD_CAPABILITY}`, agentId: agent.id };
  const input = { serverId: server.id, gate: "history_30d" as const, target: `#${room.name}`, channelId: room.id, client };
  assert.ok(await agentUpgradeCardHint(input), "before any card");

  const card = await prepareActionCard({ serverId: server.id, requesterAgentId: agent.id, targetChannelId: room.id, action: { ...UPGRADE, gate: "upload_file_size" } });
  // (g) Prepare would refuse another card there, so the hint says nothing.
  for (const gate of ["history_30d", "upload_monthly_quota", "upload_file_size"] as const) {
    assert.equal(await agentUpgradeCardHint({ ...input, gate }), null, gate);
  }
  assert.ok(await agentUpgradeCardHint({ ...input, target: `#${other.name}`, channelId: other.id }), "another conversation");
  // Deleted, the card still holds it; after the cooldown the hint is back.
  await getDb().update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, card.messageId));
  assert.equal(await agentUpgradeCardHint(input), null, "deleted card");
  await getDb().update(actionCards).set({ createdAt: new Date(Date.now() - 14 * DAY_MS - 60_000) }).where(eq(actionCards.messageId, card.messageId));
  assert.ok(await agentUpgradeCardHint(input), "after the cooldown");
});

test("a client can post an upgrade card when it declares so, or its agent's Computer last reported 1.0.53 or later", async ({ db }) => {
  void db;
  const { owner, server, agent } = await seedWorld();
  const undeclared = { capabilities: undefined, agentId: agent.id };
  assert.equal(await canClientPostUpgradeCard({ capabilities: PLAN_UPGRADE_CARD_CAPABILITY, agentId: agent.id }), true, "declared, no Computer");
  assert.equal(await canClientPostUpgradeCard(undeclared), false, "no declaration, no Computer");

  const { machine } = await registerMachine(server.id, owner.id, `hint-computer-${randomUUID().slice(0, 6)}`);
  await placeAgentOnMachine(agent.id, machine.id);
  assert.equal(await canClientPostUpgradeCard(undeclared), false, "a Computer that reported no version");
  for (const [version, capable] of [
    ["1.0.52", false],
    ["1.0.53-rc.1", false],
    ["1.0.53-staging.20261020120000.sha.abc1234", false],
    ["not-a-version", false],
    ["1.0.53", true],
    ["1.0.53+build.7", true],
    ["1.0.54-rc.1", true],
    ["1.1.0", true],
  ] as const) {
    await recordMachineComputerVersion(machine.id, version);
    assert.equal(await canClientPostUpgradeCard(undeclared), capable, version);
  }
  await recordMachineComputerVersion(machine.id, "1.0.52");
  assert.equal(await canClientPostUpgradeCard({ capabilities: `${MANUAL_CONTEXT_CAPABILITY},${PLAN_UPGRADE_CARD_CAPABILITY}`, agentId: agent.id }), true, "a declaration stands over an older Computer");
});

// No billing, no purchase card (Warden on #14428): a deployment without Stripe
// (self-hosted, dev) neither prepares an upgrade card nor offers one in a hint.
test("without billing set up, an upgrade card is refused, listed nowhere, and offered in no hint", async ({ app }) => {
  const { server, agent, room, apiKey } = await seedWorld();
  const client = { capabilities: `${MANUAL_CONTEXT_CAPABILITY},${PLAN_UPGRADE_CARD_CAPABILITY}`, agentId: agent.id };
  await withoutStripeBilling(async () => {
    const refusedCard = await prepare(app.baseUrl, apiKey, `#${room.name}`);
    assert.equal(refusedCard.status, 403, await refusedCard.clone().text());
    const body = await refusedCard.json() as { error: string; errorCode: string };
    assert.equal(body.errorCode, "FEATURE_DISABLED");
    assert.equal(body.error, "Upgrade cards are not available on this server: it has no billing set up.");
    assert.equal(await upgradeCardCount(server.id), 0);
    assert.equal(preparableActionCardTypes().includes("plan:upgrade"), false);
    assert.equal(await agentUpgradeCardHint({ serverId: server.id, gate: "history_30d", target: "#general", channelId: room.id, client }), null);
    assert.equal(await agentSearchUpgradeCardHint({ serverId: server.id, client }), null);
  });
  // The same server and client with billing: listed again, and both hints
  // offer the card (so the nulls above come from billing).
  assert.equal(preparableActionCardTypes().includes("plan:upgrade"), true);
  assert.match(await agentUpgradeCardHint({ serverId: server.id, gate: "history_30d", target: "#general", channelId: room.id, client }) ?? "", /raft action prepare --target "#general"/);
  assert.match(await agentSearchUpgradeCardHint({ serverId: server.id, client }) ?? "", /raft action prepare --target "<their conversation>"/);
});
