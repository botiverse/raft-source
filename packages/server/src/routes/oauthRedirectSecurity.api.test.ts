import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest.js";
import { signAccessToken } from "../middleware/auth.js";
import { oauthClients } from "../db/schema.js";
import { createOAuthClient, updateOAuthClient } from "../services/oauthService.js";

const test = createApiTest({ onboardingOpenerFlagDefaultEnabled: false });

for (const scenario of ["unregistered", "legacy-javascript", "mismatch", "valid"] as const) {
  test(`human OAuth callback rejects unsafe redirects: ${scenario}`, async ({ app, seed, db }) => {
    const owner = await seed.human();
    const server = await seed.server({ owner });
    const callback = "https://client.example.test/callback";
    const { client } = await createOAuthClient({
      serverId: server.id, createdByUserId: owner.id, name: "Audit callback",
      returnUrl: scenario === "unregistered" ? null : callback,
    });
    const returnUrl = scenario === "legacy-javascript" ? "javascript:window.auditExecuted=true//"
      : scenario === "valid" ? callback : "https://attacker.example.test/callback";
    if (scenario === "legacy-javascript") {
      // Model an unsafe URL registered before the fix; write validation alone
      // cannot protect existing clients.
      await db.update(oauthClients).set({ returnUrl }).where(eq(oauthClients.id, client.id));
    }
    const response = await fetch(`${app.baseUrl}/api/oauth/authorize/human`, {
      method: "POST", headers: { Authorization: `Bearer ${signAccessToken(owner.id)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: client.clientId, serverId: server.id, returnUrl, scopes: ["openid", "profile"] }),
    });
    const body = await response.json() as { code?: string; returnUrl?: string };
    assert.equal(response.status, scenario === "valid" ? 200 : 400);
    if (scenario === "valid") { assert.ok(body.code); assert.equal(body.returnUrl, callback); }
    else assert.equal(body.code, undefined, "rejected navigation must not issue an authorization code");
  });
}

test("OAuth client creation and update reject script return URLs", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const input = { serverId: server.id, createdByUserId: owner.id, name: "Audit registration" };
  await assert.rejects(createOAuthClient({ ...input, returnUrl: "javascript:alert(1)" }), /returnUrl/);
  const { client } = await createOAuthClient({ ...input, returnUrl: "https://client.example.test/callback" });
  await assert.rejects(updateOAuthClient({ serverId: server.id, clientId: client.id, returnUrl: "data:text/html,test" }), /returnUrl/);
});
