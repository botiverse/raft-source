import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  agents,
  externalAppRegistrations,
  featureFlags,
  integrationAuditEvents,
  oauthAccessRequests,
  oauthAccessTokens,
  oauthClients,
  oauthUserConsents,
} from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { currentAppPermissions } from "../test/integration/appPermissions";
import { OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { createOAuthClient, installMarketplaceOAuthClient } from "../services/oauthService";
import { addMember, createServer } from "../services/serverService";
import {
  OAuthLoginModeRefusal,
  showOAuthLoginMode,
  switchOAuthLoginMode,
  type OAuthLoginModeRefusalCode,
} from "../../scripts/oauth-login-mode";
import {
  continueLogin,
  DEFAULT_SCOPES,
  exchange,
  LOGINS,
  RETURN_URL,
  seed,
} from "./oauthLoginAllowedMatrix.fixtures";

// RFC 079 phase 3a, PR 5: the reviewed switch, db:oauth-login-mode
// (scripts/oauth-login-mode.ts, design §2.4), against the migrated schema,
// and what the switch does to an App's existing logins (§2.3; threats T8,
// T9). The switch is driven through the script's exported function, never
// with SQL. Its arguments and exit codes: scripts/oauth-login-mode.test.ts.
const test = createApiTest({ skipAuthRateLimit: true });

const CHECK_VIOLATION = "23514";
const HOUR_MS = 60 * 60 * 1000;
const SERVER_ACCESS_DENIED_BODY = JSON.stringify({
  error: "server_access_denied",
  error_description: "This token cannot be used for this request on that Server.",
});
const DEAD_CODE_BODY = JSON.stringify({
  error: "invalid_grant",
  error_description: "The authorization code is invalid, expired, or has already been used",
});
const APP_NOT_AVAILABLE_BODY = JSON.stringify({ error: "This app isn't available to you.", code: "app_not_available" });
const LOGIN_MODE_CHANGED_BODY = JSON.stringify({
  error: "This app now signs you in with your Raft account. Reload this page to continue.",
  code: "login_mode_changed",
});

const SIGN_OFF = {
  review: "https://stamp.build/github/botiverse/slock/pull/12345",
  reason: "Vault moves to account-mode login (RFC 079 phase 3c)",
  operator: "alice",
};

type Base = { baseUrl: string };

/** A member of S logging in to a published third-party App installed on S (the matrix's row), plus B: the App installed there too, the person a member. */
async function seedSwitch() {
  const row = LOGINS.find((candidate) => candidate.name === "member, installed third-party app");
  assert.ok(row, "fixture: the matrix row");
  const f = await seed(row);
  assert.ok(f.client, "fixture: an App");
  const b = await createServer("Switch B", `switch-b-${f.suffix}`, f.owner.id);
  await addMember(b.id, f.person.id, "member");
  assert.ok(await installMarketplaceOAuthClient({
    serverId: b.id,
    clientId: f.client.id,
    installedByUserId: f.owner.id,
    expected: await currentAppPermissions(f.client.id),
  }), "fixture: installed on B");
  return { ...f, client: f.client, b };
}

type Seeded = Awaited<ReturnType<typeof seedSwitch>>;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier, "ascii").digest("base64url") };
}

/** The setup page's continue on S: an OIDC (PKCE) code, or a legacy one. */
async function serverModeCode(app: Base, f: Seeded, flow: "oidc" | "legacy") {
  const { verifier, challenge } = pkce();
  const body = {
    clientId: f.client.clientId,
    serverId: f.server.id,
    returnUrl: RETURN_URL,
    scopes: DEFAULT_SCOPES,
    ...(flow === "oidc" ? { oidc: true, nonce: `nonce-${randomUUID()}`, codeChallenge: challenge, codeChallengeMethod: "S256" } : {}),
  };
  const res = await continueLogin(app, f.person.bearer, body);
  const text = await res.text();
  assert.equal(res.status, 200, `fixture: server-mode continue (${res.status}): ${text}`);
  return { code: (JSON.parse(text) as { code: string }).code, verifier: flow === "oidc" ? verifier : null };
}

async function answer(res: Response) {
  return { status: res.status, body: await res.text() };
}

