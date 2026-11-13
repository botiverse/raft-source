import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// `presentation.card` (action-card.v1, S1): every write of an action card's
// metadata carries the card beside the unchanged legacy presentation, with
// its result once executed; a card stored before cards carried one gets it on
// a human read; agents never see it; a builder that fails leaves it out
// without failing the request.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import {
  buildActionCardPresentation,
  parseActionCardSpec,
  type ActionCardMetadata,
  type ActionCardPresentation,
  type ActionCardSpecCard,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { actionCards, agents, channels, messages, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import * as channelService from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { updateAgentScopes } from "../services/agentScopesService";
import { prepareActionCard } from "../services/actionCardsService";
import { reconfirmActionCard } from "../services/actionCardConversionService";
import { setActionCardSpecBuilderForTest } from "../services/actionCardPresentation";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

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

function installOrchestrator(app: { set: (key: string, value: unknown) => void }) {
  const deliverMessage = async () => ({ status: "queued", reason: "test" });
  app.set("agentOrchestrator", {
    deliverMessage,
    deliverMessagesOnChannel: (_channelId: string, batch: ReadonlyArray<unknown>) => batch.map(() => deliverMessage()),
    loadDeliveryGates: async () => null,
    recordAgentRaftAction: async () => {},
  });
}

async function seed(app: { app: { set: (key: string, value: unknown) => void } }) {
  installOrchestrator(app.app);
  const owner = await seedUser("card-spec-owner");
  const alice = await seedUser("card-spec-alice");
  const server = await createServer("Card Spec", `card-spec-${randomUUID().slice(0, 8)}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: alice.id, role: "member" });
  const channel = await channelService.createChannel(server.id, `card-spec-${randomUUID().slice(0, 6)}`);
  await channelService.addHuman(channel.id, owner.id);
  const agent = await createAgent(server.id, `card-spec-agent-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await channelService.addAgent(channel.id, agent.id);
  await updateAgentScopes({ agentId: agent.id, scopes: ["action:prepare", "message:read"], updatedByUserId: owner.id });
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["read", "tasks"], name: "card-spec", issuedVia: "computer", createdByUserId: null });
  return { owner, alice, server, channel, agent, agentKey: minted.apiKey, ownerToken: await tokenForHuman(owner.email) };
}
type Fixture = Awaited<ReturnType<typeof seed>>;

const humanHeaders = (f: Fixture) => ({ Authorization: `Bearer ${f.ownerToken}`, "Content-Type": "application/json", "X-Server-Id": f.server.id });
const agentHeaders = (f: Fixture) => ({ Authorization: `Bearer ${f.agentKey}`, "Content-Type": "application/json" });

async function storedMetadata(messageId: string): Promise<ActionCardMetadata> {
  const [row] = await getDb().select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, messageId));
  return row!.actionMetadata as ActionCardMetadata;
}

/** The card a human client reads for `messageId` in the channel history. */
async function humanRead(baseUrl: string, f: Fixture, messageId: string): Promise<ActionCardMetadata> {
  const res = await fetch(`${baseUrl}/api/messages/channel/${f.channel.id}?limit=50`, { headers: humanHeaders(f) });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as { messages: Array<{ id: string; actionMetadata?: ActionCardMetadata }> };
  const message = body.messages.find((candidate) => candidate.id === messageId);
  assert.ok(message?.actionMetadata, "the card is in the human history");
  return message.actionMetadata;
}

