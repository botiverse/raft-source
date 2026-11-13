// Executing an action card takes the second step its kind declares
// (services/actionCardSecondFactor.ts): with two-step verification on (flag
// AND the person's own setting), an `approver` kind needs a sign-in that
// passed it (any time), a `step_up` kind one that passed it in the last 10
// minutes; otherwise 403 `second_factor_step_up_required` with the methods,
// and nothing is written (no grant, no install, no funnel row, the card still
// prepared). A `none` kind and refusing (dismissing a card, denying the
// request it is for) never need it. Someone who never turned it on sees no
// change (design §0). agent:approve_call's Approve / Deny is in
// antiprotonApprovals.api.test.ts (it needs the fake antiproton there).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  actionCards,
  oauthAccessRequests,
  oauthClientInstalls,
  oauthClientMaintainers,
  oauthClients,
  oauthGrants,
  productEvents,
  sessionFamilies,
} from "../db/schema";
import { bindMarketplaceAppName, prepareActionCard } from "../services/actionCardsService";
import { ACTION_CARD_SECOND_FACTOR } from "../services/actionCardSecondFactor";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { createOAuthClient } from "../services/oauthService";
import { STEP_UP_ACTIONS, STEP_UP_WINDOW_MS } from "../services/secondFactor/stepUpGate";
import { createApiTest } from "../test/integration/apiTest";
import { signInForTest } from "../test/integration/credentials";
import { enrollSecondFactor, useTotpSecretKey } from "../test/integration/secondFactor";

const test = createApiTest();
useTotpSecretKey();

type Json = Record<string, any>;
type Res = { status: number; body: Json };
type Seed = { human(values?: Json): Promise<any>; server(input: { owner: any }): Promise<{ id: string; slug: string }> };

async function call(baseUrl: string, method: string, path: string, token: string, serverId: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Server-Id": serverId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Json };
}

/**
 * A person signed in on the web (an unverified `full` sign-in), owner of a
 * server with an agent and a channel they share. `enforced`: two-step
 * verification then turned on (flag and setting).
 */
