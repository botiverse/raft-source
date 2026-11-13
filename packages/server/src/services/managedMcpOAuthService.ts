import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  applyManagedMcpOAuthClientPolicy,
  currentDate,
  managedMcpOAuthClientPolicy,
  setClockTimeout,
  type ManagedMcpToolCatalogEntry,
  type ManagedMcpOAuthClientInput,
  type ManagedMcpOAuthClientMode,
  type ManagedMcpOAuthClientPolicy,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { actorHasServerCapabilityInServer } from "../lib/actorPermissions";
import {
  managedMcpAssignments,
  managedMcpCredentials,
  managedMcpOAuthAttempts,
  managedMcpServers,
} from "../db/schema";
import {
  decryptManagedMcpSecret,
  encryptManagedMcpSecret,
  ManagedMcpCredentialError,
} from "./managedMcpCredentialService";
import {
  completeManagedMcpOAuth as gatewayCompleteManagedMcpOAuth,
  listManagedMcpOAuthTools as gatewayListManagedMcpOAuthTools,
  ManagedMcpGatewayError,
  managedMcpOAuthFailureCategory,
  managedMcpOAuthFailureDetail,
  startManagedMcpOAuth as gatewayStartManagedMcpOAuth,
  validateManagedMcpEndpoint,
} from "./managedMcpGateway";
import { normalizeManagedMcpOAuthClient } from "./managedMcpOAuthClient";
import { availableRaftOAuthClientKind, type ManagedMcpRaftOAuthClientKind } from "./managedMcpRaftOAuthClient";
import { requireManagedMcpOAuthClientModeForApp } from "./managedMcpOAuthClientMode";
import { connectionAudienceMatches } from "./managedMcpConnectionAudience";
import {
  ManagedMcpOAuthProvider,
  type ManagedMcpOAuthStorage,
} from "./managedMcpOAuthProvider";

const OAUTH_ATTEMPT_TTL_MS = 10 * 60_000;
/** How long a sign-in's browser binding cookie lives: as long as its attempt. */
export const MANAGED_MCP_OAUTH_ATTEMPT_TTL_SECONDS = OAUTH_ATTEMPT_TTL_MS / 1000;
const OAUTH_LEASE_TTL_MS = 60_000;
const OAUTH_LEASE_ATTEMPTS = 20;
const OAUTH_LEASE_RETRY_MS = 100;

type CredentialRow = typeof managedMcpCredentials.$inferSelect;
type ServerRow = typeof managedMcpServers.$inferSelect;
const managedMcpServerUpdate = () => getDb().update(managedMcpServers);
type ManagedMcpServerUpdateValues = Parameters<
  ReturnType<typeof managedMcpServerUpdate>["set"]
>[0];

/**
 * Test seam for the provider round-trips of a sign-in (authorization start, code exchange, the
 * first tool listing), matching this package's `__set*ForTests` convention. The real calls need a
 * public HTTPS endpoint; everything around them (rows, attempts, leases, status) is what tests pin.
 */
type ManagedMcpOAuthGateway = {
  start: typeof gatewayStartManagedMcpOAuth;
  complete: typeof gatewayCompleteManagedMcpOAuth;
  listTools: typeof gatewayListManagedMcpOAuthTools;
};
let oauthGatewayOverride: Partial<ManagedMcpOAuthGateway> | null = null;

export function __setManagedMcpOAuthGatewayForTests(gateway: Partial<ManagedMcpOAuthGateway> | null): void {
  oauthGatewayOverride = gateway;
}

const startManagedMcpOAuth: ManagedMcpOAuthGateway["start"] = (...args) =>
  (oauthGatewayOverride?.start ?? gatewayStartManagedMcpOAuth)(...args);
const completeManagedMcpOAuth: ManagedMcpOAuthGateway["complete"] = (...args) =>
  (oauthGatewayOverride?.complete ?? gatewayCompleteManagedMcpOAuth)(...args);
const listManagedMcpOAuthTools: ManagedMcpOAuthGateway["listTools"] = (...args) =>
  (oauthGatewayOverride?.listTools ?? gatewayListManagedMcpOAuthTools)(...args);

export class ManagedMcpOAuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | "managed_mcp_oauth_required"
      | "managed_mcp_oauth_invalid_state"
      | "managed_mcp_oauth_busy"
      | "managed_mcp_oauth_persist_failed"
      | "managed_mcp_oauth_connection_not_found"
      | "managed_mcp_oauth_attempt_not_found",
  ) {
    super(message);
    this.name = "ManagedMcpOAuthError";
  }
}

function hashState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setClockTimeout(resolve, durationMs));
}

export type ManagedMcpOAuthIntent = NonNullable<typeof managedMcpOAuthAttempts.$inferSelect["intent"]>;

/**
 * Records a new pending sign-in and fails the older pending ones it replaces.
 *
 * With a `connectionId` only that Connection's attempts are replaced, so two people authorizing two
 * Connections of one App do not cancel each other. Old-shape attempts (connection_id NULL) are
 * replaced too when they would land on the same row, i.e. when the Connection is the App's default.
 */
export async function replacePendingManagedMcpOAuthAttempt(input: {
  serverId: string;
  userId: string;
  mcpServerId: string;
  configVersion: number;
  state: string;
  connectionId?: string;
  replacesLegacyAttempts?: boolean;
  intent?: ManagedMcpOAuthIntent | null;
}): Promise<{ attemptId: string }> {
  const now = currentDate();
  return getDb().transaction(async (tx) => {
    const sameApp = and(
      eq(managedMcpOAuthAttempts.serverId, input.serverId),
      eq(managedMcpOAuthAttempts.mcpServerId, input.mcpServerId),
      eq(managedMcpOAuthAttempts.status, "pending"),
    );
    await tx
      .update(managedMcpOAuthAttempts)
      .set({ status: "failed" })
      .where(and(
        sameApp,
        input.connectionId === undefined
          ? isNull(managedMcpOAuthAttempts.connectionId)
          : input.replacesLegacyAttempts
            ? or(eq(managedMcpOAuthAttempts.connectionId, input.connectionId), isNull(managedMcpOAuthAttempts.connectionId))
            : eq(managedMcpOAuthAttempts.connectionId, input.connectionId),
      ));
    const [attempt] = await tx.insert(managedMcpOAuthAttempts).values({
      serverId: input.serverId,
      mcpServerId: input.mcpServerId,
      userId: input.userId,
      configVersion: input.configVersion,
      stateHash: hashState(input.state),
      expiresAt: new Date(now.getTime() + OAUTH_ATTEMPT_TTL_MS),
      connectionId: input.connectionId ?? null,
      intent: input.intent ?? null,
    }).returning({ id: managedMcpOAuthAttempts.id });
    return { attemptId: attempt.id };
  });
}

