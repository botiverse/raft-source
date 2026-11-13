// Two requests that name an agent by id or name answer an agent the caller
// may not find exactly as one that doesn't exist:
// - an App asking for an agent's access on a Server it isn't available on
//   (POST /api/oauth/requests/agent), and asking for a personal assistant;
// - a member adding another person's personal assistant to a channel, at
//   creation or afterwards (one id or a batch).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enablePersonalAssistants, withHostedRuntime } from "../test/hostedAssistantFixture";
import { addMember } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { createOAuthClient } from "../services/oauthService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seed(baseUrl: string) {
  const suffix = randomUUID().slice(0, 8);
  const serverOwner = await seedUser(`aer-server-owner-${suffix}@slock.test`, `aer-server-owner-${suffix}`);
  const owner = await seedUser(`aer-owner-${suffix}@slock.test`, `aer-owner-${suffix}`);
  const outsider = await seedUser(`aer-outsider-${suffix}@slock.test`, `aer-outsider-${suffix}`);
  const server = await createServer("Agent Existence", `aer-${suffix}`, serverOwner.id);
  const own = await createServer("Own", `aer-own-${suffix}`, outsider.id);
  await addMember(server.id, owner.id);
  await enablePersonalAssistants(server.id);
  const ordinary = await createAgent(server.id, `aer-agent-${suffix}`, { runtime: "external", model: "external" });
  const created = await fetch(`${baseUrl}/api/servers/${server.id}/assistant`, {
    method: "POST",
    headers: headers(await tokenForHuman(owner.email), server.id),
    body: JSON.stringify({ name: "Ada" }),
  });
  assert.equal(created.status, 201);
  const assistantId = (await created.json() as { assistant: { agentId: string } }).assistant.agentId;
  return { suffix, serverOwner, owner, outsider, server, own, ordinary, assistantId };
}

async function body(res: Response) {
  return { status: res.status, body: await res.text() };
}

test("an App asking for an agent on a Server it isn't available on learns nothing about that agent", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    // A Server-local App of the outsider's own Server, and one of the victim Server (for the assistant case).
    const outside = await createOAuthClient({
      serverId: s.own.id, createdByUserId: s.outsider.id, clientId: `aer-out-${s.suffix}`,
      name: "Outside", returnUrl: "https://outside.example.test/callback", allowedScopes: ["openid", "profile"],
    });
    const inside = await createOAuthClient({
      serverId: s.server.id, createdByUserId: s.serverOwner.id, clientId: `aer-in-${s.suffix}`,
      name: "Inside", returnUrl: "https://inside.example.test/callback", allowedScopes: ["openid", "profile"],
    });
    const ask = (client: { clientId: string }, secret: string, agent: Record<string, string>) => fetch(`${app.baseUrl}/api/oauth/requests/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: client.clientId, clientSecret: secret, serverSlug: s.server.slug, scopes: ["openid", "profile"], ...agent }),
    }).then(body);

    const missingByName = await ask(outside.client, outside.clientSecret, { agentName: `no-such-${s.suffix}` });
    const missingById = await ask(outside.client, outside.clientSecret, { agentId: randomUUID() });
    assert.equal(missingByName.status, 404);
    assert.deepEqual(await ask(outside.client, outside.clientSecret, { agentName: s.ordinary.name }), missingByName, "an existing agent by name");
    assert.deepEqual(await ask(outside.client, outside.clientSecret, { agentId: s.ordinary.id }), missingById, "an existing agent by id");

    // On its own Server an App still gets the request; a personal assistant is answered as no agent.
    assert.equal((await ask(inside.client, inside.clientSecret, { agentId: s.ordinary.id })).status, 200);
    assert.deepEqual(await ask(inside.client, inside.clientSecret, { agentId: s.assistantId }), await ask(inside.client, inside.clientSecret, { agentId: randomUUID() }));
  });
});

test("another person's personal assistant is refused as an unknown agent when added to a channel", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    const h = headers(await tokenForHuman(s.serverOwner.email), s.server.id);
    const create = (agentIds: string[], name: string) => fetch(`${app.baseUrl}/api/channels`, {
      method: "POST", headers: h, body: JSON.stringify({ name, visibility: "private", agentIds }),
    }).then(body);
    const unknown = randomUUID();
    const refusedCreate = await create([unknown], `aer-a-${s.suffix}`);
    assert.equal(refusedCreate.status, 400);
    assert.deepEqual(await create([s.assistantId], `aer-b-${s.suffix}`), refusedCreate, "creation");

    const made = await create([], `aer-c-${s.suffix}`);
    assert.ok(made.status === 200 || made.status === 201, made.body);
    const channelId = (JSON.parse(made.body) as { id: string }).id;
    const add = (agentId: string) => fetch(`${app.baseUrl}/api/channels/${channelId}/members`, {
      method: "POST", headers: h, body: JSON.stringify({ agentId }),
    }).then(body);
    assert.deepEqual(await add(s.assistantId), await add(unknown), "one id");
    const batch = (agentIds: string[]) => fetch(`${app.baseUrl}/api/channels/${channelId}/members/batch`, {
      method: "POST", headers: h, body: JSON.stringify({ agentIds, userIds: [] }),
    }).then(body);
    const batchUnknown = await batch([unknown]);
    const batchAssistant = await batch([s.assistantId]);
    assert.equal(batchAssistant.status, batchUnknown.status);
    assert.equal(batchAssistant.body.replaceAll(s.assistantId, "ID"), batchUnknown.body.replaceAll(unknown, "ID"), "a batch");
    // An ordinary agent is still added.
    assert.ok((await add(s.ordinary.id)).status < 300);
  });
});
