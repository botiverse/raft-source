import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";
import type { AgentApiMessageEnvelope, MessageCardInput, MessageCardMetadata, MessageCardReadAnswer } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { seedJointChannel } from "../test/integration/jointFixture";
import { getDb, type Database } from "../db";
import {
  agents, channelHumans, channels, jointChannels, jointChannelServers, linkCardOperations, messageCardRevisions, messageMentions, messages, oauthAppLinkPreviews, oauthClients, oauthLinkPreviewDeclines,
  oauthUserConsents, officialAppRegistry, serverMembers, servers, users,
} from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { __setAgentSendRaceHooksForTests } from "../services/agentSendReplayService";
import { __setPreviewHttpForTests, __settleAppLinkPreviewRechecksForTests } from "../services/appLinkPreviewService";
import { __setAppSubjectMappingForTests } from "../services/appSubjectService";
import { addAgent, addHuman, createChannel, getOrCreateThreadForChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { __resetLinkCardActionLimitsForTests } from "../services/linkCardActionLimits";
import { __setLinkCardActionHooksForTests } from "../services/linkCardActionService";
import { __observeLinkCardLiveStateForTests } from "../services/linkCardLiveState";
import { __resetLinkCardReadBudgetForTests } from "../services/linkCardReadService";
import { linkCardUrlSha256, signLinkCardHandle, verifyLinkCardHandle } from "../services/linkCardTokens";
import { __setMessageCardActionsSendLimitForTests } from "../services/messageCardActionService";
import { __resetMessageCardUpdateLimitsForTests } from "../services/messageCardService";
import { addMember } from "../services/serverService";
import { appAnswer, appBotFixture, clientRequestId, handleFor, post, statusOf, stubApp, type AppBotFixture } from "../test/linkCardActionFixture";

// RFC 086 step 1: an App's bot sends a card message whose buttons act
// through the App's action endpoint (RFC 076), optionally for one person.
// Send and update (§4.1), the per-App send limit (§4.5), the per-viewer
// handle read (§4.2) and execute's re-checks at admission and under its
// locks (§4.2), everything after the handle being RFC 076's.
const test = createApiTest();
const originalKey = process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY;
const originalOfficialServer = process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
beforeEach(() => {
  process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});
afterEach(async () => {
  await __settleAppLinkPreviewRechecksForTests();
  __setPreviewHttpForTests(null);
  __setLinkCardActionHooksForTests(null);
  __observeLinkCardLiveStateForTests(null);
  __resetLinkCardActionLimitsForTests();
  __resetLinkCardReadBudgetForTests();
  __resetMessageCardUpdateLimitsForTests();
  __setMessageCardActionsSendLimitForTests(null);
  __setAppSubjectMappingForTests(null);
  __setAgentSendRaceHooksForTests({});
  for (const [name, value] of [["RAFT_OIDC_SIGNING_PRIVATE_KEY", originalKey], ["RAFT_OFFICIAL_PUBLISHER_SERVER_ID", originalOfficialServer]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

const DISABLED_REASON = "Update Raft to use this button";
const ACTIONS = {
  approve: { kind: "execute", action_id: "approve", confirm: "prepare" },
  deny: { kind: "execute", action_id: "deny", undoWindowMs: 5000 },
} as const;

/** A Vault-like access request: Approve / Deny act, Open only navigates; every button's page is on the App's origin. */
function requestCard(fx: { origin: string }, pageOrigin = fx.origin): MessageCardInput {
  const page = `${pageOrigin}/requests/42`;
  return {
    version: 1,
    header: { title: "Access request: deploy key" },
    root: "root",
    elements: {
      root: { type: "Stack", props: {}, children: ["what", "row"] },
      what: { type: "Text", props: { text: "builder-bot asks to use the deploy key until 18:00 UTC." } },
      row: { type: "Stack", props: { direction: "row" }, children: ["approve", "deny", "open"] },
      approve: { type: "Button", props: { label: "Approve", action: { kind: "navigate", url: page } } },
      deny: { type: "Button", props: { label: "Deny", variant: "ghost", action: { kind: "navigate", url: page } } },
      open: { type: "Button", props: { label: "Open in Vault", action: { kind: "navigate", url: page } } },
    },
  };
}

type Answer = { status: number; body: Record<string, any>; headers: Headers };
async function agentCall(baseUrl: string, key: string, method: "POST" | "PUT", path: string, body: unknown): Promise<Answer> {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, any>, headers: res.headers };
}
const send = (baseUrl: string, fx: AppBotFixture, body: Record<string, unknown>, key = fx.botKey) =>
  agentCall(baseUrl, key, "POST", "/v2/send", { target: `#${fx.channel.name}`, ...body });
const update = (baseUrl: string, fx: AppBotFixture, messageId: string, body: Record<string, unknown>) =>
  agentCall(baseUrl, fx.botKey, "PUT", `/messages/${messageId}/card`, body);

type Person = { id: string; name: string; displayName: string | null; headers: Record<string, string> };
/**
 * A member of the fixture's Server (a guest of `channelId` when `guest`), in
 * each of `channels`, who agreed to the App learning who they are (the
 * per-App consent link cards use; `consent: false`: never asked).
 */
async function person(db: Database, seed: Parameters<typeof appBotFixture>[1], fx: AppBotFixture, options: { guest?: boolean; channels?: string[]; consent?: boolean } = {}): Promise<Person> {
  const human = await seed.human();
  await addMember(fx.server.id, human.id);
  for (const channelId of options.channels ?? [fx.channel.id]) await addHuman(channelId, human.id);
  if (options.consent !== false) {
    await db.insert(oauthUserConsents).values({ serverId: fx.server.id, userId: human.id, clientId: fx.client.id, scopes: ["openid", "profile"] });
  }
  if (options.guest) {
    await db.update(serverMembers).set({ role: "guest", guestChannelId: fx.channel.id })
      .where(and(eq(serverMembers.serverId, fx.server.id), eq(serverMembers.userId, human.id)));
  }
  const headers = { Authorization: `Bearer ${await tokenForHuman(human.email)}`, "X-Server-Id": fx.server.id, "Content-Type": "application/json" };
  return { id: human.id, name: human.name, displayName: human.displayName, headers };
}

async function readCard(baseUrl: string, viewer: { headers: Record<string, string> }, messageId: string, capabilities: string[] = ["card.execute.v1"]) {
  const res = await fetch(`${baseUrl}/api/messages/${messageId}/link-cards/read`, {
    method: "POST", headers: viewer.headers, body: JSON.stringify({ view_instance_id: randomUUID(), capabilities, locale: "en" }),
  });
  const body = await res.json() as { items: unknown[]; prompts: unknown[]; message_card?: MessageCardReadAnswer };
  return { status: res.status, body };
}

const metadataOf = async (db: Database, messageId: string) =>
  (await db.select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, messageId)))[0]!.actionMetadata as MessageCardMetadata;
const botMessageCount = async (db: Database, fx: AppBotFixture) => (await db.select({ id: messages.id }).from(messages).where(eq(messages.senderId, fx.botId))).length;
const actionCalls = (calls: ReturnType<typeof stubApp>) => calls.filter((call) => call.body.phase === "prepare" || call.body.phase === "execute");

test("send: stored with actions and for beside a card every client reads; for is mentioned (appended once) and notified; agents read the acting buttons", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const alice = await person(db, seed, fx);
  const sent = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, for: alice.id, content: "Vault: builder-bot asks to use the deploy key" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(sent.body.messageCard, { revision: 1 });

  const [row] = await db.select().from(messages).where(eq(messages.id, sent.body.messageId));
  assert.equal(row!.content, `Vault: builder-bot asks to use the deploy key\n\n@${alice.name}`, "Raft appends the mention of for");
  const metadata = row!.actionMetadata as MessageCardMetadata;
  assert.equal(metadata.kind, "message-card");
  assert.equal(metadata.revision, 1);
  assert.deepEqual(metadata.actions, ACTIONS);
  assert.equal(metadata.for, alice.id);
  const button = (id: string) => metadata.card.elements[id] as { type: "Button"; props: { disabledReason?: string; action: { url: string } } };
  assert.equal(button("approve").props.disabledReason, DISABLED_REASON);
  assert.equal(button("deny").props.disabledReason, DISABLED_REASON);
  assert.equal(button("open").props.disabledReason, undefined, "a navigate button stays as sent");
  assert.equal(button("approve").props.action.url, `${fx.origin}/requests/42`, "the fallback page is the stored navigate URL");
  const [revision] = await db.select().from(messageCardRevisions).where(eq(messageCardRevisions.messageId, row!.id));
  assert.deepEqual(revision!.card, metadata.card);

  // The mention notifies as any mention does.
  const mentions = await db.select().from(messageMentions).where(eq(messageMentions.messageId, row!.id));
  assert.deepEqual(mentions.map((mention) => [mention.targetType, mention.targetId]), [["user", alice.id]]);

  // Agents read the card itself: the acting buttons in Raft, for @alice.
  const history = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(`#${fx.channel.name}`)}&consume=false`, {
    headers: { Authorization: `Bearer ${fx.botKey}` },
  });
  const read = (await history.json() as { messages: AgentApiMessageEnvelope[] }).messages.find((message) => message.id === row!.id)!;
  assert.match(read.message_card?.text ?? "", new RegExp(`Approve \\(in Raft, for \`@${alice.name}\`\\) · Deny \\(in Raft, for \`@${alice.name}\`\\) · \\[Open in Vault\\]`));

  // Content that already mentions them gets nothing appended; no content: the derived fallback, then the mention.
  const mentioned = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, for: alice.id, content: `@${alice.name} please decide` });
  assert.equal((await db.select().from(messages).where(eq(messages.id, mentioned.body.messageId)))[0]!.content, `@${alice.name} please decide`);
  const derived = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, for: alice.id });
  assert.equal(derived.status, 200, JSON.stringify(derived.body));
  const derivedRow = (await db.select().from(messages).where(eq(messages.id, derived.body.messageId)))[0]!;
  assert.ok(derivedRow.content.endsWith(`\n\n@${alice.name}`), derivedRow.content);
  assert.match(derivedRow.content, /Approve \(in Raft\) · Deny \(in Raft\) · \[Open in Vault\]/, "the derived fallback reads the acting buttons as in Raft");
  assert.ok(!derivedRow.content.includes("Update Raft"), derivedRow.content);
  assert.equal((await db.select().from(messageMentions).where(eq(messageMentions.messageId, derivedRow.id))).length, 1);
  // Without for, anyone may press; nobody is mentioned.
  const open = await send(app.baseUrl, fx, { card: requestCard(fx), actions: { deny: ACTIONS.deny }, content: "Vault: one request" });
  assert.equal(open.status, 200, JSON.stringify(open.body));
  assert.equal((await metadataOf(db, open.body.messageId)).for, undefined);
});

