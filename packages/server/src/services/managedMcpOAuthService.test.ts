import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDb } from "../db/index";
import {
  managedMcpCredentials,
  managedMcpOAuthAttempts,
  managedMcpServers,
  users,
} from "../db/schema";
import { createServer } from "./serverService";
import {
  __refreshManagedMcpCatalogWithLoaderForTest,
  createManagedMcpServer,
  ManagedMcpServiceError,
  updateManagedMcpServer,
} from "./managedMcpService";
import {
  decryptManagedMcpSecret,
  encryptManagedMcpSecret,
} from "./managedMcpCredentialService";
import {
  consumeManagedMcpOAuthAttempt,
  completeManagedMcpOAuthConnection,
  disconnectManagedMcpOAuthConnection,
  failManagedMcpOAuthAttempt,
  ManagedMcpOAuthError,
  replacePendingManagedMcpOAuthAttempt,
  withManagedMcpOAuth,
} from "./managedMcpOAuthService";
import {
  ManagedMcpGatewayError,
  normalizeManagedMcpClientError,
} from "./managedMcpGateway";
import type { ManagedMcpOAuthStorage } from "./managedMcpOAuthProvider";


const originalCredentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;

beforeEach(async () => {
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 13).toString(
    "base64",
  );
  await openTestDatabase("pglite://");
});

afterEach(async () => {
  await closeTestDatabase();
  if (originalCredentialKey === undefined)
    delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
  else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalCredentialKey;
});

/**
 * `"custom"`: a URL App at connection-a, for tests that move the endpoint. A recommended App
 * (Linear) cannot be moved or switched to a custom provider (template_field_locked).
 */
async function seedOAuthConnection(kind: "linear" | "custom" = "linear") {
  const [user] = await getDb()
    .insert(users)
    .values({
      email: `mcp-oauth-${randomUUID()}@slock.test`,
      name: `mcp-oauth-${randomUUID().slice(0, 8)}`,
      displayName: "MCP OAuth Owner",
      passwordHash: "hash",
      emailVerified: true,
    })
    .returning();
  const server = await createServer(
    "MCP OAuth Test",
    `mcp-oauth-${randomUUID()}`,
    user.id,
  );
  const connection = await createManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    name: kind === "linear" ? "Linear" : "Connection A",
    provider: kind,
    authMode: "oauth",
    endpointUrl: kind === "linear" ? "https://mcp.linear.app/mcp" : "https://connection-a.example.test/mcp",
  });
  const storage = {
    redirectUrl: "https://raft.example.test/api/mcp/oauth/callback",
    tokens: { access_token: "old-access-token", token_type: "Bearer" },
  };
  await getDb()
    .update(managedMcpCredentials)
    .set({
      encryptedOAuth: encryptManagedMcpSecret(storage),
    })
    .where(eq(managedMcpCredentials.mcpServerId, connection.id));
  return { user, server, connection };
}

async function seedRefreshableOAuthConnection() {
  const seeded = await seedOAuthConnection();
  const storage: ManagedMcpOAuthStorage = {
    redirectUrl: "https://raft.example.test/api/mcp/oauth/callback",
    clientInformation: {
      client_id: "https://raft.example.test/api/mcp/oauth/client-metadata",
      token_endpoint_auth_method: "none",
    },
    tokens: {
      access_token: "expired-access-token",
      refresh_token: "durable-refresh-token",
      token_type: "Bearer",
    },
    discoveryState: {
      authorizationServerUrl: "https://auth.example.test",
      authorizationServerMetadata: {
        issuer: "https://auth.example.test",
        authorization_endpoint: "https://auth.example.test/authorize",
        token_endpoint: "https://auth.example.test/token",
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["none"],
      },
      resourceMetadata: {
        resource: "https://mcp.linear.app/mcp",
        authorization_servers: ["https://auth.example.test"],
      },
    },
  };
  await getDb()
    .update(managedMcpCredentials)
    .set({ encryptedOAuth: encryptManagedMcpSecret(storage) })
    .where(eq(managedMcpCredentials.mcpServerId, seeded.connection.id));
  await getDb()
    .update(managedMcpServers)
    .set({ oauthStatus: "connected", lastCheckError: null })
    .where(eq(managedMcpServers.id, seeded.connection.id));
  return seeded;
}