function parseStorage(
  payload: string | null,
  redirectUrl?: string,
): ManagedMcpOAuthStorage {
  if (!payload) {
    return {
      redirectUrl:
        redirectUrl ?? "https://invalid.invalid/api/mcp/oauth/callback",
    };
  }
  const value = decryptManagedMcpSecret(payload);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManagedMcpCredentialError(
      "Stored managed MCP OAuth state is invalid",
      "managed_mcp_credential_invalid",
    );
  }
  const storage = value as Partial<ManagedMcpOAuthStorage>;
  if (typeof storage.redirectUrl !== "string" || !storage.redirectUrl) {
    throw new ManagedMcpCredentialError(
      "Stored managed MCP OAuth redirect is invalid",
      "managed_mcp_credential_invalid",
    );
  }
  if (storage.configuredClient !== undefined) {
    storage.configuredClient = normalizeManagedMcpOAuthClient(storage.configuredClient) ?? undefined;
  }
  if (storage.raftClient !== undefined && storage.raftClient !== "google") delete storage.raftClient;
  if (storage.raftClientScope !== undefined && (typeof storage.raftClientScope !== "string" || !storage.raftClientScope.trim())) delete storage.raftClientScope;
  return storage as ManagedMcpOAuthStorage;
}

async function loadServer(
  serverId: string,
  mcpServerId: string,
): Promise<ServerRow> {
  const [server] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(
      and(
        eq(managedMcpServers.serverId, serverId),
        eq(managedMcpServers.id, mcpServerId),
      ),
    )
    .limit(1);
  if (!server || server.authMode !== "oauth") {
    throw new ManagedMcpOAuthError(
      "MCP server does not use OAuth",
      "managed_mcp_oauth_required",
    );
  }
  return server;
}


/**
 * The Connection an OAuth operation runs on. `null` is the App's server default: what the
 * App-level flows (catalogue refresh, the original start/disconnect routes) and old-shape sign-in
 * attempts mean.
 */
function connectionScope(serverId: string, mcpServerId: string, connectionId: string | null) {
  return and(
    eq(managedMcpCredentials.serverId, serverId),
    eq(managedMcpCredentials.mcpServerId, mcpServerId),
    connectionId === null
      ? eq(managedMcpCredentials.isServerDefault, true)
      : eq(managedMcpCredentials.id, connectionId),
  );
}

async function acquireCredentialLease(
  serverId: string,
  mcpServerId: string,
  connectionId: string | null,
): Promise<{ credential: CredentialRow; owner: string }> {
  const owner = randomUUID();
  for (let attempt = 0; attempt < OAUTH_LEASE_ATTEMPTS; attempt += 1) {
    const now = currentDate();
    // The lease is per Connection: two Connections of one App refresh and call independently.
    const [credential] = await getDb()
      .update(managedMcpCredentials)
      .set({
        leaseOwner: owner,
        leaseExpiresAt: new Date(now.getTime() + OAUTH_LEASE_TTL_MS),
        updatedAt: now,
      })
      .where(
        and(
          connectionScope(serverId, mcpServerId, connectionId),
          or(
            isNull(managedMcpCredentials.leaseOwner),
            isNull(managedMcpCredentials.leaseExpiresAt),
            lt(managedMcpCredentials.leaseExpiresAt, now),
          ),
        ),
      )
      .returning();
    if (credential) return { credential, owner };
    const [exists] = await getDb()
      .select({ id: managedMcpCredentials.id })
      .from(managedMcpCredentials)
      .where(connectionScope(serverId, mcpServerId, connectionId))
      .limit(1);
    if (!exists) {
      throw new ManagedMcpOAuthError(
        "MCP OAuth connection not found",
        "managed_mcp_oauth_connection_not_found",
      );
    }
    await sleep(OAUTH_LEASE_RETRY_MS);
  }
  throw new ManagedMcpOAuthError(
    "MCP OAuth credentials are busy; retry shortly",
    "managed_mcp_oauth_busy",
  );
}

async function releaseCredentialLease(
  credentialId: string,
  owner: string,
): Promise<void> {
  await getDb()
    .update(managedMcpCredentials)
    .set({
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: currentDate(),
    })
    .where(
      and(
        eq(managedMcpCredentials.id, credentialId),
        eq(managedMcpCredentials.leaseOwner, owner),
      ),
    );
}

function sameConnectionIdentity(left: ServerRow, right: ServerRow): boolean {
  return left.id === right.id
    && left.serverId === right.serverId
    && left.configVersion === right.configVersion
    && left.provider === right.provider
    && left.authMode === right.authMode
    && left.endpointUrl === right.endpointUrl;
}

function serverConnectionFence(server: ServerRow) {
  return and(
    eq(managedMcpServers.id, server.id),
    eq(managedMcpServers.serverId, server.serverId),
    eq(managedMcpServers.configVersion, server.configVersion),
    eq(managedMcpServers.provider, server.provider),
    eq(managedMcpServers.authMode, server.authMode),
    eq(managedMcpServers.endpointUrl, server.endpointUrl),
  );
}

function credentialConnectionExists(server: ServerRow) {
  return sql`exists (
    select 1 from ${managedMcpServers}
    where ${managedMcpServers.id} = ${server.id}
      and ${managedMcpServers.serverId} = ${server.serverId}
      and ${managedMcpServers.configVersion} = ${server.configVersion}
      and ${managedMcpServers.provider} = ${server.provider}
      and ${managedMcpServers.authMode} = ${server.authMode}
      and ${managedMcpServers.endpointUrl} = ${server.endpointUrl}
  )`;
}

type ConnectionAuthStatus = CredentialRow["authStatus"];

/**
 * `managed_mcp_servers.oauth_status` mirrors the App's DEFAULT Connection. Older binaries read it
 * during a rolling deploy, and the App-level views describe the App by its default. Same mapping as
 * the 0409 backfill, read the other way.
 */
export const APP_OAUTH_STATUS_FOR_CONNECTION = {
  ready: "connected",
  pending: "pending",
  expired: "error",
  error: "error",
  needs_auth: "disconnected",
} as const satisfies Record<ConnectionAuthStatus, ServerRow["oauthStatus"]>;

/**
 * Writes one Connection's OAuth status, fenced on the App's configuration so a result from before
 * an endpoint change cannot land after it.
 *
 * `appValues` describe the App and are written whichever Connection this is. `defaultValues`, and
 * the `oauth_status` mirror, describe the default Connection and are written only when this
 * Connection is the default, so a sign-in or an expiry on another Connection leaves them alone.
 */
