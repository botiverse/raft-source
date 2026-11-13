// PR 5 of passkeys + two-step verification (design v8 §3): step-up for
// sensitive actions. With two-step verification on (flag AND the person's
// own setting), each gated route needs this sign-in to have passed the second
// factor in the last 10 minutes; otherwise 403 `second_factor_step_up_required`
// with the methods, and nothing happens. POST /step-up marks it; ten minutes
// later it is needed again. Someone who never turned it on sees no change
// (design §0): the same status and body as before, on any sign-in.
//
// Computer and machine keys (attach, adopt-legacy, machine register, machine
// key rotation) are gated the same way from a web sign-in; a device login's
// session and a device-login grant's attach token are not.
//
// Linking a sign-in method from the apps takes an optional bearer on
// POST /mobile/oauth/start and POST /mobile/oauth/apple/native/start
// (`mode: "link"`): gated the same way; `mode: "login"` never is.
//
// Creating an app (it answers with its first client secret), an app's new
// client secret and webhook signing secret are gated the same way.
// Login with Raft consent, approving an app's agent access request,
// installing an app (marketplace or private invite), approving an installed
// app's new permissions and adding its bot need a verified sign-in, as
// approving a device or app login does (no 10-minute window); refusing an
// access request, uninstalling and removing a bot never do.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  agentBootstrapTokens,
  agentCredentials,
  computers,
  integrationAuditEvents,
  machines,
  oauthAccessRequests,
  oauthClientInstalls,
  oauthAppWebhookConfigs,
  oauthClients,
  oauthTransactions,
  sessionFamilies,
  userAuthIdentities,
  users,
} from "../db/schema";
import { signAccessToken } from "../middleware/auth";
import { createAgent } from "../services/agentService";
import { configureAppWebhook } from "../services/appWebhookConfigService";
import { createOAuthClient, createOAuthClientShareLink, installMarketplaceOAuthClient } from "../services/oauthService";
import { expectedAppPermissionsBody } from "../test/integration/appPermissions";
import { addMember } from "../services/serverService";
import { registerMachine } from "../services/machineService";
import { STEP_UP_ACTIONS, STEP_UP_WINDOW_MS } from "../services/secondFactor/stepUpGate";
import { proofForDeviceLogin } from "../services/sessionIssueGate";
import { createSession } from "../services/sessionService";
import { createApiTest } from "../test/integration/apiTest";
import { signInForTest } from "../test/integration/credentials";
import { enrollSecondFactor, useTotpSecretKey } from "../test/integration/secondFactor";

const test = createApiTest();
useTotpSecretKey();

const ENV = {
  AGENT_BOOTSTRAP_TOKEN_PEPPER: "second-factor-step-up-test-pepper-0123456789",
  SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED: "true",
  // An app webhook signing secret is stored encrypted.
  RAFT_APP_WEBHOOK_ENCRYPTION_KEY: "abababababababababababababababababababababababababababababababab",
  SLOCK_DEVICE_LOGIN_ENABLED: undefined,
  SOCIAL_AUTH_STATE_SECRET: "second-factor-step-up-state-secret",
  MOBILE_OAUTH_RETURN_URI: "raft://oauth/callback",
  MOBILE_OAUTH_ALLOWED_RETURN_URIS: undefined,
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  SERVER_URL: "https://api.example.test",
  // Native Sign in with Apple on iOS (as auth.api.test.ts withNativeAppleOAuthEnv).
  NATIVE_APPLE_AUTH_STATE_SECRET: "second-factor-step-up-native-apple-secret",
  APPLE_IOS_CLIENT_ID: "build.raft.app",
  APPLE_IOS_CLIENT_SECRET: "native-apple-client-secret",
  APPLE_TEAM_ID: undefined,
  APPLE_KEY_ID: undefined,
  APPLE_PRIVATE_KEY: undefined,
} as const;
const previousEnv = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));
function applyEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
beforeAll(() => { applyEnv(ENV); });
afterAll(() => { applyEnv(previousEnv); });

type Json = Record<string, any>;
type Res = { status: number; body: Json; setCookie: string | null };
type Human = { id: string };

async function call(baseUrl: string, method: string, path: string, token: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) as Json, setCookie: res.headers.get("set-cookie") };
}

/**
 * A person with a password and a Google identity, signed in on the web (an
 * unverified `full` sign-in), on a server of their own with an external agent.
 * `enforced`: two-step verification then turned on (flag and setting).
 */
