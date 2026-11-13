// Account-mode Login with Raft (RFC 079 phase 3a): the read path and the
// login path.
//
// An account-mode login is a person's, for one App, and names no Server: its
// token row has server_id NULL (design rule 5; the database holds that shape,
// migration 0560). Every Server-scoped request names its Server and is checked
// live against the App's audience. Server mode is untouched: its code only
// gains a branch on the token's mode (design rule 2), and nothing here runs
// for a token the server-mode lookup knows.
//
// The login path (design §3.1): POST /authorize/account issues a server-less
// code, and exchangeAccessRequest hands a server-less request to
// exchangeAccountAccessRequest, under its row lock. Only an App the reviewed
// switch put in account mode reaches either (none until phase 3c), and the
// kill switch OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY refuses both, and every
// account-mode token, until someone turns it on.
//
// Per-app revoke (design §3.2): the person lists their account-mode logins
// and revokes one App (GET and DELETE /api/me/app-logins). Neither reads the
// kill switch: listing and removing access never grant any.

import { randomBytes } from "node:crypto";
import {
  currentDate,
  isSafeOAuthReturnUrl,
  RAFT_OAUTH_SCOPE_CATALOG,
  RAFT_OAUTH_SCOPES_SUPPORTED,
} from "@botiverse/raft-shared";
import { and, asc, desc, eq, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import {
  oauthAccessRequests,
  oauthAccessTokens,
  oauthClientInstalls,
  oauthClients,
  oauthUserConsents,
  serverMembers,
  servers,
  users,
} from "../db/schema";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { evaluateFeatureFlag, OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY } from "./featureFlagService";
import * as integrationAuditService from "./integrationAuditService";
import { oauthClientIsUserManagedPredicate } from "./oauthClientManagementPolicy";
import { appTokenPassesSso } from "./sso/ssoEnforcement";
// oauthService imports this module too (the exchange's branch): nothing here
// reads its bindings at module load, only inside functions.
import {
  ACCESS_TOKEN_TTL_MS,
  accessTokenHasScope,
  AUTHORIZATION_CODE_EXPIRED_ERROR,
  CANONICAL_SERVER_ID_RE,
  hashSecret,
  HUMAN_AUTHORIZATION_CODE_TTL_MS,
  isInstalledThirdPartyAppPredicate,
  isSuspendedInstalledThirdPartyAppPredicate,
  normalizeScopes,
  OAuthAppNotAvailableError,
  OAuthInstallationSuspendedError,
  OAuthScopeNotApprovedError,
  oauthUserConsentRegrantSet,
  openAccessRequestPredicate,
  refuseCodeOfDeadSession,
  type AppServerAccess,
  type AppServerAccessServer,
  type OAuthAccessTokenIdentity,
  type OAuthUserConsentSource,
} from "./oauthService";
import { oauthClientHasKey } from "./oauthClientKeys";

/** A live account-mode token: a person's, for one App, on no Server. */
export interface OAuthAccountAccessTokenIdentity {
  mode: "account";
  tokenId: string;
  principalType: "human";
  scopes: string[];
  clientRecordId: string;
  clientKey: string;
  clientName: string;
  humanId: string;
  humanName: string;
  humanDisplayName: string | null;
  humanEmail: string;
  humanEmailVerified: boolean;
  humanAvatarUrl: string | null;
  humanDescription: string | null;
  /** The Raft session the token was approved from (RFC 083 §6.2: its SSO facts). */
  issuedBySessionFamilyId: string | null;
}

/** What a Bearer token resolves to: the server-mode identity, exactly as before, or an account-mode one. */
export type OAuthBearerIdentity = OAuthAccessTokenIdentity | OAuthAccountAccessTokenIdentity;

export function isAccountIdentity(identity: OAuthBearerIdentity): identity is OAuthAccountAccessTokenIdentity {
  return "mode" in identity && identity.mode === "account";
}

/**
 * The kill switch (decision Q12), for one person. Evaluated with the person
 * only, never a Server: an account-mode token has none. A missing flag or an
 * evaluation failure is off.
 */
export async function isAccountLoginEnabledFor(userId: string, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  try {
    return (await evaluateFeatureFlag({ key: OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY, userId }, executor)).enabled === true;
  } catch (error) {
    console.error("[oauth-account-login] feature flag evaluation failed; treating as off:", serializeErrorForLog(error));
    return false;
  }
}

/** Check 1 for a server-local App, against every Server at once: the App's own Server. */
function serverLocalAppOnItsServerPredicate(): SQL | undefined {
  return and(
    eq(oauthClients.appType, "server_local"),
    eq(oauthClients.serverId, servers.id),
  );
}

/**
 * Check 3's live half (D13): a third-party App's installation on the Server
 * approved every scope (jsonb containment on approved_scopes, read now). A
 * server-local App has no installation; the token's scopes alone decide.
 */
function scopesApprovedOnServerPredicate(scopes: readonly string[]): SQL | undefined {
  if (scopes.length === 0) return undefined;
  return or(
    eq(oauthClients.appType, "server_local"),
    sql`${oauthClientInstalls.approvedScopes} @> ${JSON.stringify([...scopes])}::jsonb`,
  );
}

/** The App an audience read is for: by record id (a token's, a request's) or by client key (a login's). */
type AccountAudienceClient = { recordId: string } | { key: string };

interface AccountAudienceInput {
  client: AccountAudienceClient;
  userId: string;
  serverId?: string;
  approvedScopes?: readonly string[];
}

/**
 * The App's audience for one person (design rule 4): the Servers where
 * checkAppServerAccess's checks 1 and 2 pass, with guests excluded (D7), read
 * live, for an App in account mode only. Check 1: the App is user-managed and
 * enabled, and available on the Server (its own Server for a server-local
 * App, an active installation for a third-party one). Check 2: the person is
 * a current member there, not retired, and not a guest. `serverId` (a
 * canonical id, checked by the caller) narrows it to one Server, and
 * `approvedScopes` adds check 3's live half.
 *
 * The one predicate behind the token lookup (D14), /servers, /membership, the
 * per-request check, the setup page's lookup, the login and the exchange:
 * applied, joins and all, by selectAccountAudience (a Server as the identity
 * endpoints show it) and selectAccountLoginAudience (the App and each
 * installation's approved scopes).
 */
function accountAudience(input: AccountAudienceInput) {
  return {
    client: "recordId" in input.client
      ? eq(oauthClients.id, input.client.recordId)
      : oauthClientHasKey(input.client.key),
    installation: and(
      eq(oauthClientInstalls.clientId, oauthClients.id),
      eq(oauthClientInstalls.serverId, servers.id),
    ),
    membership: and(
      eq(serverMembers.serverId, servers.id),
      eq(serverMembers.userId, input.userId),
    ),
    person: eq(users.id, serverMembers.userId),
    where: and(
      input.serverId === undefined ? undefined : eq(servers.id, input.serverId),
      isNull(servers.deletedAt),
      // RFC 017: the joint-storage namespace is not a Server an app can reach.
      ne(servers.kind, "joint_storage"),
      eq(oauthClients.loginMode, "account"),
      oauthClientIsUserManagedPredicate(),
      eq(oauthClients.enabled, true),
      or(serverLocalAppOnItsServerPredicate(), isInstalledThirdPartyAppPredicate()),
      isNull(users.retiredAt),
      ne(serverMembers.role, "guest"),
      scopesApprovedOnServerPredicate(input.approvedScopes ?? []),
    ),
  };
}

/** The audience, each Server as the identity endpoints show it. */
function selectAccountAudience(executor: DatabaseExecutor, input: AccountAudienceInput) {
  const audience = accountAudience(input);
  return executor.select({
    id: servers.id,
    slug: servers.slug,
    name: servers.name,
    avatarUrl: servers.avatarUrl,
    plan: servers.plan,
    role: serverMembers.role,
  })
    .from(servers)
    .innerJoin(oauthClients, audience.client)
    .leftJoin(oauthClientInstalls, audience.installation)
    .innerJoin(serverMembers, audience.membership)
    .innerJoin(users, audience.person)
    .where(audience.where);
}

/**
 * The audience as a login reads it: the App on every row, and each
 * installation's approved scopes (NULL for a server-local App, which has
 * none). One read for the login (the App and the audience at once) and the
 * exchange's re-check.
 */
function selectAccountLoginAudience(executor: DatabaseExecutor, input: AccountAudienceInput) {
  const audience = accountAudience(input);
  return executor.select({
    clientRecordId: oauthClients.id,
    clientKey: oauthClients.clientId,
    appType: oauthClients.appType,
    name: oauthClients.name,
    description: oauthClients.description,
    homepageUrl: oauthClients.homepageUrl,
    returnUrl: oauthClients.returnUrl,
    allowedScopes: oauthClients.allowedScopes,
    approvedScopes: oauthClientInstalls.approvedScopes,
  })
    .from(servers)
    .innerJoin(oauthClients, audience.client)
    .leftJoin(oauthClientInstalls, audience.installation)
    .innerJoin(serverMembers, audience.membership)
    .innerJoin(users, audience.person)
    .where(audience.where);
}

/**
 * The account-mode token lookup. Runs only for a token the server-mode lookup
 * (getIdentityByAccessToken) does not know, so an invalid token costs one more
 * indexed read and a server-mode answer never changes. Null, the 401 of an
 * unknown token, unless every check passes: the row is server-less (a
 * Server-bound row is server mode's alone, valid or not), a person's, not
 * revoked or expired; the App is in account mode; the kill switch is on for
 * the person; and the App's audience still holds them (D14), which also
 * requires the App enabled and user-managed and the account not retired.
 */
export async function getAccountIdentityByAccessToken(
  rawToken: string,
  executor: DatabaseExecutor = getDb(),
): Promise<OAuthAccountAccessTokenIdentity | null> {
  const [row] = await executor.select({
    tokenId: oauthAccessTokens.id,
    scopes: oauthAccessTokens.scopes,
    issuedBySessionFamilyId: oauthAccessTokens.issuedBySessionFamilyId,
    expiresAt: oauthAccessTokens.expiresAt,
    revokedAt: oauthAccessTokens.revokedAt,
    clientRecordId: oauthClients.id,
    clientKey: oauthClients.clientId,
    clientName: oauthClients.name,
    clientLoginMode: oauthClients.loginMode,
    humanId: users.id,
    humanName: users.name,
    humanDisplayName: users.displayName,
    humanEmail: users.email,
    humanEmailVerified: users.emailVerified,
    humanAvatarUrl: users.avatarUrl,
    humanDescription: users.description,
  }).from(oauthAccessTokens)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthAccessTokens.clientId))
    .innerJoin(users, eq(users.id, oauthAccessTokens.userId))
    .where(and(
      eq(oauthAccessTokens.tokenHash, hashSecret(rawToken)),
      isNull(oauthAccessTokens.serverId),
      eq(oauthAccessTokens.principalType, "human"),
    ))
    .limit(1);

  if (!row) return null;
  if (row.revokedAt || row.expiresAt.getTime() <= Date.now()) return null;
  // Only an account-mode App holds a server-less row, and it never leaves
  // account mode (migration 0560); read anyway, so a row that slipped past
  // the database fails closed.
  if (row.clientLoginMode !== "account") return null;
  if (!(await isAccountLoginEnabledFor(row.humanId, executor))) return null;
  const [audienceServer] = await selectAccountAudience(executor, {
    client: { recordId: row.clientRecordId },
    userId: row.humanId,
  }).limit(1);
  if (!audienceServer) return null;
  // RFC 083 §6.2: as a server-mode token, live only while the SSO facts frozen at issue are within the max age.
  if (!(await appTokenPassesSso({ userId: row.humanId, email: row.humanEmail, issuedBySessionFamilyId: row.issuedBySessionFamilyId }, executor))) return null;

  return {
    mode: "account",
    tokenId: row.tokenId,
    principalType: "human",
    scopes: row.scopes,
    clientRecordId: row.clientRecordId,
    clientKey: row.clientKey,
    clientName: row.clientName,
    humanId: row.humanId,
    humanName: row.humanName,
    humanDisplayName: row.humanDisplayName,
    humanEmail: row.humanEmail,
    humanEmailVerified: row.humanEmailVerified,
    humanAvatarUrl: row.humanAvatarUrl,
    humanDescription: row.humanDescription,
    issuedBySessionFamilyId: row.issuedBySessionFamilyId,
  };
}