test("managed MCP OAuth attempts are hash-only, expiring, and one-time", async () => {
  const { user, server, connection } = await seedOAuthConnection();
  const state = "one-time-state";
  await getDb()
    .insert(managedMcpOAuthAttempts)
    .values({
      serverId: server.id,
      mcpServerId: connection.id,
      userId: user.id,
      configVersion: connection.configVersion,
      stateHash: createHash("sha256").update(state).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    });

  const [stored] = await getDb().select().from(managedMcpOAuthAttempts);
  assert.equal(JSON.stringify(stored).includes(state), false);
  assert.equal((await consumeManagedMcpOAuthAttempt(state)).status, "consumed");
  await assert.rejects(
    () => consumeManagedMcpOAuthAttempt(state),
    (error: unknown) =>
      error instanceof ManagedMcpOAuthError &&
      error.code === "managed_mcp_oauth_invalid_state",
  );

  const expiredState = "expired-state";
  await getDb()
    .insert(managedMcpOAuthAttempts)
    .values({
      serverId: server.id,
      mcpServerId: connection.id,
      userId: user.id,
      configVersion: connection.configVersion,
      stateHash: createHash("sha256").update(expiredState).digest("hex"),
      expiresAt: new Date(Date.now() - 1),
    });
  await assert.rejects(
    () => consumeManagedMcpOAuthAttempt(expiredState),
    (error: unknown) =>
      error instanceof ManagedMcpOAuthError &&
      error.code === "managed_mcp_oauth_invalid_state",
  );
});

test("starting a replacement OAuth attempt invalidates every older pending state", async () => {
  const { user, server, connection } = await seedOAuthConnection();
  await replacePendingManagedMcpOAuthAttempt({
    serverId: server.id,
    mcpServerId: connection.id,
    userId: user.id,
    configVersion: connection.configVersion,
    state: "older-state",
  });
  await replacePendingManagedMcpOAuthAttempt({
    serverId: server.id,
    mcpServerId: connection.id,
    userId: user.id,
    configVersion: connection.configVersion,
    state: "newer-state",
  });

  await assert.rejects(
    () => consumeManagedMcpOAuthAttempt("older-state"),
    (error: unknown) =>
      error instanceof ManagedMcpOAuthError &&
      error.code === "managed_mcp_oauth_invalid_state",
  );
  assert.equal(
    (await consumeManagedMcpOAuthAttempt("newer-state")).status,
    "consumed",
  );
});

test("disconnect invalidates pending OAuth callbacks before clearing credentials", async () => {
  const { user, server, connection } = await seedOAuthConnection();
  await replacePendingManagedMcpOAuthAttempt({
    serverId: server.id,
    mcpServerId: connection.id,
    userId: user.id,
    configVersion: connection.configVersion,
    state: "pending-before-disconnect",
  });

  await disconnectManagedMcpOAuthConnection(server.id, connection.id);
  await assert.rejects(
    () => consumeManagedMcpOAuthAttempt("pending-before-disconnect"),
    (error: unknown) =>
      error instanceof ManagedMcpOAuthError &&
      error.code === "managed_mcp_oauth_invalid_state",
  );
  const [credential] = await getDb()
    .select()
    .from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.mcpServerId, connection.id));
  const signedOut = decryptManagedMcpSecret(credential.encryptedOAuth!) as ManagedMcpOAuthStorage;
  assert.equal(signedOut.tokens, undefined);
  assert.equal(signedOut.clientInformation, undefined);
});

test("provider-denied OAuth callbacks consume pending state and leave the connection recoverable", async () => {
  const { user, server, connection } = await seedOAuthConnection();
  await replacePendingManagedMcpOAuthAttempt({
    serverId: server.id,
    mcpServerId: connection.id,
    userId: user.id,
    configVersion: connection.configVersion,
    state: "provider-denied-state",
  });

  await failManagedMcpOAuthAttempt("provider-denied-state");
  await assert.rejects(
    () => consumeManagedMcpOAuthAttempt("provider-denied-state"),
    (error: unknown) =>
      error instanceof ManagedMcpOAuthError &&
      error.code === "managed_mcp_oauth_invalid_state",
  );
  const [storedConnection] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(eq(managedMcpServers.id, connection.id));
  assert.equal(storedConnection.oauthStatus, "error");
  assert.equal(
    storedConnection.lastCheckError,
    "OAuth authorization was not completed",
  );
});