async function person(seed: { human(values?: Json): Promise<any>; server(input: { owner: any }): Promise<{ id: string; slug: string }> }, enforced: boolean) {
  const human = await seed.human({ passwordCredentialEstablishedAt: new Date() });
  await getDb().insert(userAuthIdentities).values({
    userId: human.id, provider: "google", providerUserId: `google-${human.id}`, providerEmail: "someone@gmail.test",
  });
  const server = await seed.server({ owner: human });
  const agentName = `ext-${human.id.slice(0, 8)}`;
  const agent = await createAgent(server.id, agentName, { runtime: "external" });
  // A legacy (`sk_machine_*`) machine of theirs, to adopt or rotate.
  const legacy = await registerMachine(server.id, human.id, `legacy-${human.id.slice(0, 8)}`);
  const session = await signInForTest(human.id);
  let backupCodes: string[] = [];
  if (enforced) {
    ({ backupCodes } = await enrollSecondFactor(human.id));
  }
  return {
    human: human as Human, serverId: server.id, serverSlug: server.slug, agentId: agent.id, agentName,
    machineId: legacy.machine.id, legacyKey: legacy.apiKey, session, backupCodes,
  };
}

type Person = Awaited<ReturnType<typeof person>>;

/** A Server-local app of the person's Server, with an app webhook (made on first use). */
const appsOf = new WeakMap<Person, Promise<{ id: string; clientKey: string }>>();
function appOf(p: Person) {
  let made = appsOf.get(p);
  if (!made) {
    made = (async () => {
      const { client } = await createOAuthClient({
        serverId: p.serverId, createdByUserId: p.human.id, clientId: `step-up-${randomUUID().slice(0, 8)}`, name: "Step-up App",
      });
      await configureAppWebhook({ clientId: client.id, actorUserId: p.human.id, endpointUrl: "https://step-up.example.test/raft" });
      return { id: client.id, clientKey: client.clientId };
    })();
    appsOf.set(p, made);
  }
  return made;
}

/** Each gated route: the request, and what it changed (to prove a refusal changed nothing). */
type GatedRoute = {
  name: string;
  action: keyof typeof STEP_UP_ACTIONS;
  send(baseUrl: string, p: Person, token: string): Promise<Res>;
  /** The status it answers when allowed. */
  okStatus: number;
  /** Authenticated by an optional bearer (no requireAuth): a device login's session is no session there. */
  optionalBearer?: boolean;
  sideEffects(p: Person): Promise<unknown>;
};

const computersOf = async (p: Person) => (await getDb().select({ id: computers.id }).from(computers).where(eq(computers.serverId, p.serverId))).length;
const machinesOf = async (p: Person) => (await getDb().select({ id: machines.id }).from(machines).where(eq(machines.serverId, p.serverId))).length;

async function passwordHashOf(userId: string) {
  return (await getDb().select({ hash: users.passwordHash }).from(users).where(eq(users.id, userId)))[0]!.hash;
}

function nativeAppleStart(mode: "link" | "login") {
  return {
    mode, platform: "ios", appEnv: "staging", returnUri: "raft://oauth/callback",
    codeChallenge: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ", codeChallengeMethod: "S256",
  };
}