/** What checkAccountAppServerAccess needs from a live account-mode token. */
export type AccountAppServerAccessToken = Pick<OAuthAccountAccessTokenIdentity, "clientRecordId" | "humanId" | "scopes">;

/**
 * checkAppServerAccess for an account-mode token, which no Server binds: the
 * request names Server S, and S must be in the App's audience for the person
 * (checks 1 and 2, guests never: D7). Check 3: every `requiredScopes` entry is
 * in the token and, for a third-party App, in S's installation approved_scopes
 * now (D13), so a scope one Server approved never reaches another. `serverId`
 * is untrusted; anything but a canonical id is refused before any read. A
 * failure carries no reason: the caller answers every refusal the same way.
 */
export async function checkAccountAppServerAccess(
  input: {
    token: AccountAppServerAccessToken;
    serverId: string;
    requiredScopes: readonly string[];
  },
  executor: DatabaseExecutor = getDb(),
): Promise<AppServerAccess> {
  const denied: AppServerAccess = { ok: false };
  if (!CANONICAL_SERVER_ID_RE.test(input.serverId)) return denied;
  if (!input.requiredScopes.every((scope) => accessTokenHasScope(input.token, scope))) return denied;
  const [server] = await selectAccountAudience(executor, {
    client: { recordId: input.token.clientRecordId },
    userId: input.token.humanId,
    serverId: input.serverId,
    approvedScopes: input.requiredScopes,
  }).limit(1);
  return server ? { ok: true, server } : denied;
}