/** The same message as the agent reads it (`raft message read`). */
async function agentRead(baseUrl: string, f: Fixture, messageId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(`#${f.channel.name}`)}&limit=50&consume=false`, { headers: agentHeaders(f) });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as { messages: Array<Record<string, unknown>> };
  const message = body.messages.find((candidate) => candidate.id === messageId);
  assert.ok(message, "the card is in the agent history");
  return message;
}

function assertNoCardForAgent(message: unknown, label: string) {
  const text = JSON.stringify(message);
  assert.equal(text.includes("\"card\""), false, `${label}: an agent never sees presentation.card`);
  assert.equal(text.includes("action-card.v1"), false, `${label}: an agent never sees presentation.card`);
}

function assertEmitCard(presentation: ActionCardPresentation | null | undefined): ActionCardSpecCard {
  assert.ok(presentation?.card, "presentation.card is written");
  const parsed = parseActionCardSpec(presentation.card, { mode: "emit" });
  assert.ok(parsed.ok, "the stored card is one the emit parse accepts");
  assert.deepEqual(parsed.card, presentation.card, "the stored card is the parsed card");
  return presentation.card;
}

function legacyOf(presentation: ActionCardPresentation | null | undefined) {
  const { card: _card, ...legacy } = presentation ?? ({} as ActionCardPresentation);
  return legacy;
}

async function execute(baseUrl: string, f: Fixture, messageId: string, body: Record<string, unknown> = { expectedState: "prepared" }) {
  return fetch(`${baseUrl}/api/actions/${messageId}/execute`, { method: "POST", headers: humanHeaders(f), body: JSON.stringify(body) });
}

test("an agent-prepared card carries presentation.card for humans and never for the agent", async ({ app }) => {
  const f = await seed(app);
  const prepared = await fetch(`${app.baseUrl}/internal/agent-api/prepare-action`, {
    method: "POST",
    headers: agentHeaders(f),
    body: JSON.stringify({
      target: `#${f.channel.name}`,
      action: { type: "channel:create", name: "spec-room", visibility: "private", initialHumans: [`@${f.alice.name}`], initialAgents: [f.agent.name], draftHint: "For the {launch}." },
    }),
  });
  const text = await prepared.text();
  assert.equal(prepared.status, 201, text);
  const body = JSON.parse(text) as { messageId: string; metadata: ActionCardMetadata };
  assertNoCardForAgent(body, "prepare response");
  assert.equal(body.metadata.presentation?.title, "Create channel #spec-room", "the agent keeps the legacy presentation");

  const stored = await storedMetadata(body.messageId);
  const card = assertEmitCard(stored.presentation);
  // The legacy fields are exactly what they were before cards existed.
  assert.deepEqual(legacyOf(stored.presentation), buildActionCardPresentation(stored.action));
  assert.equal(card.title.key, "actionCard.title.createPrivateChannel");
  assert.deepEqual(card.title.params, { name: "spec-room" });
  // Prepare resolved the handles: the fallbacks are their names.
  const humans = card.spec.elements.humans;
  assert.deepEqual(humans?.type === "Field" ? humans.props.value : null, [{ kind: "user", id: f.alice.id, fallback: f.alice.name }]);
  const agents = card.spec.elements.agents;
  assert.deepEqual(agents?.type === "Field" ? agents.props.value : null, [{ kind: "agent", id: f.agent.id, fallback: f.agent.name }]);
  // The agent's braces stay text.
  const reason = card.spec.elements.reasonText;
  assert.equal(reason?.type === "Text" ? reason.props.text : null, "For the {launch}.");

  assert.deepEqual((await humanRead(app.baseUrl, f, body.messageId)).presentation?.card, card);
  const agentView = await agentRead(app.baseUrl, f, body.messageId);
  assertNoCardForAgent(agentView, "agent history");
  assert.equal((agentView.actionMetadata as ActionCardMetadata).presentation?.title, "Create channel #spec-room");
});

test("execute and mark-executed write the card with its result", async ({ app }) => {
  const f = await seed(app);
  const channelCard = await prepareActionCard({
    serverId: f.server.id, requesterAgentId: f.agent.id, targetChannelId: f.channel.id,
    action: { type: "channel:create", name: `spec-made-${randomUUID().slice(0, 6)}`, visibility: "public" },
  });
  assert.equal(assertEmitCard(channelCard.metadata.presentation).result, undefined, "a prepared card has no result");
  const executed = await execute(app.baseUrl, f, channelCard.messageId);
  assert.equal(executed.status, 200, await executed.clone().text());
  const executedBody = await executed.json() as { metadata: ActionCardMetadata };
  assert.equal(executedBody.metadata.result?.kind, "channel");
  const created = executedBody.metadata.result!.kind === "channel" ? executedBody.metadata.result! : null;
  const card = assertEmitCard(executedBody.metadata.presentation);
  assert.deepEqual(card.result?.elements.channel, {
    type: "Field",
    props: { label: card.result?.elements.channel?.type === "Field" ? card.result.elements.channel.props.label : null, value: [{ kind: "channel", id: created!.id, fallback: created!.name }] },
  });
  const open = card.result?.elements.openChannel;
  assert.deepEqual(open?.type === "Button" ? open.props.action : null, { kind: "navigate", target: { kind: "channel", id: created!.id } });
  assert.deepEqual((await storedMetadata(channelCard.messageId)).presentation?.card, card, "stored as sent");
  assert.deepEqual(legacyOf(executedBody.metadata.presentation), buildActionCardPresentation(executedBody.metadata.action));

  const agentCard = await prepareActionCard({
    serverId: f.server.id, requesterAgentId: f.agent.id, targetChannelId: f.channel.id,
    action: { type: "agent:create", name: "spec-scribe" },
  });
  const marked = await fetch(`${app.baseUrl}/api/actions/${agentCard.messageId}/mark-executed`, {
    method: "POST",
    headers: humanHeaders(f),
    body: JSON.stringify({ result: { kind: "agent", id: f.agent.id, name: "spec-scribe" } }),
  });
  assert.equal(marked.status, 200, await marked.clone().text());
  const markedCard = assertEmitCard((await marked.json() as { metadata: ActionCardMetadata }).metadata.presentation);
  const agentField = markedCard.result?.elements.agent;
  assert.deepEqual(agentField?.type === "Field" ? agentField.props.value : null, [{ kind: "agent", id: f.agent.id, fallback: "spec-scribe" }]);
  const openAgent = markedCard.result?.elements.openAgent;
  assert.deepEqual(openAgent?.type === "Button" ? openAgent.props.action : null, { kind: "navigate", target: { kind: "agent", id: f.agent.id } });
});