test("send refusals: 400 message_card_actions_not_allowed and nothing stored", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const alice = await person(db, seed, fx);
  const guest = await person(db, seed, fx, { guest: true });
  const outsider = await seed.human();
  const privateChannel = await createChannel(fx.server.id, `private-${randomUUID().slice(0, 8)}`, undefined, "private");
  await addHuman(privateChannel.id, fx.owner.id);
  await addAgent(privateChannel.id, fx.botId);
  const ordinary = await createAgent(fx.server.id, `plain-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  await addAgent(fx.channel.id, ordinary.id);
  const ordinaryKey = (await mintAgentCredential({ agentId: ordinary.id, scopes: ["send", "read"], name: "plain", issuedVia: "computer", createdByUserId: null })).apiKey;
  const card = requestCard(fx);
  const cases: Array<[string, Record<string, unknown>, string?]> = [
    ["for is a guest", { card, actions: ACTIONS, for: guest.id }],
    ["for is an agent", { card, actions: ACTIONS, for: ordinary.id }],
    ["for is not on this Server", { card, actions: ACTIONS, for: outsider.id }],
    ["for can't read the conversation", { card, actions: ACTIONS, for: alice.id, target: `#${privateChannel.name}` }],
    ["for is not an id", { card, actions: ACTIONS, for: "alice" }],
    ["for without actions", { card, for: alice.id }],
    ["actions without a card", { content: "hi", actions: ACTIONS }],
    ["a key naming no Button", { card, actions: { what: ACTIONS.approve } }],
    ["a key naming no element", { card, actions: { nothing: ACTIONS.approve } }],
    ["an action that doesn't validate", { card, actions: { approve: { kind: "navigate", url: `${fx.origin}/x` } } }],
    ["a fallback page off the App's origin", { card: requestCard(fx, "https://elsewhere.example.test"), actions: ACTIONS }],
    ["a sender that is not an App's bot", { card, actions: ACTIONS }, ordinaryKey],
  ];
  for (const [why, body, key] of cases) {
    const before = await botMessageCount(db, fx);
    const refused = await send(app.baseUrl, fx, body, key ?? fx.botKey);
    assert.equal(refused.status, 400, `${why}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.code, "message_card_actions_not_allowed", why);
    assert.equal(refused.body.errorCode, "message_card_actions_not_allowed", `${why}: the refusal envelope`);
    assert.equal(await botMessageCount(db, fx), before, `${why}: nothing stored`);
  }
  assert.equal((await db.select().from(messages).where(eq(messages.senderId, ordinary.id))).length, 0);

  // The App without execute eligibility: no longer an approved official App, and (a shared App) nothing allowed on this Server.
  await db.update(officialAppRegistry).set({ status: "disabled" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  const ineligible = await send(app.baseUrl, fx, { card, actions: ACTIONS, for: alice.id });
  assert.equal(ineligible.status, 400, JSON.stringify(ineligible.body));
  assert.equal(ineligible.body.code, "message_card_actions_not_allowed");
  assert.match(ineligible.body.error, /can't run card actions on this Server now/);
  assert.equal(await botMessageCount(db, fx), 0);
  // The same card without actions is an ordinary card message.
  assert.equal((await send(app.baseUrl, fx, { card })).status, 200);
});

test("joint: a card with acting buttons is refused there, at send and at update", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const joint = await seedJointChannel({ name: `joint-${randomUUID().slice(0, 8)}`, serverIds: [fx.server.id], createdByUserId: fx.owner.id });
  const projection = joint.projections[0]!;
  await addHuman(projection.id, fx.owner.id);
  await addAgent(projection.id, fx.botId);
  const target = `#${projection.name}`;
  const refused = await send(app.baseUrl, fx, { target, card: requestCard(fx), actions: ACTIONS, content: "Vault: one request" });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "message_card_actions_not_allowed");
  assert.match(refused.body.error, /joint channel/);
  const plain = await send(app.baseUrl, fx, { target, card: requestCard(fx), content: "Vault: one request" });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  const updated = await update(app.baseUrl, fx, plain.body.messageId, { card: requestCard(fx), actions: ACTIONS });
  assert.equal(updated.status, 400, JSON.stringify(updated.body));
  assert.equal(updated.body.code, "message_card_actions_not_allowed");
  assert.equal((await metadataOf(db, plain.body.messageId)).revision, 1, "nothing changed");
});

test("an idempotent retry compares actions and for too; the per-App limit is 30 sends with actions a minute (429 + Retry-After), never spent by a replay", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const alice = await person(db, seed, fx);
  const bob = await person(db, seed, fx);
  const body = { card: requestCard(fx), actions: ACTIONS, for: alice.id, idempotencyKey: `vault-${randomUUID()}` };
  const first = await send(app.baseUrl, fx, body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const again = await send(app.baseUrl, fx, body);
  assert.equal(again.status, 200);
  assert.equal(again.body.messageId, first.body.messageId, "the same send answers the original message");
  for (const [why, changed] of [
    ["other actions", { ...body, actions: { ...ACTIONS, deny: { kind: "execute", action_id: "deny", undoWindowMs: 6000 } } }],
    ["no actions", { card: body.card, idempotencyKey: body.idempotencyKey }],
    ["another for", { ...body, for: bob.id }],
  ] as const) {
    const conflict = await send(app.baseUrl, fx, changed);
    assert.equal(conflict.status, 409, `${why}: ${JSON.stringify(conflict.body)}`);
    assert.equal(conflict.body.code, "idempotency_key_reused", why);
  }

  __setMessageCardActionsSendLimitForTests(2);
  for (let index = 0; index < 2; index += 1) assert.equal((await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS })).status, 200);
  const limited = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS });
  assert.equal(limited.status, 429, JSON.stringify(limited.body));
  assert.equal(limited.body.code, "RATE_LIMITED");
  assert.ok(Number(limited.headers.get("retry-after")) > 0, "Retry-After");
  assert.deepEqual({ operation: limited.body.details.operation, limit: limited.body.details.limit }, { operation: "messageSendV2", limit: 2 });
  assert.equal((await send(app.baseUrl, fx, body)).body.messageId, first.body.messageId, "a replay of a committed send still answers");
  assert.equal((await send(app.baseUrl, fx, { card: requestCard(fx) })).status, 200, "a card without actions spends nothing of it");
});

