import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/index";
import { users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { createOAuthClient, issueHumanAuthorizationCode, requestAgentAccess } from "../services/oauthService";
import { encodeOidcAuthorizationCode } from "../services/oidcService";
import { createServer } from "../services/serverService";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { fixturePasswordHash, signInForTest } from "../test/integration/credentials";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

for (const kind of ["agent-code", "agent-request", "human-code", "human-oidc"] as const) {
  test(`PKCE downgrade rejects an unsolicited verifier for ${kind} without consuming the code`, async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    try {
      const suffix = randomUUID();
      const [owner] = await getDb().insert(users).values({
        email: `pkce-${suffix}@raft.test`, name: `pkce-${suffix}`,
        passwordHash: await fixturePasswordHash("password123"), emailVerified: true,
      }).returning();
      const server = await createServer("PKCE downgrade", `pkce-${suffix}`, owner.id);
      const redirectUri = "https://rp.example.test/login/generic_oauth";
      const { client, clientSecret } = await createOAuthClient({
        serverId: server.id, createdByUserId: owner.id, clientId: `pkce-${suffix.slice(0, 8)}`,
        name: "PKCE RP", returnUrl: redirectUri, allowedScopes: ["openid", "profile"],
      });
      let code: string;
      if (kind.startsWith("agent")) {
        const agent = await createAgent(server.id, "PkceAgent", { runtime: "external", model: "external" });
        const result = await requestAgentAccess({ clientId: client.id, serverSlug: server.slug, agentName: agent.name, scopes: ["openid", "profile"] });
        assert.equal(result.status, "approved");
        code = result.request.id;
      } else {
        const result = await issueHumanAuthorizationCode({ clientKey: client.clientId, userId: owner.id, serverId: server.id, returnUrl: redirectUri, scopes: ["openid", "profile"], approverSessionFamilyId: (await signInForTest(owner.id)).familyId });
        code = kind === "human-oidc"
          ? encodeOidcAuthorizationCode({ requestId: result.code, clientId: client.clientId, redirectUri })
          : result.code;
      }
      const exchange = (params: Record<string, unknown>, scoped = false) => fetch(
        `${app.baseUrl}${scoped ? `/oidc/${server.slug}` : ""}/api/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64")}` },
          body: JSON.stringify({
            grant_type: kind === "agent-request" ? "urn:slock:grant-type:agent_request" : "authorization_code",
            ...(kind === "agent-request" ? { requestId: code } : { code }),
            redirect_uri: redirectUri, ...params,
          }),
        },
      );
      // A relying party's own verifier must not turn an unrelated non-PKCE
      // code into a PKCE login. Presence, including empty/malformed values,
      // is rejected on both advertised token mounts before code consumption.
      for (const scoped of [false, true]) {
        for (const verifier of ["rp-verifier-abcdefghijklmnopqrstuvwxyz-0123456789", "", null, ["verifier"]]) {
          const response = await exchange({ code_verifier: verifier }, scoped);
          assert.equal(response.status, 400);
          const body = await response.json() as Record<string, unknown>;
          assert.equal(body.error, "invalid_grant");
          assert.equal("access_token" in body, false);
          assert.equal("id_token" in body, false);
        }
      }
      // Compatibility + non-consumption control: a legitimate non-PKCE
      // exchange still succeeds, once, when the parameter is absent.
      const legitimate = await exchange({});
      assert.equal(legitimate.status, 200);
      assert.ok((await legitimate.json() as { access_token: string }).access_token);
      assert.equal((await exchange({})).status, kind === "human-oidc" ? 400 : 409);
    } finally {
      await app.close();
    }
  });
}