async function recordConnectionOAuthStatus(
  server: ServerRow,
  connectionId: string | null,
  input: {
    status: ConnectionAuthStatus;
    lastError?: string | null;
    accountLabel?: string | null;
    /** The endpoint this sign-in is now valid for (`authorized_endpoint_url`); written with `ready`. */
    authorizedEndpointUrl?: string;
    appValues?: ManagedMcpServerUpdateValues;
    defaultValues?: ManagedMcpServerUpdateValues;
    /**
     * Write only while the Connection's stored credentials are still at this `credential_version`:
     * a stale tool call's verdict must not overwrite a newer grant, sign-in or disconnect.
     * The Connection row is locked, so credential and status changes cannot race this check.
     */
    expectedCredentialVersion?: number;
  },
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    // ⚠️ Lock the App row BEFORE asking which Connection is the default, in the same order
    // `setServerDefaultConnection` locks. Read unlocked, "A is the default" could be decided just
    // before a concurrent switch to B commits, and A's failure would then overwrite B's status in
    // the mirror, refusing every Agent that follows the default (@Huarong).
    const [locked] = await tx
      .select({ id: managedMcpServers.id })
      .from(managedMcpServers)
      .where(serverConnectionFence(server))
      .for("update");
    if (!locked) return false;
    const connectionQuery = tx
      .select({
        id: managedMcpCredentials.id,
        isServerDefault: managedMcpCredentials.isServerDefault,
        credentialVersion: managedMcpCredentials.credentialVersion,
      })
      .from(managedMcpCredentials)
      .where(connectionScope(server.serverId, server.id, connectionId))
      .limit(1);
    const [connection] = input.expectedCredentialVersion === undefined
      ? await connectionQuery
      : await connectionQuery.for("update");
    if (
      input.expectedCredentialVersion !== undefined
      && connection?.credentialVersion !== input.expectedCredentialVersion
    ) return false;
    const isDefault = connection?.isServerDefault === true;
    const rows = await tx
      .update(managedMcpServers)
      .set({
        ...(input.appValues ?? {}),
        ...(isDefault
          ? { oauthStatus: APP_OAUTH_STATUS_FOR_CONNECTION[input.status], ...(input.defaultValues ?? {}) }
          : {}),
        updatedAt: currentDate(),
      })
      .where(serverConnectionFence(server))
      .returning({ id: managedMcpServers.id });
    if (rows.length !== 1) return false;
    if (connection) {
      await tx
        .update(managedMcpCredentials)
        .set({
          authStatus: input.status,
          lastCheckedAt: currentDate(),
          lastError: input.lastError ?? null,
          ...(input.accountLabel !== undefined ? { accountLabel: input.accountLabel } : {}),
          ...(input.authorizedEndpointUrl !== undefined ? { authorizedEndpointUrl: input.authorizedEndpointUrl } : {}),
          updatedAt: currentDate(),
        })
        .where(eq(managedMcpCredentials.id, connection.id));
    }
    return true;
  });
}

export const __recordConnectionOAuthStatusForTests = recordConnectionOAuthStatus;

async function withOAuthLease<T>(
  serverId: string,
  mcpServerId: string,
  connectionId: string | null,
  redirectUrl: string | undefined,
  fixedState: string | undefined,
  expectedConfigVersion: number | undefined,
  operation: (
    server: ServerRow,
    provider: ManagedMcpOAuthProvider,
    storage: ManagedMcpOAuthStorage,
    lease: { credentialId: string; owner: string; isServerDefault: boolean; credential: CredentialRow },
  ) => Promise<T>,
): Promise<T> {
  const initialServer = await loadServer(serverId, mcpServerId);
  if (
    expectedConfigVersion !== undefined
    && initialServer.configVersion !== expectedConfigVersion
  ) {
    throw new ManagedMcpOAuthError(
      "MCP OAuth connection changed before the operation began",
      "managed_mcp_oauth_invalid_state",
    );
  }
  const { credential, owner } = await acquireCredentialLease(
    serverId,
    mcpServerId,
    connectionId,
  );
  try {
    const server = await loadServer(serverId, mcpServerId);
    if (!sameConnectionIdentity(initialServer, server)) {
      throw new ManagedMcpOAuthError(
        "MCP OAuth connection changed while acquiring credentials",
        "managed_mcp_oauth_invalid_state",
      );
    }
    const storage = parseStorage(credential.encryptedOAuth, redirectUrl);
    const persist = async () => {
      const [updated] = await getDb()
        .update(managedMcpCredentials)
        .set({
          encryptedOAuth: encryptManagedMcpSecret(storage),
          credentialVersion: sql`${managedMcpCredentials.credentialVersion} + 1`,
          updatedAt: currentDate(),
        })
        .where(
          and(
            eq(managedMcpCredentials.id, credential.id),
            eq(managedMcpCredentials.leaseOwner, owner),
            credentialConnectionExists(server),
          ),
        )
        .returning({ id: managedMcpCredentials.id });
      if (!updated) {
        throw new ManagedMcpOAuthError(
          "MCP OAuth connection changed before credentials were saved",
          "managed_mcp_oauth_persist_failed",
        );
      }
    };
    const provider = new ManagedMcpOAuthProvider(storage, persist, fixedState);
    return await operation(server, provider, storage, {
      credentialId: credential.id,
      owner,
      isServerDefault: credential.isServerDefault,
      credential,
    });
  } finally {
    await releaseCredentialLease(credential.id, owner);
  }
}

/** A display label from the token response (Notion returns `workspace_name`). Never a token. */
function accountLabelFromTokens(tokens: ManagedMcpOAuthStorage["tokens"]): string | null {
  const label = (tokens as Record<string, unknown> | undefined)?.workspace_name;
  return typeof label === "string" && label.trim() ? label.trim().slice(0, 200) : null;
}

async function updateCatalog(
  server: ServerRow,
  connectionId: string,
  toolCatalog: ManagedMcpToolCatalogEntry[],
  accountLabel: string | null,
): Promise<void> {
  const updated = await recordConnectionOAuthStatus(server, connectionId, {
    status: "ready",
    accountLabel,
    // Fenced on the App's configuration in the same transaction, so this is the server signed in to.
    authorizedEndpointUrl: server.endpointUrl,
    appValues: {
      toolCatalog,
      catalogVersion: sql`${managedMcpServers.catalogVersion} + 1`,
    },
    defaultValues: {
      lastCheckedAt: currentDate(),
      lastCheckError: null,
    },
  });
  if (!updated) {
    throw new ManagedMcpOAuthError(
      "MCP OAuth connection changed before its catalog was saved",
      "managed_mcp_oauth_persist_failed",
    );
  }
}

/**
 * Which Connection a sign-in starts on.
 *
 * Omitted means the App's server default, created when the App has none: the original
 * single-credential start route keeps meaning "authorize this App".
 */
export type ManagedMcpOAuthStartTarget =
  | { connectionId: string }
  | { newConnectionName: string };

/**
 * A "new Connection" sign-in writes its row before the provider is contacted. If the popup is
 * closed, or the attempt simply expires, nothing ever completes it, and without this every retry
 * would add another unusable row. Before a new one is written:
 *
 *   - a retry by the same person under the same name reuses their abandoned row (the new attempt
 *     replaces the old one), so retries do not accumulate;
 *   - abandoned rows whose sign-ins can no longer complete are deleted.
 *
 * "Abandoned" is narrow on purpose: never the default, OAuth, still `pending`/`error`, never
 * completed (no consumed attempt: a completed sign-in consumes its attempt and a failed one is
 * marked failed), and not pinned by any Agent. Deletion additionally needs no live attempt and an
 * age past the attempt TTL, so a row whose first attempt is being written right now is safe.
 * Returns the reused Connection id, if any.
 */