test("update: carrying actions runs every send check again; without actions the acting buttons end; for can't change", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const alice = await person(db, seed, fx);
  const bob = await person(db, seed, fx);
  const sent = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, for: alice.id, content: "Vault: one request" });
  const messageId = sent.body.messageId as string;

  const kept = await update(app.baseUrl, fx, messageId, { card: requestCard(fx), actions: { approve: ACTIONS.approve }, content: "Vault: one request" });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  let metadata = await metadataOf(db, messageId);
  assert.equal(metadata.revision, 2);
  assert.deepEqual(metadata.actions, { approve: ACTIONS.approve });
  assert.equal(metadata.for, alice.id, "for is the send's");
  assert.equal((metadata.card.elements.approve as { props: { disabledReason?: string } }).props.disabledReason, DISABLED_REASON);
  assert.equal((metadata.card.elements.deny as { props: { disabledReason?: string } }).props.disabledReason, undefined, "no longer acting");

  for (const [why, body] of [
    ["a key naming no Button", { card: requestCard(fx), actions: { what: ACTIONS.approve } }],
    ["another for", { card: requestCard(fx), actions: ACTIONS, for: bob.id }],
    ["a fallback page off the App's origin", { card: requestCard(fx, "https://elsewhere.example.test"), actions: ACTIONS }],
  ] as const) {
    const refused = await update(app.baseUrl, fx, messageId, body);
    assert.equal(refused.status, 400, `${why}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.code, "message_card_actions_not_allowed", why);
  }
  // The App lost its execute eligibility since the send.
  await db.update(officialAppRegistry).set({ status: "disabled" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  const ineligible = await update(app.baseUrl, fx, messageId, { card: requestCard(fx), actions: ACTIONS });
  assert.equal(ineligible.status, 400, JSON.stringify(ineligible.body));
  assert.equal(ineligible.body.code, "message_card_actions_not_allowed");
  assert.equal((await metadataOf(db, messageId)).revision, 2, "no refused update changed anything");

  // Without actions (the App says what happened): the acting buttons end, whatever the App's eligibility.
  const decided: MessageCardInput = { version: 1, root: "done", elements: { done: { type: "Text", props: { text: "Approved by Alice" } } } };
  const ended = await update(app.baseUrl, fx, messageId, { card: decided });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  metadata = await metadataOf(db, messageId);
  assert.equal(metadata.revision, 3);
  assert.ok(!("actions" in metadata), "no acting buttons");
  assert.equal(metadata.for, alice.id);
  assert.deepEqual((await readCard(app.baseUrl, alice, messageId)).body.message_card, { card_revision: "3", actions: [] });
});

test("handle read: none without card.execute.v1, none for anyone but for (who is named), none once the App can't act; one per acting button for them", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const alice = await person(db, seed, fx);
  const guest = await person(db, seed, fx, { guest: true });
  const sent = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, for: alice.id, content: "Vault: one request" });
  const messageId = sent.body.messageId as string;

  const withoutCapability = await readCard(app.baseUrl, alice, messageId, ["card.v2", "button.v1", "confirm.v1", "undo.v1"]);
  assert.equal(withoutCapability.status, 200);
  assert.deepEqual(withoutCapability.body, { items: [], prompts: [], message_card: { card_revision: "1", actions: [] } });

  const forAlice = await readCard(app.baseUrl, alice, messageId);
  assert.equal(forAlice.status, 200);
  const answer = forAlice.body.message_card!;
  assert.equal(answer.card_revision, "1");
  assert.equal(answer.app?.id, fx.client.id);
  assert.equal(answer.app?.reviewed, undefined, "an approved official App");
  assert.deepEqual(answer.actions.map((action) => [action.element_id, action.action_id, action.url]), [
    ["approve", "approve", `${fx.origin}/requests/42`], ["deny", "deny", `${fx.origin}/requests/42`],
  ]);
  assert.ok(answer.actions.every((action) => typeof action.handle === "string" && typeof action.ticket === "string"));
  assert.equal(answer.actions[0]!.ticket, answer.actions[1]!.ticket, "one view per fallback page");
  assert.equal(answer.waiting_for, undefined);

  // Anyone else: no handle, and who the card waits for.
  const owner = await readCard(app.baseUrl, fx, messageId);
  const ownerName = (await db.select({ name: users.name, displayName: users.displayName }).from(users).where(eq(users.id, alice.id)))[0]!;
  assert.deepEqual(owner.body.message_card, { card_revision: "1", actions: [], waiting_for: { id: alice.id, name: ownerName.displayName || ownerName.name } });

  // A card for anyone: every member who is not a guest gets the handles.
  const open = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, content: "Vault: one request" });
  assert.equal((await readCard(app.baseUrl, fx, open.body.messageId)).body.message_card?.actions.length, 2);
  assert.equal((await readCard(app.baseUrl, guest, open.body.messageId)).body.message_card?.actions.length, 0, "a guest presses nothing");

  // The App loses its execute eligibility: no handle, for anyone.
  await db.update(officialAppRegistry).set({ status: "disabled" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  assert.deepEqual((await readCard(app.baseUrl, alice, messageId)).body.message_card, { card_revision: "1", actions: [] });

  // A card message without actions reads as one with no acting buttons.
  const plain = await send(app.baseUrl, fx, { card: requestCard(fx) });
  assert.deepEqual((await readCard(app.baseUrl, alice, plain.body.messageId)).body.message_card, { card_revision: "1", actions: [] });
});

test("an unofficial App's sends with acting buttons follow the Server's card-button rule (RFC 076 §17): a shared App once this Server allowed its endpoint, a server_local App on its own Server until switched off; buttons only for a client showing Raft's not-reviewed confirmation", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  await db.update(officialAppRegistry).set({ status: "disabled" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  const cardButtons = (method: "PUT" | "DELETE", actionEndpoint = fx.actionEndpoint) => fetch(`${app.baseUrl}/api/integrations/clients/${fx.client.id}/action-endpoint/own-server-actions`, {
    method, headers: fx.headers, ...(method === "PUT" ? { body: JSON.stringify({ action_endpoint: actionEndpoint }) } : {}),
  });
  const refusedSend = async (why: string) => {
    const refused = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS });
    assert.equal(refused.status, 400, `${why}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.code, "message_card_actions_not_allowed", why);
  };
  // A shared App (the fixture's), nothing allowed on this Server: refused.
  await refusedSend("not allowed here");
  assert.equal((await cardButtons("PUT")).status, 200);
  const sent = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, content: "Vault: one request" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual((await readCard(app.baseUrl, fx, sent.body.messageId)).body.message_card, { card_revision: "1", actions: [] }, "without unreviewed_app.v1");
  const read = (await readCard(app.baseUrl, fx, sent.body.messageId, ["card.execute.v1", "unreviewed_app.v1"])).body.message_card!;
  assert.equal(read.app?.reviewed, false);
  assert.equal(read.actions.length, 2);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const executed = await post(app.baseUrl, "execute", fx, { client_request_id: clientRequestId(), handle: read.actions.find((action) => action.element_id === "deny")!.handle });
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  assert.equal(actionCalls(calls).length, 1);
  // The App changes its endpoint: links only until allowed again (the send too).
  await db.update(oauthAppLinkPreviews).set({ actionEndpoint: `${fx.actionEndpoint}-v2` }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  await refusedSend("endpoint changed since the allow");
  assert.deepEqual((await readCard(app.baseUrl, fx, sent.body.messageId, ["card.execute.v1", "unreviewed_app.v1"])).body.message_card, { card_revision: "1", actions: [] });
  await db.update(oauthAppLinkPreviews).set({ actionEndpoint: fx.actionEndpoint }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  assert.equal((await cardButtons("DELETE")).status, 200);
  await refusedSend("withdrawn");

  // A server_local App on its own Server: on by default, refused once switched off.
  await db.update(oauthClients).set({ appType: "server_local" }).where(eq(oauthClients.id, fx.client.id));
  assert.equal((await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS })).status, 200, "on by default");
  assert.equal((await cardButtons("DELETE")).status, 200);
  await refusedSend("switched off");
});

