import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "../db/index";
import { agents, oauthClients, serverAgentMembers, servers, users } from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { getOidcJwks, signOidcIdToken } from "../services/oidcService";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
const enabled = process.env.AGENT_JWT_GRAFANA_REQUIRED === "1";

test.skipIf(!enabled)("issued JWT interoperates with real Grafana 12.4.12 without creating a login session", async () => {
  const envNames = ["RAFT_OIDC_SIGNING_PRIVATE_KEY", "RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS", "SERVER_URL"] as const;
  const previous = envNames.map((name) => process.env[name]);
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  delete process.env.RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS;
  process.env.SERVER_URL = "https://issuer.example.test";
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "raft-jwt-grafana-"));
  const container = `raft-jwt-test-${randomUUID().slice(0, 8)}`;
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const suffix = randomUUID();
    const [owner] = await getDb().insert(users).values({ name: `jwt-${suffix}`, email: `jwt-${suffix}@raft.test`, passwordHash: "fixture", emailVerified: true }).returning();
    const [server] = await getDb().insert(servers).values({ name: "Grafana fixture", slug: `jwt-${suffix}`, ownerId: owner.id }).returning();
    const [agent] = await getDb().insert(agents).values({ serverId: server.id, name: "grafana-agent" }).returning();
    await getDb().insert(serverAgentMembers).values({ serverId: server.id, agentId: agent.id });
    const [client] = await getDb().insert(oauthClients).values({ serverId: server.id, createdByUserId: owner.id, name: "Grafana", clientId: "test-grafana", clientSecretHash: "fixture", allowedScopes: ["openid", "profile"], enabled: true, appType: "server_local" }).returning();
    const credential = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "grafana-e2e", issuedVia: "computer", createdByUserId: null });
    const issuer = `https://issuer.example.test/oidc/${server.slug}`;
    fs.writeFileSync(path.join(folder, "jwks.json"), JSON.stringify(getOidcJwks()), { mode: 0o644 });
    fs.chmodSync(folder, 0o755); // only public JWKS, needed by the container user
    const expectations = { iss: issuer, aud: client.clientId, type: "agent", token_use: "agent_access", server_id: server.id };
    const settings = {
      GF_AUTH_JWT_ENABLED: "true", GF_AUTH_JWT_HEADER_NAME: "X-Raft-JWT", GF_AUTH_JWT_URL_LOGIN: "false",
      GF_AUTH_JWT_JWK_SET_FILE: "/etc/grafana/raft-jwks.json", GF_AUTH_JWT_USERNAME_CLAIM: "login",
      GF_AUTH_JWT_AUTO_SIGN_UP: "true", GF_AUTH_JWT_EXPECT_CLAIMS: JSON.stringify(expectations),
      GF_AUTH_JWT_ROLE_ATTRIBUTE_PATH: `type == 'agent' && server_slug == '${server.slug}' && 'Viewer'`,
      GF_AUTH_JWT_ROLE_ATTRIBUTE_STRICT: "true", GF_AUTH_JWT_ALLOW_ASSIGN_GRAFANA_ADMIN: "false",
      GF_AUTH_ANONYMOUS_ENABLED: "false", GF_ANALYTICS_REPORTING_ENABLED: "false",
      GF_ANALYTICS_CHECK_FOR_UPDATES: "false", GF_PLUGINS_PREINSTALL_DISABLED: "true",
    };
    execFileSync("docker", ["run", "--rm", "-d", "--name", container, "-p", "127.0.0.1::3000", "-v", `${folder}/jwks.json:/etc/grafana/raft-jwks.json:ro`, ...Object.entries(settings).flatMap(([key, value]) => ["-e", `${key}=${value}`]), "grafana/grafana:12.4.12"], { stdio: "pipe" });
    const address = execFileSync("docker", ["port", container, "3000"], { encoding: "utf8" }).trim();
    const base = `http://${address}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      const response = await fetch(`${base}/api/health`).catch(() => null);
      if (response?.ok) { const health = await response.json() as { version: string }; assert.equal(health.version, "12.4.12"); ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(ready, true, "Grafana must actually start");
    const issuedResponse = await fetch(`${app.baseUrl}/internal/agent-api/integrations/token`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential.apiKey}` }, body: JSON.stringify({ service: client.clientId }) });
    assert.equal(issuedResponse.status, 200);
    const issued = await issuedResponse.json() as { access_token: string };
    const headers = { "X-Raft-JWT": issued.access_token };
    const userResponse = await fetch(`${base}/api/user`, { headers, redirect: "manual" });
    assert.equal(userResponse.status, 200);
    const user = await userResponse.json() as { login: string; isGrafanaAdmin: boolean };
    assert.equal(user.login, `raft-agent-${agent.id}`);
    assert.equal(user.isGrafanaAdmin, false);
    assert.doesNotMatch(userResponse.headers.get("set-cookie") ?? "", /grafana_session/);
    const orgs = await (await fetch(`${base}/api/user/orgs`, { headers })).json() as { role: string }[];
    assert.equal(orgs[0].role, "Viewer");
    assert.equal((await fetch(`${base}/api/user`, { redirect: "manual" })).status, 401, "no JWT means no carried-over identity");

    const [encodedHeader, encodedClaims] = issued.access_token.split(".");
    const claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString());
    const signedVariant = (change: Record<string, unknown>) => {
      const payload = Buffer.from(JSON.stringify({ ...claims, ...change })).toString("base64url");
      const input = `${encodedHeader}.${payload}`;
      return `${input}.${sign("sha256", Buffer.from(input), { key: pair.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    };
    for (const change of [{ iss: "https://wrong.example" }, { aud: "other-service" }, { server_id: randomUUID() }, { type: "human" }, { token_use: "id_token" }, { exp: 1 }]) {
      assert.equal((await fetch(`${base}/api/user`, { headers: { "X-Raft-JWT": signedVariant(change) } })).status, 401, `reject ${Object.keys(change)[0]}`);
    }
    const idToken = signOidcIdToken({ issuer, expiresInSeconds: 3600, identity: { sub: agent.id, clientId: client.clientId, scopes: ["openid", "profile"], type: "agent", serverId: server.id, serverSlug: server.slug, serverRole: "member", preferredUsername: agent.name } });
    assert.equal((await fetch(`${base}/api/user`, { headers: { "X-Raft-JWT": idToken } })).status, 401);
    const parts = issued.access_token.split(".");
    const tampered = `${parts[0]}.${Buffer.from(JSON.stringify({ ...claims, name: "tampered" })).toString("base64url")}.${parts[2]}`;
    assert.equal((await fetch(`${base}/api/user`, { headers: { "X-Raft-JWT": tampered } })).status, 401);
    const logs = execFileSync("docker", ["logs", container], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(logs.includes(issued.access_token), false);
    assert.equal(logs.includes(credential.apiKey), false);
  } finally {
    try { execFileSync("docker", ["rm", "-f", container], { stdio: "pipe" }); } catch { /* start may have failed */ }
    fs.rmSync(folder, { recursive: true, force: true });
    envNames.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    await app.close();
  }
});