const GATED: GatedRoute[] = [
  {
    name: "PATCH /api/auth/me (password change)",
    action: "password_change",
    send: (baseUrl, _p, token) => call(baseUrl, "PATCH", "/api/auth/me", token, { currentPassword: "password123", newPassword: "a-new-password-123" }),
    okStatus: 200,
    sideEffects: async (p) => passwordHashOf(p.human.id),
  },
  {
    name: "DELETE /api/auth/identities/:provider",
    action: "identity_unlink",
    send: (baseUrl, _p, token) => call(baseUrl, "DELETE", "/api/auth/identities/google", token),
    okStatus: 200,
    sideEffects: async (p) => (await getDb().select().from(userAuthIdentities).where(eq(userAuthIdentities.userId, p.human.id))).length,
  },
  {
    name: "POST /api/auth/:provider/link/start",
    action: "identity_link",
    send: (baseUrl, _p, token) => call(baseUrl, "POST", "/api/auth/google/link/start", token, { returnTo: "/settings" }),
    okStatus: 200,
    // The start's only effect is the signed state (URL) and its nonce cookie (assertRefused: none).
    sideEffects: async () => null,
  },
  {
    name: "POST /api/auth/mobile/oauth/:provider/link/start",
    action: "identity_link",
    send: (baseUrl, _p, token) => call(baseUrl, "POST", "/api/auth/mobile/oauth/google/link/start", token, {
      returnUri: "raft://oauth/callback", codeChallenge: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
    }),
    okStatus: 201,
    sideEffects: async (p) => (await getDb().select().from(oauthTransactions).where(eq(oauthTransactions.userId, p.human.id))).length,
  },
  {
    name: "POST /api/auth/mobile/oauth/start (mode link)",
    action: "identity_link",
    send: (baseUrl, _p, token) => call(baseUrl, "POST", "/api/auth/mobile/oauth/start", token, {
      provider: "google", mode: "link", returnUri: "raft://oauth/callback", codeChallenge: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
    }),
    okStatus: 201,
    optionalBearer: true,
    sideEffects: async (p) => (await getDb().select().from(oauthTransactions).where(eq(oauthTransactions.userId, p.human.id))).length,
  },
  {
    name: "POST /api/auth/mobile/oauth/apple/native/start (mode link)",
    action: "identity_link",
    send: (baseUrl, _p, token) => call(baseUrl, "POST", "/api/auth/mobile/oauth/apple/native/start", token, nativeAppleStart("link")),
    okStatus: 201,
    optionalBearer: true,
    sideEffects: async (p) => (await getDb().select().from(oauthTransactions).where(eq(oauthTransactions.userId, p.human.id))).length,
  },
  {
    name: "POST /api/agents/:id/credentials",
    action: "agent_credential_mint",
    send: (baseUrl, p, token) => call(baseUrl, "POST", `/api/agents/${p.agentId}/credentials`, token, {}),
    okStatus: 201,
    sideEffects: async (p) => (await getDb().select().from(agentCredentials).where(eq(agentCredentials.agentId, p.agentId))).length,
  },
  {
    name: "POST /api/agents/:id/bootstrap-tokens",
    action: "agent_bootstrap_token",
    send: (baseUrl, p, token) => call(baseUrl, "POST", `/api/agents/${p.agentId}/bootstrap-tokens`, token, {}, { "X-Server-Id": p.serverId }),
    okStatus: 201,
    sideEffects: async (p) => (await getDb().select().from(agentBootstrapTokens).where(eq(agentBootstrapTokens.targetAgentId, p.agentId))).length,
  },
  {
    name: "POST /api/computer/attach",
    action: "computer_attach",
    send: (baseUrl, p, token) => call(baseUrl, "POST", "/api/computer/attach", token, { serverSlug: p.serverSlug, name: "laptop" }),
    okStatus: 201,
    sideEffects: computersOf,
  },
  {
    name: "POST /api/computer/adopt-legacy",
    action: "computer_adopt",
    send: (baseUrl, p, token) => call(baseUrl, "POST", "/api/computer/adopt-legacy", token, { legacyApiKey: p.legacyKey }),
    okStatus: 201,
    sideEffects: computersOf,
  },
  {
    name: "POST /api/servers/:id/machines (register a machine key)",
    action: "machine_key_register",
    send: (baseUrl, p, token) => call(baseUrl, "POST", `/api/servers/${p.serverId}/machines`, token, { name: "new-machine" }, { "X-Server-Id": p.serverId }),
    okStatus: 200,
    sideEffects: machinesOf,
  },
  {
    name: "POST /api/servers/:id/machines/:machineId/rotate-key",
    action: "machine_key_rotate",
    send: (baseUrl, p, token) => call(baseUrl, "POST", `/api/servers/${p.serverId}/machines/${p.machineId}/rotate-key`, token, undefined, { "X-Server-Id": p.serverId }),
    okStatus: 200,
    sideEffects: async (p) => (await getDb().select({ hash: machines.apiKeyHash }).from(machines).where(eq(machines.id, p.machineId)))[0]!.hash,
  },
  {
    name: "POST /api/integrations/clients (a new app and its first client secret)",
    action: "integration_app_register",
    send: (baseUrl, p, token) => call(baseUrl, "POST", "/api/integrations/clients", token, {
      name: "Registered App", returnUrl: "https://registered.example.test/callback", clientId: `step-up-new-${randomUUID().slice(0, 8)}`,
    }, { "X-Server-Id": p.serverId }),
    okStatus: 200,
    sideEffects: async (p) => (await getDb().select({ id: oauthClients.id }).from(oauthClients).where(eq(oauthClients.serverId, p.serverId))).length,
  },
  {
    name: "POST /api/integrations/clients/:clientId/regenerate-secret",
    action: "integration_client_secret_regenerate",
    send: async (baseUrl, p, token) => call(baseUrl, "POST", `/api/integrations/clients/${(await appOf(p)).id}/regenerate-secret`, token, undefined, { "X-Server-Id": p.serverId }),
    okStatus: 200,
    sideEffects: async (p) => (await getDb().select({ hash: oauthClients.clientSecretHash }).from(oauthClients).where(eq(oauthClients.id, (await appOf(p)).id)))[0]!.hash,
  },
  {
    name: "POST /api/integrations/clients/:clientId/app-notifications/webhook/rotate-secret",
    action: "integration_webhook_secret_rotate",
    send: async (baseUrl, p, token) => call(baseUrl, "POST", `/api/integrations/clients/${(await appOf(p)).id}/app-notifications/webhook/rotate-secret`, token, {}, { "X-Server-Id": p.serverId }),
    okStatus: 200,
    sideEffects: async (p) => (await getDb().select({ revision: oauthAppWebhookConfigs.revision }).from(oauthAppWebhookConfigs).where(eq(oauthAppWebhookConfigs.clientId, (await appOf(p)).id)))[0]!.revision,
  },
];

/** The routes a device login's session reaches at all (middleware/auth.ts DEVICE_SESSION_ROUTES). */
const DEVICE_SESSION_REACHES = new Set<GatedRoute["action"]>(["agent_credential_mint", "computer_attach", "computer_adopt"]);