async function person(seed: Seed, enforced: boolean) {
  const human = await seed.human();
  const server = await seed.server({ owner: human });
  const agent = await createAgent(server.id, `card-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  const channel = await createChannel(server.id, `cards-${randomUUID().slice(0, 8)}`, undefined, "channel");
  await addHuman(channel.id, human.id);
  await addAgent(channel.id, agent.id);
  const session = await signInForTest(human.id);
  let backupCodes: string[] = [];
  if (enforced) {
    ({ backupCodes } = await enrollSecondFactor(human.id));
  }
  return { human: human as { id: string }, server, agent, channel, session, backupCodes };
}
type Person = Awaited<ReturnType<typeof person>>;

const execute = (baseUrl: string, p: Person, messageId: string) =>
  call(baseUrl, "POST", `/api/actions/${messageId}/execute`, p.session.token, p.server.id, { expectedState: "prepared" });

async function stepUp(baseUrl: string, p: Person, backupCode: string) {
  const res = await call(baseUrl, "POST", "/api/auth/second-factor/step-up", p.session.token, p.server.id, { backupCode });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

async function ageVerification(p: Person, byMs: number) {
  await getDb().update(sessionFamilies)
    .set({ secondFactorVerifiedAt: new Date(Date.now() - byMs) })
    .where(eq(sessionFamilies.id, p.session.familyId));
}

const prepare = (p: Person, action: Parameters<typeof prepareActionCard>[0]["action"]) =>
  prepareActionCard({ serverId: p.server.id, requesterAgentId: p.agent.id, targetChannelId: p.channel.id, action });

/** A prepared card of one kind for this person, and what executing it writes. */
type Card = { messageId: string; requestId?: string; sideEffects(): Promise<unknown> };
type GatedKind = {
  kind: "integration:approve_agent_login" | "integration:install_marketplace_app" | "integration:register_app" | "integration:recover_app_owner";
  card(seed: Seed, p: Person): Promise<Card>;
};

async function cardState(messageId: string) {
  const [card] = await getDb().select({ id: actionCards.id, state: actionCards.state }).from(actionCards).where(eq(actionCards.messageId, messageId));
  const events = await getDb().select({ eventType: productEvents.eventType }).from(productEvents).where(eq(productEvents.subjectId, card!.id));
  return { state: card!.state, events: events.map((event) => event.eventType).sort() };
}

const GATED: GatedKind[] = [
  {
    kind: "integration:approve_agent_login",
    async card(_seed, p) {
      const { client } = await createOAuthClient({
        serverId: p.server.id, createdByUserId: p.human.id, clientId: `card-login-${randomUUID().slice(0, 8)}`, name: "Card Login App",
        returnUrl: "https://login.example.test/callback",
      });
      const [request] = await getDb().insert(oauthAccessRequests).values({
        serverId: p.server.id, principalType: "agent", agentId: p.agent.id, clientId: client.id, scopes: ["openid"], status: "pending",
      }).returning();
      const card = await prepare(p, {
        type: "integration:approve_agent_login", requestId: request!.id, agentId: p.agent.id, agentName: p.agent.name,
        clientId: client.id, clientKey: client.clientId, clientName: client.name, scopes: ["openid"],
      });
      return {
        messageId: card.messageId,
        requestId: request!.id,
        sideEffects: async () => ({
          grants: (await getDb().select({ id: oauthGrants.id }).from(oauthGrants).where(eq(oauthGrants.clientId, client.id))).length,
          request: (await getDb().select({ status: oauthAccessRequests.status }).from(oauthAccessRequests).where(eq(oauthAccessRequests.id, request!.id)))[0]!.status,
          card: await cardState(card.messageId),
        }),
      };
    },
  },
  {
    kind: "integration:install_marketplace_app",
    async card(seed, p) {
      const publisher = await seed.human();
      const publisherServer = await seed.server({ owner: publisher });
      const { client } = await createOAuthClient({
        serverId: publisherServer.id, createdByUserId: publisher.id, clientId: `card-market-${randomUUID().slice(0, 8)}`,
        appType: "third_party_global", name: "Card Market App", homepageUrl: "https://market.example.test",
        returnUrl: "https://market.example.test/callback", allowedScopes: ["openid"],
      });
      await getDb().update(oauthClients).set({ publishStatus: "published", humanMarketplaceVisible: true }).where(eq(oauthClients.id, client.id));
      const card = await prepare(p, {
        type: "integration:install_marketplace_app", clientId: client.id, clientKey: client.clientId, ...bindMarketplaceAppName(client.name),
        agentId: p.agent.id, agentName: p.agent.displayName ?? p.agent.name, scopes: ["openid"],
      });
      return {
        messageId: card.messageId,
        sideEffects: async () => ({
          installs: (await getDb().select({ id: oauthClientInstalls.id }).from(oauthClientInstalls)
            .where(and(eq(oauthClientInstalls.clientId, client.id), eq(oauthClientInstalls.serverId, p.server.id)))).length,
          card: await cardState(card.messageId),
        }),
      };
    },
  },
  {
    kind: "integration:register_app",
    async card(_seed, p) {
      const clientKey = `card-register-${randomUUID().slice(0, 8)}`;
      const card = await prepare(p, {
        type: "integration:register_app", name: "Card Registered App", clientKey, returnUrl: "https://registered.example.test/callback",
        homepageUrl: "https://registered.example.test", scopes: ["openid"], unsafeDemoUrlOverride: false,
      });
      return {
        messageId: card.messageId,
        sideEffects: async () => ({
          apps: (await getDb().select({ id: oauthClients.id }).from(oauthClients).where(eq(oauthClients.clientId, clientKey))).length,
          card: await cardState(card.messageId),
        }),
      };
    },
  },
  {
    kind: "integration:recover_app_owner",
    async card(_seed, p) {
      // A Server-local app with no owner left.
      const { client } = await createOAuthClient({
        serverId: p.server.id, createdByUserId: p.human.id, clientId: `card-recover-${randomUUID().slice(0, 8)}`, name: "Orphan App",
      });
      await getDb().update(oauthClients).set({ ownerAgentId: null }).where(eq(oauthClients.id, client.id));
      await getDb().update(oauthClientMaintainers).set({ revokedAt: new Date() }).where(eq(oauthClientMaintainers.clientId, client.id));
      const card = await prepare(p, { type: "integration:recover_app_owner", clientKey: client.clientId, targetAgent: p.agent.name });
      return {
        messageId: card.messageId,
        sideEffects: async () => ({
          owner: (await getDb().select({ ownerAgentId: oauthClients.ownerAgentId }).from(oauthClients).where(eq(oauthClients.id, client.id)))[0]!.ownerAgentId,
          card: await cardState(card.messageId),
        }),
      };
    },
  },
];

function refusalOf(kind: GatedKind["kind"]) {
  const rule = ACTION_CARD_SECOND_FACTOR[kind];
  if (rule.secondFactor === "approver") return rule.error;
  if (rule.secondFactor === "step_up") return STEP_UP_ACTIONS[rule.action];
  throw new Error(`${kind} is not gated`);
}

function assertRefused(res: Res, kind: GatedKind["kind"]) {
  assert.equal(res.status, 403, `${kind}: ${JSON.stringify(res.body)}`);
  assert.deepEqual(res.body, { error: refusalOf(kind), code: "second_factor_step_up_required", methods: ["totp", "backup_code"] }, kind);
}

for (const gated of GATED) {
  const rule = ACTION_CARD_SECOND_FACTOR[gated.kind].secondFactor;

  test(`${gated.kind} (${rule}): with two-step verification on, refused on an unverified sign-in and nothing is written`, async ({ app, seed }) => {
    const p = await person(seed, true);
    const card = await gated.card(seed, p);
    const before = await card.sideEffects();
    assert.equal((before as { card: { state: string } }).card.state, "prepared");
    assertRefused(await execute(app.baseUrl, p, card.messageId), gated.kind);
    assert.deepEqual(await card.sideEffects(), before, `${gated.kind}: nothing written`);

    if (rule === "approver") {
      // Verified on this sign-in, longer ago than step-up's 10 minutes: allowed.
      await stepUp(app.baseUrl, p, p.backupCodes[0]!);
      await ageVerification(p, STEP_UP_WINDOW_MS + 60_000);
    } else {
      // Verified more than 10 minutes ago: refused again; a fresh step-up: allowed.
      await stepUp(app.baseUrl, p, p.backupCodes[0]!);
      await ageVerification(p, STEP_UP_WINDOW_MS + 60_000);
      assertRefused(await execute(app.baseUrl, p, card.messageId), gated.kind);
      assert.deepEqual(await card.sideEffects(), before, `${gated.kind}: nothing written`);
      await stepUp(app.baseUrl, p, p.backupCodes[1]!);
    }
    const allowed = await execute(app.baseUrl, p, card.messageId);
    assert.equal(allowed.status, 200, `${gated.kind}: ${JSON.stringify(allowed.body)}`);
    assert.notDeepEqual(await card.sideEffects(), before, `${gated.kind}: applied`);
  });

  test(`${gated.kind} (${rule}): without two-step verification, unchanged on an unverified sign-in`, async ({ app, seed }) => {
    // The answer a verified enforced person gets, for its shape.
    const enforced = await person(seed, true);
    await stepUp(app.baseUrl, enforced, enforced.backupCodes[0]!);
    const reference = await execute(app.baseUrl, enforced, (await gated.card(seed, enforced)).messageId);
    assert.equal(reference.status, 200, `${gated.kind}: ${JSON.stringify(reference.body)}`);
    // Two people who never turned it on: both as before.
    const plain = await person(seed, false);
    const flagOnly = await person(seed, false);
    for (const p of [plain, flagOnly]) {
      const card = await gated.card(seed, p);
      const before = await card.sideEffects();
      const res = await execute(app.baseUrl, p, card.messageId);
      assert.equal(res.status, 200, `${gated.kind}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body?.code, undefined);
      assert.deepEqual(Object.keys(res.body ?? {}).sort(), Object.keys(reference.body ?? {}).sort(), gated.kind);
      assert.notDeepEqual(await card.sideEffects(), before, `${gated.kind}: applied`);
    }
  });
}

