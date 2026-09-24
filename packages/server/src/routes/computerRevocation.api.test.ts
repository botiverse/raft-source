import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import argon2 from "argon2";
import { vi } from "vitest";
import { createApiTest } from "../test/integration/apiTest.js";
import { signAccessToken } from "../middleware/auth.js";
import { computers, machines } from "../db/schema.js";
import { createAgent } from "../services/agentService.js";
import { registerMachine } from "../services/machineService.js";
import { findComputerByApiKey, findComputerByApiKeyWithReason } from "../services/computerCredentialService.js";

const test = createApiTest({ onboardingOpenerFlagDefaultEnabled: false });

test("deleting a Computer's machine revokes its key before it can mint another agent credential", async ({ app, seed, db }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const headers = { Authorization: `Bearer ${signAccessToken(owner.id)}`, "Content-Type": "application/json", "X-Server-Id": server.id };
  const attached = await fetch(`${app.baseUrl}/api/computer/attach`, {
    method: "POST", headers, body: JSON.stringify({ serverSlug: server.slug, name: "audit-computer" }),
  });
  assert.equal(attached.status, 201, await attached.clone().text());
  const computer = await attached.json() as { apiKey: string; machineId: string };
  const { machine: otherMachine } = await registerMachine(server.id, owner.id, "audit-other-machine");
  const agent = await createAgent(server.id, "AuditTarget", { runtime: "claude", model: "sonnet", machineId: otherMachine.id });
  const mint = () => fetch(`${app.baseUrl}/internal/computer/runners/${agent.id}/credentials`, {
    method: "POST", headers: { Authorization: `Bearer ${computer.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const before = await fetch(`${app.baseUrl}/internal/computer/runners`, { headers: { Authorization: `Bearer ${computer.apiKey}` } });
  assert.equal(before.status, 200, await before.text());
  const removed = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${computer.machineId}`, { method: "DELETE", headers });
  assert.equal(removed.status, 200, await removed.text());
  const after = await mint();
  const status = after.status;
  await after.text();
  assert.equal(status, 401, "deleted machine's Computer key must not mint a fresh agent key");
  const [row] = await db.select().from(computers).where(eq(computers.serverId, server.id));
  assert.ok(row.revokedAt, "retain a durable revocation receipt before the FK clears machineId");
  assert.equal(row.machineId, null);
});

for (const change of ["old-orphan", "delete-during-verify"] as const) {
  test(`Computer authentication rejects ${change} through both HTTP and daemon lookup`, async ({ app, seed, db }) => {
    const owner = await seed.human();
    const server = await seed.server({ owner });
    const attached = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST", headers: { Authorization: `Bearer ${signAccessToken(owner.id)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ serverSlug: server.slug, name: "audit-orphan" }),
    });
    assert.equal(attached.status, 201);
    const { apiKey, machineId } = await attached.json() as { apiKey: string; machineId: string };
    assert.ok(await findComputerByApiKey(apiKey));
    // Direct deletion models historical pre-fix FK SET NULL, with no receipt.
    const remove = () => db.delete(machines).where(eq(machines.id, machineId));
    const verify = argon2.verify.bind(argon2);
    const spy = change === "delete-during-verify" ? vi.spyOn(argon2, "verify").mockImplementationOnce(async (...args) => {
      const valid = await verify(...args); await remove(); return valid;
    }) : null;
    try {
      if (change === "old-orphan") await remove();
      assert.equal(await findComputerByApiKey(apiKey), null);
      const reason = await findComputerByApiKeyWithReason(apiKey);
      assert.deepEqual(reason, { ok: false, reason: "computer_machine_unlinked" });
      const response = await fetch(`${app.baseUrl}/internal/computer/runners`, { headers: { Authorization: `Bearer ${apiKey}` } });
      assert.equal(response.status, 401); await response.text();
    } finally { spy?.mockRestore(); }
  });
}