test("execute: the person the card is for presses through RFC 076 (prepare and confirm, or the undo window); the operation's URL identity is the button's fallback page; their receipt reads as a link card's", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const alice = await person(db, seed, fx);
  const sent = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, for: alice.id, content: "Vault: one request" });
  const messageId = sent.body.messageId as string;
  const handles = (await readCard(app.baseUrl, alice, messageId)).body.message_card!.actions;
  const handle = (id: string) => handles.find((action) => action.element_id === id)!.handle;
  const calls = stubApp((call) => call.body.phase === "prepare"
    ? appAnswer({ status: "prepared", description: {
      prepared_action_id: call.body.prepared_action_id, action_id: call.body.action_id, business_revision: "1", locale: "en", read_at: "2026-11-13T08:15:30.120Z",
      title: "Approve builder-bot's use of the deploy key", rows: [{ label: "Until", value: "18:00 UTC" }], confirm_label: "Approve", cancel_label: "Cancel",
    } })
    // Done: the view's one open operation (RFC 076 §5.2) is free for the next press.
    : appAnswer({ status: "done" }));

  // Undo window: no prepare.
  const denied = await post(app.baseUrl, "execute", alice, { client_request_id: clientRequestId(), handle: handle("deny") });
  assert.equal(denied.status, 200, JSON.stringify(denied.body));
  const [deny] = actionCalls(calls);
  assert.deepEqual({ phase: deny!.body.phase, url: deny!.body.url, action_id: deny!.body.action_id, card_revision: deny!.body.card_revision },
    { phase: "execute", url: `${fx.origin}/requests/42`, action_id: "deny", card_revision: "1" });
  assert.equal(deny!.url, fx.actionEndpoint, "sent to the App's action endpoint");
  const [op] = await db.select().from(linkCardOperations).where(eq(linkCardOperations.operationId, denied.body.operation_id as string));
  assert.deepEqual({ messageId: op!.messageId, urlSha256: op!.urlSha256, viewerId: op!.viewerId, providerKey: op!.providerKey, installationKey: op!.installationKey },
    { messageId, urlSha256: linkCardUrlSha256(`${fx.origin}/requests/42`), viewerId: alice.id, providerKey: fx.client.clientId, installationKey: fx.install.id });
  const status = await statusOf(app.baseUrl, alice, { operation_id: denied.body.operation_id });
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.notEqual(status.body.state, "not_visible", "her receipt is hers");

  // Confirm: prepare, then execute with the prepared record.
  const prepared = await post(app.baseUrl, "prepare", alice, { handle: handle("approve"), claimed: { business_revision: "1" } });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const approved = await post(app.baseUrl, "execute", alice, {
    client_request_id: clientRequestId(), handle: handle("approve"), prepared_action_id: prepared.body.prepared_action_id, prepared_digest: prepared.body.prepared_digest,
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual(actionCalls(calls).map((call) => [call.body.phase, call.body.action_id]), [["execute", "deny"], ["prepare", "approve"], ["execute", "approve"]]);

  // Another viewer presenting alice's handle, and a handle after the card moved on: refused, no App call.
  const owner = await post(app.baseUrl, "execute", fx, { client_request_id: clientRequestId(), handle: handles[1]!.handle });
  assert.equal(owner.status, 410, JSON.stringify(owner.body));
  const fresh = (await readCard(app.baseUrl, alice, messageId)).body.message_card!.actions;
  assert.equal((await update(app.baseUrl, fx, messageId, { card: requestCard(fx), actions: ACTIONS, content: "Vault: one request" })).status, 200);
  const stale = await post(app.baseUrl, "execute", alice, { client_request_id: clientRequestId(), handle: fresh.find((action) => action.element_id === "deny")!.handle });
  assert.equal(stale.status, 410, JSON.stringify(stale.body));
  assert.equal(stale.body.code, "HANDLE_INVALID");
  assert.equal(actionCalls(calls).length, 3);
});

// Between read and execute, the person the card is for is demoted to a
// guest, leaves the Server, or can no longer read the conversation. Execute
// refuses (no operation, no App call) at admission (its live check: the
// transaction never opens) and under its locks (the change lands after the
// live check passed: the in-transaction re-check refuses).
const CHANGES = {
  "was demoted to a guest": (db: Database, fx: AppBotFixture, channelId: string, viewer: Person) => db.update(serverMembers).set({ role: "guest", guestChannelId: channelId })
    .where(and(eq(serverMembers.serverId, fx.server.id), eq(serverMembers.userId, viewer.id))),
  "left the Server": (db: Database, fx: AppBotFixture, _channelId: string, viewer: Person) => db.delete(serverMembers)
    .where(and(eq(serverMembers.serverId, fx.server.id), eq(serverMembers.userId, viewer.id))),
  "can no longer read the conversation": (db: Database, _fx: AppBotFixture, channelId: string, viewer: Person) => db.delete(channelHumans)
    .where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, viewer.id))),
} as const;
for (const [change, apply] of Object.entries(CHANGES)) {
  for (const when of ["admission", "under the lock"] as const) {
    test(`execute is refused when for ${change} between read and execute: ${when}`, async ({ app, db, seed }) => {
      const fx = await appBotFixture(db, seed);
      const privateChannel = await createChannel(fx.server.id, `private-${randomUUID().slice(0, 8)}`, undefined, "private");
      await addHuman(privateChannel.id, fx.owner.id);
      await addAgent(privateChannel.id, fx.botId);
      const calls = stubApp(() => appAnswer({ status: "accepted" }));
      const viewer = await person(db, seed, fx, { channels: [fx.channel.id, privateChannel.id] });
      const sent = await send(app.baseUrl, fx, { target: `#${privateChannel.name}`, card: requestCard(fx), actions: ACTIONS, for: viewer.id, content: "Vault: one request" });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      const deny = (await readCard(app.baseUrl, viewer, sent.body.messageId)).body.message_card!.actions.find((action) => action.element_id === "deny")!;
      const phases: string[] = [];
      __observeLinkCardLiveStateForTests((phase) => phases.push(phase));
      if (when === "admission") await apply(db, fx, privateChannel.id, viewer);
      else __setLinkCardActionHooksForTests({ beforeAdmission: async () => { await apply(db, fx, privateChannel.id, viewer); } });
      const refused = await post(app.baseUrl, "execute", viewer, { client_request_id: clientRequestId(), handle: deny.handle });
      if (when === "admission" && change === "left the Server") {
        // Someone who left is no longer let in for this Server at all (requireServer), before any card check.
        assert.ok(refused.status >= 400 && refused.status < 500, `${refused.status} ${JSON.stringify(refused.body)}`);
      } else {
        assert.equal(refused.status, 410, `${refused.status} ${JSON.stringify(refused.body)}`);
        assert.equal(refused.body.code, "HANDLE_INVALID");
        assert.deepEqual(phases, when === "admission" ? ["execute"] : ["execute", "execute_transaction"],
          when === "admission" ? "refused by the live check, before the transaction" : "refused by the re-check under the locks");
      }
      assert.equal(actionCalls(calls).length, 0, "the App is never called");
      assert.equal((await db.select().from(linkCardOperations).where(eq(linkCardOperations.messageId, sent.body.messageId))).length, 0, "no operation");
    });
  }
}