async function reclaimAbandonedOAuthConnections(server: ServerRow, userId: string, name: string): Promise<string | null> {
  const now = currentDate();
  const abandoned = and(
    eq(managedMcpCredentials.serverId, server.serverId),
    eq(managedMcpCredentials.mcpServerId, server.id),
    eq(managedMcpCredentials.isServerDefault, false),
    eq(managedMcpCredentials.authKind, "oauth"),
    inArray(managedMcpCredentials.authStatus, ["pending", "error"]),
    sql`not exists (select 1 from ${managedMcpOAuthAttempts} where ${managedMcpOAuthAttempts.connectionId} = ${managedMcpCredentials.id} and ${managedMcpOAuthAttempts.status} = 'consumed')`,
    sql`not exists (select 1 from ${managedMcpAssignments} where ${managedMcpAssignments.boundConnectionId} = ${managedMcpCredentials.id})`,
  );
  await getDb().delete(managedMcpCredentials).where(and(
    abandoned,
    lt(managedMcpCredentials.createdAt, new Date(now.getTime() - OAUTH_ATTEMPT_TTL_MS)),
    sql`not exists (select 1 from ${managedMcpOAuthAttempts} where ${managedMcpOAuthAttempts.connectionId} = ${managedMcpCredentials.id} and ${managedMcpOAuthAttempts.status} = 'pending' and ${managedMcpOAuthAttempts.expiresAt} > ${now})`,
  ));
  const [mine] = await getDb()
    .select({ id: managedMcpCredentials.id })
    .from(managedMcpCredentials)
    .where(and(abandoned, eq(managedMcpCredentials.createdByUserId, userId), eq(managedMcpCredentials.name, name)))
    .limit(1);
  return mine?.id ?? null;
}

async function resolveStartTarget(
  server: ServerRow,
  userId: string,
  target: ManagedMcpOAuthStartTarget | undefined,
): Promise<{ connectionId: string; created: boolean; isServerDefault: boolean }> {
  if (target && "newConnectionName" in target) {
    const reused = await reclaimAbandonedOAuthConnections(server, userId, target.newConnectionName);
    if (reused) return { connectionId: reused, created: true, isServerDefault: false };
    // A new Connection is never the default when it is created: it has no tokens yet. Becoming the
    // default is a separate, admin-only decision applied after a successful sign-in.
    const [row] = await getDb().insert(managedMcpCredentials).values({
      serverId: server.serverId,
      mcpServerId: server.id,
      isServerDefault: false,
      name: target.newConnectionName,
      authKind: "oauth",
      authStatus: "pending",
      createdByUserId: userId,
    }).returning({ id: managedMcpCredentials.id });
    return { connectionId: row.id, created: true, isServerDefault: false };
  }
  const connectionId = target?.connectionId ?? null;
  const select = () => getDb()
    .select({
      id: managedMcpCredentials.id,
      isServerDefault: managedMcpCredentials.isServerDefault,
      authKind: managedMcpCredentials.authKind,
    })
    .from(managedMcpCredentials)
    .where(connectionScope(server.serverId, server.id, connectionId))
    .limit(1);
  let [row] = await select();
  if (!row && connectionId === null) {
    await getDb().insert(managedMcpCredentials).values({
      serverId: server.serverId,
      mcpServerId: server.id,
      isServerDefault: true,
      name: server.name,
      authKind: "oauth",
      authStatus: "needs_auth",
      createdByUserId: userId,
    }).onConflictDoNothing();
    [row] = await select();
  }
  if (!row || row.authKind === "headers") {
    throw new ManagedMcpOAuthError(
      "MCP OAuth connection not found",
      "managed_mcp_oauth_connection_not_found",
    );
  }
  return { connectionId: row.id, created: false, isServerDefault: row.isServerDefault };
}

/**
 * Raft fixes the provider's client settings (see managedMcpOAuthClientPolicy), whatever was sent;
 * the user supplies only the Client ID and secret. Such providers cannot register a client
 * automatically, so removing the client is refused before any network request.
 */
function enforceOAuthClientPolicy(
  policy: ManagedMcpOAuthClientPolicy | null,
  client: ManagedMcpOAuthClientInput | null | undefined,
  raftClient: ManagedMcpRaftOAuthClientKind | null,
): ManagedMcpOAuthClientInput | null | undefined {
  if (!policy) return client;
  // With Raft's own client on this deployment, removing the user's client means signing in with Raft's.
  if (client === null && !raftClient) {
    throw new ManagedMcpGatewayError(
      "This MCP server does not support automatic client registration; register an OAuth client with the provider and enter it",
      "managed_mcp_oauth_client_registration_unsupported",
    );
  }
  if (client && !client.clientSecret) {
    throw new ManagedMcpCredentialError("This provider's OAuth client needs its client secret", "managed_mcp_credential_invalid");
  }
  return applyManagedMcpOAuthClientPolicy(policy, client);
}

/**
 * The template's client mode, on what was submitted: an `automatic`-only App takes no registered
 * client, and a `registered`-only App cannot drop to automatic registration (unless Raft's own
 * client stands in). Method, scope and secret stay the user's choice; only a provider policy fixes them.
 */
function enforceOAuthClientMode(
  mode: ManagedMcpOAuthClientMode,
  client: ManagedMcpOAuthClientInput | null | undefined,
  raftClient: ManagedMcpRaftOAuthClientKind | null,
): void {
  if (mode === "automatic" && client) {
    throw new ManagedMcpCredentialError("This App signs in with automatic client registration only", "managed_mcp_credential_invalid");
  }
  if (mode === "registered" && client === null && !raftClient) {
    throw new ManagedMcpGatewayError(
      "This MCP server does not support automatic client registration; register an OAuth client with the provider and enter it",
      "managed_mcp_oauth_client_registration_unsupported",
    );
  }
}

/**
 * MCP servers whose authorization server advertises client metadata documents but rejects Raft's
 * at authorization ("invalid client_id or mismatched redirect_uri"), while accepting dynamic
 * registration. Without a metadata URL the SDK registers a client instead.
 */
const CLIENT_METADATA_DOCUMENT_REJECTED_HOSTS = new Set(["mcp.airtable.com"]);