function read(app: Base, path: string, token: string) {
  return fetch(`${app.baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } }).then(answer);
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function loginModeOf(clientRecordId: string) {
  const [row] = await getDb().select({ loginMode: oauthClients.loginMode }).from(oauthClients).where(eq(oauthClients.id, clientRecordId));
  return row?.loginMode;
}

function switchAuditRows(clientRecordId?: string) {
  return getDb().select().from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.eventType, "oauth.login_mode_switched"),
    clientRecordId === undefined ? undefined : eq(integrationAuditEvents.clientId, clientRecordId),
  ));
}

async function setAccountLoginFlag() {
  const values = { enabled: true, killSwitch: false, defaultEnabled: true };
  await getDb().insert(featureFlags)
    .values({ key: OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY, randomizationUnit: "user", salt: "login-mode-switch-test", ...values })
    .onConflictDoUpdate({ target: featureFlags.key, set: values });
}

function refusedWith(code: OAuthLoginModeRefusalCode, message: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof OAuthLoginModeRefusal, `expected a refusal, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.match(error.message, message);
    return true;
  };
}

type DatabaseErrorShape = { code?: unknown; constraint?: unknown; cause?: unknown };

/** The refusal is the named constraint's, with its SQLSTATE (as db/oauthAccountLoginRows.test.ts). */
function violates(code: string, constraint: string) {
  return (error: unknown) => {
    for (let current: unknown = error; current && typeof current === "object"; current = (current as DatabaseErrorShape).cause) {
      const candidate = current as DatabaseErrorShape;
      if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
        assert.deepEqual({ code: candidate.code, constraint: candidate.constraint }, { code, constraint });
        return true;
      }
    }
    assert.fail(`expected ${constraint} (${code}), got ${String(error)}`);
  };
}

test("show: a server-mode App, with only its live server-mode human tokens and open server-mode human codes counted", async ({ app }) => {
  const f = await seedSwitch();
  // One live human token on S (its code consumed), and two open codes.
  const login = await serverModeCode(app, f, "oidc");
  assert.equal((await exchange(app, f.client, login.code, "", login.verifier)).status, 200);
  await serverModeCode(app, f, "oidc");
  await serverModeCode(app, f, "legacy");

  // Rows that are not counted: expired, revoked or agent tokens; consumed,
  // denied, older than ten minutes or agent requests.
  const db = getDb();
  const [agent] = await db.insert(agents).values({ serverId: f.server.id, name: `switch-${f.suffix}`, creatorType: "user", creatorId: f.owner.id }).returning();
  const human = { serverId: f.server.id, principalType: "human" as const, userId: f.person.id, clientId: f.client.id, scopes: ["openid"] };
  const now = Date.now();
  await db.insert(oauthAccessTokens).values([
    { ...human, tokenHash: tokenHash(randomUUID()), expiresAt: new Date(now - 1000) },
    { ...human, tokenHash: tokenHash(randomUUID()), expiresAt: new Date(now + HOUR_MS), revokedAt: new Date(now) },
    { ...human, principalType: "agent", userId: null, agentId: agent!.id, tokenHash: tokenHash(randomUUID()), expiresAt: new Date(now + HOUR_MS) },
  ]);
  await db.insert(oauthAccessRequests).values([
    { ...human, status: "approved", consumedAt: new Date(now) },
    { ...human, status: "denied" },
    { ...human, status: "approved", createdAt: new Date(now - 11 * 60 * 1000) },
    { ...human, principalType: "agent", userId: null, agentId: agent!.id, status: "approved" },
  ]);

  const before = await db.select().from(oauthClients).where(eq(oauthClients.id, f.client.id));
  assert.deepEqual(await showOAuthLoginMode(`  ${f.client.clientId} `), {
    client: f.client.clientId,
    id: f.client.id,
    name: "Allowed App",
    appType: "third_party_global",
    loginMode: "server",
    userManaged: true,
    enabled: true,
    publishStatus: "published",
    liveServerHumanTokens: 1,
    openServerHumanCodes: 2,
    liveAccountTokens: 0,
  });
  assert.deepEqual(await db.select().from(oauthClients).where(eq(oauthClients.id, f.client.id)), before, "show writes nothing");
  assert.deepEqual(await switchAuditRows(f.client.id), []);
  await assert.rejects(showOAuthLoginMode(`unknown-${f.suffix}`), refusedWith("unknown_client", /no App has the client id/));
});

