import assert from "node:assert/strict";
import dns from "node:dns";
import { vi } from "vitest";
import { parseErrorResponse, registerClient, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidClientError, InvalidGrantError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  isManagedMcpAddressAllowed,
  ManagedMcpGatewayError,
  managedMcpOAuthFailureDetail,
  managedMcpOAuthStartError,
  completeManagedMcpOAuth,
  callManagedMcpTool,
  createSafeFetch,
  startManagedMcpOAuth,
  normalizeManagedMcpClientError,
  normalizeManagedMcpClientErrorForConnection,
  normalizeManagedMcpToolCatalog,
  validateManagedMcpEndpoint,
} from "./managedMcpGateway";
import { applyManagedMcpOAuthClientPolicy, managedMcpOAuthClientPolicy } from "@botiverse/raft-shared";
import { ManagedMcpOAuthProvider, type ManagedMcpOAuthStorage } from "./managedMcpOAuthProvider";
import { probeManagedMcpEndpoint } from "./managedMcpProbe";

test("DNS policy refusals remain distinct from empty results and unrelated DNS errors", async () => {
  const lookup = vi.spyOn(dns.promises, "lookup");
  const endpoint = "https://policy-probe.example.test/mcp";
  try {
    lookup.mockResolvedValue([{ address: "198.18.0.1", family: 4 }] as never);
    const blocked = await probeManagedMcpEndpoint(endpoint);
    assert.equal(blocked.error?.code, "managed_mcp_endpoint_blocked");
    const sharedFetch = createSafeFetch();
    try {
      await assert.rejects(sharedFetch.fetch(endpoint), (error: unknown) => error instanceof TypeError && (error.cause as NodeJS.ErrnoException | undefined)?.code === "EACCES");
    } finally {
      await sharedFetch.close();
    }
    const provider = new ManagedMcpOAuthProvider({ redirectUrl: "https://raft.example.test/callback" }, async () => {}, "test-state");
    await assert.rejects(startManagedMcpOAuth(endpoint, provider), { code: "managed_mcp_endpoint_blocked" });
    await assert.rejects(completeManagedMcpOAuth(endpoint, provider, "synthetic-code"), { code: "managed_mcp_endpoint_blocked" });
    await assert.rejects(callManagedMcpTool({ endpoint, headers: {}, name: "search", arguments: {} }), { code: "managed_mcp_endpoint_blocked" });

    lookup.mockResolvedValue([] as never);
    assert.equal((await probeManagedMcpEndpoint(endpoint)).error?.code, "managed_mcp_unreachable");
    await assert.rejects(startManagedMcpOAuth(endpoint, provider), { code: "managed_mcp_unreachable" });
    lookup.mockRejectedValue(Object.assign(new Error("unrelated DNS permission failure"), { code: "EACCES" }));
    assert.equal((await probeManagedMcpEndpoint(endpoint)).error?.code, "managed_mcp_unreachable");
    await assert.rejects(startManagedMcpOAuth(endpoint, provider), { code: "managed_mcp_unreachable" });
  } finally {
    lookup.mockRestore();
  }
});

test("managed MCP endpoint validation accepts public HTTPS endpoints", () => {
  assert.equal(validateManagedMcpEndpoint("https://docs.mcp.cloudflare.com/mcp").toString(), "https://docs.mcp.cloudflare.com/mcp");
  assert.equal(
    validateManagedMcpEndpoint("https://auth.example.com/authorize?response_type=code&state=opaque").searchParams.get("state"),
    "opaque",
    "OAuth authorization URLs keep standard query parameters",
  );
  assert.equal(isManagedMcpAddressAllowed("8.8.8.8"), true);
  assert.equal(isManagedMcpAddressAllowed("2606:4700:4700::1111"), true);
});