test("a card that names an agent by handle has its display name as the reference's fallback, and shows no handle", async ({ app }) => {
  const f = await seed(app);
  await getDb().update(agents).set({ displayName: "Kai" }).where(eq(agents.id, f.agent.id));
  const prepared = await prepareActionCard({
    serverId: f.server.id, requesterAgentId: f.agent.id, targetChannelId: f.channel.id,
    action: { type: "integration:recover_app_owner", clientKey: "reminder", targetAgent: `@${f.agent.name}` },
  });
  const card = assertEmitCard(prepared.metadata.presentation);
  assert.deepEqual(card.title, { ...(card.title as object), params: { clientKey: "reminder", agent: { kind: "agent", id: f.agent.id, fallback: "Kai" } } });
  assert.equal(JSON.stringify(card).includes(f.agent.name), false, "the handle is nowhere on the card");
});

test("a card stored before presentation.card gets one on a human read and on an idempotent execute, never on an agent read", async ({ app }) => {
  const f = await seed(app);
  const card = await prepareActionCard({
    serverId: f.server.id, requesterAgentId: f.agent.id, targetChannelId: f.channel.id,
    action: { type: "channel:create", name: `spec-old-${randomUUID().slice(0, 6)}`, visibility: "public", initialHumans: [f.alice.id] },
  });
  const executed = await execute(app.baseUrl, f, card.messageId);
  assert.equal(executed.status, 200, await executed.clone().text());
  // As an older server wrote it: the legacy presentation alone.
  const before = await storedMetadata(card.messageId);
  await getDb().update(messages).set({ actionMetadata: { ...before, presentation: legacyOf(before.presentation) } }).where(eq(messages.id, card.messageId));

  const read = await humanRead(app.baseUrl, f, card.messageId);
  const built = assertEmitCard(read.presentation);
  assert.deepEqual(legacyOf(read.presentation), legacyOf(before.presentation), "the legacy fields are read as stored");
  assert.ok(built.result?.elements.channel, "the read card shows the stored result");
  // Nothing beyond the row is read: the fallback is the id's first 8 characters.
  const humans = built.spec.elements.humans;
  assert.deepEqual(humans?.type === "Field" ? humans.props.value : null, [{ kind: "user", id: f.alice.id, fallback: f.alice.id.slice(0, 8) }]);
  assert.equal((await storedMetadata(card.messageId)).presentation?.card, undefined, "a read writes nothing");

  const replay = await execute(app.baseUrl, f, card.messageId, {});
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.deepEqual((await replay.json() as { metadata: ActionCardMetadata }).metadata.presentation?.card, built, "the idempotent answer has the card too");

  assertNoCardForAgent(await agentRead(app.baseUrl, f, card.messageId), "agent history of an old card");
});

test("reconfirm gives a card stored without presentation.card one", async ({ app }) => {
  const f = await seed(app);
  const card = await prepareActionCard({
    serverId: f.server.id, requesterAgentId: f.agent.id, targetChannelId: f.channel.id,
    action: { type: "channel:create", name: `spec-joint-${randomUUID().slice(0, 6)}`, visibility: "public" },
  });
  const db = getDb();
  const before = await storedMetadata(card.messageId);
  // A card a joint conversion left waiting for reconfirmation, stored by an older server.
  await db.update(channels).set({ type: "joint" }).where(eq(channels.id, f.channel.id));
  await db.update(actionCards).set({ freezeState: "reconfirm_required", conversionSourceChannelId: f.channel.id }).where(eq(actionCards.messageId, card.messageId));
  await db.update(messages).set({ actionMetadata: { ...before, state: "reconfirm_required", presentation: legacyOf(before.presentation) } }).where(eq(messages.id, card.messageId));

  const out = await db.transaction((tx) => reconfirmActionCard(tx, { messageId: card.messageId, userId: f.owner.id }));
  assert.equal(out.metadata.state, "prepared");
  const rebuilt = assertEmitCard(out.metadata.presentation);
  assert.deepEqual(rebuilt, before.presentation?.card, "the same card prepare wrote");
  assert.deepEqual((await storedMetadata(card.messageId)).presentation?.card, rebuilt);
});

test("a builder that throws leaves the card out, and prepare, execute and reads still succeed", async ({ app }) => {
  const f = await seed(app);
  setActionCardSpecBuilderForTest(() => { throw new Error("injected builder failure"); });
  try {
    const card = await prepareActionCard({
      serverId: f.server.id, requesterAgentId: f.agent.id, targetChannelId: f.channel.id,
      action: { type: "channel:create", name: `spec-fail-${randomUUID().slice(0, 6)}`, visibility: "public" },
    });
    assert.equal("card" in (card.metadata.presentation ?? {}), false);
    assert.deepEqual(card.metadata.presentation, buildActionCardPresentation(card.metadata.action), "the legacy presentation goes alone");
    const executed = await execute(app.baseUrl, f, card.messageId);
    assert.equal(executed.status, 200, await executed.clone().text());
    const stored = await storedMetadata(card.messageId);
    assert.equal(stored.state, "executed");
    assert.equal("card" in (stored.presentation ?? {}), false);
    assert.equal((await humanRead(app.baseUrl, f, card.messageId)).presentation?.card, undefined);
  } finally {
    setActionCardSpecBuilderForTest(null);
  }
});
