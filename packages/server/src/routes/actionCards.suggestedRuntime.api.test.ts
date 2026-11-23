// agent:create's suggestedRuntime is checked at prepare against what this
// server offers for a new agent now, by the runtime admission the agent create
// route uses (runtimeAdmissionService): an unknown or deprecated id, or one
// behind a flag that is off, is refused with the offered ids; Antigravity
// (no longer deprecated) is taken whether its OAR host flag is on or off.
// Never with a cloud agent. Prepare reads the server's answer (no person has
// picked yet).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agents, featureFlagRules, featureFlags, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import * as channelService from "../services/channelService";
import { ActionCardError, prepareActionCard, suggestedRuntimeNotOfferedMessage } from "../services/actionCardsService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

function stubOrchestrator(app: { app: { set: (key: string, value: unknown) => void } }) {
  const deliverMessage = async () => ({ status: "queued", reason: "test" });
  app.app.set("agentOrchestrator", {
    deliverMessage,
    deliverMessagesOnChannel: (_channelId: string, batch: ReadonlyArray<unknown>) => batch.map(() => deliverMessage()),
    loadDeliveryGates: async () => null,
    recordAgentRaftAction: async () => {},
  });
}

async function seedServer() {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb().insert(users).values({
    email: `rt-owner-${suffix}@test.invalid`,
    name: `rt-owner-${suffix}`,
    displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Suggested Runtime", `suggested-rt-${suffix}`, owner!.id);
  const channel = await channelService.createChannel(server.id, `rt-${suffix.slice(0, 6)}`);
  await channelService.addHuman(channel.id, owner!.id);
  const agent = await createAgent(server.id, `rt-agent-${suffix.slice(0, 6)}`, { runtime: "claude" });
  await getDb().update(agents).set({ creatorType: "user", creatorId: owner!.id }).where(eq(agents.id, agent.id));
  await channelService.addAgent(channel.id, agent.id);
  const prepare = (action: Record<string, unknown>) => prepareActionCard({
    serverId: server.id, requesterAgentId: agent.id, targetChannelId: channel.id, agentAuthored: true,
    action: { type: "agent:create", name: `scribe-${randomUUID().slice(0, 6)}`, ...action } as Parameters<typeof prepareActionCard>[0]["action"],
  });
  const refusal = async (action: Record<string, unknown>) => {
    try {
      await prepare(action);
    } catch (error) {
      assert.ok(error instanceof ActionCardError, String(error));
      return { status: error.status, code: error.code, message: error.message };
    }
    return assert.fail("expected a refusal");
  };
  return { owner: owner!, server, prepare, refusal };
}

test("prepare takes a runtime this server offers for new agents, and the card says it was suggested", async ({ app }) => {
  stubOrchestrator(app);
  const { prepare } = await seedServer();
  const card = await prepare({ suggestedRuntime: "codex" });
  const action = card.metadata.action;
  assert.equal(action.type === "agent:create" && action.suggestedRuntime, "codex");
  const spec = JSON.stringify(card.metadata.presentation?.card);
  assert.match(spec, /actionCard\.field\.suggestedRuntime/);
  assert.match(spec, /Codex CLI/);
  // Without it, the card is as before.
  const plain = await prepare({});
  assert.equal(plain.metadata.action.type === "agent:create" && plain.metadata.action.suggestedRuntime, undefined);
});

test("prepare refuses an unknown, deprecated or flag-off runtime, naming the offered ids, and a cloud agent with one", async ({ app }) => {
  stubOrchestrator(app);
  const { server, prepare, refusal } = await seedServer();

  const unknown = await refusal({ suggestedRuntime: "gpt-cli" });
  assert.deepEqual([unknown.status, unknown.code], [422, "RUNTIME_NOT_OFFERED"]);
  assert.match(unknown.message, /^suggestedRuntime "gpt-cli" is not a runtime Raft knows\. Offered: claude \(Claude Code\), codex \(Codex CLI\), /);
  assert.match(unknown.message, /leave suggestedRuntime out so the person picks\.$/);
  assert.doesNotMatch(unknown.message, /gemini|copilot|\bkimi\b(?!-)/, "deprecated ids are not offered");
  assert.match(unknown.message, /antigravity \(Antigravity CLI\)/, "Antigravity is offered");

  const deprecated = await refusal({ suggestedRuntime: "gemini" });
  assert.equal(deprecated.code, "RUNTIME_NOT_OFFERED");
  assert.match(deprecated.message, /"gemini" is deprecated for new agents\. Offered: /);

  // Antigravity: offered with its OAR host flag off, and on.
  const flagOff = await prepare({ suggestedRuntime: "antigravity" });
  assert.equal(flagOff.metadata.action.type === "agent:create" && flagOff.metadata.action.suggestedRuntime, "antigravity");
  await getDb().insert(featureFlags).values({ key: "agent_runtime_oar_antigravity", randomizationUnit: "server", salt: "test", defaultEnabled: false }).onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({ id: randomUUID(), flagKey: "agent_runtime_oar_antigravity", stage: "server", priority: 0, decision: "allow", values: [server.id] });
  const flagOn = await prepare({ suggestedRuntime: "antigravity" });
  assert.equal(flagOn.metadata.action.type === "agent:create" && flagOn.metadata.action.suggestedRuntime, "antigravity");

  // A cloud agent runs on Raft's cloud runtime: no suggested runtime with it.
  const hosted = await refusal({ hosting: "antiproton", suggestedRuntime: "claude" });
  assert.equal(hosted.code, "INVALID_ACTION");
  assert.match(hosted.message, /suggestedRuntime/);
});

test("prepare refuses an agent:create description longer than a new agent's may be (#triage:#541)", async ({ app }) => {
  stubOrchestrator(app);
  const { prepare, refusal } = await seedServer();
  const fits = await prepare({ description: "y".repeat(300) });
  assert.equal(fits.metadata.action.type === "agent:create" && fits.metadata.action.description?.length, 300);
  const long = await refusal({ description: "y".repeat(301) });
  assert.deepEqual([long.status, long.code], [422, "DESCRIPTION_TOO_LONG"]);
  assert.match(long.message, /at most 300\. .*message after it is created\.$/);
});

test("with no runtime offered, the refusal says to leave suggestedRuntime out, not to pick from an empty list", () => {
  assert.equal(
    suggestedRuntimeNotOfferedMessage("codex", "is not enabled on this server", []),
    'suggestedRuntime "codex" is not enabled on this server. This server offers no runtime for new agents now; leave suggestedRuntime out.',
  );
  assert.equal(
    suggestedRuntimeNotOfferedMessage("gpt-cli", "is not a runtime Raft knows", ["claude", "kimi-sdk"]),
    'suggestedRuntime "gpt-cli" is not a runtime Raft knows. Offered: claude (Claude Code), kimi-sdk (Kimi Code). Use one of these ids, or leave suggestedRuntime out so the person picks.',
  );
});