test("switch: login_mode becomes account, with one audit row holding exactly the sign-off and the counts, and the JSON result", async ({ app }) => {
  const f = await seedSwitch();
  const login = await serverModeCode(app, f, "oidc");
  assert.equal((await exchange(app, f.client, login.code, "", login.verifier)).status, 200);
  await serverModeCode(app, f, "legacy");

  const result = await switchOAuthLoginMode({
    client: ` ${f.client.clientId} `,
    review: `  ${SIGN_OFF.review}  `,
    reason: `${SIGN_OFF.reason}\n`,
    operator: ` ${SIGN_OFF.operator}`,
  });
  assert.equal(await loginModeOf(f.client.id), "account");

  const audit = await switchAuditRows();
  assert.equal(audit.length, 1, "exactly one audit row");
  const [event] = audit;
  assert.deepEqual({
    serverId: event!.serverId,
    clientId: event!.clientId,
    eventCategory: event!.eventCategory,
    outcome: event!.outcome,
    source: event!.source,
    actorType: event!.actorType,
    actorId: event!.actorId,
    subjectType: event!.subjectType,
    subjectId: event!.subjectId,
    targetType: event!.targetType,
    targetId: event!.targetId,
    metadata: event!.metadata,
    diff: event!.diff,
  }, {
    // The App's own Server: the publisher's, where it was registered.
    serverId: f.publisher.id,
    clientId: f.client.id,
    eventCategory: "registration",
    outcome: "success",
    source: "system",
    actorType: "system",
    actorId: null,
    subjectType: "app",
    subjectId: f.client.id,
    targetType: "app",
    targetId: f.client.id,
    metadata: {
      clientKey: f.client.clientId,
      from: "server",
      to: "account",
      review: SIGN_OFF.review,
      reason: SIGN_OFF.reason,
      operator: SIGN_OFF.operator,
      liveServerHumanTokens: 1,
      openServerHumanCodes: 1,
    },
    diff: null,
  });

  // The CLI prints JSON.stringify(result) as its one line: these keys, in this order.
  assert.equal(JSON.stringify(result), JSON.stringify({
    changed: true,
    client: f.client.clientId,
    id: f.client.id,
    from: "server",
    to: "account",
    review: SIGN_OFF.review,
    reason: SIGN_OFF.reason,
    operator: SIGN_OFF.operator,
    liveServerHumanTokens: 1,
    openServerHumanCodes: 1,
    auditEventId: event!.id,
  }));
});

test("a second switch changes nothing: changed:false, no second audit row", async ({ db }) => {
  void db;
  const f = await seedSwitch();
  const input = { client: f.client.clientId, ...SIGN_OFF };
  assert.equal((await switchOAuthLoginMode(input)).changed, true);
  const [first] = await switchAuditRows(f.client.id);
  const row = await getDb().select().from(oauthClients).where(eq(oauthClients.id, f.client.id));

  const again = await switchOAuthLoginMode({ ...input, review: "another review", reason: "again" });
  assert.equal(JSON.stringify(again), JSON.stringify({ changed: false, client: f.client.clientId, id: f.client.id, loginMode: "account" }));
  assert.deepEqual(await switchAuditRows(f.client.id), [first], "still the one audit row");
  assert.deepEqual(await getDb().select().from(oauthClients).where(eq(oauthClients.id, f.client.id)), row);
});

test("refusals change nothing and write no audit row: an unknown App, a built-in or platform-managed App, a missing or empty review or reason, an overlong reason", async ({ db }) => {
  void db;
  const f = await seedSwitch();
  const register = async (label: string) => {
    const { client } = await createOAuthClient({
      serverId: f.publisher.id,
      createdByUserId: f.owner.id,
      appType: "third_party_global",
      clientId: `${label}-${f.suffix}`,
      name: `${label} App`,
      returnUrl: RETURN_URL,
      allowedScopes: DEFAULT_SCOPES,
    });
    return client;
  };
  const builtin = await register("builtin");
  await getDb().update(oauthClients).set({ appType: "slock_builtin" }).where(eq(oauthClients.id, builtin.id));
  // Platform-managed: an external app registration owns it (oauthClientManagementPolicy.ts), whatever its type.
  const platform = await register("platform");
  await getDb().insert(externalAppRegistrations).values({
    oauthClientId: platform.id,
    provider: "slack",
    environment: "test",
    providerAppId: `A_${f.suffix}`,
    providerOAuthClientId: `oauth-${f.suffix}`,
    capabilityManifestVersion: 1,
    capabilityManifestHash: "manifest-v1",
  });
  const input = { client: f.client.clientId, ...SIGN_OFF };

  await assert.rejects(switchOAuthLoginMode({ ...input, client: `unknown-${f.suffix}` }), refusedWith("unknown_client", /no App has the client id unknown-/));
  await assert.rejects(switchOAuthLoginMode({ ...input, client: builtin.clientId }), refusedWith("not_user_managed", /built-in or platform-managed App \(slock_builtin\)/));
  await assert.rejects(switchOAuthLoginMode({ ...input, client: platform.clientId }), refusedWith("not_user_managed", /built-in or platform-managed App \(third_party_global\)/));
  const missing = (field: "review" | "reason") => {
    const { [field]: _, ...rest } = input;
    return rest as typeof input;
  };
  await assert.rejects(switchOAuthLoginMode(missing("review")), refusedWith("invalid_input", /--review is required/));
  await assert.rejects(switchOAuthLoginMode({ ...input, review: "   " }), refusedWith("invalid_input", /--review is required/));
  await assert.rejects(switchOAuthLoginMode(missing("reason")), refusedWith("invalid_input", /--reason is required/));
  await assert.rejects(switchOAuthLoginMode({ ...input, reason: "" }), refusedWith("invalid_input", /--reason is required/));
  await assert.rejects(switchOAuthLoginMode({ ...input, reason: "x".repeat(1001) }), refusedWith("invalid_input", /--reason is required: 1 to 1000/));
  // A value the audit writer would drop as credential-shaped: refused rather than recorded without it.
  await assert.rejects(switchOAuthLoginMode({ ...input, reason: "pasted Bearer abc.def" }), refusedWith("invalid_input", /the audit row would drop reason/));

  for (const client of [f.client, builtin, platform]) assert.equal(await loginModeOf(client.id), "server", client.clientId);
  assert.deepEqual(await switchAuditRows(), [], "no audit row");
});