test("a template endpoint with a non-secret query can start OAuth with a synthetic provider", async () => {
  const endpoint = "https://mcp.example.test/mcp?region=example";
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "mcp.example.test" && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({ resource: endpoint, authorization_servers: ["https://auth.example.test"] });
    }
    if (url.hostname === "auth.example.test" && url.pathname.startsWith("/.well-known/")) {
      return Response.json({
        issuer: "https://auth.example.test",
        authorization_endpoint: "https://auth.example.test/authorize",
        token_endpoint: "https://auth.example.test/token",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const provider = new ManagedMcpOAuthProvider({
    redirectUrl: "https://raft.example.test/api/mcp/oauth/callback",
    configuredClient: { clientId: "fixture-client", clientSecret: "fixture-secret", tokenEndpointAuthMethod: "client_secret_post" },
  }, async () => {}, "fixed-state");
  assert.equal(await startManagedMcpOAuth(endpoint, provider, fakeFetch), "REDIRECT");
});

test("managed MCP endpoint validation rejects unsafe URL forms", () => {
  for (const url of [
    "http://example.com/mcp",
    "https://user:pass@example.com/mcp",
    "https://example.com/mcp#fragment",
    "https://localhost/mcp",
    "https://service.internal/mcp",
    "https://127.0.0.1/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/mcp",
  ]) {
    assert.throws(() => validateManagedMcpEndpoint(url), ManagedMcpGatewayError, url);
  }
});

test("managed MCP address policy blocks private, reserved, translated, and mapped addresses", () => {
  for (const address of [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "172.16.0.1", "192.88.99.1", "192.168.1.1",
    "::1", "64:ff9b::1", "100::1", "2001:db8::1", "2002::1", "3fff::1", "5f00::1",
    "fc00::1", "fe80::1", "::ffff:127.0.0.1",
  ]) {
    assert.equal(isManagedMcpAddressAllowed(address), false, address);
  }
});

test("managed MCP client errors distinguish reconnect-required OAuth from transient provider failures", () => {
  for (const error of [
    new UnauthorizedError(),
    new InvalidGrantError("refresh token revoked"),
    new StreamableHTTPError(401, "token rejected after refresh"),
  ]) {
    // These SDK OAuth errors can only arise on OAuth connections.
    assert.equal(normalizeManagedMcpClientError(error, false, 'oauth').code, "managed_mcp_oauth_required");
  }
  assert.equal(normalizeManagedMcpClientError(new ServerError("temporarily unavailable"), false).code, "managed_mcp_unreachable");
  assert.equal(normalizeManagedMcpClientError(new Error("network reset"), false).code, "managed_mcp_unreachable");
  assert.equal(normalizeManagedMcpClientError(new Error("deadline"), true).message, "MCP request timed out");
});

test("managed MCP catalog normalization bounds schemas and keeps only typed annotations", () => {
  assert.deepEqual(normalizeManagedMcpToolCatalog([{
    name: "search",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true, unexpected: "discard" },
  }]), [{
    name: "search",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true },
  }]);
  assert.throws(() => normalizeManagedMcpToolCatalog([{
    name: " padded ",
    inputSchema: { type: "object" },
  }]), ManagedMcpGatewayError);
  assert.throws(() => normalizeManagedMcpToolCatalog([{
    name: "huge",
    inputSchema: { type: "object", examples: ["x".repeat(600 * 1024)] },
  }]), ManagedMcpGatewayError);
});

test("managed MCP 401/403 copy follows the connection auth mode (afe07b8d right-cause)", () => {
  const rejected = new StreamableHTTPError(401, "Unauthorized");
  // authMode=none/headers: endpoint rejection must never wear OAuth wording
  const none = normalizeManagedMcpClientError(rejected, false, 'none');
  assert.equal(none.code, "managed_mcp_endpoint_auth_rejected");
  assert.ok(!/oauth/i.test(none.message), `none-mode copy leaked OAuth wording: ${none.message}`);
  const forbidden = new StreamableHTTPError(403, "Forbidden");
  assert.equal(normalizeManagedMcpClientError(forbidden, false, 'none').code, "managed_mcp_endpoint_auth_rejected");
  // mirror tooth: a real OAuth connection keeps the reconnect contract
  const oauth = normalizeManagedMcpClientError(rejected, false, 'oauth');
  assert.equal(oauth.code, "managed_mcp_oauth_required");
  assert.match(oauth.message, /OAuth authorization expired/);
  // OAuth SDK-level unauthorized is still reconnect for OAuth connections only
  assert.equal(normalizeManagedMcpClientError(new UnauthorizedError(), false, 'oauth').code, "managed_mcp_oauth_required");
  // non-auth statuses stay unreachable regardless of mode
  assert.equal(normalizeManagedMcpClientError(new StreamableHTTPError(500, "boom"), false, 'none').code, "managed_mcp_unreachable");
});