/** One acting button's handle, as the read gives it to `viewer`. */
async function handleOf(baseUrl: string, viewer: { headers: Record<string, string> }, messageId: string, elementId: string): Promise<string> {
  const read = await readCard(baseUrl, viewer, messageId);
  const action = read.body.message_card?.actions.find((item) => item.element_id === elementId);
  assert.ok(action, `${elementId}: ${JSON.stringify(read.body)}`);
  return action.handle;
}
const appViewOf = (fx: AppBotFixture) => ({ id: fx.client.id, name: `Cards ${fx.client.clientId.slice("cards-".length)}`, icon: null });

test("consent, one rule for both kinds of card: no handle until the viewer agreed once for this App (the read says so and carries the App's prompt); a decline is honoured and said", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const alice = await person(db, seed, fx, { consent: false });
  const sent = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, for: alice.id, content: "Vault: one request" });
  const messageId = sent.body.messageId as string;

  // Never asked: no handle; the buttons draw enabled and the first press runs the link cards' own prompt.
  const needed = await readCard(app.baseUrl, alice, messageId);
  assert.equal(needed.status, 200);
  assert.deepEqual(needed.body.message_card, { card_revision: "1", actions: [], consent: "needed", app: appViewOf(fx) });
  assert.deepEqual(needed.body.prompts, [{ url: `${fx.origin}/requests/42`, app: appViewOf(fx) }], "the link card read's prompt shape");
  // A client without card.execute.v1 is asked nothing.
  assert.deepEqual((await readCard(app.baseUrl, alice, messageId, [])).body, { items: [], prompts: [], message_card: { card_revision: "1", actions: [] } });

  // She allows it, through the prompt's own call; the read is repeated.
  const allowed = await fetch(`${app.baseUrl}/api/integrations/clients/${fx.client.id}/link-preview-consent`, { method: "POST", headers: alice.headers });
  assert.equal(allowed.status, 200);
  const granted = await readCard(app.baseUrl, alice, messageId);
  assert.equal(granted.body.message_card?.actions.length, 2);
  assert.equal(granted.body.message_card?.consent, undefined);
  assert.deepEqual(granted.body.prompts, []);
  const earlier = granted.body.message_card!.actions.find((action) => action.element_id === "deny")!.handle;

  // She declines: no handle, and the buttons say why; a handle she still holds is refused before the App is called.
  const declined = await fetch(`${app.baseUrl}/api/integrations/clients/${fx.client.id}/link-preview-decline`, { method: "POST", headers: alice.headers });
  assert.equal(declined.status, 200);
  const after = await readCard(app.baseUrl, alice, messageId);
  assert.deepEqual(after.body.message_card, { card_revision: "1", actions: [], consent: "declined", app: appViewOf(fx) });
  assert.deepEqual(after.body.prompts, []);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const refused = await post(app.baseUrl, "execute", alice, { client_request_id: clientRequestId(), handle: earlier });
  assert.equal(refused.status, 410, JSON.stringify(refused.body));
  assert.equal(actionCalls(calls).length, 0);
  // Declined between read and execute (under the execute's locks, as for a link card).
  await fetch(`${app.baseUrl}/api/integrations/clients/${fx.client.id}/link-preview-consent`, { method: "POST", headers: alice.headers });
  const fresh = await handleOf(app.baseUrl, alice, messageId, "deny");
  __setLinkCardActionHooksForTests({ beforeAdmission: async () => {
    await db.insert(oauthLinkPreviewDeclines).values({ userId: alice.id, serverId: fx.server.id, clientId: fx.client.id, declinedAt: new Date() });
  } });
  const underLock = await post(app.baseUrl, "execute", alice, { client_request_id: clientRequestId(), handle: fresh });
  assert.equal(underLock.status, 410, JSON.stringify(underLock.body));
  assert.equal(actionCalls(calls).length, 0);
});

const mentionedIn = async (db: Database, messageId: string) => (await db.select().from(messageMentions).where(eq(messageMentions.messageId, messageId)))
  .map((mention) => [mention.targetType, mention.targetId]);

test("for is mentioned by id: notified when an agent shares their name", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const alice = await person(db, seed, fx);
  const namesake = await createAgent(fx.server.id, alice.name, { runtime: "claude", model: "sonnet" });
  await addAgent(fx.channel.id, namesake.id);
  const shared = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, for: alice.id, content: "Vault: one request" });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  assert.equal((await db.select({ name: agents.name }).from(agents).where(eq(agents.id, namesake.id)))[0]!.name, alice.name, "an agent with her very name");
  assert.deepEqual(await mentionedIn(db, shared.body.messageId), [["user", alice.id]]);
});

test("for is mentioned by id: notified when the Server hides its member directory from the bot (an ordinary member)", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  // A hidden human directory: the bot may name only owners and admins; Raft's mention of for still binds an ordinary member.
  await db.update(servers).set({ hideHumansFromMembers: true }).where(eq(servers.id, fx.server.id));
  const bob = await person(db, seed, fx);
  const hidden = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, for: bob.id, content: "Vault: one request" });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.deepEqual(await mentionedIn(db, hidden.body.messageId), [["user", bob.id]]);
  const derived = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, for: bob.id });
  assert.deepEqual(await mentionedIn(db, derived.body.messageId), [["user", bob.id]], "a fallback Raft derived mentions for too, and no one else");
  // The bot's own text mention of bob still resolves by its directory, as before: no edge.
  const byName = await send(app.baseUrl, fx, { content: `@${bob.name} hello` });
  assert.deepEqual(await mentionedIn(db, byName.body.messageId), []);
});

test("for is looked up among this Server's members: a person elsewhere gets the answer no one gets; an update that adds acting buttons spends the App's send budget", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const elsewhere = await seed.human();
  const otherServer = await seed.server({ owner: elsewhere });
  void otherServer;
  const card = requestCard(fx);
  const outsider = await send(app.baseUrl, fx, { card, actions: ACTIONS, for: elsewhere.id });
  const nobody = await send(app.baseUrl, fx, { card, actions: ACTIONS, for: randomUUID() });
  assert.deepEqual([outsider.status, outsider.body.code], [400, "message_card_actions_not_allowed"]);
  assert.deepEqual({ error: outsider.body.error, path: outsider.body.path }, { error: nobody.body.error, path: nobody.body.path }, "the same refusal");

  __setMessageCardActionsSendLimitForTests(1);
  const plain = await send(app.baseUrl, fx, { card, content: "Vault: one request" });
  assert.equal((await send(app.baseUrl, fx, { card, actions: ACTIONS })).status, 200, "the one send with actions this minute");
  const adds = await update(app.baseUrl, fx, plain.body.messageId, { card, actions: ACTIONS });
  assert.equal(adds.status, 429, JSON.stringify(adds.body));
  assert.equal(adds.body.code, "RATE_LIMITED");
  assert.equal(adds.body.details.operation, "messageCardUpdate");
  assert.ok(Number(adds.headers.get("retry-after")) > 0);
  assert.equal((await metadataOf(db, plain.body.messageId)).revision, 1, "nothing changed");
  // An update of a card that already acts spends nothing of it.
  const acting = await db.select({ id: messages.id }).from(messages).where(eq(messages.senderId, fx.botId));
  const withActions = acting.find((row) => row.id !== plain.body.messageId)!.id;
  assert.equal((await update(app.baseUrl, fx, withActions, { card, actions: ACTIONS })).status, 200);
});

test("the read asks execute's predicate: no handle where execute would refuse (the App no longer matched as a link card provider)", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const alice = await person(db, seed, fx);
  const sent = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, for: alice.id, content: "Vault: one request" });
  assert.equal((await readCard(app.baseUrl, alice, sent.body.messageId)).body.message_card?.actions.length, 2);
  // The App may no longer receive the person's profile: still eligible to act, but no registered provider for this viewer.
  await db.update(oauthClients).set({ allowedScopes: ["openid"] }).where(eq(oauthClients.id, fx.client.id));
  assert.deepEqual((await readCard(app.baseUrl, alice, sent.body.messageId)).body.message_card, { card_revision: "1", actions: [] });
});