function rejectsClientMetadataDocument(endpointUrl: string): boolean {
  try {
    return CLIENT_METADATA_DOCUMENT_REJECTED_HOSTS.has(new URL(endpointUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export async function startManagedMcpOAuthConnection(input: {
  serverId: string;
  userId: string;
  mcpServerId: string;
  redirectUrl: string;
  connection?: ManagedMcpOAuthStartTarget;
  /** Per-Connection, write-only. Omit to keep, null for automatic, object to replace. */
  oauthClient?: ManagedMcpOAuthClientInput | null;
  intent?: ManagedMcpOAuthIntent | null;
}): Promise<{ authorizationUrl: string; attemptId: string; connectionId: string; state: string }> {
  const initialServer = await loadServer(input.serverId, input.mcpServerId);
  const policy = managedMcpOAuthClientPolicy(initialServer.endpointUrl);
  const raftClient = availableRaftOAuthClientKind(policy);
  const clientMode = await requireManagedMcpOAuthClientModeForApp(initialServer);
  const submittedClient = normalizeManagedMcpOAuthClient(input.oauthClient);
  enforceOAuthClientMode(clientMode, submittedClient, raftClient);
  const oauthClient = enforceOAuthClientPolicy(policy, submittedClient, raftClient);
  const target = await resolveStartTarget(initialServer, input.userId, input.connection);
  const state = randomBytes(32).toString("base64url");
  let attemptId: string | null = null;
  try {
    const authorizationUrl = await withOAuthLease(
      input.serverId,
      input.mcpServerId,
      target.connectionId,
      input.redirectUrl,
      state,
      initialServer.configVersion,
      async (server, provider, storage) => {
        ({ attemptId } = await replacePendingManagedMcpOAuthAttempt({
          serverId: input.serverId,
          userId: input.userId,
          mcpServerId: input.mcpServerId,
          configVersion: server.configVersion,
          state,
          connectionId: target.connectionId,
          replacesLegacyAttempts: target.isServerDefault,
          intent: input.intent ?? null,
        }));
        // The lease and the replaced pending attempt fence this Connection only. Never change
        // another Connection's client or the App's assignment/default selection.
        // A Connection without its own client signs in with Raft's client when this deployment
        // has one for the provider: on removal, and on a first sign-in that sends nothing.
        const usesRaftClient = raftClient !== null && (
          oauthClient === null || (oauthClient === undefined && !storage.configuredClient && !storage.raftClient)
        );
        const clientChanged = oauthClient !== undefined || usesRaftClient;
        if (oauthClient) {
          storage.configuredClient = oauthClient;
          delete storage.raftClient;
          delete storage.raftClientScope;
        } else if (oauthClient === null) {
          delete storage.configuredClient;
          delete storage.raftClient;
          delete storage.raftClientScope;
        }
        if (usesRaftClient) storage.raftClient = raftClient;
        // Raft's client always requests the current policy's scopes, never the server's full list.
        if (storage.raftClient && policy) storage.raftClientScope = policy.scopes.join(" ");
        // The client this sign-in will use, including one kept from before: under a policy it must
        // be the user's client with its secret (given the fixed settings) or Raft's client while this
        // deployment still has it, before any network request.
        if (policy) {
          if (storage.configuredClient) storage.configuredClient = enforceOAuthClientPolicy(policy, storage.configuredClient, raftClient) ?? undefined;
          else if (!(storage.raftClient && raftClient)) enforceOAuthClientPolicy(policy, null, null);
        }
        // A registered-only App needs a client to sign in with: the user's, or Raft's own.
        else if (clientMode === "registered" && !storage.configuredClient && !(storage.raftClient && raftClient)) {
          enforceOAuthClientMode(clientMode, null, null);
        }
        storage.authorizationState = state;
        // Persist before any network request: even a failed reconnect must not retain the old
        // token beside a newly selected client. Full replacement also drops DCR/discovery state.
        await provider.invalidateCredentials(clientChanged ? "all" : "tokens");
        delete storage.codeVerifier;
        storage.redirectUrl = input.redirectUrl;
        const metadataUrl = new URL(
          "client-metadata",
          input.redirectUrl,
        ).toString();
        storage.clientMetadataUrl = metadataUrl.startsWith("https://") && !rejectsClientMetadataDocument(server.endpointUrl)
          ? metadataUrl
          : undefined;
        if (
          storage.clientInformation?.client_id.startsWith("https://")
          && storage.clientInformation.client_id !== storage.clientMetadataUrl
        ) {
          delete storage.clientInformation;
        }
        const result = await startManagedMcpOAuth(server.endpointUrl, provider);
        if (result !== "REDIRECT" || !provider.authorizationUrl) {
          throw new ManagedMcpOAuthError(
            "MCP OAuth did not provide an authorization URL",
            "managed_mcp_oauth_required",
          );
        }
        if (!(await recordConnectionOAuthStatus(server, target.connectionId, {
          status: "pending",
          defaultValues: { lastCheckError: null },
        }))) {
          throw new ManagedMcpOAuthError(
            "MCP OAuth connection changed before authorization was saved",
            "managed_mcp_oauth_persist_failed",
          );
        }
        return validateManagedMcpEndpoint(provider.authorizationUrl).toString();
      },
    );
    // `state` is for the route's browser binding cookie only; it never goes into a response body.
    return { authorizationUrl, attemptId: attemptId!, connectionId: target.connectionId, state };
  } catch (error) {
    await getDb()
      .update(managedMcpOAuthAttempts)
      .set({ status: "failed" })
      .where(eq(managedMcpOAuthAttempts.stateHash, hashState(state)));
    if (target.created) {
      // Nothing was ever authorized on it; leaving it would show an unusable Connection.
      await getDb().delete(managedMcpCredentials).where(eq(managedMcpCredentials.id, target.connectionId));
    } else {
      await recordConnectionOAuthStatus(initialServer, target.connectionId, {
        status: "error",
        lastError: "OAuth authorization could not be started",
      });
    }
    throw error;
  }
}

export interface ManagedMcpOAuthCompletion {
  serverId: string;
  mcpServerId: string;
  attemptId: string;
  connectionId: string;
  userId: string;
  intent: ManagedMcpOAuthIntent | null;
}

export async function completeManagedMcpOAuthConnection(input: {
  state: string;
  authorizationCode: string;
}): Promise<ManagedMcpOAuthCompletion> {
  const attempt = await consumeManagedMcpOAuthAttempt(input.state);
  // An old-shape attempt (connection_id NULL, started by an older binary) completes on the App's
  // default Connection, the single row that binary assumed.
  let connectionId: string | null = attempt.connectionId;
  let superseded = false;
  // Which step failed, so the Connection says why: no tokens, or tokens the MCP server refused.
  let stage: "token" | "tools" | null = null;

  try {
    if (
      !(await actorHasServerCapabilityInServer(
        attempt.serverId,
        "user",
        attempt.userId,
        "manageExternalAuth",
      ))
    ) {
      throw new ManagedMcpOAuthError(
        "MCP OAuth authorization is no longer permitted",
        "managed_mcp_oauth_invalid_state",
      );
    }
    await withOAuthLease(
      attempt.serverId,
      attempt.mcpServerId,
      connectionId,
      undefined,
      input.state,
      attempt.configVersion,
      async (server, provider, storage, lease) => {
        connectionId = lease.credentialId;
        if (storage.authorizationState !== undefined && storage.authorizationState !== input.state) {
          superseded = true;
          throw new ManagedMcpOAuthError("MCP OAuth sign-in was replaced", "managed_mcp_oauth_invalid_state");
        }
        stage = "token";
        await completeManagedMcpOAuth(
          server.endpointUrl,
          provider,
          input.authorizationCode,
        );
        stage = "tools";
        const toolCatalog = await listManagedMcpOAuthTools(
          server.endpointUrl,
          provider,
        );
        // Network steps are done; a failure from here on is Raft's own, not the provider's.
        stage = null;
        await updateCatalog(server, lease.credentialId, toolCatalog, accountLabelFromTokens(storage.tokens));
      },
    );
    return {
      serverId: attempt.serverId,
      mcpServerId: attempt.mcpServerId,
      attemptId: attempt.id,
      connectionId: connectionId!,
      userId: attempt.userId,
      intent: attempt.intent ?? null,
    };
  } catch (error) {
    await getDb()
      .update(managedMcpOAuthAttempts)
      .set({ status: "failed" })
      .where(eq(managedMcpOAuthAttempts.id, attempt.id));
    const [frozenServer] = await getDb()
      .select()
      .from(managedMcpServers)
      .where(
        and(
          eq(managedMcpServers.id, attempt.mcpServerId),
          eq(managedMcpServers.serverId, attempt.serverId),
          eq(managedMcpServers.configVersion, attempt.configVersion),
        ),
      )
      .limit(1);
    const lastError = managedMcpOAuthCompletionError(stage, error);
    if (frozenServer && !superseded) await recordConnectionOAuthStatus(frozenServer, connectionId, {
      status: "error",
      lastError,
      defaultValues: {
        lastCheckedAt: currentDate(),
        lastCheckError: lastError,
      },
    });
    throw error;
  }
}

/** The Connection's status line after a failed callback: the step and the provider's reason. */
export function managedMcpOAuthCompletionError(stage: "token" | "tools" | null, error: unknown): string {
  if (stage === null) return "OAuth connection failed";
  const detail = managedMcpOAuthFailureDetail(error);
  const step = stage === "token" ? "OAuth token exchange failed" : "Signed in, but the MCP server refused the request";
  return detail ? `${step}: ${detail}` : step;
}

/**
 * Why a tool call's Connection must be reconnected, for its status line and the log. Only what the
 * call observed: whether the Connection had a refresh token stored, which renewal refusal the SDK
 * acted on, and the provider's failure as a fixed category (`managedMcpOAuthFailureCategory`: an
 * OAuth error code or HTTP status, never provider text, so nothing it sent reaches either).
 */
export function managedMcpOAuthReconnectReason(
  hadRefreshToken: boolean,
  refusedRenewal: "tokens" | "client" | null,
  error: unknown,
): { cause: "no_refresh_token" | "refresh_refused" | "client_refused" | "rejected"; category: string | null; message: string } {
  const category = managedMcpOAuthFailureCategory(error);
  if (refusedRenewal === "tokens") {
    return { cause: "refresh_refused", category: "invalid_grant", message: "OAuth renewal refused by the provider (invalid_grant); reconnect required" };
  }
  if (refusedRenewal === "client") {
    return { cause: "client_refused", category: null, message: "OAuth renewal refused by the provider (OAuth client rejected); reconnect required" };
  }
  if (category) return { cause: "rejected", category, message: `OAuth authorization rejected (${category}); reconnect required` };
  if (!hadRefreshToken) {
    return { cause: "no_refresh_token", category: null, message: "OAuth authorization expired and this Connection has no refresh token stored; reconnect required" };
  }
  return { cause: "rejected", category: null, message: "OAuth authorization expired; reconnect required" };
}

export async function consumeManagedMcpOAuthAttempt(
  state: string,
): Promise<typeof managedMcpOAuthAttempts.$inferSelect> {
  const now = currentDate();
  const [attempt] = await getDb()
    .update(managedMcpOAuthAttempts)
    .set({
      status: "consumed",
      consumedAt: now,
    })
    .where(
      and(
        eq(managedMcpOAuthAttempts.stateHash, hashState(state)),
        eq(managedMcpOAuthAttempts.status, "pending"),
        gt(managedMcpOAuthAttempts.expiresAt, now),
      ),
    )
    .returning();
  if (!attempt) {
    throw new ManagedMcpOAuthError(
      "MCP OAuth state is invalid, expired, or already used",
      "managed_mcp_oauth_invalid_state",
    );
  }
  return attempt;
}

export async function failManagedMcpOAuthAttempt(state: string): Promise<void> {
  if (!state) return;
  const [attempt] = await getDb()
    .update(managedMcpOAuthAttempts)
    .set({ status: "failed" })
    .where(
      and(
        eq(managedMcpOAuthAttempts.stateHash, hashState(state)),
        eq(managedMcpOAuthAttempts.status, "pending"),
      ),
    )
    .returning({
      serverId: managedMcpOAuthAttempts.serverId,
      mcpServerId: managedMcpOAuthAttempts.mcpServerId,
      configVersion: managedMcpOAuthAttempts.configVersion,
      connectionId: managedMcpOAuthAttempts.connectionId,
    });
  if (!attempt) return;
  const [server] = await getDb()
    .select()
    .from(managedMcpServers)
    .where(
      and(
        eq(managedMcpServers.id, attempt.mcpServerId),
        eq(managedMcpServers.serverId, attempt.serverId),
        eq(managedMcpServers.configVersion, attempt.configVersion),
      ),
    )
    .limit(1);
  if (server) await recordConnectionOAuthStatus(server, attempt.connectionId, {
    status: "error",
    lastError: "OAuth authorization was not completed",
    defaultValues: {
      lastCheckedAt: currentDate(),
      lastCheckError: "OAuth authorization was not completed",
    },
  });
}

export type ManagedMcpOAuthAttemptStatus = "pending" | "connected" | "failed" | "expired";

/**
 * What became of a sign-in, for the browser that started it (the popup's fallback when the
 * BroadcastChannel message does not arrive). Only the user who started the attempt can see it;
 * anyone else gets the same answer as for an id that does not exist.
 */
export async function getManagedMcpOAuthAttemptStatus(input: {
  serverId: string;
  userId: string;
  attemptId: string;
}): Promise<{ attemptId: string; status: ManagedMcpOAuthAttemptStatus; connectionId: string | null }> {
  const [attempt] = await getDb()
    .select()
    .from(managedMcpOAuthAttempts)
    .where(and(
      eq(managedMcpOAuthAttempts.id, input.attemptId),
      eq(managedMcpOAuthAttempts.serverId, input.serverId),
      eq(managedMcpOAuthAttempts.userId, input.userId),
    ))
    .limit(1);
  if (!attempt) {
    throw new ManagedMcpOAuthError("MCP OAuth attempt not found", "managed_mcp_oauth_attempt_not_found");
  }
  const view = (status: ManagedMcpOAuthAttemptStatus) => ({
    attemptId: attempt.id,
    status,
    connectionId: attempt.connectionId,
  });
  if (attempt.status === "failed") return view("failed");
  if (attempt.status === "pending") return view(attempt.expiresAt > currentDate() ? "pending" : "expired");
  // Consumed: the callback ran. The Connection's status says whether the exchange finished.
  const [connection] = await getDb()
    .select({ authStatus: managedMcpCredentials.authStatus })
    .from(managedMcpCredentials)
    .where(connectionScope(attempt.serverId, attempt.mcpServerId, attempt.connectionId))
    .limit(1);
  if (connection?.authStatus === "ready") return view("connected");
  return view(connection?.authStatus === "pending" ? "pending" : "failed");
}

export async function disconnectManagedMcpOAuthConnection(
  serverId: string,
  mcpServerId: string,
  connectionId: string | null = null,
): Promise<void> {
  await loadServer(serverId, mcpServerId);
  await withOAuthLease(
    serverId,
    mcpServerId,
    connectionId,
    undefined,
    undefined,
    undefined,
    async (server, _provider, storage, lease) => {
      await getDb()
        .update(managedMcpOAuthAttempts)
        .set({ status: "failed" })
        .where(
          and(
            eq(managedMcpOAuthAttempts.serverId, serverId),
            eq(managedMcpOAuthAttempts.mcpServerId, mcpServerId),
            eq(managedMcpOAuthAttempts.status, "pending"),
            lease.isServerDefault
              ? or(eq(managedMcpOAuthAttempts.connectionId, lease.credentialId), isNull(managedMcpOAuthAttempts.connectionId))
              : eq(managedMcpOAuthAttempts.connectionId, lease.credentialId),
          ),
        );
      const [cleared] = await getDb()
        .update(managedMcpCredentials)
        .set({
          // Keep only the client choice (registered or Raft's) and a fresh sign-in fence. A callback
          // already consumed before waiting for this lease must not resurrect a signed-out grant.
          encryptedOAuth: encryptManagedMcpSecret({
            redirectUrl: storage.redirectUrl,
            ...(storage.configuredClient ? { configuredClient: storage.configuredClient } : {}),
            ...(storage.raftClient ? { raftClient: storage.raftClient } : {}),
            ...(storage.raftClientScope ? { raftClientScope: storage.raftClientScope } : {}),
            authorizationState: randomBytes(32).toString("base64url"),
          } satisfies ManagedMcpOAuthStorage),
          credentialVersion: sql`${managedMcpCredentials.credentialVersion} + 1`,
          updatedAt: currentDate(),
        })
        .where(
          and(
            eq(managedMcpCredentials.id, lease.credentialId),
            eq(managedMcpCredentials.leaseOwner, lease.owner),
            credentialConnectionExists(server),
          ),
        )
        .returning({ id: managedMcpCredentials.id });
      if (!cleared) {
        throw new ManagedMcpOAuthError(
          "MCP OAuth lease was lost before credentials were disconnected",
          "managed_mcp_oauth_persist_failed",
        );
      }
      if (!(await recordConnectionOAuthStatus(server, lease.credentialId, {
        status: "needs_auth",
        defaultValues: {
          toolCatalog: [],
          catalogVersion: sql`${managedMcpServers.catalogVersion} + 1`,
          lastCheckedAt: null,
          lastCheckError: null,
        },
      }))) {
        throw new ManagedMcpOAuthError(
          "MCP OAuth connection changed before disconnect completed",
          "managed_mcp_oauth_persist_failed",
        );
      }
    },
  );
}

/**
 * The provider a tool call runs with. Every write still goes through the
 * credential lease (`persistToolCallStorage`), so it records which kind of
 * write the SDK is making: a token save from a refresh it just won, an
 * invalidation after a refresh it lost, or bookkeeping (discovery, client
 * information, verifier).
 */
class ToolCallOAuthProvider extends ManagedMcpOAuthProvider {
  writeKind: "tokens" | "invalidate" | "other" = "other";
  /**
   * The SDK invalidates tokens only after the provider refused a refresh (`invalid_grant`), and
   * everything after `invalid_client` / `unauthorized_client`, then ends in a plain sign-in-required
   * error; this keeps which of the two it was.
   */
  refusedRenewal: "tokens" | "client" | null = null;

  override async saveTokens(...args: Parameters<ManagedMcpOAuthProvider["saveTokens"]>): Promise<void> {
    this.writeKind = "tokens";
    try {
      await super.saveTokens(...args);
    } finally {
      this.writeKind = "other";
    }
  }

  override async invalidateCredentials(
    ...args: Parameters<ManagedMcpOAuthProvider["invalidateCredentials"]>
  ): Promise<void> {
    this.writeKind = "invalidate";
    if (args[0] === "tokens") this.refusedRenewal = "tokens";
    else if (args[0] === "all") this.refusedRenewal = "client";
    try {
      await super.invalidateCredentials(...args);
    } finally {
      this.writeKind = "other";
    }
  }
}

/** What one tool call read, and whether another call saved newer credentials under it. */
interface ToolCallSnapshot {
  credentialId: string;
  version: number;
  supersededByConcurrentSave: boolean;
}

/** The Connection's stored row, read without the lease. `connectionId` null is the App's server default. */
async function loadCredentialSnapshot(
  serverId: string,
  mcpServerId: string,
  connectionId: string | null,
): Promise<CredentialRow> {
  const [credential] = await getDb()
    .select()
    .from(managedMcpCredentials)
    .where(connectionScope(serverId, mcpServerId, connectionId))
    .limit(1);
  if (!credential) {
    throw new ManagedMcpOAuthError(
      "MCP OAuth is not connected",
      "managed_mcp_oauth_required",
    );
  }
  return credential;
}

/**
 * A tool call's write-back: the only part of a tool call that holds the
 * credential lease (of the Connection the call runs on). When another call
 * saved credentials since this one read them (`credential_version` moved):
 * - an invalidation is dropped: the refresh it lost was raced by one that
 *   won, and wiping the winner's tokens would force a needless reconnect;
 * - a token save is written: it is the newest grant the provider issued;
 * - bookkeeping keeps the newer stored tokens instead of this call's stale ones.
 */
async function persistToolCallStorage(
  server: ServerRow,
  storage: ManagedMcpOAuthStorage,
  snapshot: ToolCallSnapshot,
  writeKind: ToolCallOAuthProvider["writeKind"],
): Promise<void> {
  const { credential, owner } = await acquireCredentialLease(
    server.serverId,
    server.id,
    snapshot.credentialId,
  );
  try {
    if (credential.id !== snapshot.credentialId) {
      throw new ManagedMcpOAuthError(
        "MCP OAuth connection changed before credentials were saved",
        "managed_mcp_oauth_persist_failed",
      );
    }
    if (credential.credentialVersion !== snapshot.version) {
      snapshot.supersededByConcurrentSave = true;
      const stored = parseStorage(credential.encryptedOAuth, storage.redirectUrl);
      if (stored.authorizationState !== storage.authorizationState) {
        throw new ManagedMcpOAuthError("MCP OAuth sign-in changed during the tool call", "managed_mcp_oauth_invalid_state");
      }
      if (writeKind === "invalidate") {
        Object.assign(storage, stored);
        if (!stored.tokens) delete storage.tokens;
        snapshot.version = credential.credentialVersion;
        return;
      }
      if (writeKind === "other") {
        if (stored.tokens) storage.tokens = stored.tokens;
        else delete storage.tokens;
      }
    }
    const [updated] = await getDb()
      .update(managedMcpCredentials)
      .set({
        encryptedOAuth: encryptManagedMcpSecret(storage),
        credentialVersion: sql`${managedMcpCredentials.credentialVersion} + 1`,
        updatedAt: currentDate(),
      })
      .where(
        and(
          eq(managedMcpCredentials.id, credential.id),
          eq(managedMcpCredentials.leaseOwner, owner),
          credentialConnectionExists(server),
        ),
      )
      .returning({ credentialVersion: managedMcpCredentials.credentialVersion });
    if (!updated) {
      throw new ManagedMcpOAuthError(
        "MCP OAuth connection changed before credentials were saved",
        "managed_mcp_oauth_persist_failed",
      );
    }
    snapshot.version = updated.credentialVersion;
    if (writeKind === "tokens") {
      // A newly issued grant proves the Connection works. A concurrent call
      // that lost the same refresh may already have marked it expired (its
      // invalidation landed first); undo that so a good grant never sits
      // behind an error status. Only this Connection (and, when it is the
      // default, the App's mirror) is touched.
      await recordConnectionOAuthStatus(server, snapshot.credentialId, {
        status: "ready",
        lastError: null,
        defaultValues: { lastCheckError: null },
      });
    }
  } finally {
    await releaseCredentialLease(credential.id, owner);
  }
}

function requiresReconnect(error: unknown): boolean {
  return error instanceof ManagedMcpGatewayError
    && error.code === "managed_mcp_oauth_required";
}

/**
 * Runs `operation` with one Connection's OAuth credentials. `connectionId` null is the App's server
 * default.
 *
 * The call itself runs on a snapshot of the stored credentials, outside the credential lease, so
 * calls on one Connection run concurrently; only a write-back the SDK makes mid-call (a refresh,
 * discovery) takes that Connection's lease (`persistToolCallStorage`). A call that needed
 * reconnecting only because a concurrent call refreshed a rotating refresh token first is run once
 * more on the newer credentials of the SAME Connection instead of marking it expired. A call that
 * failed any other way is not repeated: it may have reached the tool.
 *
 * A reactive token refresh happens inside `operation` (the SDK's refresh grant, saved through the
 * provider). When it fails for good the Connection is marked `expired`, which admission refuses
 * with `login_required` until someone signs in again; other Connections of the App are untouched.
 */
export async function withManagedMcpOAuth<T>(
  serverId: string,
  mcpServerId: string,
  operation: (
    server: ServerRow,
    provider: ManagedMcpOAuthProvider,
  ) => Promise<T>,
  expectedConfigVersion?: number,
  connectionId: string | null = null,
): Promise<T> {
  const server = await loadServer(serverId, mcpServerId);
  if (
    expectedConfigVersion !== undefined
    && server.configVersion !== expectedConfigVersion
  ) {
    throw new ManagedMcpOAuthError(
      "MCP OAuth connection changed before the operation began",
      "managed_mcp_oauth_invalid_state",
    );
  }
  // The Connection is fixed by the first read: a retry never moves to another one (for example a
  // server default switched in between).
  let target = connectionId;
  for (let attempt = 0; ; attempt += 1) {
    const credential = await loadCredentialSnapshot(serverId, mcpServerId, target);
    target = credential.id;
    const storage = parseStorage(credential.encryptedOAuth);
    // Tokens recorded for another server are never sent, and never refreshed: the refresh grant
    // would go to whichever authorization server the CURRENT endpoint declares.
    if (storage.tokens && !connectionAudienceMatches(credential, server)) {
      await recordConnectionOAuthStatus(server, credential.id, {
        status: "needs_auth",
        lastError: "The MCP server address changed; sign in again",
      });
      throw new ManagedMcpOAuthError(
        "MCP OAuth sign-in belongs to a different server address",
        "managed_mcp_oauth_required",
      );
    }
    if (!storage.tokens)
      throw new ManagedMcpOAuthError(
        "MCP OAuth is not connected",
        "managed_mcp_oauth_required",
      );
    const hadRefreshToken = Boolean(storage.tokens.refresh_token);
    const snapshot: ToolCallSnapshot = {
      credentialId: credential.id,
      version: credential.credentialVersion,
      supersededByConcurrentSave: false,
    };
    const provider: ToolCallOAuthProvider = new ToolCallOAuthProvider(storage, () =>
      persistToolCallStorage(server, storage, snapshot, provider.writeKind));
    try {
      return await operation(server, provider);
    } catch (error) {
      if (attempt === 0 && requiresReconnect(error)) {
        const latest = await loadCredentialSnapshot(serverId, mcpServerId, credential.id);
        // Our own write-backs move `snapshot.version`; only someone else's save
        // makes the stored version differ from it.
        if (snapshot.supersededByConcurrentSave || latest.credentialVersion !== snapshot.version) {
          continue;
        }
      }
      const reconnectRequired = requiresReconnect(error);
      const reason = reconnectRequired ? managedMcpOAuthReconnectReason(hadRefreshToken, provider.refusedRenewal, error) : null;
      const message = reason?.message ?? "MCP request failed; retry without reconnecting";
      const recorded = await recordConnectionOAuthStatus(server, snapshot.credentialId, {
        status: reconnectRequired ? "expired" : "ready",
        lastError: message,
        defaultValues: {
          lastCheckedAt: currentDate(),
          lastCheckError: message,
        },
        // Only while the stored credentials are still the ones this call last
        // saw. A late refresh or request failure must not mark a replaced or
        // disconnected Connection ready, nor expire a newer grant.
        expectedCredentialVersion: snapshot.version,
      });
      // Only once the expiry is recorded: a verdict the fence rejected came from credentials that are
      // no longer the stored ones, so it says nothing about the Connection as it is now.
      if (reason && recorded) {
        console.warn("mcp.oauth.reconnect_required", {
          serverId: server.serverId,
          mcpServerId: server.id,
          connectionId: snapshot.credentialId,
          cause: reason.cause,
          category: reason.category,
          hadRefreshToken,
        });
      }
      throw error;
    }
  }
}