test("managed MCP OAuth token saves are encrypted and fenced by the credential lease", async () => {
  const { server, connection } = await seedOAuthConnection();
  await withManagedMcpOAuth(
    server.id,
    connection.id,
    async (_managedServer, provider) => {
      await provider.saveTokens({
        access_token: "rotated-access-token",
        token_type: "Bearer",
      });
    },
  );

  const [credential] = await getDb()
    .select()
    .from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.mcpServerId, connection.id));
  assert.equal(
    credential.encryptedOAuth?.includes("rotated-access-token"),
    false,
  );
  assert.equal(
    (
      decryptManagedMcpSecret(credential.encryptedOAuth!) as {
        tokens: { access_token: string };
      }
    ).tokens.access_token,
    "rotated-access-token",
  );
  assert.equal(credential.credentialVersion, 2);
  assert.equal(credential.leaseOwner, null);
  assert.equal(credential.leaseExpiresAt, null);
});

test("expired managed MCP access tokens refresh and persist without reconnecting", async () => {
  const { server, connection } = await seedRefreshableOAuthConnection();
  let refreshRequests = 0;
  await withManagedMcpOAuth(server.id, connection.id, async (_managedServer, provider) => {
    const result = await auth(provider, {
      serverUrl: new URL("https://mcp.linear.app/mcp"),
      fetchFn: async (input, init) => {
        assert.equal(String(input), "https://auth.example.test/token");
        assert.equal(init?.method, "POST");
        const params = new URLSearchParams(String(init?.body));
        assert.equal(params.get("grant_type"), "refresh_token");
        assert.equal(params.get("refresh_token"), "durable-refresh-token");
        refreshRequests += 1;
        return new Response(JSON.stringify({
          access_token: "rotated-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    assert.equal(result, "AUTHORIZED");
  });

  assert.equal(refreshRequests, 1);
  const [credential] = await getDb()
    .select()
    .from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.mcpServerId, connection.id));
  const stored = decryptManagedMcpSecret(credential.encryptedOAuth!) as ManagedMcpOAuthStorage;
  assert.equal(stored.tokens?.access_token, "rotated-access-token");
  assert.equal(stored.tokens?.refresh_token, "durable-refresh-token");
  assert.equal(credential.leaseOwner, null);
  const [storedConnection] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(eq(managedMcpServers.id, connection.id));
  assert.equal(storedConnection.oauthStatus, "connected");
  assert.equal(storedConnection.lastCheckError, null);
});

test("revoked refresh tokens require reconnect while transient requests keep the connection", async () => {
  const { server, connection } = await seedRefreshableOAuthConnection();
  let revokedRefreshRequests = 0;
  const warnings = captureReconnectWarnings();
  await assert.rejects(
    () => withManagedMcpOAuth(server.id, connection.id, async (_managedServer, provider) => {
      try {
        await auth(provider, {
          serverUrl: new URL("https://mcp.linear.app/mcp"),
          fetchFn: async () => {
            revokedRefreshRequests += 1;
            return new Response(JSON.stringify({
              error: "invalid_grant",
              error_description: `refresh token revoked for ${SYNTHETIC_PRIVATE_TEXT}`,
            }), { status: 400, headers: { "Content-Type": "application/json" } });
          },
        });
      } catch (error) {
        throw normalizeManagedMcpClientError(error, false, "oauth");
      }
    }),
    ManagedMcpGatewayError,
  );
  warnings.restore();
  assert.equal(revokedRefreshRequests, 1);
  assert.deepEqual(warnings.entries.map(({ cause, category, hadRefreshToken }) => ({ cause, category, hadRefreshToken })), [
    { cause: "refresh_refused", category: "invalid_grant", hadRefreshToken: true },
  ]);
  assert.ok(!JSON.stringify(warnings.entries).includes(SYNTHETIC_PRIVATE_TEXT), "the provider's text never reaches the log");
  let [storedConnection] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(eq(managedMcpServers.id, connection.id));
  assert.equal(storedConnection.oauthStatus, "error");
  assert.equal(storedConnection.lastCheckError, "OAuth renewal refused by the provider (invalid_grant); reconnect required");
  const [revokedCredential] = await getDb()
    .select()
    .from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.mcpServerId, connection.id));
  assert.equal((decryptManagedMcpSecret(revokedCredential.encryptedOAuth!) as ManagedMcpOAuthStorage).tokens, undefined);

  const transient = await seedRefreshableOAuthConnection();
  await assert.rejects(
    () => withManagedMcpOAuth(transient.server.id, transient.connection.id, async (_managedServer, provider) => {
      try {
        await auth(provider, {
          serverUrl: new URL("https://mcp.linear.app/mcp"),
          fetchFn: async () => new Response(JSON.stringify({
            error: "temporarily_unavailable",
            error_description: "authorization server overloaded",
          }), { status: 503, headers: { "Content-Type": "application/json" } }),
        });
      } catch (error) {
        throw normalizeManagedMcpClientError(error, false, "oauth");
      }
    }),
    ManagedMcpGatewayError,
  );
  [storedConnection] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(eq(managedMcpServers.id, transient.connection.id));
  assert.equal(storedConnection.oauthStatus, "connected");
  assert.equal(storedConnection.lastCheckError, "MCP request failed; retry without reconnecting");
});

test("managed MCP OAuth tool calls on one connector run concurrently, outside the credential lease", async () => {
  const { server, connection } = await seedOAuthConnection();
  const events: string[] = [];
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstStartedPromise = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = withManagedMcpOAuth(server.id, connection.id, async () => {
    events.push("first-start");
    firstStarted();
    await firstGate;
    events.push("first-end");
  });
  await firstStartedPromise;
  // While the first call is still in flight, the credential lease is free and
  // a second call on the same connector runs to completion.
  const [during] = await getDb()
    .select()
    .from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.mcpServerId, connection.id));
  assert.equal(during.leaseOwner, null);
  await withManagedMcpOAuth(server.id, connection.id, async () => {
    events.push("second");
  });
  assert.deepEqual(events, ["first-start", "second"]);
  releaseFirst();
  await first;
  assert.deepEqual(events, ["first-start", "second", "first-end"]);
});

