import assert from "node:assert/strict";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { normalizeManagedMcpOAuthClient, configuredManagedMcpOAuthStorage } from "./managedMcpOAuthClient";
import { ManagedMcpOAuthProvider } from "./managedMcpOAuthProvider";

test("OAuth client validation rejects incomplete credentials without reflecting input", () => {
  for (const bad of [[], "secret-value", { clientId: "id", clientSecret: "secret-value", tokenEndpointAuthMethod: "none" }, { clientId: "id", tokenEndpointAuthMethod: "client_secret_post" }, { clientId: "id", tokenEndpointAuthMethod: "none", authorizationUrl: "https://unexpected.example" }]) {
    assert.throws(() => normalizeManagedMcpOAuthClient(bad), (error: Error) => !error.message.includes("secret-value"));
  }
  assert.equal(normalizeManagedMcpOAuthClient(null), null);
  assert.equal(normalizeManagedMcpOAuthClient(undefined), undefined);
});

for (const method of ["none", "client_secret_post", "client_secret_basic"] as const) {
  test(`registered OAuth ${method} completes SDK redirect, code exchange, and refresh without DCR`, async () => {
    const storage = configuredManagedMcpOAuthStorage({ clientId: "registered-client", ...(method !== "none" ? { clientSecret: "registered-secret" } : {}), tokenEndpointAuthMethod: method, scope: "read:files", requestOfflineAccess: true });
    storage.redirectUrl = "https://raft.example.com/api/mcp/oauth/callback";
    storage.clientMetadataUrl = "https://raft.example.com/api/mcp/oauth/client-metadata";
    let saved = 0;
    const provider = new ManagedMcpOAuthProvider(storage, async () => { saved++; }, "fixed-state");
    const tokenRequests: Array<{ headers: Headers; params: URLSearchParams }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.includes("oauth-protected-resource")) return Response.json({ resource: "https://mcp.example.com/mcp", authorization_servers: ["https://auth.example.com"], scopes_supported: ["read:files", "write:files"] });
      if (url.pathname.includes(".well-known")) return Response.json({ issuer: "https://auth.example.com", authorization_endpoint: "https://auth.example.com/authorize", token_endpoint: "https://auth.example.com/token", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: [method] });
      if (url.pathname === "/token") {
        const params = new URLSearchParams(String(init?.body));
        tokenRequests.push({ headers: new Headers(init?.headers), params });
        return Response.json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600 });
      }
      throw new Error(`Unexpected OAuth request: ${url.origin}${url.pathname}`);
    };
    const options = { serverUrl: "https://mcp.example.com/mcp", scope: provider.clientMetadata.scope, fetchFn };
    assert.equal(await auth(provider, options), "REDIRECT");
    const redirect = new URL(provider.authorizationUrl!);
    assert.equal(redirect.searchParams.get("client_id"), "registered-client");
    assert.equal(redirect.searchParams.get("scope"), "read:files");
    assert.equal(redirect.searchParams.get("state"), "fixed-state");
    assert.equal(redirect.searchParams.get("code_challenge_method"), "S256");
    assert.equal(redirect.searchParams.get("access_type"), "offline");
    assert.ok(!redirect.toString().includes("registered-secret"));
    assert.equal(await auth(provider, { ...options, authorizationCode: "code" }), "AUTHORIZED");
    assert.equal(tokenRequests[0].params.get("grant_type"), "authorization_code");
    assert.ok(tokenRequests[0].params.get("code_verifier"));
    // SDK auth() with stored refresh token exchanges it rather than registering again.
    assert.equal(await auth(provider, options), "AUTHORIZED");
    assert.equal(tokenRequests[1].params.get("grant_type"), "refresh_token");
    for (const request of tokenRequests) {
      if (method === "client_secret_basic") assert.equal(request.headers.get("authorization"), `Basic ${Buffer.from("registered-client:registered-secret").toString("base64")}`);
      else assert.equal(request.params.get("client_secret"), method === "none" ? null : "registered-secret");
    }
    await provider.invalidateCredentials("all");
    assert.equal(provider.clientInformation()?.client_id, "registered-client");
    assert.equal(provider.tokens(), undefined);
    assert.ok(saved > 0);
  });
}