test("managed MCP headers-mode 401 copy names configured credentials (Tao A)", () => {
  const copy = normalizeManagedMcpClientError(new StreamableHTTPError(401, "Unauthorized"), false, "headers");
  assert.equal(copy.code, "managed_mcp_endpoint_auth_rejected");
  assert.match(copy.message, /configured credentials/);
  assert.ok(!/oauth/i.test(copy.message));
  assert.ok(!/without credentials/.test(copy.message));
});

test("managed MCP OAuth transport path keeps reconnect copy when provider rejects with 401", () => {
  const copy = normalizeManagedMcpClientErrorForConnection(
    new StreamableHTTPError(401, "Unauthorized"),
    false,
    {},
    {} as never,
  );
  assert.equal(copy.code, "managed_mcp_oauth_required");
  assert.match(copy.message, /OAuth authorization expired/);
});

test("catalog pagination retrieves later tools and rejects loops, duplicate names, and aggregate overflow", async () => {
  const { collectManagedMcpTools } = await import("./managedMcpGateway");
  const tool = (name: string) => ({ name, inputSchema: { type: "object" as const } });
  const pages = [{ tools: [tool("first")], nextCursor: "second" }, { tools: [tool("last")] }];
  const requested: Array<string | undefined> = [];
  const client = { listTools: async (params?: { cursor?: string }) => { requested.push(params?.cursor); return pages.shift()!; } };
  assert.deepEqual((await collectManagedMcpTools(client, new AbortController().signal)).map((entry) => entry.name), ["first", "last"]);
  assert.deepEqual(requested, [undefined, "second"]);
  await assert.rejects(collectManagedMcpTools({ listTools: async () => ({ tools: [], nextCursor: "loop" }) }, new AbortController().signal), /did not terminate/);
  await assert.rejects(collectManagedMcpTools({ listTools: async () => ({ tools: [tool("duplicate")], nextCursor: "next" }) }, new AbortController().signal), /unique/);
  let page = 0;
  await assert.rejects(collectManagedMcpTools({ listTools: async () => ({ tools: Array.from({ length: 101 }, (_, i) => tool(`${page}-${i}`)), nextCursor: String(++page) }) }, new AbortController().signal), /too many/);
});

test("a failed sign-in step reports the provider's own reason, redacted and bounded", async () => {
  const wrapped = new ManagedMcpGatewayError("MCP OAuth token exchange failed", "managed_mcp_unreachable", { cause: new InvalidClientError("Unauthorized") });
  assert.equal(managedMcpOAuthFailureDetail(wrapped), "invalid_client: Unauthorized");
  const googleBody = JSON.stringify({ error: { code: 403, message: "Google Docs MCP API has not been used in project 1 before or it is disabled.", status: "PERMISSION_DENIED" } });
  assert.equal(
    managedMcpOAuthFailureDetail(normalizeManagedMcpClientError(new StreamableHTTPError(403, `Error POSTing to endpoint: ${googleBody}`), false, "oauth")),
    "HTTP 403: Google Docs MCP API has not been used in project 1 before or it is disabled.",
    "the normalized error keeps the HTTP failure as its cause",
  );

  // Only a message field is read from an HTTP body; any other shape or plain text yields the status alone.
  const leakyBody = JSON.stringify({ status: "forbidden", access_token: "ya29.synthetic-token" });
  assert.equal(managedMcpOAuthFailureDetail(new StreamableHTTPError(403, `Error POSTing to endpoint: ${leakyBody}`)), "HTTP 403");
  assert.equal(managedMcpOAuthFailureDetail(new StreamableHTTPError(500, "Error POSTing to endpoint: <html>token=abc</html>")), "HTTP 500");
  // Credential-shaped text inside a message or an OAuth description is redacted before truncation.
  const echoed = JSON.stringify({ message: `bad request client_secret=s3cr3t Authorization: Bearer ya29.abc ${"Z".repeat(60)}` });
  const redacted = managedMcpOAuthFailureDetail(new StreamableHTTPError(400, `Error POSTing to endpoint: ${echoed}`)) ?? "";
  assert.doesNotMatch(redacted, /s3cr3t|ya29|ZZZZ/u);
  assert.match(redacted, /client_secret=\[redacted\]/u);
  assert.doesNotMatch(managedMcpOAuthFailureDetail(new InvalidClientError("client_secret=s3cr3t rejected")) ?? "", /s3cr3t/u);
  // A quoted value may contain spaces; all of it goes.
  const quoted = managedMcpOAuthFailureDetail(new InvalidClientError(`rejected {"client_secret":"review firstword secondword"} and 'password': 'two words'`)) ?? "";
  assert.doesNotMatch(quoted, /review|firstword|secondword|two words/u);
  assert.match(quoted, /"client_secret":"\[redacted\]"/u);
  // The SDK's own wrapping of a non-OAuth token response carries the raw body; only the status survives.
  const raw = await parseErrorResponse(new Response(JSON.stringify({ oops: true, refresh_token: "synthetic-refresh" }), { status: 502 }));
  assert.equal(managedMcpOAuthFailureDetail(raw), "server_error: HTTP 502");
  // Raft's own errors are not a provider's reason.
  assert.equal(managedMcpOAuthFailureDetail(new Error("duplicate key value violates unique constraint")), null);
  assert.equal(managedMcpOAuthFailureDetail(new InvalidClientError("word ".repeat(100)))?.length, 300);
});

