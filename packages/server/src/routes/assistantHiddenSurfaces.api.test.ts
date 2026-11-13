// Only its owner finds a personal assistant (agentFindableBy; tygg, Tenny,
// #proj-assistant 5cc12a51). Its creator is its owner, so the owner's profile
// lists the agents they created: there the assistant is shown to the owner
// (and to the assistant itself), and left out for everyone else, as if it did
// not exist. An installed App is never its owner: its agent and Computer reads
// leave the assistant out (the OAuth directory: oauthAgentDirectory.api.test.ts;
// the App agent list over HTTP: integrations.api.test.ts).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enablePersonalAssistants, withHostedRuntime } from "../test/hostedAssistantFixture";
import { getDb } from "../db/index";
import { agents, computers } from "../db/schema";
import { addMember } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { registerMachine } from "../services/machineService";
import { generateComputerApiKeyMaterial } from "../services/computerCredentialService";
import { listAppAgentProjections, listAppComputerProjections } from "../services/appOutboundProjectionService";
import type { VerifiedAppInstallationCredential } from "../services/appInstallationCredentialService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seed(baseUrl: string) {
  const suffix = randomUUID().slice(0, 8);
  const serverOwner = await seedUser(`ahs-server-owner-${suffix}@slock.test`, `ahs-server-owner-${suffix}`);
  const admin = await seedUser(`ahs-admin-${suffix}@slock.test`, `ahs-admin-${suffix}`);
  const owner = await seedUser(`ahs-owner-${suffix}@slock.test`, `ahs-owner-${suffix}`);
  const member = await seedUser(`ahs-member-${suffix}@slock.test`, `ahs-member-${suffix}`);
  const server = await createServer("Assistant Hidden Surfaces", `ahs-${suffix}`, serverOwner.id);
  await addMember(server.id, admin.id, "admin");
  await addMember(server.id, owner.id);
  await addMember(server.id, member.id);
  await enablePersonalAssistants(server.id);
  // An ordinary agent the owner made: everyone keeps seeing it.
  const ordinary = await createAgent(server.id, `ahs-made-${suffix}`, { runtime: "external", model: "external", creatorType: "user", creatorId: owner.id });
  const created = await fetch(`${baseUrl}/api/servers/${server.id}/assistant`, {
    method: "POST",
    headers: headers(await tokenForHuman(owner.email), server.id),
    body: JSON.stringify({ name: "Ada" }),
  });
  assert.equal(created.status, 201);
  const assistantId = (await created.json() as { assistant: { agentId: string } }).assistant.agentId;
  return { serverOwner, admin, owner, member, server, ordinary, assistantId };
}

async function memberProfileAgents(baseUrl: string, serverId: string, ownerId: string, viewerEmail: string) {
  const res = await fetch(`${baseUrl}/api/servers/${serverId}/members/${ownerId}/profile`, {
    headers: headers(await tokenForHuman(viewerEmail), serverId),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return ((await res.json()) as { createdAgents: Array<{ id: string }> }).createdAgents.map((agent) => agent.id);
}

async function agentProfileAgents(baseUrl: string, apiKey: string, handle: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/profile?target=${encodeURIComponent(`@${handle}`)}`, {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  });
  assert.equal(res.status, 200, await res.clone().text());
  return ((await res.json()) as { createdAgents: Array<{ id: string }> }).createdAgents.map((agent) => agent.id);
}

test("the owner's member profile lists their assistant to them only", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    for (const viewer of [s.member, s.admin, s.serverOwner]) {
      assert.deepEqual(
        await memberProfileAgents(app.baseUrl, s.server.id, s.owner.id, viewer.email),
        [s.ordinary.id],
        `${viewer.name} does not find another person's assistant on their profile`,
      );
    }
    const own = await memberProfileAgents(app.baseUrl, s.server.id, s.owner.id, s.owner.email);
    assert.deepEqual(own.sort(), [s.ordinary.id, s.assistantId].sort(), "the owner still finds it");
  });
});

test("an agent reading the owner's profile does not find the assistant; the assistant itself does", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    const other = await createAgent(s.server.id, `ahs-reader-${randomUUID().slice(0, 6)}`, { runtime: "external", model: "external" });
    const otherKey = (await mintAgentCredential({ agentId: other.id, scopes: ["send", "read"], name: "reader", issuedVia: "human", createdByUserId: s.serverOwner.id })).apiKey;
    assert.deepEqual(await agentProfileAgents(app.baseUrl, otherKey, s.owner.name), [s.ordinary.id], "another agent does not find it");

    const selfKey = (await mintAgentCredential({ agentId: s.assistantId, scopes: ["send", "read"], name: "self", issuedVia: "human", createdByUserId: s.owner.id })).apiKey;
    const seenBySelf = await agentProfileAgents(app.baseUrl, selfKey, s.owner.name);
    assert.deepEqual(seenBySelf.sort(), [s.ordinary.id, s.assistantId].sort(), "the assistant finds itself on its owner's profile");
  });
});

test("an installed App's agent and computer reads leave the assistant out", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    // The owner's Computer runs an ordinary agent; the assistant is hosted,
    // never on a Computer (agents_assistant_not_on_machine).
    const { machine } = await registerMachine(s.server.id, s.owner.id, `ahs-box-${randomUUID().slice(0, 8)}`);
    const material = await generateComputerApiKeyMaterial();
    const [computer] = await getDb().insert(computers).values({
      serverId: s.server.id, name: "ahs-box", apiKeyHash: material.apiKeyHash, apiKeyPrefix: material.apiKeyPrefix,
      attachedByUserId: s.owner.id, machineId: machine.id,
    }).returning();
    await getDb().update(agents).set({ machineId: machine.id }).where(eq(agents.id, s.ordinary.id));
    const credential: VerifiedAppInstallationCredential = {
      tokenId: randomUUID(), installationId: randomUUID(), clientId: randomUUID(), serverId: s.server.id,
      grantRevision: 1, groups: ["agent", "computer"], audience: "test", expiresAt: new Date(Date.now() + 60_000),
    };
    const listed = (await listAppAgentProjections(credential)).map((agent) => agent.id);
    assert.ok(listed.includes(s.ordinary.id));
    assert.equal(listed.includes(s.assistantId), false, "the agent directory leaves the assistant out");
    const box = (await listAppComputerProjections(credential)).find((row) => row.id === computer!.id)!;
    assert.deepEqual(box.hosted_agent_ids, [s.ordinary.id], "the Computer's hosted agents are its ordinary agent only");
    assert.equal(box.hosted_agent_count, 1);
  });
});