function assertRefused(res: Res, route: GatedRoute) {
  assert.equal(res.status, 403, `${route.name}: ${JSON.stringify(res.body)}`);
  assert.deepEqual(res.body, {
    error: STEP_UP_ACTIONS[route.action],
    code: "second_factor_step_up_required",
    methods: ["totp", "backup_code"],
  }, route.name);
  assert.equal(res.setCookie, null, `${route.name}: no state cookie`);
}

async function stepUp(baseUrl: string, token: string, backupCode: string) {
  const res = await call(baseUrl, "POST", "/api/auth/second-factor/step-up", token, { backupCode });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

async function ageVerification(familyId: string, byMs: number) {
  await getDb().update(sessionFamilies)
    .set({ secondFactorVerifiedAt: new Date(Date.now() - byMs) })
    .where(eq(sessionFamilies.id, familyId));
}

for (const route of GATED) {
  test(`${route.name}: with two-step verification on, needs the second factor on this sign-in in the last 10 minutes`, async ({ app, seed }) => {
    const p = await person(seed, true);
    const before = await route.sideEffects(p);

    // Never verified on this sign-in: refused, nothing changed.
    assertRefused(await route.send(app.baseUrl, p, p.session.token), route);
    assert.deepEqual(await route.sideEffects(p), before, `${route.name}: no side effect`);

    // Verified more than 10 minutes ago: refused again.
    await stepUp(app.baseUrl, p.session.token, p.backupCodes[0]!);
    await ageVerification(p.session.familyId, STEP_UP_WINDOW_MS + 60_000);
    assertRefused(await route.send(app.baseUrl, p, p.session.token), route);
    assert.deepEqual(await route.sideEffects(p), before, `${route.name}: no side effect`);

    // A fresh step-up (a repeat one stamps the time again): allowed.
    await stepUp(app.baseUrl, p.session.token, p.backupCodes[1]!);
    const allowed = await route.send(app.baseUrl, p, p.session.token);
    assert.equal(allowed.status, route.okStatus, `${route.name}: ${JSON.stringify(allowed.body)}`);
    assert.equal(allowed.body?.code, undefined);
  });

  test(`${route.name}: without two-step verification, unchanged on an unverified sign-in`, async ({ app, seed }) => {
    // Two people who never turned it on: both as before.
    const plain = await person(seed, false);
    const flagOnly = await person(seed, false);
    for (const p of [plain, flagOnly]) {
      const [family] = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.id, p.session.familyId));
      assert.equal(family!.secondFactorVerifiedAt, null);
      const before = await route.sideEffects(p);
      const res = await route.send(app.baseUrl, p, p.session.token);
      assert.equal(res.status, route.okStatus, `${route.name}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body?.code, undefined);
      if (before !== null) assert.notDeepEqual(await route.sideEffects(p), before, `${route.name}: applied`);
      else assert.ok(res.setCookie && typeof res.body.url === "string", `${route.name}: started`);
    }
  });
}

test("the same answer as before for someone without two-step verification: response keys match a stepped-up enforced person's", async ({ app, seed }) => {
  for (const route of GATED) {
    const plain = await person(seed, false);
    const enforced = await person(seed, true);
    await stepUp(app.baseUrl, enforced.session.token, enforced.backupCodes[0]!);
    const a = await route.send(app.baseUrl, plain, plain.session.token);
    const b = await route.send(app.baseUrl, enforced, enforced.session.token);
    assert.equal(a.status, b.status, route.name);
    assert.deepEqual(Object.keys(a.body ?? {}).sort(), Object.keys(b.body ?? {}).sort(), route.name);
  }
});

test("a sign-in that passed the second step at sign-in less than 10 minutes ago needs no step-up; a stale or revoked one does", async ({ app, seed }) => {
  const p = await person(seed, true);
  const mint = GATED.find((route) => route.action === "agent_credential_mint")!;
  await getDb().update(sessionFamilies).set({ secondFactorVerifiedAt: new Date(Date.now() - 60_000), secondFactorMethod: "totp" })
    .where(eq(sessionFamilies.id, p.session.familyId));
  assert.equal((await mint.send(app.baseUrl, p, p.session.token)).status, 201);
  await ageVerification(p.session.familyId, STEP_UP_WINDOW_MS + 1_000);
  assertRefused(await mint.send(app.baseUrl, p, p.session.token), mint);
});

test("agent key from a device login's session (raft agent login): not gated, its approval already needed a verified sign-in", async ({ app, seed }) => {
  const p = await person(seed, true);
  const device = await createSession(await proofForDeviceLogin(p.human.id, p.session.familyId), undefined, { scope: "device" });
  const deviceToken = signAccessToken(p.human.id, device.familyId);
  const minted = await call(app.baseUrl, "POST", `/api/agents/${p.agentId}/credentials`, deviceToken, {});
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
});

test("a device login's session cannot reach the other gated routes at all (unchanged)", async ({ app, seed }) => {
  const p = await person(seed, true);
  const device = await createSession(await proofForDeviceLogin(p.human.id, p.session.familyId), undefined, { scope: "device" });
  const deviceToken = signAccessToken(p.human.id, device.familyId);
  for (const route of GATED.filter((r) => !DEVICE_SESSION_REACHES.has(r.action))) {
    const res = await route.send(app.baseUrl, p, deviceToken);
    if (route.optionalBearer) {
      // No session at all there: link mode needs one.
      assert.equal(res.status, 401, `${route.name}: ${JSON.stringify(res.body)}`);
      continue;
    }
    assert.equal(res.status, 403, route.name);
    assert.equal(res.body.code, "device_session_not_allowed", route.name);
  }
});

test("native Apple and mobile OAuth start in login mode: never gated, with or without a bearer", async ({ app, seed }) => {
  const p = await person(seed, true);
  const before = await getDb().select().from(oauthTransactions).where(eq(oauthTransactions.userId, p.human.id));
  for (const token of [null, p.session.token]) {
    const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const native = await fetch(`${app.baseUrl}/api/auth/mobile/oauth/apple/native/start`, { method: "POST", headers, body: JSON.stringify(nativeAppleStart("login")) });
    assert.equal(native.status, 201, await native.clone().text());
    const mobile = await fetch(`${app.baseUrl}/api/auth/mobile/oauth/start`, {
      method: "POST", headers,
      body: JSON.stringify({ provider: "google", mode: "login", returnUri: "raft://oauth/callback", codeChallenge: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ" }),
    });
    assert.equal(mobile.status, 201, await mobile.clone().text());
  }
  // A login start is bound to nobody.
  assert.equal((await getDb().select().from(oauthTransactions).where(eq(oauthTransactions.userId, p.human.id))).length, before.length);
});

test("native Apple link: /authorize cannot link without a gated start (its request token binds mode and user)", async ({ app, seed }) => {
  const p = await person(seed, true);
  // A login-mode start, then /authorize with the enforced person's bearer: still login, links nothing to them.
  const login = await call(app.baseUrl, "POST", "/api/auth/mobile/oauth/apple/native/start", p.session.token, nativeAppleStart("login"));
  assert.equal(login.status, 201);
  const [row] = await getDb().select().from(oauthTransactions).where(eq(oauthTransactions.id, login.body.requestId));
  assert.equal(row!.mode, "login");
  assert.equal(row!.userId, null);
  // A forged link-mode request token for that request is refused before Apple is asked.
  const forged = await call(app.baseUrl, "POST", "/api/auth/mobile/oauth/apple/native/authorize", p.session.token, {
    requestId: login.body.requestId, requestToken: `${login.body.requestToken}x`, authorizationCode: "code", identityToken: "token",
  });
  assert.equal(forged.status, 400, JSON.stringify(forged.body));
  assert.equal((await getDb().select().from(oauthTransactions).where(eq(oauthTransactions.id, login.body.requestId)))[0]!.status, "pending_provider");
});

async function deviceSessionOf(p: Person) {
  const device = await createSession(await proofForDeviceLogin(p.human.id, p.session.familyId), undefined, { scope: "device" });
  return { familyId: device.familyId, token: signAccessToken(p.human.id, device.familyId) };
}

test("computer attach and adopt from a device login's session (raft-computer login): not gated, its approval already needed a verified sign-in", async ({ app, seed }) => {
  for (const action of ["computer_attach", "computer_adopt"] as const) {
    const route = GATED.find((r) => r.action === action)!;
    const p = await person(seed, true);
    const device = await deviceSessionOf(p);
    const before = await route.sideEffects(p);
    const res = await route.send(app.baseUrl, p, device.token);
    assert.equal(res.status, 201, `${route.name}: ${JSON.stringify(res.body)}`);
    assert.notDeepEqual(await route.sideEffects(p), before, `${route.name}: applied`);
    const [computer] = await getDb().select({ family: computers.keyIssuedBySessionFamilyId }).from(computers).where(eq(computers.serverId, p.serverId));
    assert.equal(computer!.family, device.familyId, `${route.name}: the key records the device session`);
  }
});

async function postJson(baseUrl: string, path: string, body: unknown, token?: string): Promise<Res> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as Json, setCookie: res.headers.get("set-cookie") };
}

test("computer attach with a device-login grant's attach token: not gated, its approval needed a verified sign-in", async ({ app, seed }) => {
  const p = await person(seed, true);
  // Approving needs this sign-in to have passed the second factor.
  await stepUp(app.baseUrl, p.session.token, p.backupCodes[0]!);
  const login = await postJson(app.baseUrl, "/api/auth/device/authorize", {
    clientName: "raft-computer", grant: { kind: "computer_attach", machineName: "laptop", hostname: "laptop", os: "macOS" },
  });
  assert.equal(login.status, 201, JSON.stringify(login.body));
  const described = await postJson(app.baseUrl, "/api/auth/device/describe", { userCode: login.body.userCode }, p.session.token);
  assert.equal(described.status, 200, JSON.stringify(described.body));
  const approved = await postJson(app.baseUrl, "/api/auth/device/approve", {
    userCode: login.body.userCode, approvalTicket: described.body.approvalTicket, serverId: p.serverId,
  }, p.session.token);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const polled = await postJson(app.baseUrl, "/api/auth/device/token", { deviceCode: login.body.deviceCode });
  assert.match(polled.body.attachToken, /^dvat_/);
  // The approving sign-in's step-up is long past: the token still attaches.
  await ageVerification(p.session.familyId, STEP_UP_WINDOW_MS + 60_000);
  const attached = await postJson(app.baseUrl, "/api/computer/attach", {}, polled.body.attachToken);
  assert.equal(attached.status, 201, JSON.stringify(attached.body));
  assert.equal(await computersOf(p), 1);
});

async function issuedAudit(credentialId: string) {
  const [row] = await getDb().select({ metadata: integrationAuditEvents.metadata }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.eventType, "agent_credential.issued"), eq(integrationAuditEvents.targetId, credentialId)));
  return row!.metadata as Json;
}

test("an agent key's issued audit event records which kind of session minted it, not its family", async ({ app, seed }) => {
  // A device login's session (not gated by step-up), for someone with two-step verification on.
  const p = await person(seed, true);
  const device = await deviceSessionOf(p);
  const fromDevice = await call(app.baseUrl, "POST", `/api/agents/${p.agentId}/credentials`, device.token, {});
  assert.equal(fromDevice.status, 201, JSON.stringify(fromDevice.body));
  const deviceAudit = await issuedAudit(fromDevice.body.credentialId);
  assert.equal(deviceAudit.sessionSource, "device_session");
  assert.equal("sessionFamilyId" in deviceAudit, false);

  // A person's own web sign-in.
  const plain = await person(seed, false);
  const fromWeb = await call(app.baseUrl, "POST", `/api/agents/${plain.agentId}/credentials`, plain.session.token, {});
  assert.equal(fromWeb.status, 201, JSON.stringify(fromWeb.body));
  const webAudit = await issuedAudit(fromWeb.body.credentialId);
  assert.equal(webAudit.sessionSource, "web_session");
  assert.equal("sessionFamilyId" in webAudit, false);
});

// Approvals of an app's access: a verified sign-in (at sign-in or by step-up,
// any time before), as approving a device or app login; not the 10-minute window.

type Seed = Parameters<typeof person>[0];

/** A pending request from a member's app for the person's agent (made on first use). */
const accessRequestsOf = new WeakMap<Person, Promise<string>>();
function accessRequestOf(seed: Seed, baseUrl: string, p: Person) {
  let made = accessRequestsOf.get(p);
  if (!made) {
    made = (async () => {
      const member = await seed.human();
      await addMember(p.serverId, member.id, "member");
      const { client, clientSecret } = await createOAuthClient({
        serverId: p.serverId, createdByUserId: member.id, clientId: `step-up-req-${randomUUID().slice(0, 8)}`, name: "Asking App",
        allowedScopes: ["agent:notification:write"],
      });
      const res = await fetch(`${baseUrl}/api/oauth/requests/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: client.clientId, clientSecret, serverSlug: p.serverSlug, agentName: p.agentName, scopes: ["agent:notification:write"] }),
      });
      const body = await res.json() as Json;
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.status, "pending");
      return body.requestId as string;
    })();
    accessRequestsOf.set(p, made);
  }
  return made;
}