test("starting OAuth against a provider without client registration names that, not an unreachable server", async () => {
  // Google's authorization server publishes no registration_endpoint; this is the SDK's own error for it.
  const sdkError = await registerClient("https://accounts.example.com", {
    metadata: {
      issuer: "https://accounts.example.com",
      authorization_endpoint: "https://accounts.example.com/o/oauth2/v2/auth",
      token_endpoint: "https://oauth2.example.com/token",
      response_types_supported: ["code"],
    },
    clientMetadata: { redirect_uris: ["https://raft.example.test/api/mcp/oauth/callback"] },
  }).then(() => assert.fail("registration without an endpoint must fail"), (error: unknown) => error);
  assert.equal(managedMcpOAuthStartError(sdkError).code, "managed_mcp_oauth_client_registration_unsupported");
  assert.equal(managedMcpOAuthStartError(new Error("HTTP 500 trying to load well-known OAuth metadata")).code, "managed_mcp_unreachable");
});

test("a Google sign-in requests only the policy's scopes, not the server's full scopes_supported", async () => {
  // Docs' real resource metadata lists full Drive access among its scopes.
  const docsMetadata = {
    resource: "https://docsmcp.googleapis.com/mcp/v1",
    authorization_servers: ["https://accounts.google.com/"],
    scopes_supported: ["drive.readonly", "documents.readonly", "drive", "documents"].map((name) => `https://www.googleapis.com/auth/${name}`),
  };
  const googleMetadata = {
    issuer: "https://accounts.google.com",
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: "https://oauth2.googleapis.com/token",
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
  };
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return Response.json(docsMetadata);
    if (url.hostname === "accounts.google.com" && url.pathname.startsWith("/.well-known/")) return Response.json(googleMetadata);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const policy = managedMcpOAuthClientPolicy("https://docsmcp.googleapis.com/mcp/v1");
  const storage: ManagedMcpOAuthStorage = {
    redirectUrl: "https://raft.example.test/api/mcp/oauth/callback",
    configuredClient: applyManagedMcpOAuthClientPolicy(policy, { clientId: "web-client", clientSecret: "web-secret", tokenEndpointAuthMethod: "client_secret_post" }),
  };
  const provider = new ManagedMcpOAuthProvider(storage, async () => {}, "fixed-state");
  assert.equal(await startManagedMcpOAuth("https://docsmcp.googleapis.com/mcp/v1", provider, fakeFetch), "REDIRECT");
  const authorization = new URL(provider.authorizationUrl!);
  assert.equal(authorization.searchParams.get("scope"), "https://www.googleapis.com/auth/documents");
  assert.equal(authorization.searchParams.get("access_type"), "offline");
  assert.equal(authorization.searchParams.get("client_id"), "web-client");
});