test("the switch locks the App's row FOR UPDATE before it reads the mode", async ({ db }) => {
  void db;
  const f = await seedSwitch();
  await switchOAuthLoginMode({ client: f.client.clientId, ...SIGN_OFF });
  // Inside one transaction, the idempotent path's only statements are the
  // lock and the read: a row lock (SELECT ... FOR UPDATE) holds RowShareLock
  // on the table until the end of the transaction; a plain read only
  // AccessShareLock.
  const tableLocks = async () => (await getDb().execute<{ mode: string }>(sql`
    SELECT "mode" FROM pg_locks WHERE "locktype" = 'relation' AND "relation" = 'oauth_clients'::regclass AND "pid" = pg_backend_pid()
  `)).rows.map((row) => row.mode);
  const rollback = new Error("rollback");
  await assert.rejects(getDb().transaction(async () => {
    assert.equal((await tableLocks()).includes("RowShareLock"), false, "witness: no row lock yet");
    assert.equal((await switchOAuthLoginMode({ client: f.client.clientId, ...SIGN_OFF })).changed, false);
    assert.ok((await tableLocks()).includes("RowShareLock"), "the switch locked the App's row");
    throw rollback;
  }), (error) => error === rollback);
});

test("§2.3 / T9 / T8: at the switch, a live server-mode token keeps working and stays bound, open server-mode codes are refused, account logins work, and there is no way back", async ({ app }) => {
  const f = await seedSwitch();
  // Before the switch: a server-mode OIDC login on S, and two open codes there.
  const login = await serverModeCode(app, f, "oidc");
  const tokenAnswer = await exchange(app, f.client, login.code, "", login.verifier);
  assert.equal(tokenAnswer.status, 200);
  const preSwitchToken = (await tokenAnswer.json() as { access_token: string }).access_token;
  const openOidc = await serverModeCode(app, f, "oidc");
  const openLegacy = await serverModeCode(app, f, "legacy");
  const consentsOnS = () => getDb().select().from(oauthUserConsents).where(and(
    eq(oauthUserConsents.userId, f.person.id), eq(oauthUserConsents.clientId, f.client.id), eq(oauthUserConsents.serverId, f.server.id),
  ));
  const [consent] = await consentsOnS();
  assert.ok(consent, "the server-mode login's consent on S");
  assert.equal((await showOAuthLoginMode(f.client.clientId)).openServerHumanCodes, 2);

  const switched = await switchOAuthLoginMode({ client: f.client.clientId, ...SIGN_OFF });
  assert.equal(switched.changed, true);
  assert.deepEqual(
    [switched.changed && switched.liveServerHumanTokens, switched.changed && switched.openServerHumanCodes],
    [1, 2],
    "the switch saw what it changes",
  );

  // The pre-switch token: valid until it expires, still bound to S.
  const userinfo = await read(app, "/api/oauth/userinfo", preSwitchToken);
  assert.equal(userinfo.status, 200, userinfo.body);
  assert.equal(JSON.parse(userinfo.body).server_id, f.server.id);
  assert.equal((await read(app, `/api/oauth/serverinfo?server_id=${f.server.id}`, preSwitchToken)).status, 200);
  assert.deepEqual(await read(app, `/api/oauth/serverinfo?server_id=${f.b.id}`, preSwitchToken), { status: 403, body: SERVER_ACCESS_DENIED_BODY }, "B, where the App is installed and the person a member: still refused");
  const servers = await read(app, "/api/oauth/servers", preSwitchToken);
  assert.deepEqual((JSON.parse(servers.body) as { servers: Array<{ id: string }> }).servers.map((server) => server.id), [f.server.id]);

  // The open codes: today's dead-code invalid_grant, OIDC and legacy alike; nothing written.
  const tokensBefore = await getDb().select({ id: oauthAccessTokens.id }).from(oauthAccessTokens).where(eq(oauthAccessTokens.clientId, f.client.id));
  assert.deepEqual(await exchange(app, f.client, openOidc.code, "", openOidc.verifier).then(answer), { status: 400, body: DEAD_CODE_BODY }, "OIDC");
  assert.deepEqual(await exchange(app, f.client, openLegacy.code, "", null).then(answer), { status: 400, body: DEAD_CODE_BODY }, "legacy");
  assert.equal((await getDb().select({ id: oauthAccessTokens.id }).from(oauthAccessTokens).where(eq(oauthAccessTokens.clientId, f.client.id))).length, tokensBefore.length);
  // New logins while the kill switch is off for the person (the runbook's
  // order matters): the App is not available to them, a page opened before
  // the switch included; never a new Server-bound code.
  const { verifier, challenge } = pkce();
  const accountBody = { clientId: f.client.clientId, returnUrl: RETURN_URL, scopes: DEFAULT_SCOPES, oidc: true, nonce: `nonce-${randomUUID()}`, codeChallenge: challenge, codeChallengeMethod: "S256" };
  const authorizeAccount = () => fetch(`${app.baseUrl}/api/oauth/authorize/account`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.person.bearer}` },
    body: JSON.stringify(accountBody),
  }).then(answer);
  const oldPage = () => continueLogin(app, f.person.bearer, { clientId: f.client.clientId, serverId: f.server.id, returnUrl: RETURN_URL, scopes: DEFAULT_SCOPES }).then(answer);
  assert.deepEqual(await oldPage(), { status: 403, body: APP_NOT_AVAILABLE_BODY });
  assert.deepEqual(await authorizeAccount(), { status: 403, body: APP_NOT_AVAILABLE_BODY });

  // The kill switch on: a page opened before the switch gets 409 (it reloads), and an account-mode login works: a token on no Server, usable on B.
  await setAccountLoginFlag();
  assert.deepEqual(await oldPage(), { status: 409, body: LOGIN_MODE_CHANGED_BODY });
  const authorized = await authorizeAccount();
  assert.equal(authorized.status, 200, authorized.body);
  const accountAnswer = await exchange(app, f.client, (JSON.parse(authorized.body) as { code: string }).code, "", verifier).then(answer);
  assert.equal(accountAnswer.status, 200, accountAnswer.body);
  const accountToken = (JSON.parse(accountAnswer.body) as { access_token: string }).access_token;
  const [accountRow] = await getDb().select().from(oauthAccessTokens).where(eq(oauthAccessTokens.tokenHash, tokenHash(accountToken)));
  assert.equal(accountRow?.serverId, null);
  const accountUserinfo = await read(app, "/api/oauth/userinfo", accountToken);
  assert.equal(accountUserinfo.status, 200, accountUserinfo.body);
  assert.equal("server_id" in JSON.parse(accountUserinfo.body), false);
  assert.equal((await read(app, `/api/oauth/serverinfo?server_id=${f.b.id}`, accountToken)).status, 200);

  // Consents: the per-Server one is untouched (until 3b); the account login added its own.
  assert.deepEqual(await consentsOnS(), [consent]);
  assert.equal((await getDb().select().from(oauthUserConsents).where(and(
    eq(oauthUserConsents.userId, f.person.id), eq(oauthUserConsents.clientId, f.client.id), isNull(oauthUserConsents.serverId),
  ))).length, 1);

  // What show says now: the old token still live, the refused codes not yet expired, one account token.
  assert.deepEqual(await showOAuthLoginMode(f.client.clientId), {
    client: f.client.clientId,
    id: f.client.id,
    name: "Allowed App",
    appType: "third_party_global",
    loginMode: "account",
    userManaged: true,
    enabled: true,
    publishStatus: "published",
    liveServerHumanTokens: 1,
    openServerHumanCodes: 2,
    liveAccountTokens: 1,
  });

  // T8: no way back, whatever the writer.
  await assert.rejects(
    getDb().execute(sql`UPDATE "oauth_clients" SET "login_mode" = 'server' WHERE "id" = ${f.client.id}`),
    violates(CHECK_VIOLATION, "oauth_clients_login_mode_forward_only"),
  );
  assert.equal(await loginModeOf(f.client.id), "account");
  assert.equal((await switchAuditRows(f.client.id)).length, 1);
});
