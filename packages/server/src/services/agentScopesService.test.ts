import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { getDb } from "../db/index.js";
import { agentScopes, users } from "../db/schema.js";
import { createAgent } from "./agentService.js";
import { loadAgentScopes, resetAgentScopesToDefault, updateAgentScopes } from "./agentScopesService.js";
import { createServer } from "./serverService.js";
import { AGENT_GRANTABLE_SCOPES } from "@botiverse/raft-shared";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedScopeAgent(slug: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${slug}@slock.test`,
    name: slug,
    displayName: slug,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer(`${slug} server`, `${slug}-server`, owner.id);
  const agent = await createAgent(server.id, `${slug}-agent`, { runtime: "codex" });
  return { owner, agent };
}

test("missing agent scope row uses default profile with all current grantable scopes", async ({ app }) => {
  const { agent } = await seedScopeAgent("scope-default");

  const set = await loadAgentScopes(agent.id);

  assert.equal(set.mode, "default");
  assert.deepEqual(set.granted, [...AGENT_GRANTABLE_SCOPES]);
  assert.equal(set.revision, 0);
});

test("saved custom profile does not auto-grant scopes missing from the stored set", async ({ app }) => {
  const db = getDb();
  const { owner, agent } = await seedScopeAgent("scope-custom");
  await db.insert(agentScopes).values({
    agentId: agent.id,
    serverId: agent.serverId,
    scopes: ["message:read"],
    mode: "custom",
    updatedByUserId: owner.id,
  });

  const set = await loadAgentScopes(agent.id);

  assert.equal(set.mode, "custom");
  assert.deepEqual(set.granted, ["message:read"]);
});

test("saving scopes marks the profile custom and reset restores default-following mode", async ({ app }) => {
  const { owner, agent } = await seedScopeAgent("scope-reset");

  const custom = await updateAgentScopes({
    agentId: agent.id,
    scopes: ["message:read"],
    updatedByUserId: owner.id,
  });
  assert.equal(custom.mode, "custom");
  assert.deepEqual(custom.granted, ["message:read"]);

  const reset = await resetAgentScopesToDefault({
    agentId: agent.id,
    updatedByUserId: owner.id,
  });

  assert.equal(reset.mode, "default");
  assert.deepEqual(reset.granted, [...AGENT_GRANTABLE_SCOPES]);
  assert.equal(reset.revision, custom.revision + 1);
});
