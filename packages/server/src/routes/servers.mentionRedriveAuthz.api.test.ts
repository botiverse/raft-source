import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";
import argon2 from "argon2";

import { getDb } from "../db/index.js";
import { serverMembers, users } from "../db/schema.js";
import { assignMachine, createAgent } from "../services/agentService.js";
import { registerMachine } from "../services/machineService.js";
import { createServer } from "../services/serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

/**
 * ARM ① of @Kabi's CHANGES REQUIRED on PR #6700 — the authorize layer.
 *
 * After the first two pushes he re-measured on 4743a991 and narrowed the finding to exactly this:
 * `authorizeMentionDeliveryDiagnostic`, "diagnostic/mention-delivery" and NOT_ACCESSIBLE each
 * appeared in ZERO changed test files. His reason for holding it open is worth preserving: he had
 * read the layer and judged the implementation CORRECT — three-way narrowing on role, machine and
 * agent, failing uniformly to 404 with no existence oracle. The finding is not "I think it is
 * wrong", it is "only one person has read it and no arm guards it". Those two together.
 *
 * THE DISCRIMINATOR IS THE BODY, NOT THE STATUS CODE. Unauthorized answers 404 NOT_ACCESSIBLE and
 * an unknown message answers 404 NOT_JOINABLE — deliberately identical codes, so the route leaks
 * no existence oracle. An arm asserting only `res.status === 404` would therefore pass even if
 * authorization were removed entirely, because the unknown-message path returns 404 anyway. That
 * is the failure this file has to avoid, so every assertion reads `status` out of the JSON.
 */

async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function login(baseUrl: string, email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(res.status, 200, `login failed for ${email}`);
  return (await res.json() as { accessToken: string }).accessToken;
}

test("redrive refuses a caller without agent-inspection rights, and says NOT_ACCESSIBLE", async ({ app }) => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`redrive-owner-${suffix}@slock.test`, `redrive-owner-${suffix}`);
  const outsider = await seedUser(`redrive-outsider-${suffix}@slock.test`, `redrive-outsider-${suffix}`);
  const server = await createServer(`Redrive Authz ${suffix}`, `redrive-authz-${suffix}`, owner.id);
  // An ordinary member: in the server, but without manageAgents and not the agent's creator.
  await db.insert(serverMembers)
    .values({ serverId: server.id, userId: outsider.id, role: "member" })
    .onConflictDoNothing();
  const machine = await registerMachine(server.id, owner.id, `redrive-machine-${suffix}`);
  const agent = await createAgent(server.id, `redrive-agent-${suffix}`, { runtime: "codex" });
  await assignMachine(agent.id, machine.machine.id);

  // The harness stubs agentOrchestrator and the stub has no redriveMentionDelivery, so an
  // AUTHORIZED call 500s with no `status` field. That would make the positive control read
  // `undefined` — indistinguishable from a dozen other failures. Give the stub the one method,
  // returning the verdict a real orchestrator gives for an unknown occurrence, so "cleared
  // authorization" has a POSITIVE signature instead of merely being "not NOT_ACCESSIBLE".
  (app.app.get("agentOrchestrator") as Record<string, unknown>).redriveMentionDelivery =
    async () => ({ status: "NOT_JOINABLE" as const });

  // Well-formed UUID naming no occurrence: it clears the shape guard, so the request reaches
  // authorization instead of being turned away before it.
  const messageId = randomUUID();
  const url = `${app.baseUrl}/api/servers/${server.id}/machines/${machine.machine.id}`
    + `/agents/${agent.id}/diagnostic/mention-delivery/${messageId}/redrive`;
  const body = JSON.stringify({ expectedVersion: 0 });

  const outsiderToken = await login(app.baseUrl, outsider.email);
  const refused = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${outsiderToken}`,
      "Content-Type": "application/json",
      "X-Server-Id": server.id,
    },
    body,
  });
  const refusedJson = await refused.json() as { status?: string };
  assert.equal(refused.status, 404, "an unauthorized redrive must not be distinguishable by code");
  assert.equal(refusedJson.status, "NOT_ACCESSIBLE", "the refusal must be the authorization one");

  // POSITIVE CONTROL. Without it, deleting the authorization check entirely would leave the
  // assertion above passing: an unknown message also answers 404, so "refused" and "allowed
  // through to a missing occurrence" are indistinguishable on the code alone. An authorized
  // caller must get PAST authorization and be told NOT_JOINABLE instead.
  const ownerToken = await login(app.baseUrl, owner.email);
  const allowed = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "Content-Type": "application/json",
      "X-Server-Id": server.id,
    },
    body,
  });
  const allowedJson = await allowed.json() as { status?: string };
  assert.notEqual(
    allowedJson.status,
    "NOT_ACCESSIBLE",
    "an owner (manageAgents) must clear authorization — otherwise this arm cannot fail",
  );
  assert.equal(allowedJson.status, "NOT_JOINABLE", "past authz, an unknown occurrence is NOT_JOINABLE");
});