function rotatingTokenEndpoint() {
  let issued = 0;
  return {
    issued: () => issued,
    fetchFn: async (_input: unknown, init?: RequestInit) => {
      const params = new URLSearchParams(String(init?.body));
      // Rotating refresh tokens: only the latest refresh token is accepted.
      if (params.get("refresh_token") !== (issued === 0 ? "durable-refresh-token" : `rotated-refresh-${issued}`)) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      issued += 1;
      return new Response(JSON.stringify({
        access_token: `rotated-access-${issued}`,
        refresh_token: `rotated-refresh-${issued}`,
        token_type: "Bearer",
        expires_in: 3600,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

test("a refresh that lost a rotating refresh token to a concurrent call keeps the winner's grant", async () => {
  const { server, connection } = await seedRefreshableOAuthConnection();
  const serverUrl = new URL("https://mcp.linear.app/mcp");
  const endpoint = rotatingTokenEndpoint();
  const loserRead = gate();
  const winnerDone = gate();

  // The loser read the stored (expired) credentials before the winner
  // refreshed; its own refresh then spends a refresh token that is no longer
  // valid. Its invalidation must not wipe the winner's tokens: the SDK picks
  // up the stored grant and carries on.
  const loser = withManagedMcpOAuth(server.id, connection.id, async (_managed, provider) => {
    assert.equal(provider.tokens()?.access_token, "expired-access-token");
    loserRead.open();
    await winnerDone.opened;
    return auth(provider, { serverUrl, fetchFn: endpoint.fetchFn });
  });
  await loserRead.opened;
  await withManagedMcpOAuth(server.id, connection.id, async (_managed, provider) => {
    assert.equal(await auth(provider, { serverUrl, fetchFn: endpoint.fetchFn }), "AUTHORIZED");
  });
  winnerDone.open();

  assert.equal(await loser, "AUTHORIZED");
  const [credential] = await getDb()
    .select()
    .from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.mcpServerId, connection.id));
  const stored = decryptManagedMcpSecret(credential.encryptedOAuth!) as ManagedMcpOAuthStorage;
  assert.equal(stored.tokens?.refresh_token, `rotated-refresh-${endpoint.issued()}`);
  assert.equal(stored.tokens?.access_token, `rotated-access-${endpoint.issued()}`);
  assert.equal(credential.leaseOwner, null);
  const [storedConnection] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(eq(managedMcpServers.id, connection.id));
  assert.equal(storedConnection.oauthStatus, "connected");
});

test("a refresh that wins after a concurrent loser marked the connection expired restores it to connected", async () => {
  const { server, connection } = await seedRefreshableOAuthConnection();
  const winnerRead = gate();
  const loserDone = gate();

  // Order the other way round from the test above: the winner read the same
  // credentials, the loser's invalidation lands first and it marks the
  // connection expired, then the winner's newly issued grant is saved.
  const winner = withManagedMcpOAuth(server.id, connection.id, async (_managed, provider) => {
    winnerRead.open();
    await loserDone.opened;
    await provider.saveTokens({
      access_token: "winner-access",
      refresh_token: "winner-refresh",
      token_type: "Bearer",
    });
    return "ok";
  });
  await winnerRead.opened;
  await assert.rejects(
    () => withManagedMcpOAuth(server.id, connection.id, async (_managed, provider) => {
      await provider.invalidateCredentials("tokens");
      throw new ManagedMcpGatewayError("MCP OAuth authorization expired; reconnect from Settings", "managed_mcp_oauth_required");
    }),
    ManagedMcpGatewayError,
  );
  let [storedConnection] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(eq(managedMcpServers.id, connection.id));
  assert.equal(storedConnection.oauthStatus, "error");
  loserDone.open();

  assert.equal(await winner, "ok");
  [storedConnection] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(eq(managedMcpServers.id, connection.id));
  assert.equal(storedConnection.oauthStatus, "connected");
  assert.equal(storedConnection.lastCheckError, null);
  const [credential] = await getDb()
    .select()
    .from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.mcpServerId, connection.id));
  assert.equal((decryptManagedMcpSecret(credential.encryptedOAuth!) as ManagedMcpOAuthStorage).tokens?.access_token, "winner-access");
});

test("a call rejected as unauthorized after a concurrent refresh runs once more on the new tokens, not marking the connection expired", async () => {
  const { server, connection } = await seedRefreshableOAuthConnection();
  const serverUrl = new URL("https://mcp.linear.app/mcp");
  const endpoint = rotatingTokenEndpoint();
  const firstRead = gate();
  const refreshed = gate();
  const seen: Array<string | undefined> = [];

  const call = withManagedMcpOAuth(server.id, connection.id, async (_managed, provider) => {
    seen.push(provider.tokens()?.access_token);
    if (seen.length > 1) return "ok";
    firstRead.open();
    await refreshed.opened;
    throw new ManagedMcpGatewayError("MCP OAuth authorization expired; reconnect from Settings", "managed_mcp_oauth_required");
  });
  await firstRead.opened;
  await withManagedMcpOAuth(server.id, connection.id, async (_managed, provider) => {
    await auth(provider, { serverUrl, fetchFn: endpoint.fetchFn });
  });
  refreshed.open();

  assert.equal(await call, "ok");
  assert.deepEqual(seen, ["expired-access-token", "rotated-access-1"]);
  const [storedConnection] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(eq(managedMcpServers.id, connection.id));
  assert.equal(storedConnection.oauthStatus, "connected");
});

test("a reconnect verdict from stale credentials does not overwrite a newer grant saved meanwhile", async () => {
  const { server, connection } = await seedRefreshableOAuthConnection();
  let saves = 0;
  const saveNewerGrant = () => withManagedMcpOAuth(server.id, connection.id, async (_managed, provider) => {
    saves += 1;
    await provider.saveTokens({ access_token: `newer-access-${saves}`, refresh_token: `newer-refresh-${saves}`, token_type: "Bearer" });
  });
  let attempts = 0;
  const warnings = captureReconnectWarnings();
  // Each attempt is rejected as unauthorized after another call saved a newer
  // grant: the first is retried, the second gives up, but its verdict came
  // from credentials that are no longer the stored ones, so it must not mark
  // the connection expired.
  await assert.rejects(
    () => withManagedMcpOAuth(server.id, connection.id, async () => {
      attempts += 1;
      await saveNewerGrant();
      throw new ManagedMcpGatewayError("MCP OAuth authorization expired; reconnect from Settings", "managed_mcp_oauth_required");
    }),
    ManagedMcpGatewayError,
  );
  warnings.restore();
  assert.equal(attempts, 2);
  assert.deepEqual(warnings.entries, [], "a verdict the fence rejected is not logged as reconnect-required");
  const [storedConnection] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(eq(managedMcpServers.id, connection.id));
  assert.equal(storedConnection.oauthStatus, "connected");
  assert.equal(storedConnection.lastCheckError, null);
});

test("a refresh that the provider refuses as invalid_client is recorded as a refused client, without the provider's text", async () => {
  const { server, connection } = await seedRefreshableOAuthConnection();
  // A user's own client: the SDK's invalidate-all after invalid_client keeps it, so the retry ends
  // in sign-in required rather than registering a new client.
  const [seededCredential] = await getDb()
    .select()
    .from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.mcpServerId, connection.id));
  const storage = decryptManagedMcpSecret(seededCredential.encryptedOAuth!) as ManagedMcpOAuthStorage;
  delete storage.clientInformation;
  storage.configuredClient = { clientId: "own-client", clientSecret: "own-secret", tokenEndpointAuthMethod: "client_secret_post" };
  await getDb()
    .update(managedMcpCredentials)
    .set({ encryptedOAuth: encryptManagedMcpSecret(storage) })
    .where(eq(managedMcpCredentials.mcpServerId, connection.id));
  const resourceMetadata = storage.discoveryState!.resourceMetadata;
  const authorizationServerMetadata = storage.discoveryState!.authorizationServerMetadata;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  let refreshRequests = 0;
  const warnings = captureReconnectWarnings();
  await assert.rejects(
    () => withManagedMcpOAuth(server.id, connection.id, async (_managedServer, provider) => {
      try {
        await auth(provider, {
          serverUrl: new URL("https://mcp.linear.app/mcp"),
          fetchFn: async (input: string | URL | Request) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.includes("oauth-protected-resource")) return json(resourceMetadata);
            if (url.includes("oauth-authorization-server") || url.includes("openid-configuration")) return json(authorizationServerMetadata);
            if (url === "https://auth.example.test/token") {
              refreshRequests += 1;
              return json({ error: "invalid_client", error_description: `client disabled for ${SYNTHETIC_PRIVATE_TEXT}` }, 401);
            }
            return new Response("not found", { status: 404 });
          },
        });
      } catch (error) {
        throw normalizeManagedMcpClientError(error, false, "oauth");
      }
    }),
    ManagedMcpGatewayError,
  );
  warnings.restore();
  assert.equal(refreshRequests, 1);
  const [storedConnection] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(eq(managedMcpServers.id, connection.id));
  assert.equal(storedConnection.oauthStatus, "error");
  assert.equal(storedConnection.lastCheckError, "OAuth renewal refused by the provider (OAuth client rejected); reconnect required");
  assert.deepEqual(warnings.entries.map(({ cause, category, hadRefreshToken }) => ({ cause, category, hadRefreshToken })), [
    { cause: "client_refused", category: null, hadRefreshToken: true },
  ]);
  assert.ok(!JSON.stringify(warnings.entries).includes(SYNTHETIC_PRIVATE_TEXT));
  assert.ok(!storedConnection.lastCheckError?.includes(SYNTHETIC_PRIVATE_TEXT));
});