/** /servers for an account-mode token: the App's audience for the person, by name, then id. */
export async function listAccountAppServers(
  token: AccountAppServerAccessToken,
  executor: DatabaseExecutor = getDb(),
): Promise<AppServerAccessServer[]> {
  return selectAccountAudience(executor, {
    client: { recordId: token.clientRecordId },
    userId: token.humanId,
  }).orderBy(asc(servers.name), asc(servers.id));
}

// ---------------------------------------------------------------------------
// The login path (design §3.1, §3.2).
// ---------------------------------------------------------------------------

/**
 * A Server-bound continue (POST /authorize/human) or code for an App now in
 * account mode. On the continue it means a setup page opened before the switch
 * (409, after the audience check); at the token endpoint, a code issued
 * before it (Q3), answered as a dead code.
 */
export class OAuthLoginModeChangedError extends Error {
  constructor() {
    super("login_mode_changed");
    this.name = "OAuthLoginModeChangedError";
  }
}

/**
 * An account-mode request at a Server-scoped token endpoint (D21): refused
 * before anything is written, with the answer of a grant for another Server.
 */
export class OAuthGrantNotServerBoundError extends Error {
  constructor() {
    super("grant_not_server_bound");
    this.name = "OAuthGrantNotServerBoundError";
  }
}

