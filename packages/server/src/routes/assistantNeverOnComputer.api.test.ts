// A personal assistant is never bound to a machine (Computer). It runs hosted;
// every agent on a Computer shares one OS user. Each write path that could
// bind one refuses explicitly with AssistantCannotUseComputerError (409
// `assistant_cannot_use_computer` over HTTP), never a 500, and the CHECK
// agents_assistant_not_on_machine holds the rule in the database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enablePersonalAssistants, withHostedRuntime } from "../test/hostedAssistantFixture";
import { getDb } from "../db/index";
import { agents, machines } from "../db/schema";
import { addMember } from "../services/serverService";
import { autoAssignMachine, createAgent } from "../services/agentService";
import { placeAgentWithoutSource } from "../services/agentMigrationService";
import { AssistantCannotUseComputerError } from "../services/computerAgents";
import { convertFailedHostedCindyToComputer } from "../services/hostedCindyService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const REFUSAL = "A personal assistant runs hosted and can't be placed on a Computer.";

async function seedServer(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`${label}-owner-${suffix}@slock.test`, `${label}-owner-${suffix}`);
  const server = await createServer("Assistant Never On Computer", `${label}-${suffix}`, owner.id);
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: `${label}-computer-${suffix}`,
    apiKeyHash: `unused-${label}-${suffix}`,
    runtimes: ["claude"],
  }).returning();
  return { owner, server, machine: machine! };
}

/** An assistant row as the service writes it, without the hosted runtime. */
async function seedAssistantRow(serverId: string, ownerId: string, runtime = "external") {
  const agent = await createAgent(serverId, `pa-${randomUUID().slice(0, 8)}`, {
    runtime,
    creatorType: "user",
    creatorId: ownerId,
    kind: "personal_assistant",
  });
  await getDb().update(agents).set({ assistantOwnerUserId: ownerId }).where(eq(agents.id, agent.id));
  return agent;
}

async function machineOf(agentId: string) {
  const [row] = await getDb().select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, agentId));
  return row?.machineId ?? null;
}

test("migrate refuses an assistant explicitly (409, not 500)", async ({ app }) => {
  await withHostedRuntime(async () => {
    const { owner, server, machine } = await seedServer("pa-route");
    await enablePersonalAssistants(server.id);
    const created = await fetch(`${app.baseUrl}/api/servers/${server.id}/assistant`, {
      method: "POST",
      headers: headers(await tokenForHuman(owner.email), server.id),
      body: JSON.stringify({ name: "Ada" }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const { agentId } = (await created.json() as { assistant: { agentId: string } }).assistant;
    assert.equal(await machineOf(agentId), null, "created with no machine");

    const migrate = await fetch(`${app.baseUrl}/api/agents/${agentId}/migrate`, {
      method: "POST",
      headers: headers(await tokenForHuman(owner.email), server.id),
      body: JSON.stringify({ targetComputer: machine.id }),
    });
    assert.equal(migrate.status, 409, await migrate.clone().text());
    const migrateBody = await migrate.json() as { error: string; code: string };
    assert.equal(migrateBody.error, REFUSAL);
    assert.equal(migrateBody.code, "not_supported");

    assert.equal(await machineOf(agentId), null, "still on no machine");
  });
});

test("the service paths refuse an assistant: placement with no source, create with a machine, the Cindy conversion", async ({ db: _db }) => {
  const { owner, server, machine } = await seedServer("pa-service");
  // Managed runtime on purpose: the external-runtime guards must not be what stops it.
  const assistant = await seedAssistantRow(server.id, owner.id, "claude");
  assert.equal(await machineOf(assistant.id), null, "an assistant is not auto-assigned at create");

  // What POST /migrate does for an agent on no Computer; it re-checks under the agent row lock.
  await assert.rejects(placeAgentWithoutSource({
    agentId: assistant.id,
    targetMachineId: machine.id,
    actorFence: { serverId: server.id, userId: owner.id, capability: "migrateAgents" },
  }), AssistantCannotUseComputerError);
  assert.equal(await machineOf(assistant.id), null);

  await assert.rejects(
    createAgent(server.id, `pa-${randomUUID().slice(0, 8)}`, { runtime: "claude", kind: "personal_assistant", machineId: machine.id }),
    AssistantCannotUseComputerError,
  );

  await assert.rejects(convertFailedHostedCindyToComputer({
    serverId: server.id,
    agentId: assistant.id,
    actorUserId: owner.id,
    runtime: "claude",
    model: "sonnet",
    runtimeConfig: { runtime: "claude" } as never,
    reasoningEffort: null,
    envVars: null,
    machineId: machine.id,
  }), AssistantCannotUseComputerError);
  assert.equal(await machineOf(assistant.id), null);
});

test("autoAssignMachine binds an ordinary agent but never an assistant", async ({ db: _db }) => {
  const { owner, server, machine } = await seedServer("pa-auto");
  const assistant = await seedAssistantRow(server.id, owner.id, "claude");
  const ordinary = await createAgent(server.id, `plain-${randomUUID().slice(0, 8)}`, { runtime: "claude" });
  // Created on the Computer (auto-assigned); off it again so autoAssignMachine has something to bind.
  await getDb().update(agents).set({ machineId: null }).where(eq(agents.id, ordinary.id));

  await autoAssignMachine(server.id, machine.id);

  assert.equal(await machineOf(ordinary.id), machine.id);
  assert.equal(await machineOf(assistant.id), null);
});

test("the database CHECK rejects an assistant on a machine, and a machine-bound agent becoming an assistant", async ({ db: _db }) => {
  const { owner, server, machine } = await seedServer("pa-check");
  const assistant = await seedAssistantRow(server.id, owner.id);
  await assert.rejects(
    getDb().update(agents).set({ machineId: machine.id }).where(eq(agents.id, assistant.id)),
    (err: unknown) => /agents_assistant_not_on_machine/.test(String((err as { cause?: unknown }).cause ?? err) + String(err)),
  );

  const member = await seedUser(`pa-check-member-${randomUUID().slice(0, 8)}@slock.test`, `pa-check-member-${randomUUID().slice(0, 8)}`);
  await addMember(server.id, member.id);
  const bound = await createAgent(server.id, `bound-${randomUUID().slice(0, 8)}`, { runtime: "claude", machineId: machine.id });
  assert.equal(await machineOf(bound.id), machine.id);
  await assert.rejects(
    getDb().update(agents).set({ assistantOwnerUserId: member.id }).where(eq(agents.id, bound.id)),
    (err: unknown) => /agents_assistant_not_on_machine/.test(String((err as { cause?: unknown }).cause ?? err) + String(err)),
  );
});