test("an endpoint rejection is recorded as its HTTP status only, in the status and the log", async () => {
  const { server, connection } = await seedRefreshableOAuthConnection();
  const warnings = captureReconnectWarnings();
  await assert.rejects(
    () => withManagedMcpOAuth(server.id, connection.id, async () => {
      throw normalizeManagedMcpClientError(
        new StreamableHTTPError(403, `Error POSTing to endpoint: {"error":"forbidden","message":"${SYNTHETIC_PRIVATE_TEXT}"}`),
        false,
        "oauth",
      );
    }),
    ManagedMcpGatewayError,
  );
  warnings.restore();
  const [storedConnection] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(eq(managedMcpServers.id, connection.id));
  assert.equal(storedConnection.lastCheckError, "OAuth authorization rejected (HTTP 403); reconnect required");
  assert.deepEqual(warnings.entries.map(({ cause, category }) => ({ cause, category })), [{ cause: "rejected", category: "HTTP 403" }]);
  assert.ok(!JSON.stringify(warnings.entries).includes(SYNTHETIC_PRIVATE_TEXT));
});

test("a call that fails for a reason other than reconnect is not repeated", async () => {
  const { server, connection } = await seedOAuthConnection();
  let calls = 0;
  await assert.rejects(
    () => withManagedMcpOAuth(server.id, connection.id, async () => {
      calls += 1;
      throw new ManagedMcpGatewayError("MCP server could not be reached", "managed_mcp_unreachable");
    }),
    ManagedMcpGatewayError,
  );
  assert.equal(calls, 1);
});