test("main paths: a DM to the person it is for, a thread, and a thread of a joint channel (read side too)", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const alice = await person(db, seed, fx);
  const calls = stubApp(() => appAnswer({ status: "done" }));
  // How Vault uses it: a DM to the vault's owner.
  const dm = await send(app.baseUrl, fx, { target: `dm:@${alice.name}~human`, card: requestCard(fx), actions: ACTIONS, for: alice.id, content: "Vault: one request" });
  assert.equal(dm.status, 200, JSON.stringify(dm.body));
  const inDm = await post(app.baseUrl, "execute", alice, { client_request_id: clientRequestId(), handle: await handleOf(app.baseUrl, alice, dm.body.messageId, "deny") });
  assert.equal(inDm.status, 200, JSON.stringify(inDm.body));
  assert.equal((await readCard(app.baseUrl, fx, dm.body.messageId)).status, 404, "not a party to the DM: the unknown message's answer");

  // A thread of the channel.
  const thread = await send(app.baseUrl, fx, { target: `#${fx.channel.name}:${fx.message.id.slice(0, 8)}`, card: requestCard(fx), actions: ACTIONS, for: alice.id, content: "Vault: one request" });
  assert.equal(thread.status, 200, JSON.stringify(thread.body));
  const inThread = await post(app.baseUrl, "execute", alice, { client_request_id: clientRequestId(), handle: await handleOf(app.baseUrl, alice, thread.body.messageId, "deny") });
  assert.equal(inThread.status, 200, JSON.stringify(inThread.body));
  assert.equal(actionCalls(calls).length, 2);

  // A thread of a joint channel: refused at send; a card with actions stored there anyway gets no handle.
  const joint = await seedJointChannel({ name: `joint-${randomUUID().slice(0, 8)}`, serverIds: [fx.server.id], createdByUserId: fx.owner.id });
  const projection = joint.projections[0]!;
  await addHuman(projection.id, fx.owner.id);
  await addAgent(projection.id, fx.botId);
  const root = await createMessage(joint.canonical.id, "user", fx.owner.id, "root");
  const jointThread = await getOrCreateThreadForChannel(projection.id, root.id, fx.owner.id, "user");
  const refused = await send(app.baseUrl, fx, { target: `#${projection.name}:${root.id.slice(0, 8)}`, card: requestCard(fx), actions: ACTIONS, content: "Vault: one request" });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "message_card_actions_not_allowed");
  const stored = await metadataOf(db, dm.body.messageId);
  const planted = await createMessage(jointThread.canonicalThreadChannelId, "agent", fx.botId, "Vault: one request", "chat", undefined, {
    actionMetadata: { ...stored, for: undefined },
  });
  const read = await readCard(app.baseUrl, fx, planted.id);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.message_card, { card_revision: "1", actions: [] }, "read through a joint: no acting buttons");
});

test("execute refusals on the main path: not for at prepare, eligibility lost (admission and under the lock), a deleted message, a handle of the other kind, a button an update removed", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const alice = await person(db, seed, fx);
  const bob = await person(db, seed, fx);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const sendOne = async () => (await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, for: alice.id, content: "Vault: one request" })).body.messageId as string;
  const execute = (viewer: { headers: Record<string, string> }, handle: string) => post(app.baseUrl, "execute", viewer, { client_request_id: clientRequestId(), handle });

  // Someone who isn't for, at prepare, with a handle signed for them as the read would sign it.
  const forAlice = await sendOne();
  const aliceClaims = verifyLinkCardHandle(await handleOf(app.baseUrl, alice, forAlice, "approve"), new Date())!.claims;
  const bobs = signLinkCardHandle({ ...aliceClaims, binding: { ...aliceClaims.binding, viewerId: bob.id } });
  const prepared = await post(app.baseUrl, "prepare", bob, { handle: bobs, claimed: { business_revision: "1" } });
  assert.equal(prepared.status, 410, JSON.stringify(prepared.body));
  assert.equal(prepared.body.code, "HANDLE_INVALID");

  // The App loses its eligibility between read and execute: at admission, and under the execute's locks.
  const official = (status: "approved" | "disabled") => db.update(officialAppRegistry).set({ status }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  let handle = await handleOf(app.baseUrl, alice, await sendOne(), "deny");
  await official("disabled");
  const atAdmission = await execute(alice, handle);
  assert.deepEqual([atAdmission.status, atAdmission.body.code], [410, "PROVIDER_NOT_ELIGIBLE"], JSON.stringify(atAdmission.body));
  await official("approved");
  handle = await handleOf(app.baseUrl, alice, await sendOne(), "deny");
  __setLinkCardActionHooksForTests({ beforeAdmission: async () => { await official("disabled"); } });
  const underLock = await execute(alice, handle);
  __setLinkCardActionHooksForTests(null);
  assert.deepEqual([underLock.status, underLock.body.code], [410, "PROVIDER_NOT_ELIGIBLE"], JSON.stringify(underLock.body));
  await official("approved");

  // A deleted message: its handle is refused, and the read answers the unknown message's 404.
  const deleted = await sendOne();
  handle = await handleOf(app.baseUrl, alice, deleted, "deny");
  await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, deleted));
  assert.equal((await execute(alice, handle)).status, 410);
  assert.equal((await readCard(app.baseUrl, alice, deleted)).status, 404);

  // A link card's handle against a card message, and a card message's handle against a link's message.
  const card = await sendOne();
  const linkHandle = handleFor(fx, { binding: { messageId: card } }).handle;
  assert.equal((await execute(fx, linkHandle)).status, 410, "a link's handle never matches a card message");
  const cardClaims = verifyLinkCardHandle(await handleOf(app.baseUrl, alice, card, "deny"), new Date())!.claims;
  const moved = signLinkCardHandle({ ...cardClaims, binding: { ...cardClaims.binding, messageId: fx.message.id } });
  assert.equal((await execute(alice, moved)).status, 410, "a card message's handle never matches a link's message");

  // A later update removed the button.
  const approve = await handleOf(app.baseUrl, alice, card, "approve");
  assert.equal((await update(app.baseUrl, fx, card, { card: requestCard(fx), actions: { deny: ACTIONS.deny }, content: "Vault: one request" })).status, 200);
  const removed = await post(app.baseUrl, "prepare", alice, { handle: approve, claimed: { business_revision: "1" } });
  assert.equal(removed.status, 410, JSON.stringify(removed.body));
  assert.equal(actionCalls(calls).length, 0, "the App is never called");
  assert.equal((await db.select().from(linkCardOperations).where(eq(linkCardOperations.viewerId, alice.id))).length, 0);
});

test("for from an App's bot is the App subject Raft gave it, resolved through Raft's mapping and stored as the user id; a malformed subject and one naming no one are refused alike", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const alice = await person(db, seed, fx);
  const bob = await person(db, seed, fx);
  // The `sub` Sign in with Raft gave the App for alice (today the mapping is the identity).
  const aliceSub = alice.id;
  const sent = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, for: aliceSub, content: "Vault: one request" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal((await metadataOf(db, sent.body.messageId)).for, alice.id, "stored as the user id");
  // An update may name the same person, as a subject too.
  assert.equal((await update(app.baseUrl, fx, sent.body.messageId, { card: requestCard(fx), actions: ACTIONS, for: aliceSub, content: "Vault: one request" })).status, 200);

  const malformed = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, for: "alice" });
  const nobody = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, for: randomUUID() });
  for (const refused of [malformed, nobody]) assert.deepEqual([refused.status, refused.body.code], [400, "message_card_actions_not_allowed"]);
  assert.deepEqual({ error: malformed.body.error, path: malformed.body.path }, { error: nobody.body.error, path: nobody.body.path }, "one answer for both");

  // The subject becomes a person only through Raft's mapping: another mapping names another person.
  __setAppSubjectMappingForTests(async ({ clientId, sub }) => (clientId === fx.client.id && sub === aliceSub ? bob.id : null));
  const mapped = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, for: aliceSub, content: "Vault: one request" });
  assert.equal(mapped.status, 200, JSON.stringify(mapped.body));
  assert.equal((await metadataOf(db, mapped.body.messageId)).for, bob.id, "the mapping decided who for is");
  assert.deepEqual(await mentionedIn(db, mapped.body.messageId), [["user", bob.id]]);
  const updateNamesAlice = await update(app.baseUrl, fx, sent.body.messageId, { card: requestCard(fx), actions: ACTIONS, for: aliceSub });
  assert.equal(updateNamesAlice.status, 400, "the same subject now names someone else than the card's for");
});