/**
 * POST /authorize/account sent a Server-scoped issuer's `server` hint (D21).
 * Only thrown once the audience check has passed, so it tells nobody outside
 * the audience that the App exists.
 */
export class OAuthRootIssuerRequiredError extends Error {
  constructor() {
    super("root_issuer_required");
    this.name = "OAuthRootIssuerRequiredError";
  }
}

function scopesOfPhase(phase: (typeof RAFT_OAUTH_SCOPE_CATALOG)[keyof typeof RAFT_OAUTH_SCOPE_CATALOG]["phase"]): readonly string[] {
  return RAFT_OAUTH_SCOPES_SUPPORTED.filter((scope) => RAFT_OAUTH_SCOPE_CATALOG[scope].phase === phase);
}

/**
 * D13's identity scopes: the catalog's identity phase, `openid profile email
 * identity`. Q7 (whether `identity` belongs here; the RFC names three) is
 * open: this one constant decides it. A scope in neither set is never granted
 * in account mode.
 */
export const ACCOUNT_LOGIN_IDENTITY_SCOPES: readonly string[] = scopesOfPhase("identity");

/**
 * The non-identity scopes a person's account-mode login can carry (Q8):
 * `agent:read` today. Never a resource-bound scope (agent_inbound): an
 * account-mode exchange takes no `resource` (Q15).
 */
const ACCOUNT_LOGIN_NON_IDENTITY_SCOPES: readonly string[] = scopesOfPhase("agent_directory");

/**
 * D13: the requested scopes (already within the App's allowed scopes) an
 * account-mode login is granted. A scope is granted when account mode carries
 * it and the App is server-local (no installation gate, as in server mode and
 * check 3) or at least one of the person's non-guest audience installations
 * approved it now (Q8). Each request re-checks a scope against its Server's
 * installation (checkAccountAppServerAccess). Fewer scopes than requested is
 * a normal answer; refused (the caller sends `invalid_scope` to the App's
 * registered URL) when `openid` was requested and is not granted, or nothing
 * is.
 */
function accountLoginScopes(input: {
  requestedScopes: readonly string[];
  appType: string;
  audienceApprovedScopes: ReadonlyArray<readonly string[] | null>;
  returnUrl: string | null;
}): string[] {
  const approvedSomewhere = (scope: string) => input.appType === "server_local"
    || input.audienceApprovedScopes.some((approved) => approved?.includes(scope) === true);
  const granted = input.requestedScopes.filter((scope) => (
    (ACCOUNT_LOGIN_IDENTITY_SCOPES.includes(scope) || ACCOUNT_LOGIN_NON_IDENTITY_SCOPES.includes(scope))
    && approvedSomewhere(scope)
  ));
  const notGranted = input.requestedScopes.filter((scope) => !granted.includes(scope));
  if (granted.length === 0 || (input.requestedScopes.includes("openid") && !granted.includes("openid"))) {
    throw new OAuthScopeNotApprovedError(notGranted, input.returnUrl);
  }
  return granted;
}

/** Whether the App (by record id) is in account mode now. Read alone: loginMode never joins the public columns (design rule 3). */
export async function isAccountModeClient(clientRecordId: string, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  const [row] = await executor.select({ loginMode: oauthClients.loginMode })
    .from(oauthClients)
    .where(eq(oauthClients.id, clientRecordId))
    .limit(1);
  return row?.loginMode === "account";
}

/** The login mode of the App with this client key, or null when there is none. */
export async function getOAuthClientLoginMode(clientKey: string, executor: DatabaseExecutor = getDb()) {
  const [row] = await executor.select({ loginMode: oauthClients.loginMode })
    .from(oauthClients)
    .where(oauthClientHasKey(clientKey))
    .limit(1);
  return row?.loginMode ?? null;
}