test("OAuth token persistence cannot revive connection A after an identity update to B", async () => {
  const { user, server, connection } = await seedOAuthConnection("custom");
  let operationStarted!: () => void;
  let releaseOperation!: () => void;
  const started = new Promise<void>((resolve) => {
    operationStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });

  const staleOperation = withManagedMcpOAuth(
    server.id,
    connection.id,
    async (_managedServer, provider) => {
      operationStarted();
      await gate;
      await provider.saveTokens({
        access_token: "connection-a-token",
        token_type: "Bearer",
      });
    },
    connection.configVersion,
  );
  await started;

  const updated = await updateManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    mcpServerId: connection.id,
    provider: "custom",
    authMode: "oauth",
    endpointUrl: "https://connection-b.example.test/mcp",
  });
  assert.equal(updated.configVersion, connection.configVersion + 1);
  releaseOperation();

  await assert.rejects(
    staleOperation,
    (error: unknown) => error instanceof ManagedMcpOAuthError
      && error.code === "managed_mcp_oauth_persist_failed",
  );
  const [storedServer] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(eq(managedMcpServers.id, connection.id));
  const [credential] = await getDb()
    .select()
    .from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.mcpServerId, connection.id));
  assert.equal(storedServer.endpointUrl, "https://connection-b.example.test/mcp");
  assert.equal(storedServer.oauthStatus, "disconnected");
  assert.deepEqual(storedServer.toolCatalog, []);
  assert.equal(storedServer.lastCheckError, null);
  assert.equal(credential.encryptedOAuth, null);
  assert.equal(credential.leaseOwner, null);
  assert.equal(credential.leaseExpiresAt, null);
});

