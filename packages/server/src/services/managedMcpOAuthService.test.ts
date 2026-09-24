import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { getDb } from "../db/index.js";
import {
  managedMcpCredentials,
  managedMcpOAuthAttempts,
  managedMcpServers,
  users,
} from "../db/schema.js";
import { createServer } from "./serverService.js";
import {
  __refreshManagedMcpCatalogWithLoaderForTest,
  createManagedMcpServer,
  ManagedMcpServiceError,
  updateManagedMcpServer,
} from "./managedMcpService.js";
import {
  decryptManagedMcpSecret,
  encryptManagedMcpSecret,
} from "./managedMcpCredentialService.js";
import {
  consumeManagedMcpOAuthAttempt,
  completeManagedMcpOAuthConnection,
  disconnectManagedMcpOAuthConnection,
  failManagedMcpOAuthAttempt,
  ManagedMcpOAuthError,
  replacePendingManagedMcpOAuthAttempt,
  withManagedMcpOAuth,
} from "./managedMcpOAuthService.js";
import {
  ManagedMcpGatewayError,
  normalizeManagedMcpClientError,
} from "./managedMcpGateway.js";
import type { ManagedMcpOAuthStorage } from "./managedMcpOAuthProvider.js";


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

async function seedOAuthConnection() {
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
    name: "Linear",
    provider: "linear",
    authMode: "oauth",
    endpointUrl: "https://mcp.linear.app/mcp",
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
  assert.equal(credential.encryptedOAuth, null);
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
  await assert.rejects(
    () => withManagedMcpOAuth(server.id, connection.id, async (_managedServer, provider) => {
      try {
        await auth(provider, {
          serverUrl: new URL("https://mcp.linear.app/mcp"),
          fetchFn: async () => {
            revokedRefreshRequests += 1;
            return new Response(JSON.stringify({
              error: "invalid_grant",
              error_description: "refresh token revoked",
            }), { status: 400, headers: { "Content-Type": "application/json" } });
          },
        });
      } catch (error) {
        throw normalizeManagedMcpClientError(error, false);
      }
    }),
    ManagedMcpGatewayError,
  );
  assert.equal(revokedRefreshRequests, 1);
  let [storedConnection] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(eq(managedMcpServers.id, connection.id));
  assert.equal(storedConnection.oauthStatus, "error");
  assert.equal(storedConnection.lastCheckError, "OAuth authorization expired; reconnect required");
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
        throw normalizeManagedMcpClientError(error, false);
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

test("managed MCP OAuth operations serialize across concurrent Server workers", async () => {
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
  const second = withManagedMcpOAuth(server.id, connection.id, async () => {
    events.push("second-start");
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(events, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start"]);
});

test("OAuth token persistence cannot revive connection A after an identity update to B", async () => {
  const { user, server, connection } = await seedOAuthConnection();
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
  const { user, server, connection } = await seedOAuthConnection();
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
  const { user, server, connection } = await seedOAuthConnection();
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
  const { user, server, connection } = await seedOAuthConnection();
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