type ApprovalRoute = {
  name: string;
  error: string;
  send(seed: Seed, baseUrl: string, p: Person, token: string): Promise<Res>;
  sideEffects(seed: Seed, baseUrl: string, p: Person): Promise<unknown>;
};

const humanCodesOf = async (p: Person) => (await getDb().select({ id: oauthAccessRequests.id }).from(oauthAccessRequests)
  .where(and(eq(oauthAccessRequests.clientId, (await appOf(p)).id), eq(oauthAccessRequests.principalType, "human")))).length;
const humanAuthorize = (path: string) => async (_seed: Seed, baseUrl: string, p: Person, token: string) =>
  call(baseUrl, "POST", path, token, { clientId: (await appOf(p)).clientKey, serverId: p.serverId, scopes: ["openid", "profile"] });

/**
 * A published marketplace app from another person's Server, for this person
 * (made on first use, one per `purpose`): `installed` puts it on their Server
 * first, then widens its scopes (an update waiting for approval).
 */
const marketplaceAppsOf = new WeakMap<Person, Map<string, Promise<{ id: string; token?: string }>>>();
function marketplaceAppOf(seed: Seed, p: Person, purpose: "install" | "invite" | "grant" | "bot") {
  let mine = marketplaceAppsOf.get(p);
  if (!mine) marketplaceAppsOf.set(p, mine = new Map());
  let made = mine.get(purpose);
  if (!made) {
    made = (async () => {
      const publisher = await seed.human();
      const publisherServer = await seed.server({ owner: publisher });
      const { client } = await createOAuthClient({
        serverId: publisherServer.id, createdByUserId: publisher.id, clientId: `step-up-${purpose}-${randomUUID().slice(0, 8)}`,
        appType: purpose === "invite" ? undefined : "third_party_global", name: "Installable App",
        homepageUrl: "https://installable.example.test", returnUrl: "https://installable.example.test/callback",
        allowedScopes: ["openid", "profile"], enableBot: purpose === "bot",
      });
      if (purpose === "invite") {
        const share = await createOAuthClientShareLink({ serverId: publisherServer.id, clientId: client.id, targetServerSlug: p.serverSlug, createdByUserId: publisher.id });
        return { id: client.id, token: share!.token };
      }
      await getDb().update(oauthClients).set({ publishStatus: "published", humanMarketplaceVisible: true }).where(eq(oauthClients.id, client.id));
      if (purpose === "grant" || purpose === "bot") {
        assert.ok(await installMarketplaceOAuthClient({
          serverId: p.serverId, clientId: client.id, installedByUserId: p.human.id, expected: { scopes: ["openid", "profile"], groups: [], textRevisionId: null },
        }));
      }
      if (purpose === "grant") {
        await getDb().update(oauthClients).set({ allowedScopes: ["openid", "profile", "agent:notification:write"] }).where(eq(oauthClients.id, client.id));
      }
      return { id: client.id };
    })();
    mine.set(purpose, made);
  }
  return made;
}