test("a server's wider insufficient_scope challenge cannot widen a fixed-scope client's sign-in", async () => {
  const storage: ManagedMcpOAuthStorage = {
    redirectUrl: "https://raft.example.test/api/mcp/oauth/callback",
    configuredClient: applyManagedMcpOAuthClientPolicy(
      managedMcpOAuthClientPolicy("https://docsmcp.googleapis.com/mcp/v1"),
      { clientId: "web-client", clientSecret: "web-secret", tokenEndpointAuthMethod: "client_secret_post" },
    ),
  };
  const provider = new ManagedMcpOAuthProvider(storage, async () => {}, "fixed-state");
  const challenge = new URL("https://accounts.google.com/o/oauth2/v2/auth?scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive");
  assert.throws(() => provider.redirectToAuthorization(challenge), UnauthorizedError);
  assert.equal(provider.authorizationUrl, undefined, "no authorization URL is produced");
  const same = new URL("https://accounts.google.com/o/oauth2/v2/auth?scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdocuments");
  provider.redirectToAuthorization(same);
  assert.equal(new URL(provider.authorizationUrl!).searchParams.get("scope"), "https://www.googleapis.com/auth/documents");
});

test("Raft's Google client: least-privilege scopes, and its deployment secret never persists, even after the SDK's write-back", async () => {
  const saved = { id: process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_ID, secret: process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SECRET };
  process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_ID = "synthetic-raft-client";
  process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SECRET = "synthetic-raft-secret";
  try {
    const tokenRequests: string[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({
          resource: "https://docsmcp.googleapis.com/mcp/v1",
          authorization_servers: ["https://accounts.google.com/"],
          scopes_supported: ["drive", "documents"].map((name) => `https://www.googleapis.com/auth/${name}`),
        });
      }
      if (url.hostname === "accounts.google.com" && url.pathname.startsWith("/.well-known/")) {
        return Response.json({
          issuer: "https://accounts.google.com",
          authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          token_endpoint: "https://oauth2.googleapis.com/token",
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.toString() === "https://oauth2.googleapis.com/token") {
        tokenRequests.push(String(init?.body));
        return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 3600 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const storage: ManagedMcpOAuthStorage = {
      redirectUrl: "https://raft.example.test/api/mcp/oauth/callback",
      raftClient: "google",
      raftClientScope: managedMcpOAuthClientPolicy("https://docsmcp.googleapis.com/mcp/v1")!.scopes.join(" "),
    };
    const persisted: string[] = [];
    const provider = new ManagedMcpOAuthProvider(storage, async () => { persisted.push(JSON.stringify(storage)); }, "fixed-state");

    assert.equal(await startManagedMcpOAuth("https://docsmcp.googleapis.com/mcp/v1", provider, fakeFetch), "REDIRECT");
    const authorization = new URL(provider.authorizationUrl!);
    assert.equal(authorization.searchParams.get("scope"), "https://www.googleapis.com/auth/documents", "never the server's full list");
    assert.equal(authorization.searchParams.get("client_id"), "synthetic-raft-client");

    await completeManagedMcpOAuth("https://docsmcp.googleapis.com/mcp/v1", provider, "synthetic-code", fakeFetch);
    assert.equal(tokenRequests.length, 1);
    assert.match(tokenRequests[0], /client_secret=synthetic-raft-secret/u, "the exchange used the deployment's secret");
    assert.equal(storage.tokens?.access_token, "synthetic-access");
    assert.ok(persisted.length > 0);
    for (const snapshot of [...persisted, JSON.stringify(storage)]) {
      assert.doesNotMatch(snapshot, /synthetic-raft-secret/u, "the deployment secret is never stored");
    }
    assert.equal(storage.clientInformation, undefined, "the SDK's write-back of the client is not kept");

    delete process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SECRET;
    assert.equal(provider.clientInformation(), undefined, "removed from the deployment: no client, and no fallback");
    assert.equal(provider.clientMetadataUrl, undefined, "nor automatic registration in its place");
  } finally {
    if (saved.id === undefined) delete process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_ID; else process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_ID = saved.id;
    if (saved.secret === undefined) delete process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SECRET; else process.env.MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SECRET = saved.secret;
  }
});
