// Two-step verification and the app login handoff: the session the exchange
// (POST /api/auth/app-login/complete) issues inherits the approving sign-in's
// second factor, as of the approver's time, when that family is the person's
// own live `full` sign-in that passed it (services/sessionIssueGate.ts
// proofForAppLogin). The step-up window is not extended by the handoff. A
// device login's session never inherits. Someone without two-step
// verification sees no change.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { vi } from "vitest";

import { getDb } from "../db/index";
import { sessionFamilies } from "../db/schema";
import { createAgent } from "../services/agentService";
import { STEP_UP_ACTIONS } from "../services/secondFactor/stepUpGate";
import { revokeSessionFamilyInTransaction } from "../services/sessionService";
import { createApiTest } from "../test/integration/apiTest";
import { signInForTest } from "../test/integration/credentials";
import { enrollSecondFactor, useTotpSecretKey } from "../test/integration/secondFactor";

const test = createApiTest();
useTotpSecretKey();

const ENV = {
  APP_URL: "https://app.raft.test",
  SLOCK_DEVICE_LOGIN_ENABLED: undefined,
  AGENT_BOOTSTRAP_TOKEN_PEPPER: "app-login-second-factor-test-pepper-0123456789",
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
type Res = { status: number; body: Json };
type Seed = { human(values?: Json): Promise<any>; server(input: { owner: any }): Promise<{ id: string; slug: string }> };

const RETURN_URI = "raft://login/callback";
const MINUTE = 60_000;

async function post(baseUrl: string, path: string, body: unknown, token?: string): Promise<Res> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) as Json };
}

/**
 * A person signed in on the web (an unverified `full` sign-in), with an
 * external agent on a server of their own. `enforced`: two-step verification
 * then turned on; `verifiedAgoMs`: the sign-in passed it that long ago.
 */
async function person(seed: Seed, options: { enforced: boolean; verifiedAgoMs?: number }) {
  const human = await seed.human({ passwordCredentialEstablishedAt: new Date() });
  const server = await seed.server({ owner: human });
  const agent = await createAgent(server.id, `ext-${human.id.slice(0, 8)}`, { runtime: "external" });
  const session = await signInForTest(human.id);
  if (options.enforced) {
    await enrollSecondFactor(human.id);
  }
  if (options.verifiedAgoMs !== undefined) {
    await getDb().update(sessionFamilies)
      .set({ secondFactorVerifiedAt: new Date(Date.now() - options.verifiedAgoMs), secondFactorMethod: "totp" })
      .where(eq(sessionFamilies.id, session.familyId));
  }
  return { userId: human.id as string, agentId: agent.id, session };
}

async function familyOf(familyId: string) {
  const [family] = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.id, familyId));
  return family!;
}

function familyIdOf(accessToken: string): string {
  return (jwt.decode(accessToken) as { familyId: string }).familyId;
}

/** Start an app login and approve it with `token`: the approve answer, and what the exchange needs. */
async function startAndApprove(baseUrl: string, token: string) {
  const verifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
  const started = await post(baseUrl, "/api/auth/app-login/start", { returnUri: RETURN_URI, codeChallenge });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const approved = await post(baseUrl, `/api/auth/app-login/requests/${started.body.requestId}/approve`, {}, token);
  const code = approved.status === 200 ? new URL(approved.body.redirectUrl).searchParams.get("code") : null;
  return { approved, code, verifier };
}

async function exchange(baseUrl: string, code: string, verifier: string) {
  const res = await post(baseUrl, "/api/auth/app-login/complete", { code, codeVerifier: verifier });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { body: res.body, token: res.body.accessToken as string, familyId: familyIdOf(res.body.accessToken) };
}

/** The whole handoff, approved by `token`: the app's new session. */
async function appLogin(baseUrl: string, token: string) {
  const { approved, code, verifier } = await startAndApprove(baseUrl, token);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return exchange(baseUrl, code!, verifier);
}

/** Approve a device login (raft-computer, a user session) with `token`. */
async function approveDeviceLogin(baseUrl: string, token: string) {
  const login = await post(baseUrl, "/api/auth/device/authorize", { clientName: "raft-computer" });
  assert.equal(login.status, 201, JSON.stringify(login.body));
  const described = await post(baseUrl, "/api/auth/device/describe", { userCode: login.body.userCode }, token);
  assert.equal(described.status, 200, JSON.stringify(described.body));
  const approved = await post(baseUrl, "/api/auth/device/approve", {
    userCode: login.body.userCode, approvalTicket: described.body.approvalTicket,
  }, token);
  return { approved, deviceCode: login.body.deviceCode as string };
}

const mintAgentKey = (baseUrl: string, agentId: string, token: string) =>
  post(baseUrl, `/api/agents/${agentId}/credentials`, {}, token);

function assertStepUpRequired(res: Res) {
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.code, "second_factor_step_up_required");
}