async function installOf(p: Person, clientId: string) {
  const [install] = await getDb().select({ status: oauthClientInstalls.status, approvedScopes: oauthClientInstalls.approvedScopes, botGrant: oauthClientInstalls.botGrant })
    .from(oauthClientInstalls).where(and(eq(oauthClientInstalls.serverId, p.serverId), eq(oauthClientInstalls.clientId, clientId)));
  return install ?? null;
}

const INSTALL_ERROR = "Confirm it's you with your second step before installing this app.";

const APPROVALS: ApprovalRoute[] = [
  {
    name: "POST /api/oauth/authorize/human (Login with Raft consent)",
    error: "Confirm it's you with your second step before signing in to this app.",
    send: humanAuthorize("/api/oauth/authorize/human"),
    sideEffects: async (_seed, _baseUrl, p) => humanCodesOf(p),
  },
  {
    name: "POST /api/integrations/requests/:requestId/approve",
    error: "Confirm it's you with your second step before approving this app's access.",
    send: async (seed, baseUrl, p, token) => call(baseUrl, "POST", `/api/integrations/requests/${await accessRequestOf(seed, baseUrl, p)}/approve`, token, {}, { "X-Server-Id": p.serverId }),
    sideEffects: async (seed, baseUrl, p) => (await getDb().select({ status: oauthAccessRequests.status }).from(oauthAccessRequests)
      .where(eq(oauthAccessRequests.id, await accessRequestOf(seed, baseUrl, p))))[0]!.status,
  },
  {
    name: "POST /api/integrations/marketplace/:clientId/install",
    error: INSTALL_ERROR,
    send: async (seed, baseUrl, p, token) => {
      const { id } = await marketplaceAppOf(seed, p, "install");
      return call(baseUrl, "POST", `/api/integrations/marketplace/${id}/install`, token, await expectedAppPermissionsBody(id), { "X-Server-Id": p.serverId });
    },
    sideEffects: async (seed, _baseUrl, p) => installOf(p, (await marketplaceAppOf(seed, p, "install")).id),
  },
  {
    name: "POST /api/integration-invites/:token/install",
    error: INSTALL_ERROR,
    send: async (seed, baseUrl, p, token) => {
      const app = await marketplaceAppOf(seed, p, "invite");
      return call(baseUrl, "POST", `/api/integration-invites/${app.token}/install`, token, { serverId: p.serverId, ...await expectedAppPermissionsBody(app.id) });
    },
    sideEffects: async (seed, _baseUrl, p) => installOf(p, (await marketplaceAppOf(seed, p, "invite")).id),
  },
  {
    name: "PUT /api/integrations/marketplace/:clientId/install/app-notifications/grant",
    error: "Confirm it's you with your second step before approving this app's new permissions.",
    send: async (seed, baseUrl, p, token) => {
      const { id } = await marketplaceAppOf(seed, p, "grant");
      return call(baseUrl, "PUT", `/api/integrations/marketplace/${id}/install/app-notifications/grant`, token, await expectedAppPermissionsBody(id), { "X-Server-Id": p.serverId });
    },
    sideEffects: async (seed, _baseUrl, p) => (await installOf(p, (await marketplaceAppOf(seed, p, "grant")).id))?.approvedScopes,
  },
  {
    name: "POST /api/integrations/clients/:clientId/install/bot (grant)",
    error: "Confirm it's you with your second step before adding this app's bot.",
    send: async (seed, baseUrl, p, token) => {
      const { id } = await marketplaceAppOf(seed, p, "bot");
      return call(baseUrl, "POST", `/api/integrations/clients/${id}/install/bot`, token, { action: "grant" }, { "X-Server-Id": p.serverId });
    },
    sideEffects: async (seed, _baseUrl, p) => (await installOf(p, (await marketplaceAppOf(seed, p, "bot")).id))?.botGrant,
  },
];