test("a thread of a joint channel stored on the host server (not in joint storage) reads as joint: no handles", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  // A joint whose canonical stream is the host's own projection, on the host server.
  const projection = await createChannel(fx.server.id, `hosted-${randomUUID().slice(0, 8)}`, undefined, "joint");
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: projection.id, createdByServerId: fx.server.id, createdByUserId: fx.owner.id }).returning();
  await db.insert(jointChannelServers).values({ jointChannelId: joint!.id, serverId: fx.server.id, localChannelId: projection.id, role: "host", joinedByUserId: fx.owner.id });
  await addHuman(projection.id, fx.owner.id);
  const root = await createMessage(projection.id, "user", fx.owner.id, "root");
  const thread = await getOrCreateThreadForChannel(projection.id, root.id, fx.owner.id, "user");
  const [stored] = await db.select({ serverId: channels.serverId, type: channels.type }).from(channels).where(eq(channels.id, thread.canonicalThreadChannelId));
  assert.deepEqual(stored, { serverId: fx.server.id, type: "thread" }, "the thread is stored on the host server");
  // A card with acting buttons stored there (the send refuses it; the read must not rest on that).
  const sample = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, content: "Vault: one request" });
  const planted = await createMessage(thread.canonicalThreadChannelId, "agent", fx.botId, "Vault: one request", "chat", undefined, {
    actionMetadata: await metadataOf(db, sample.body.messageId),
  });
  assert.equal((await readCard(app.baseUrl, fx, sample.body.messageId)).body.message_card?.actions.length, 2, "the same card outside the joint has handles");
  const read = await readCard(app.baseUrl, fx, planted.id);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.message_card, { card_revision: "1", actions: [] }, "read through a joint: no acting buttons");
});

test("an archive that lands inside the send's transaction, after the archive check: 409 channel_archived, nothing stored", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const before = await botMessageCount(db, fx);
  // Between the send's archive check and the card's checks in its transaction (the insert's race seam).
  __setAgentSendRaceHooksForTests({ beforeInsert: async () => {
    await getDb().update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, fx.channel.id));
  } });
  const refused = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, content: "Vault: one request", idempotencyKey: `vault-${randomUUID()}` });
  __setAgentSendRaceHooksForTests({});
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "channel_archived");
  assert.equal(await botMessageCount(db, fx), before, "nothing stored");
});

test("the App's toast on execute's answer reaches a client that declared execute.toast.v1 on the read (bound into the card message's handle), and no other", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const alice = await person(db, seed, fx);
  const toast = { tone: "success", text: "Denied: builder-bot can't use the deploy key" };
  const calls = stubApp(() => appAnswer({ status: "done", toast }));
  const pressed = async (capabilities: string[]) => {
    const sent = await send(app.baseUrl, fx, { card: requestCard(fx), actions: ACTIONS, for: alice.id, content: "Vault: one request" });
    const read = await readCard(app.baseUrl, alice, sent.body.messageId, capabilities);
    const deny = read.body.message_card!.actions.find((action) => action.element_id === "deny")!;
    const claims = verifyLinkCardHandle(deny.handle, new Date())!.claims;
    const executed = await post(app.baseUrl, "execute", alice, { client_request_id: clientRequestId(), handle: deny.handle });
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    return { body: executed.body, bound: claims.binding.capabilities };
  };
  const declared = await pressed(["card.execute.v1", "execute.toast.v1"]);
  assert.deepEqual(declared.bound, ["card.execute.v1", "execute.toast.v1"], "bound into the handle");
  assert.equal(declared.body.state, "done");
  assert.deepEqual(declared.body.app_result, { toast }, "the App's own toast");
  const without = await pressed(["card.execute.v1"]);
  assert.deepEqual(without.bound, ["card.execute.v1"]);
  assert.equal(without.body.state, "done");
  assert.equal(without.body.app_result, undefined, "a client that didn't declare it gets Raft's fixed hint only");
  assert.ok(without.body.toast, "Raft's fixed hint");
  assert.equal(actionCalls(calls).length, 2);
});