test("a verified approver's app session is verified as of the approver's time and may approve without a step-up", async ({ app, seed }) => {
  const p = await person(seed, { enforced: true, verifiedAgoMs: MINUTE });
  const approver = await familyOf(p.session.familyId);
  const appSession = await appLogin(app.baseUrl, p.session.token);

  const family = await familyOf(appSession.familyId);
  assert.equal(family.scope, "full");
  assert.equal(family.secondFactorVerifiedAt?.getTime(), approver.secondFactorVerifiedAt!.getTime(), "the approver's time, not now");
  assert.equal(family.secondFactorMethod, "totp");

  // From the app session: approving another app login, and a device login.
  const nested = await startAndApprove(app.baseUrl, appSession.token);
  assert.equal(nested.approved.status, 200, JSON.stringify(nested.approved.body));
  const device = await approveDeviceLogin(app.baseUrl, appSession.token);
  assert.equal(device.approved.status, 200, JSON.stringify(device.approved.body));
  // A step-up-gated action, within the approver's window.
  assert.equal((await mintAgentKey(app.baseUrl, p.agentId, appSession.token)).status, 201);
});

test("an unverified approver's family passes nothing on: the app session must step up once two-step verification is on", async ({ app, seed }) => {
  // Never turned on: approving needs no verification, and there is none to inherit.
  const p = await person(seed, { enforced: false });
  const appSession = await appLogin(app.baseUrl, p.session.token);
  const family = await familyOf(appSession.familyId);
  assert.equal(family.secondFactorVerifiedAt, null);
  assert.equal(family.secondFactorMethod, null);

  await enrollSecondFactor(p.userId);
  assertStepUpRequired((await startAndApprove(app.baseUrl, appSession.token)).approved);
  assertStepUpRequired((await approveDeviceLogin(app.baseUrl, appSession.token)).approved);
  assertStepUpRequired(await mintAgentKey(app.baseUrl, p.agentId, appSession.token));
});

test("an approver family revoked between approval and exchange passes nothing on: its code is refused, no session at all", async ({ app, seed }) => {
  const p = await person(seed, { enforced: true, verifiedAgoMs: MINUTE });
  const { approved, code, verifier } = await startAndApprove(app.baseUrl, p.session.token);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  await getDb().transaction((tx) => revokeSessionFamilyInTransaction(tx, p.userId, p.session.familyId, "logout"));
  const families = () => getDb().select({ id: sessionFamilies.id }).from(sessionFamilies).where(eq(sessionFamilies.userId, p.userId));
  const before = await families();

  const refused = await post(app.baseUrl, "/api/auth/app-login/complete", { code, codeVerifier: verifier });
  assert.deepEqual(refused, { status: 410, body: { error: "App login code could not be exchanged", code: "code_expired" } });
  assert.deepEqual(await families(), before, "no session was issued");
});

test("the step-up window runs from the approver's verification: the handoff does not extend it", async ({ app, seed }) => {
  // Verified 9 minutes before the exchange: a gated action works at exchange...
  const p = await person(seed, { enforced: true, verifiedAgoMs: 9 * MINUTE });
  const appSession = await appLogin(app.baseUrl, p.session.token);
  const minted = await mintAgentKey(app.baseUrl, p.agentId, appSession.token);
  assert.equal(minted.status, 201, JSON.stringify(minted.body));

  // ...but 2 minutes later (approver's time + 11 minutes) it needs a step-up again.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * MINUTE });
  try {
    const stale = await mintAgentKey(app.baseUrl, p.agentId, appSession.token);
    assertStepUpRequired(stale);
    assert.equal(stale.body.error, STEP_UP_ACTIONS.agent_credential_mint);
  } finally {
    vi.useRealTimers();
  }
  // Approving needs a verified sign-in, not a recent one: still allowed.
  assert.equal((await startAndApprove(app.baseUrl, appSession.token)).approved.status, 200);
});

test("a device login's session never inherits the approver's verification", async ({ app, seed }) => {
  const p = await person(seed, { enforced: true, verifiedAgoMs: MINUTE });
  const { approved, deviceCode } = await approveDeviceLogin(app.baseUrl, p.session.token);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const polled = await post(app.baseUrl, "/api/auth/device/token", { deviceCode });
  assert.equal(polled.status, 200, JSON.stringify(polled.body));
  const family = await familyOf(familyIdOf(polled.body.accessToken));
  assert.equal(family.scope, "device");
  assert.equal(family.secondFactorVerifiedAt, null);
  assert.equal(family.secondFactorMethod, null);
});

test("without two-step verification: the same handoff, answer and session as before", async ({ app, seed }) => {
  const plain = await person(seed, { enforced: false });
  const flagOnly = await person(seed, { enforced: false });
  const verified = await person(seed, { enforced: true, verifiedAgoMs: MINUTE });
  const verifiedAnswer = await appLogin(app.baseUrl, verified.session.token);
  for (const p of [plain, flagOnly]) {
    const appSession = await appLogin(app.baseUrl, p.session.token);
    assert.deepEqual(Object.keys(appSession.body).sort(), ["accessToken", "refreshToken", "user"]);
    assert.deepEqual(Object.keys(appSession.body).sort(), Object.keys(verifiedAnswer.body).sort());
    assert.equal((await familyOf(appSession.familyId)).secondFactorVerifiedAt, null);
    assert.equal((await startAndApprove(app.baseUrl, appSession.token)).approved.status, 200);
    assert.equal((await approveDeviceLogin(app.baseUrl, appSession.token)).approved.status, 200);
    assert.equal((await mintAgentKey(app.baseUrl, p.agentId, appSession.token)).status, 201);
  }
});