for (const route of APPROVALS) {
  test(`${route.name}: with two-step verification on, needs a sign-in that passed the second step`, async ({ app, seed }) => {
    const p = await person(seed, true);
    const before = await route.sideEffects(seed, app.baseUrl, p);

    // Never verified on this sign-in: refused, nothing changed.
    const refused = await route.send(seed, app.baseUrl, p, p.session.token);
    assert.equal(refused.status, 403, `${route.name}: ${JSON.stringify(refused.body)}`);
    assert.deepEqual(refused.body, { error: route.error, code: "second_factor_step_up_required", methods: ["totp", "backup_code"] });
    assert.deepEqual(await route.sideEffects(seed, app.baseUrl, p), before, `${route.name}: no side effect`);

    // Verified on this sign-in, longer ago than step-up's 10 minutes: allowed.
    await stepUp(app.baseUrl, p.session.token, p.backupCodes[0]!);
    await ageVerification(p.session.familyId, STEP_UP_WINDOW_MS + 60_000);
    const allowed = await route.send(seed, app.baseUrl, p, p.session.token);
    assert.equal(allowed.status, 200, `${route.name}: ${JSON.stringify(allowed.body)}`);
    assert.notDeepEqual(await route.sideEffects(seed, app.baseUrl, p), before, `${route.name}: applied`);
  });

  test(`${route.name}: without two-step verification, unchanged on an unverified sign-in`, async ({ app, seed }) => {
    // Two people who never turned it on: both as before,
    // with the same keys as a verified enforced person's answer.
    const plain = await person(seed, false);
    const flagOnly = await person(seed, false);
    const enforced = await person(seed, true);
    await stepUp(app.baseUrl, enforced.session.token, enforced.backupCodes[0]!);
    const reference = await route.send(seed, app.baseUrl, enforced, enforced.session.token);
    assert.equal(reference.status, 200, `${route.name}: ${JSON.stringify(reference.body)}`);
    for (const p of [plain, flagOnly]) {
      const before = await route.sideEffects(seed, app.baseUrl, p);
      const res = await route.send(seed, app.baseUrl, p, p.session.token);
      assert.equal(res.status, 200, `${route.name}: ${JSON.stringify(res.body)}`);
      assert.notEqual(res.body?.code, "second_factor_step_up_required");
      assert.deepEqual(Object.keys(res.body ?? {}).sort(), Object.keys(reference.body ?? {}).sort(), route.name);
      assert.notDeepEqual(await route.sideEffects(seed, app.baseUrl, p), before, `${route.name}: applied`);
    }
  });
}