test("an OAuth callback for connection A is rejected before provider I/O after update to B", async () => {
  const { user, server, connection } = await seedOAuthConnection("custom");
  const state = "connection-a-callback";
  await replacePendingManagedMcpOAuthAttempt({
    serverId: server.id,
    mcpServerId: connection.id,
    userId: user.id,
    configVersion: connection.configVersion,
    state,
  });
  await updateManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    mcpServerId: connection.id,
    provider: "custom",
    authMode: "oauth",
    endpointUrl: "https://connection-b.example.test/mcp",
  });

  const originalFetch = globalThis.fetch;
  let providerRequests = 0;
  globalThis.fetch = (async () => {
    providerRequests += 1;
    throw new Error("provider I/O must not occur");
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => completeManagedMcpOAuthConnection({
        state,
        authorizationCode: "connection-a-code",
      }),
      (error: unknown) => error instanceof ManagedMcpOAuthError
        && error.code === "managed_mcp_oauth_invalid_state",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(providerRequests, 0);
  const [storedServer] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(eq(managedMcpServers.id, connection.id));
  assert.equal(storedServer.endpointUrl, "https://connection-b.example.test/mcp");
  assert.equal(storedServer.oauthStatus, "disconnected");
  assert.deepEqual(storedServer.toolCatalog, []);
  assert.equal(storedServer.lastCheckError, null);
});

test("an OAuth tool lease rejects connection A before provider I/O after update to B", async () => {
  const { user, server, connection } = await seedOAuthConnection("custom");
  await updateManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    mcpServerId: connection.id,
    provider: "custom",
    authMode: "oauth",
    endpointUrl: "https://connection-b.example.test/mcp",
  });
  const [serverBefore] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(eq(managedMcpServers.id, connection.id));
  const [credentialBefore] = await getDb()
    .select()
    .from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.mcpServerId, connection.id));
  let providerOperations = 0;

  await assert.rejects(
    () => withManagedMcpOAuth(
      server.id,
      connection.id,
      async () => {
        providerOperations += 1;
      },
      connection.configVersion,
    ),
    (error: unknown) => error instanceof ManagedMcpOAuthError
      && error.code === "managed_mcp_oauth_invalid_state",
  );

  const [serverAfter] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(eq(managedMcpServers.id, connection.id));
  const [credentialAfter] = await getDb()
    .select()
    .from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.mcpServerId, connection.id));
  assert.equal(providerOperations, 0);
  assert.deepEqual(serverAfter, serverBefore);
  assert.deepEqual(credentialAfter, credentialBefore);
});