test("an update re-derives the fallback the same way: acting buttons in Raft while the card has actions, the plain card once they end; a sender's content is kept", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const content = async (messageId: string) => (await db.select({ content: messages.content }).from(messages).where(eq(messages.id, messageId)))[0]!.content;
  const sent = await send(app.baseUrl, fx, { card: requestCard(fx), idempotencyKey: `vault-${randomUUID()}` });
  const plain = await content(sent.body.messageId);
  assert.match(plain, /\[Approve\]\(https:/, "a navigate-only card's fallback: its links");
  const acting = await update(app.baseUrl, fx, sent.body.messageId, { card: requestCard(fx), actions: ACTIONS });
  assert.equal(acting.status, 200, JSON.stringify(acting.body));
  const withActions = await content(sent.body.messageId);
  assert.match(withActions, /Approve \(in Raft\) · Deny \(in Raft\) · \[Open in Vault\]\(https:/);
  assert.ok(!withActions.includes("Update Raft"), withActions);
  assert.equal((await update(app.baseUrl, fx, sent.body.messageId, { card: requestCard(fx) })).status, 200);
  assert.equal(await content(sent.body.messageId), plain, "the actions ended: the fallback it had");
  assert.equal((await update(app.baseUrl, fx, sent.body.messageId, { card: requestCard(fx), actions: ACTIONS, content: "Vault: one request" })).status, 200);
  assert.equal(await content(sent.body.messageId), "Vault: one request", "a sender's content stays as written");
  // A retry compares the card and actions, not the content Raft derived: the same keyed send answers the same message.
  const keyed = { card: requestCard(fx), actions: ACTIONS, idempotencyKey: `vault-${randomUUID()}` };
  const first = await send(app.baseUrl, fx, keyed);
  assert.equal((await send(app.baseUrl, fx, keyed)).body.messageId, first.body.messageId);
});

// RFC 086 step 2 (§5.1, §5.2), PR B: forms on acting buttons. A SecretInput
// only on a confirm button, only from an official App, only once the App
// registered its card encryption key; its button's handle only for a client
// that declared the form capabilities, binding the key's kid, and the read
// then carries the key from Raft's registration.
const NAME_FIELD = { type: "TextInput", id: "name", label: "Name", default: "deploy-key-prod" } as const;
const SECRET_FIELD = { type: "SecretInput", id: "value", label: "Value" } as const;
const SECRET_ACTIONS = {
  approve: { ...ACTIONS.approve, form: { fields: [NAME_FIELD, SECRET_FIELD] } },
  deny: ACTIONS.deny,
} as const;
const FORM_CAPABILITIES = ["card.execute.v1", "card.form.v1", "card.form.secret.v1"];

/** A fresh P-256 public key as the App registers it (RFC 086 §5.2), stored on its registration as the PUT route stores it. */
async function setCardKey(db: Database, fx: AppBotFixture, kid: string) {
  const { x, y } = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const jwk = { kty: "EC", crv: "P-256", use: "enc", alg: "ECDH-ES", kid, x, y } as const;
  await db.update(oauthAppLinkPreviews).set({ cardEncryptionKey: jwk, cardEncryptionKid: kid, cardEncryptionKeySetAt: new Date() })
    .where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  return jwk;
}

test("SecretInput at send and update: refused on an undo-window button, without a registered key (its own code), from an App that isn't official; stored for an official App with its key", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const card = requestCard(fx);
  const refusedWith = async (why: string, body: Record<string, unknown>, code: string, error: RegExp) => {
    const before = await botMessageCount(db, fx);
    const refused = await send(app.baseUrl, fx, { card, ...body });
    assert.equal(refused.status, 400, `${why}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.code, code, why);
    assert.match(refused.body.error, error, why);
    assert.equal(await botMessageCount(db, fx), before, `${why}: nothing stored`);
  };

  // No key registered yet: a clear code of its own; a form of TextInputs needs none.
  await refusedWith("no key", { actions: SECRET_ACTIONS }, "message_card_encryption_key_required", /needs the App's card encryption key/);
  const textOnly = await send(app.baseUrl, fx, { card, actions: { ...SECRET_ACTIONS, approve: { ...ACTIONS.approve, form: { fields: [NAME_FIELD] } } } });
  assert.equal(textOnly.status, 200, JSON.stringify(textOnly.body));

  const jwk = await setCardKey(db, fx, "vault-1");
  // An undo-window button never holds a SecretInput, whatever the App.
  await refusedWith("undo window", { actions: { deny: { ...ACTIONS.deny, form: { fields: [SECRET_FIELD] } } } }, "message_card_actions_not_allowed", /never on an undo-window button/);
  await refusedWith("a SecretInput's default", { actions: { approve: { ...ACTIONS.approve, form: { fields: [{ ...SECRET_FIELD, default: "sk-live-marker" }] } } } }, "message_card_actions_not_allowed", /never a default or value/);

  // An official App with its key: stored as sent.
  const sent = await send(app.baseUrl, fx, { card, actions: SECRET_ACTIONS, content: "Vault: a new key" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual((await metadataOf(db, sent.body.messageId)).actions, SECRET_ACTIONS);
  assert.ok(!JSON.stringify(await metadataOf(db, sent.body.messageId)).includes(jwk.x), "the key is never in the card's metadata");

  // The key removed: an update carrying the SecretInput is refused the same way; nothing changes.
  await db.update(oauthAppLinkPreviews).set({ cardEncryptionKey: null, cardEncryptionKid: null, cardEncryptionKeySetAt: null }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  const updated = await update(app.baseUrl, fx, sent.body.messageId, { card, actions: SECRET_ACTIONS });
  assert.equal(updated.status, 400, JSON.stringify(updated.body));
  assert.equal(updated.body.code, "message_card_encryption_key_required");
  assert.equal((await metadataOf(db, sent.body.messageId)).revision, 1);
  await setCardKey(db, fx, "vault-2");

  // Not official (a server_local App acting on its own Server, RFC 076 §17): its card buttons act, but a SecretInput is refused, key or not.
  await db.update(officialAppRegistry).set({ status: "disabled" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  await db.update(oauthClients).set({ appType: "server_local" }).where(eq(oauthClients.id, fx.client.id));
  await refusedWith("not official", { actions: SECRET_ACTIONS }, "message_card_actions_not_allowed", /Only an official App can ask for a secret/);
  const unofficialText = await send(app.baseUrl, fx, { card, actions: { approve: { ...ACTIONS.approve, form: { fields: [NAME_FIELD] } } } });
  assert.equal(unofficialText.status, 200, `a TextInput form is any acting App's: ${JSON.stringify(unofficialText.body)}`);
  const unofficialUpdate = await update(app.baseUrl, fx, unofficialText.body.messageId, { card, actions: SECRET_ACTIONS });
  assert.equal(unofficialUpdate.status, 400, JSON.stringify(unofficialUpdate.body));
  assert.equal(unofficialUpdate.body.code, "message_card_actions_not_allowed");
});

test("SecretInput handle read: none without card.form.v1 and card.form.secret.v1 (the other buttons keep theirs); with them, the handle binds the kid and the answer carries the App's registered key; a rotation fails the old handle closed", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const alice = await person(db, seed, fx);
  const jwk = await setCardKey(db, fx, "vault-1");
  const sent = await send(app.baseUrl, fx, { card: requestCard(fx), actions: SECRET_ACTIONS, for: alice.id, content: "Vault: a new key" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const messageId = sent.body.messageId as string;

  for (const capabilities of [["card.execute.v1"], ["card.execute.v1", "card.form.v1"], ["card.execute.v1", "card.form.secret.v1"]]) {
    const answer = (await readCard(app.baseUrl, alice, messageId, capabilities)).body.message_card!;
    assert.deepEqual(answer.actions.map((action) => action.element_id), ["deny"], `${capabilities.join(",")}: no handle for the SecretInput button`);
    assert.equal(answer.app?.encryption_key, undefined, `${capabilities.join(",")}: no key without its handle`);
  }

  const answer = (await readCard(app.baseUrl, alice, messageId, FORM_CAPABILITIES)).body.message_card!;
  assert.deepEqual(answer.actions.map((action) => action.element_id), ["approve", "deny"]);
  assert.deepEqual(answer.app?.encryption_key, jwk, "the public JWK as Raft stores it");
  const claimsOf = (handle: string) => verifyLinkCardHandle(handle, new Date())!.claims;
  const approve = answer.actions.find((action) => action.element_id === "approve")!.handle;
  assert.deepEqual(claimsOf(approve).messageCard, { elementId: "approve", encryptionKid: "vault-1" }, "the handle binds the kid");
  // What the client needs for the sealed header (RFC 086 §5.3): the App's client key (aud) and the handle's expiry (exp), only for a SecretInput button.
  assert.equal(answer.app?.client_key, fx.client.clientId);
  assert.equal(answer.actions.find((action) => action.element_id === "approve")!.handle_exp, claimsOf(approve).exp);
  assert.equal(answer.actions.find((action) => action.element_id === "deny")!.handle_exp, undefined);
  assert.deepEqual(claimsOf(answer.actions.find((action) => action.element_id === "deny")!.handle).messageCard, { elementId: "deny" }, "no kid on a button without a SecretInput");
  // Nobody else gets the key: the owner (not for) reads no handle and no key.
  assert.equal((await readCard(app.baseUrl, fx, messageId, FORM_CAPABILITIES)).body.message_card!.app, undefined);

  // A handle binding another kid than the App's is refused (prepare: 410), and the App isn't called.
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const forged = signLinkCardHandle({ ...claimsOf(approve), messageCard: { elementId: "approve", encryptionKid: "vault-0" } });
  const forgedPrepare = await post(app.baseUrl, "prepare", alice, { handle: forged, claimed: { business_revision: "1" } });
  assert.equal(forgedPrepare.status, 410, JSON.stringify(forgedPrepare.body));
  assert.equal(forgedPrepare.body.code, "HANDLE_INVALID");

  // The App rotates its key: the handle issued under vault-1 fails closed; a new read binds vault-2 and carries the new key.
  const rotated = await setCardKey(db, fx, "vault-2");
  const stale = await post(app.baseUrl, "prepare", alice, { handle: approve, claimed: { business_revision: "1" } });
  assert.equal(stale.status, 410, JSON.stringify(stale.body));
  assert.equal(stale.body.code, "HANDLE_INVALID");
  assert.equal(actionCalls(calls).length, 0);
  const again = (await readCard(app.baseUrl, alice, messageId, FORM_CAPABILITIES)).body.message_card!;
  assert.deepEqual(again.app?.encryption_key, rotated);
  assert.equal(claimsOf(again.actions.find((action) => action.element_id === "approve")!.handle).messageCard?.encryptionKid, "vault-2");

  // The key removed, or the App no longer official: no handle for the SecretInput button (the other keeps its own while the App can act).
  await db.update(oauthAppLinkPreviews).set({ cardEncryptionKey: null, cardEncryptionKid: null, cardEncryptionKeySetAt: null }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  const keyless = (await readCard(app.baseUrl, alice, messageId, FORM_CAPABILITIES)).body.message_card!;
  assert.deepEqual(keyless.actions.map((action) => action.element_id), ["deny"]);
  assert.equal(keyless.app?.encryption_key, undefined);
  await setCardKey(db, fx, "vault-3");
  await db.update(officialAppRegistry).set({ status: "disabled" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  await db.update(oauthClients).set({ appType: "server_local" }).where(eq(oauthClients.id, fx.client.id));
  const unofficial = (await readCard(app.baseUrl, alice, messageId, [...FORM_CAPABILITIES, "unreviewed_app.v1"])).body.message_card!;
  assert.deepEqual(unofficial.actions.map((action) => action.element_id), ["deny"], "SecretInput is for official Apps only");
  assert.equal(unofficial.app?.encryption_key, undefined);
});
