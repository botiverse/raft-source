import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// An agent's own card JSON that fails the server's checks (contract with
// Sage, #proj-apps:5eafd481): 400 INVALID_ACTION, `error` one short
// sentence, and everything to fix in `suggestedNextAction` (raft-sdk shows
// only the code and that): each wrong field as `path: reason`, at most ten,
// then the card types this server accepts, derived from the schema less the
// integration-command types, and feedback:submit where Hands feedback is not
// configured.
//
// The Agent API contract still checks `action` strictly before the route
// runs, so an unknown type or a missing field reaches prepareActionCard only
// through the legacy machine route (or once that contract is loosened); a
// cross-field error reaches it through both.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import {
  actionCardActionSchema,
  INVALID_ACTION_CARD_MAX_ISSUES,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { actionCards, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { registerMachine } from "../services/machineService";
import * as channelService from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import {
  ActionCardError,
  INTEGRATION_COMMAND_ACTION_TYPES,
  preparableActionCardTypes,
  prepareActionCard,
} from "../services/actionCardsService";
import { withHandsFeedbackConfigured, withoutHandsFeedback } from "../test/handsFeedbackStub";
import { useStripeBillingConfigured } from "../test/stripeBillingEnv";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
useStripeBillingConfigured();

const REQUEST_TIMEOUT_MS = 120_000;
/** The refusal's `error`: the same field list, for CLIs that print only `error`. */
const sentence = (fields: string): string => `The action card failed validation: ${fields}.`;
const FIX = "Fix these fields and run it again: ";

/** The schema's own discriminator values: the source validation uses, not a copy of the list. */
const schemaTypes = (): string[] => actionCardActionSchema.options.map((option) => option.shape.type.value);

async function seedWorld() {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb().insert(users).values({
    email: `invalid-card-owner-${suffix}@test.invalid`,
    name: `invalid-card-owner-${suffix}`,
    displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Invalid Cards", `invalid-cards-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, "card-scout", { runtime: "claude" });
  const room = await channelService.createChannel(server.id, `card-room-${suffix.slice(0, 6)}`);
  await channelService.addHuman(room.id, owner!.id);
  await channelService.addAgent(room.id, agent.id);
  const { machine, apiKey: machineKey } = await registerMachine(server.id, owner!.id, "card-machine");
  await placeAgentOnMachine(agent.id, machine.id);
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read", "tasks"], name: "invalid-card", issuedVia: "computer", createdByUserId: null });
  return { server, agent, room, machineKey, apiKey };
}

type World = Awaited<ReturnType<typeof seedWorld>>;

async function refusal(world: World, action: unknown, options: { agentAuthored?: boolean } = { agentAuthored: true }) {
  try {
    await prepareActionCard({
      serverId: world.server.id,
      requesterAgentId: world.agent.id,
      targetChannelId: world.room.id,
      action: action as never,
      ...options,
    });
  } catch (error) {
    assert.ok(error instanceof ActionCardError, String(error));
    return error;
  }
  assert.fail("expected a refusal");
}

/** `Card types this server accepts: …` as the answer ends, on this deployment now. */
function acceptedTail(): string {
  return ` Card types this server accepts: ${preparableActionCardTypes().join(", ")}.`;
}

async function cardCount(serverId: string): Promise<number> {
  return (await getDb().select().from(actionCards).where(eq(actionCards.serverId, serverId))).length;
}

type Refusal = { error?: string; errorCode?: string; code?: string; suggestedNextAction?: string };

async function refusedBody(response: Response): Promise<Refusal> {
  assert.equal(response.status, 400, await response.clone().text());
  return await response.json() as Refusal;
}

test("the accepted card types are the schema's, less integration-command types and feedback:submit without Hands feedback", async ({ db }) => {
  void db;
  const world = await seedWorld();
  const preparable = schemaTypes().filter((type) => !INTEGRATION_COMMAND_ACTION_TYPES.has(type));
  assert.ok(preparable.includes("channel:create"));

  await withHandsFeedbackConfigured(async () => {
    // No card type has a flag any more: feedback:submit, question:ask and plan:upgrade are listed with no flag row at all.
    assert.deepEqual(preparableActionCardTypes(), preparable);
    assert.ok(preparable.includes("plan:upgrade"));
  });

  // Without Hands feedback (self-hosted, local) prepare refuses feedback:submit, so it is not offered; nothing else changes.
  await withoutHandsFeedback(async () => {
    assert.deepEqual(preparableActionCardTypes(), preparable.filter((type) => type !== "feedback:submit"));
    const unknown = await refusal(world, { type: "channel:delete", name: "old-room" });
    assert.doesNotMatch(String(unknown.suggestedNextAction), /feedback:submit/);
  });
});

test("prepare names each wrong field and the accepted card types, in one bounded next step", async ({ db }) => {
  void db;
  const world = await seedWorld();
  const tail = acceptedTail();

  const unknown = await refusal(world, { type: "channel:delete", name: "old-room" });
  assert.deepEqual([unknown.status, unknown.code, unknown.message], [400, "INVALID_ACTION", sentence('type: unknown card type "channel:delete"')]);
  assert.equal(unknown.suggestedNextAction, `${FIX}type: unknown card type "channel:delete".${tail}`);

  const missing = await refusal(world, { type: "channel:create" });
  assert.equal(missing.code, "INVALID_ACTION");
  assert.equal(missing.suggestedNextAction, `${FIX}name: required.${tail}`);
  // Zod's default text becomes a short reason by kind of issue.
  const shapes = await refusal(world, { type: "agent:create", name: "x".repeat(61), hosting: "cloud", description: 7 });
  assert.equal(shapes.suggestedNextAction, `${FIX}name: at most 60 characters; description: must be a string; hosting: must be one of computer, antiproton.${tail}`);

  // validateActionCardAction's rules, by the field they are about.
  const crossField = await refusal(world, { type: "agent:create", name: "helper", model: "gpt-5.6-luna" });
  assert.deepEqual([crossField.status, crossField.code, crossField.message], [400, "INVALID_ACTION", sentence('model: agent:create model is only for a cloud agent (hosting: "antiproton")')]);
  assert.equal(crossField.suggestedNextAction, `${FIX}model: agent:create model is only for a cloud agent (hosting: "antiproton").${tail}`);
  const noMembers = await refusal(world, { type: "channel:add_member", channel: world.room.name });
  assert.equal(noMembers.suggestedNextAction, `${FIX}action: channel:add_member must include at least one human or agent.${tail}`);

  // Many wrong fields: the first ten, then how many more.
  const many = await refusal(world, { type: "channel:add_member", channel: world.room.name, humans: Array.from({ length: 30 }, (_, i) => i) });
  const listed = Array.from({ length: INVALID_ACTION_CARD_MAX_ISSUES }, (_, i) => `humans.${i}: must be a string`);
  assert.equal(many.suggestedNextAction, `${FIX}${listed.join("; ")}; and ${30 - INVALID_ACTION_CARD_MAX_ISSUES} more.${tail}`);
  // A huge unknown type is not echoed whole.
  const huge = await refusal(world, { type: "x".repeat(100_000) });
  assert.ok(huge.suggestedNextAction!.length < 1_000, huge.suggestedNextAction);
  assert.match(huge.suggestedNextAction!, /^Fix these fields and run it again: type: unknown card type "x+…"\./);
  assert.equal(await cardCount(world.server.id), 0);
});

test("an action the server builds from a command's flags keeps INVALID_PAYLOAD and the check's own text", async ({ db }) => {
  void db;
  const world = await seedWorld();
  const schema = await refusal(world, { type: "channel:create" }, {});
  assert.deepEqual([schema.status, schema.code], [400, "INVALID_PAYLOAD"]);
  assert.equal(schema.suggestedNextAction, undefined);
  assert.match(schema.message, /expected string, received undefined/, "Zod's own text, as before");
  const crossField = await refusal(world, { type: "agent:create", name: "helper", model: "gpt-5.6-luna" }, {});
  assert.deepEqual([crossField.code, crossField.message], ["INVALID_PAYLOAD", 'agent:create model is only for a cloud agent (hosting: "antiproton")']);
});

test("the Agent API answers a cross-field error with INVALID_ACTION and the next step", async ({ app }) => {
  const world = await seedWorld();
  const response = await fetch(`${app.baseUrl}/internal/agent-api/prepare-action`, {
    method: "POST",
    headers: { Authorization: `Bearer ${world.apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({ target: `#${world.room.name}`, action: { type: "channel:add_member", channel: world.room.name } }),
  });
  const body = await refusedBody(response);
  assert.deepEqual(body, {
    error: sentence("action: channel:add_member must include at least one human or agent"),
    errorCode: "INVALID_ACTION",
    suggestedNextAction: `${FIX}action: channel:add_member must include at least one human or agent.${acceptedTail()}`,
  });
  assert.equal(await cardCount(world.server.id), 0);
});

test("the legacy machine route answers an unknown type and a missing field the same way", async ({ app }) => {
  const world = await seedWorld();
  const tail = acceptedTail();
  assert.match(tail, /plan:upgrade/);
  const post = (action: unknown) => fetch(`${app.baseUrl}/internal/agent/${world.agent.id}/prepare-action`, {
    method: "POST",
    headers: { Authorization: `Bearer ${world.machineKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({ target: `#${world.room.name}`, action }),
  });

  assert.deepEqual(await refusedBody(await post({ type: "channel:delete" })), {
    error: sentence('type: unknown card type "channel:delete"'),
    errorCode: "INVALID_ACTION",
    suggestedNextAction: `${FIX}type: unknown card type "channel:delete".${tail}`,
  });
  assert.deepEqual(await refusedBody(await post({ type: "channel:create", visibility: "public" })), {
    error: sentence("name: required"),
    errorCode: "INVALID_ACTION",
    suggestedNextAction: `${FIX}name: required.${tail}`,
  });
  // A message the schema wrote itself stays: it already says why.
  assert.deepEqual(await refusedBody(await post({ type: "plan:upgrade", gate: "history_30d" })), {
    error: sentence('reason: plan:upgrade needs "reason": one plain sentence (up to 200 characters) saying why this person needs Pro'),
    errorCode: "INVALID_ACTION",
    suggestedNextAction: `${FIX}reason: plan:upgrade needs "reason": one plain sentence (up to 200 characters) saying why this person needs Pro.${tail}`,
  });
  assert.equal(await cardCount(world.server.id), 0);
});

// Refusal slice 7: a target the agent can't write to answers as on send
// (agentRouteRefusals.unwritableTargetRefusal), on both prepare routes. A
// missing channel and a private one the agent isn't in read the same; a public
// channel it can see but isn't in is 403.
test("both prepare routes refuse an unwritable target the way send does", async ({ app }) => {
  const world = await seedWorld();
  const suffix = randomUUID().slice(0, 6);
  const hidden = await channelService.createChannel(world.server.id, `hidden-${suffix}`, undefined, "private");
  const open = await channelService.createChannel(world.server.id, `open-${suffix}`);
  const routes = [
    { url: `${app.baseUrl}/internal/agent-api/prepare-action`, key: world.apiKey },
    { url: `${app.baseUrl}/internal/agent/${world.agent.id}/prepare-action`, key: world.machineKey },
  ];
  const action = { type: "channel:create", name: `new-${suffix}`, visibility: "public" };
  for (const route of routes) {
    const post = (target: string) => fetch(route.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${route.key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({ target, action }),
    });
    const missing = await post(`#no-such-${suffix}`);
    const missingBody = await missing.json() as Refusal;
    assert.equal(missing.status, 404, JSON.stringify(missingBody));
    assert.equal(missingBody.code, "target_not_found");
    assert.match(String(missingBody.error), /^Nothing you can post in matches #no-such-/);

    const privateMiss = await post(`#${hidden.name}`);
    const privateBody = await privateMiss.json() as Refusal;
    assert.equal(privateMiss.status, 404, JSON.stringify(privateBody));
    assert.equal(privateBody.code, "target_not_found");
    assert.equal(privateBody.error, String(missingBody.error).replace(`#no-such-${suffix}`, `#${hidden.name}`), "hidden reads as missing");

    const notMember = await post(`#${open.name}`);
    const notMemberBody = await notMember.json() as Refusal;
    assert.equal(notMember.status, 403, JSON.stringify(notMemberBody));
    assert.equal(notMemberBody.code, "target_forbidden");
  }
  assert.equal(await cardCount(world.server.id), 0);
});