/**
 * Whether Server S (an id the membership read already matched) is in the
 * account-mode App's audience for the person now: the setup page's "ready"
 * and the continue's 409 (design §1 rows 3 and 4).
 */
export async function isServerInAccountAudience(input: {
  clientKey: string;
  userId: string;
  serverId: string;
}, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  const [row] = await selectAccountAudience(executor, {
    client: { key: input.clientKey },
    userId: input.userId,
    serverId: input.serverId,
  }).limit(1);
  return row !== undefined;
}

/**
 * Q4: the App is installed, suspended, on a Server where the person is a
 * non-guest member, and no Server holds them in its audience. The login says
 * so, as server mode's does to a member; only reachable by such a member.
 */
async function hasSuspendedAccountInstallation(executor: DatabaseExecutor, input: {
  clientKey: string;
  userId: string;
}): Promise<boolean> {
  const [row] = await executor.select({ id: oauthClientInstalls.id })
    .from(oauthClientInstalls)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
    .innerJoin(servers, eq(servers.id, oauthClientInstalls.serverId))
    .innerJoin(serverMembers, and(
      eq(serverMembers.serverId, servers.id),
      eq(serverMembers.userId, input.userId),
    ))
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .where(and(
      oauthClientHasKey(input.clientKey),
      eq(oauthClients.loginMode, "account"),
      oauthClientIsUserManagedPredicate(),
      isSuspendedInstalledThirdPartyAppPredicate(),
      isNull(servers.deletedAt),
      ne(servers.kind, "joint_storage"),
      isNull(users.retiredAt),
      ne(serverMembers.role, "guest"),
    ))
    .limit(1);
  return row !== undefined;
}

/**
 * POST /authorize/account (design §3.1 step 2): a code for the person's
 * account-mode login to the App, naming no Server. The kill switch, then one
 * read of the App (user-managed, enabled, in account mode) with the person's
 * non-guest audience Servers and each installation's approved scopes. Unknown
 * App, server-mode App, outside the audience, guest only and switch off are
 * one refusal, OAuthAppNotAvailableError (D4/D11); only past it come the
 * answers that tell the App exists: `server` sent (root_issuer_required), the
 * return URL (the registered one, exactly; a mismatch is audited as in
 * issueHumanAuthorizationCode) and D13's scopes.
 */
export async function issueAccountAuthorizationCode(input: {
  clientKey: string;
  userId: string;
  returnUrl: string;
  scopes?: unknown;
  /** The body carried `server`: the Server-scoped issuer's hint. */
  serverHinted: boolean;
  /** As issueHumanAuthorizationCode's: the code is exchanged only while this family is live. */
  approverSessionFamilyId: string | null;
}) {
  const db = getDb();
  const now = currentDate();
  if (!(await isAccountLoginEnabledFor(input.userId, db))) throw new OAuthAppNotAvailableError();
  const audience = await selectAccountLoginAudience(db, { client: { key: input.clientKey }, userId: input.userId });
  const client = audience[0];
  if (!client) {
    // Read whatever the App, so an unknown one takes the same reads.
    if (await hasSuspendedAccountInstallation(db, input)) throw new OAuthInstallationSuspendedError();
    throw new OAuthAppNotAvailableError();
  }
  if (input.serverHinted) throw new OAuthRootIssuerRequiredError();

  if (!client.returnUrl || !isSafeOAuthReturnUrl(client.returnUrl) || input.returnUrl.trim() !== client.returnUrl) {
    await integrationAuditService.recordIntegrationAuditEventBestEffort({
      serverId: null,
      clientId: client.clientRecordId,
      eventType: "oauth.redirect_mismatch",
      outcome: "failure",
      source: "api",
      actor: { type: "human", id: input.userId },
      subject: { type: "human", id: input.userId },
      target: { type: "app", id: client.clientRecordId },
      metadata: {
        clientKey: client.clientKey,
        errorCode: "return_url_mismatch",
      },
    });
    throw new Error("returnUrl does not match registered OAuth client");
  }
  const registeredReturnUrl: string = client.returnUrl;

  const requestedScopes = input.scopes === undefined || input.scopes === null
    ? ["openid", "profile"]
    : normalizeScopes(input.scopes, { clientId: client.clientKey, allowedScopes: client.allowedScopes });
  const scopes = accountLoginScopes({
    requestedScopes,
    appType: client.appType,
    audienceApprovedScopes: audience.map((server) => server.approvedScopes),
    returnUrl: registeredReturnUrl,
  });

  const created = await db.transaction(async (tx) => {
    const [request] = await tx.insert(oauthAccessRequests).values({
      serverId: null,
      principalType: "human",
      userId: input.userId,
      agentId: null,
      clientId: client.clientRecordId,
      scopes,
      status: "approved",
      remember: false,
      resolvedByUserId: input.userId,
      resolvedAt: now,
      approverSessionFamilyId: input.approverSessionFamilyId,
      createdAt: now,
      updatedAt: now,
    }).returning();
    await integrationAuditService.recordIntegrationAuditEvent({
      clientId: client.clientRecordId,
      eventType: "oauth.lifecycle",
      outcome: "success",
      source: "api",
      actor: { type: "system" },
      target: { type: "app", id: client.clientRecordId },
      metadata: {
        clientKey: client.clientKey,
        stage: "authorization",
        result: "issued",
        grantType: "authorization_code",
        principalType: "human",
        loginMode: "account",
      },
    }, tx);
    return request!;
  });

  return {
    code: created.id,
    client: {
      clientId: client.clientKey,
      appType: client.appType,
      name: client.name,
      description: client.description,
      homepageUrl: client.homepageUrl,
    },
    scopes,
    returnUrl: registeredReturnUrl,
  };
}