test("a catalog result from connection A cannot overwrite connection B", async () => {
  const { user, server, connection } = await seedOAuthConnection("custom");
  let fetchStarted!: () => void;
  let releaseFetch!: () => void;
  const started = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const staleRefresh = __refreshManagedMcpCatalogWithLoaderForTest(
    server.id,
    connection.id,
    async () => {
      fetchStarted();
      await gate;
      return [{
        name: "connection_a_tool",
        description: "stale A catalog",
        inputSchema: { type: "object" },
      }];
    },
  );
  await started;

  await updateManagedMcpServer({
    serverId: server.id,
    userId: user.id,
    mcpServerId: connection.id,
    provider: "custom",
    authMode: "oauth",
    endpointUrl: "https://connection-b.example.test/mcp",
  });
  releaseFetch();

  await assert.rejects(
    staleRefresh,
    (error: unknown) => error instanceof ManagedMcpServiceError
      && error.code === "managed_mcp_config_stale",
  );
  const [storedServer] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(eq(managedMcpServers.id, connection.id));
  assert.equal(storedServer.endpointUrl, "https://connection-b.example.test/mcp");
  assert.equal(storedServer.oauthStatus, "disconnected");
  assert.deepEqual(storedServer.toolCatalog, []);
  assert.equal(storedServer.lastCheckError, null);
});

test("⭐ the App's OAuth status reaches its default Connection, so a connected App is callable and an expired one is not", async () => {
  // Seeded the way production data looks right after this release: the App's oauth_status says
  // connected, but nothing has yet written the Connection's own auth_status (it starts needs_auth).
  const seeded = await seedRefreshableOAuthConnection();
  const { createAgent } = await import("./agentService");
  const { executeManagedMcpCall } = await import("./managedMcpService");
  const agent = await createAgent(seeded.server.id, `oauth-agent-${randomUUID().slice(0, 8)}`);
  await getDb().update(managedMcpServers)
    .set({ toolCatalog: [{ name: "search", inputSchema: { type: "object" } }] })
    .where(eq(managedMcpServers.id, seeded.connection.id));
  const [app] = await getDb().select().from(managedMcpServers).where(eq(managedMcpServers.id, seeded.connection.id));
  let toolCalls = 0;
  const call = () => executeManagedMcpCall(seeded.server.id, agent.id, {
    mcpServerId: app.id, toolName: "search", arguments: {}, expectedConfigVersion: app.configVersion, expectedAssignmentVersion: 1,
  }, undefined, async () => { toolCalls += 1; return { content: [], isError: false }; });
  const connectionStatus = async () => (await getDb().select().from(managedMcpCredentials)
    .where(eq(managedMcpCredentials.mcpServerId, app.id)))[0].authStatus;

  // An OAuth round that ends with the App connected (here a transient tool failure, which keeps the
  // connection) goes through the same status write the sign-in callback uses.
  await assert.rejects(
    () => withManagedMcpOAuth(seeded.server.id, app.id, async () => {
      throw new ManagedMcpGatewayError("MCP server could not be reached", "managed_mcp_unreachable");
    }),
    ManagedMcpGatewayError,
  );
  assert.equal(await connectionStatus(), "ready", "⭐ connected App ⇒ ready default Connection");
  await call();
  assert.equal(toolCalls, 1, "⭐ and an Agent's call is admitted");

  // The authorization expires: the Connection follows, and the Agent is refused with login_required.
  await assert.rejects(
    () => withManagedMcpOAuth(seeded.server.id, app.id, async () => {
      throw new ManagedMcpGatewayError("MCP OAuth authorization expired; reconnect from Settings", "managed_mcp_oauth_required");
    }),
    ManagedMcpGatewayError,
  );
  assert.equal(await connectionStatus(), "expired");
  await assert.rejects(call(), (error: unknown) => error instanceof ManagedMcpServiceError);
  assert.equal(toolCalls, 1);
});

/** Short, unlabelled private text a provider could put in an error; no redactor pattern matches it. */
const SYNTHETIC_PRIVATE_TEXT = "alice.private@example.test pin 4821";

function captureReconnectWarnings(): { entries: Array<Record<string, unknown>>; restore: () => void } {
  const entries: Array<Record<string, unknown>> = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    if (args[0] === "mcp.oauth.reconnect_required") entries.push(args[1] as Record<string, unknown>);
    else original(...args);
  };
  return { entries, restore: () => { console.warn = original; } };
}