test("refusing an app's access request needs no verified sign-in", async ({ app, seed }) => {
  const p = await person(seed, true);
  const requestId = await accessRequestOf(seed, app.baseUrl, p);
  const denied = await call(app.baseUrl, "POST", `/api/integrations/requests/${requestId}/deny`, p.session.token, {}, { "X-Server-Id": p.serverId });
  assert.equal(denied.status, 200, JSON.stringify(denied.body));
  const [row] = await getDb().select({ status: oauthAccessRequests.status }).from(oauthAccessRequests).where(eq(oauthAccessRequests.id, requestId));
  assert.equal(row!.status, "denied");
});

test("uninstalling an app and removing its bot need no verified sign-in", async ({ app, seed }) => {
  const p = await person(seed, true);
  const { id } = await marketplaceAppOf(seed, p, "bot");
  const removed = await call(app.baseUrl, "POST", `/api/integrations/clients/${id}/install/bot`, p.session.token, { action: "revoke" }, { "X-Server-Id": p.serverId });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal((await installOf(p, id))?.botGrant, "revoked");
  const uninstalled = await call(app.baseUrl, "DELETE", `/api/integrations/marketplace/${id}/install`, p.session.token, undefined, { "X-Server-Id": p.serverId });
  assert.equal(uninstalled.status, 200, JSON.stringify(uninstalled.body));
  assert.notEqual((await installOf(p, id))?.status, "active");
});

test("the OIDC mount of /authorize/human is not served (its scoped-mount guard), for anyone", async ({ app, seed }) => {
  for (const enforced of [false, true]) {
    const p = await person(seed, enforced);
    const res = await humanAuthorize(`/oidc/${p.serverSlug}/api/oauth/authorize/human`)(seed, app.baseUrl, p, p.session.token);
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.deepEqual(res.body, { error: "not_found" });
  }
});