/**
 * Records the person's account-mode consent to the App: one row per (person,
 * App) with no Server, upserted on the partial unique index
 * idx_oauth_user_consents_user_client_account (migration 0560). The same
 * merge as grantOAuthUserConsent's per-Server row.
 */
export async function grantAccountOAuthUserConsent(executor: DatabaseExecutor, input: {
  userId: string;
  clientId: string;
  scopes: readonly string[];
  source: OAuthUserConsentSource;
  now: Date;
}) {
  const [consent] = await executor.insert(oauthUserConsents).values({
    userId: input.userId,
    serverId: null,
    clientId: input.clientId,
    scopes: [...new Set(input.scopes)].sort(),
    source: input.source,
    grantedAt: input.now,
    updatedAt: input.now,
  }).onConflictDoUpdate({
    target: [oauthUserConsents.userId, oauthUserConsents.clientId],
    targetWhere: sql`server_id IS NULL`,
    set: oauthUserConsentRegrantSet(input.now),
  }).returning();
  return consent!;
}

/** What an account-mode exchange returns: a one-hour token naming no Server, never a refresh token (D15). */
export interface AccountAccessExchange {
  mode: "account";
  accessToken: string;
  expiresAt: Date;
  scopes: string[];
  token: typeof oauthAccessTokens.$inferSelect;
  /** The ID token's subject when `openid` was granted, else null. */
  identity: OAuthAccountAccessTokenIdentity | null;
}

/**
 * POST /token for an account-mode request (design §3.1 step 3), inside
 * exchangeAccessRequest's transaction, with the request row locked FOR
 * UPDATE there. The same pending, denied, consumed and ten-minute checks; then
 * live, the sign-in that asked for the code (refuseCodeOfDeadSession), the
 * kill switch and the App's audience for the person (in account mode, D5/D7),
 * else access_denied; D13's scopes again; a `resource` refused
 * (Q15). Writes the token (no Server, an hour, created now so the one-hour
 * CHECK holds whatever the clocks), the person's account-mode consent, the
 * request's consumption and the audit event.
 */