test("refusing an app login card never needs the second step: dismissing it, and denying its request", async ({ app, seed }) => {
  const p = await person(seed, true);
  const card = await GATED[0]!.card(seed, p);
  const dismissed = await call(app.baseUrl, "POST", `/api/actions/${card.messageId}/event`, p.session.token, p.server.id, {
    eventType: "action_card.dismiss", metadata: { dismiss_reason: "close_button" },
  });
  assert.equal(dismissed.status, 204, JSON.stringify(dismissed.body));
  const denied = await call(app.baseUrl, "POST", `/api/integrations/requests/${card.requestId}/deny`, p.session.token, p.server.id, {});
  assert.equal(denied.status, 200, JSON.stringify(denied.body));
  const [request] = await getDb().select({ status: oauthAccessRequests.status }).from(oauthAccessRequests).where(eq(oauthAccessRequests.id, card.requestId!));
  assert.equal(request!.status, "denied");
  assert.equal((await getDb().select({ id: oauthGrants.id }).from(oauthGrants).where(eq(oauthGrants.agentId, p.agent.id))).length, 0);
});

test("a `none` kind (channel:create) is never gated, on an unverified sign-in with two-step verification on", async ({ app, seed }) => {
  assert.equal(ACTION_CARD_SECOND_FACTOR["channel:create"].secondFactor, "none");
  const p = await person(seed, true);
  const card = await prepare(p, { type: "channel:create", name: `made-${randomUUID().slice(0, 8)}`, visibility: "public" });
  const res = await execute(app.baseUrl, p, card.messageId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.metadata?.result?.kind, "channel");
});