export async function exchangeAccountAccessRequest(
  tx: DatabaseTransaction,
  request: typeof oauthAccessRequests.$inferSelect,
  input: { now: Date; resource?: unknown },
): Promise<AccountAccessExchange> {
  const { now } = input;
  if (request.status === "pending") throw new Error("authorization_pending");
  if (request.status === "denied") throw new Error("access_denied");
  if (request.consumedAt) throw new Error("request_already_consumed");
  const userId = request.userId;
  // The database holds this shape (migration 0560); fail closed anyway.
  if (request.principalType !== "human" || !userId || request.agentId !== null) {
    throw new Error("Access request not found");
  }
  if (now.getTime() > request.createdAt.getTime() + HUMAN_AUTHORIZATION_CODE_TTL_MS) {
    throw new Error(AUTHORIZATION_CODE_EXPIRED_ERROR);
  }
  await refuseCodeOfDeadSession(tx, request, now);
  if (!(await isAccountLoginEnabledFor(userId, tx))) throw new Error("access_denied");
  const audience = await selectAccountLoginAudience(tx, { client: { recordId: request.clientId }, userId });
  if (audience.length === 0) throw new Error("access_denied");
  let scopes: string[];
  try {
    scopes = accountLoginScopes({
      requestedScopes: request.scopes ?? [],
      appType: audience[0]!.appType,
      audienceApprovedScopes: audience.map((server) => server.approvedScopes),
      returnUrl: null,
    });
  } catch (error) {
    if (error instanceof OAuthScopeNotApprovedError) throw new Error("access_denied");
    throw error;
  }
  if (input.resource !== undefined && input.resource !== null && input.resource !== "") {
    throw new Error("resource is not supported for account-mode logins");
  }

  const rawToken = `slock_at_${randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
  const [createdToken] = await tx.insert(oauthAccessTokens).values({
    serverId: null,
    principalType: "human",
    agentId: null,
    userId,
    clientId: request.clientId,
    requestId: request.id,
    grantId: null,
    issuedBySessionFamilyId: request.approverSessionFamilyId,
    tokenHash: hashSecret(rawToken),
    scopes,
    resource: null,
    expiresAt,
    createdAt: now,
  }).returning();
  await grantAccountOAuthUserConsent(tx, {
    userId,
    clientId: request.clientId,
    scopes,
    source: "login",
    now,
  });

  const identity = scopes.includes("openid")
    ? await getAccountIdentityByAccessToken(rawToken, tx)
    : null;
  if (scopes.includes("openid") && !identity) {
    throw new Error("openid_identity_unavailable");
  }

  await tx.update(oauthAccessRequests).set({
    consumedAt: now,
    updatedAt: now,
  }).where(eq(oauthAccessRequests.id, request.id));

  await integrationAuditService.recordIntegrationAuditEvent({
    clientId: request.clientId,
    eventType: "oauth.lifecycle",
    outcome: "success",
    source: "api",
    actor: { type: "system" },
    target: { type: "app", id: request.clientId },
    metadata: {
      stage: "token_exchange",
      result: "issued",
      principalType: "human",
      loginMode: "account",
    },
  }, tx);

  return {
    mode: "account",
    accessToken: rawToken,
    expiresAt,
    scopes,
    token: createdToken!,
    identity,
  };
}

// ---------------------------------------------------------------------------
// Per-app revoke (design §3.2, Q9).
// ---------------------------------------------------------------------------

/** One of the person's account-mode logins, as GET /api/me/app-logins lists it. */
export interface AccountAppLogin {
  /** The account-mode consent's id. */
  id: string;
  /** The App's public client key: what DELETE /api/me/app-logins/:clientId takes. */
  clientId: string;
  name: string;
  logoUrl: string | null;
  scopes: string[];
  grantedAt: Date;
}

/**
 * The person's active account-mode consents (no Server), newest first. Only an
 * App in account mode holds one, and it never leaves account mode (migration
 * 0560's guard and forward-only triggers), so this is every account-mode App
 * the person is signed in to, and nothing else.
 */
export async function listAccountAppLogins(userId: string, executor: DatabaseExecutor = getDb()): Promise<AccountAppLogin[]> {
  return executor.select({
    id: oauthUserConsents.id,
    clientId: oauthClients.clientId,
    name: oauthClients.name,
    logoUrl: oauthClients.logoUrl,
    scopes: oauthUserConsents.scopes,
    grantedAt: oauthUserConsents.grantedAt,
  }).from(oauthUserConsents)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthUserConsents.clientId))
    .where(and(
      eq(oauthUserConsents.userId, userId),
      isNull(oauthUserConsents.serverId),
      isNull(oauthUserConsents.revokedAt),
    ))
    .orderBy(desc(oauthUserConsents.grantedAt), desc(oauthUserConsents.id));
}

/** What a per-app revoke changed: the audit event's counts. */
export interface AccountAppLoginRevocation {
  clientRecordId: string;
  deniedPendingRequestCount: number;
  revokedTokenCount: number;
  revokedAccountConsentCount: number;
  revokedServerConsentCount: number;
}

/**
 * No App has a client key outside printable ASCII or longer than this (every
 * creation path writes far shorter keys), so anything else is answered as an
 * unknown App without a read; a NUL byte would otherwise fail the query.
 */
const CLIENT_KEY_SHAPE = /^[\x21-\x7e]{1,256}$/;

/**
 * DELETE /api/me/app-logins/:clientId: the person revokes everything the App
 * holds of theirs, in one transaction. Null, and nothing written, for a key
 * that names no App in account mode (unknown, malformed, or a server-mode
 * App, which stays as it is today); the route answers 204 either way, so the
 * answer tells nobody which Apps exist. Otherwise, in this order:
 *
 * 0. The App row, FOR KEY SHARE. It never blocks an exchange (whose inserts
 *    take the same lock on it); it orders this revoke whole before or after
 *    an App deletion or a Marketplace offline review, which lock that row
 *    FOR UPDATE before anything else.
 * 1. Deny the person's open human requests for the App, on any Server or
 *    none, as uninstall does: an approved code not exchanged yet is never
 *    exchanged (the exchange answers access_denied).
 * 2. Revoke their Server-bound human tokens for the App, including those
 *    issued before it switched to account mode.
 * 3. Revoke their consents to the App: the account-mode one and every
 *    per-Server one (Q9), which are also what link previews gate on. Their
 *    link-preview declines stay: a decline is the person's own "no", not
 *    access the App holds, and removing it would bring the prompt back.
 * 4. Revoke their account-mode tokens for the App.
 * 5. Audit oauth.app_login_revoked with the counts, when anything changed.
 *
 * Lock order. The exchange locks its request FOR UPDATE, then inserts the
 * token and upserts the consent. Step 1 takes the request rows first too, so
 * an exchange in flight is serialised with this revoke by that lock: one
 * committed first, the other sees it (the exchange finds its request denied;
 * this revoke finds the request consumed, and its token and consent, both
 * read after, revoked). Uninstall and a member leaving lock the App row no
 * stronger than KEY SHARE, take requests before tokens before consents (steps
 * 1 to 3) and never touch a server-less row, so there is no cycle with them
 * either. Account-mode tokens come
 * after the consents (step 4): a login whose request was created after step
 * 1 is then either kept whole, token and consent (this revoke took the
 * consent row first), or revoked whole (its exchange committed first), never
 * left with a live token behind a revoked consent the list no longer shows.
 */
export async function revokeAccountAppLogin(input: {
  userId: string;
  clientKey: string;
}): Promise<AccountAppLoginRevocation | null> {
  if (!CLIENT_KEY_SHAPE.test(input.clientKey)) return null;
  return getDb().transaction(async (tx) => {
    const [client] = await tx.select({ id: oauthClients.id, clientKey: oauthClients.clientId })
      .from(oauthClients)
      .where(and(oauthClientHasKey(input.clientKey), eq(oauthClients.loginMode, "account")))
      .limit(1)
      .for("key share");
    if (!client) return null;
    const now = currentDate();

    const deniedRequests = await tx.update(oauthAccessRequests).set({
      status: "denied",
      remember: false,
      resolvedByUserId: input.userId,
      resolvedAt: now,
      updatedAt: now,
    }).where(and(
      eq(oauthAccessRequests.userId, input.userId),
      eq(oauthAccessRequests.clientId, client.id),
      eq(oauthAccessRequests.principalType, "human"),
      openAccessRequestPredicate(),
    )).returning({ id: oauthAccessRequests.id });

    const personsTokens = and(
      eq(oauthAccessTokens.userId, input.userId),
      eq(oauthAccessTokens.clientId, client.id),
      eq(oauthAccessTokens.principalType, "human"),
      isNull(oauthAccessTokens.revokedAt),
    );
    const revokedServerTokens = await tx.update(oauthAccessTokens).set({ revokedAt: now })
      .where(and(personsTokens, isNotNull(oauthAccessTokens.serverId)))
      .returning({ id: oauthAccessTokens.id });

    const revokedConsents = await tx.update(oauthUserConsents).set({ revokedAt: now, updatedAt: now })
      .where(and(
        eq(oauthUserConsents.userId, input.userId),
        eq(oauthUserConsents.clientId, client.id),
        isNull(oauthUserConsents.revokedAt),
      ))
      .returning({ id: oauthUserConsents.id, serverId: oauthUserConsents.serverId });

    const revokedAccountTokens = await tx.update(oauthAccessTokens).set({ revokedAt: now })
      .where(and(personsTokens, isNull(oauthAccessTokens.serverId)))
      .returning({ id: oauthAccessTokens.id });

    const revocation: AccountAppLoginRevocation = {
      clientRecordId: client.id,
      deniedPendingRequestCount: deniedRequests.length,
      revokedTokenCount: revokedServerTokens.length + revokedAccountTokens.length,
      revokedAccountConsentCount: revokedConsents.filter((consent) => consent.serverId === null).length,
      revokedServerConsentCount: revokedConsents.filter((consent) => consent.serverId !== null).length,
    };
    const changed = revocation.deniedPendingRequestCount + revocation.revokedTokenCount
      + revocation.revokedAccountConsentCount + revocation.revokedServerConsentCount;
    // A revoke that found nothing of the person's writes nothing, the audit
    // row included.
    if (changed === 0) return revocation;

    // No Server: the person's own act, never on a Server's audit page.
    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: null,
      clientId: client.id,
      eventType: "oauth.app_login_revoked",
      outcome: "success",
      source: "web",
      actor: { type: "human", id: input.userId },
      subject: { type: "human", id: input.userId },
      target: { type: "app", id: client.id },
      metadata: {
        clientKey: client.clientKey,
        deniedPendingRequestCount: revocation.deniedPendingRequestCount,
        revokedTokenCount: revocation.revokedTokenCount,
        revokedAccountConsentCount: revocation.revokedAccountConsentCount,
        revokedServerConsentCount: revocation.revokedServerConsentCount,
      },
    }, tx);
    return revocation;
  });
}
