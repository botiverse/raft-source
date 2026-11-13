import { createApiTest } from "../test/integration/apiTest";
import jwt from "jsonwebtoken";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import net from "node:net";

import argon2 from "argon2";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { getDb } from "../db/index";
import { agentCredentials, agents, computers, machines, deviceAuthorizationRevokeTokens, deviceAuthorizations, integrationAuditEvents, sessionFamilies, sessions, users } from "../db/schema";
import { findComputerByApiKeyWithReason } from "../services/computerCredentialService";
import { DeviceSessionRevokedError, lockLiveSessionFamily } from "../services/sessionService";
import { proofForDeviceLogin } from "../services/sessionIssueGate";
import {
  consumeDeviceAuthorization,
  isDeviceAuthSurfaceEnabled,
  normalizeUserCode,
  recordDeviceLoginSession,
  revokeDeviceLoginByLink,
  revokeDeviceLoginSession,
  sanitizeClientName,
  scrubDeviceAuthorizationRequesterDetails,
} from "../services/deviceAuthService";
import * as deviceAuthService from "../services/deviceAuthService";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "../services/emailService";
import { computeTokenLookupHash } from "../services/agentCredentialService";
import { vi } from "vitest";
import * as sessionService from "../services/sessionService";
import { openTestApp } from "../test/integration/app";
import { accessTokenForTest, signInForTest } from "../test/integration/credentials";
import { isDeviceSessionRoute, signAccessToken, verifyActiveAccessToken, verifyActiveAccessTokenWithAccount } from "../middleware/auth";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { registerMachine } from "../services/machineService";
import { revokeKeysOfRevokedDeviceSessions } from "../services/deviceSessionKeys";
import { requestPasswordReset, retireStagingSelfAccount } from "../services/userService";
import { ensureFamilyRevokeCapability, revokePushFamilyByCapability } from "../services/pushService";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// task #30 PR-A2 regression guard — device-code login grant
// (RFC v0.8 contract v3 §3/§5/§9). Pins: env gate, the three principal
// phases (authorize public / approve user-auth / token public poll),
// single-consume, denied, expired, and zero existence enumeration.
//
// Pepper note: the harness defaults JWT_SECRET to a <32-char value, but
// computeTokenLookupHash → getBootstrapTokenPepper requires >= 32 chars.
// Set AGENT_BOOTSTRAP_TOKEN_PEPPER explicitly (same shared pepper the
// bootstrap-token model uses — no parallel auth path).
const PEPPER = "device-code-test-pepper-0123456789abcdef"; // 40 chars

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

// Default-on gate semantics: unset / "" / any non-false value enables the
// surface; only explicit "false"/"0"/"no"/"off" disables. Tests passing
// `enabled=false` get an explicit "false" to exercise the kill switch path;
// `enabled=true` deletes the env (default-on); `gate: "<raw>"` overrides for
// the explicit kill-switch matrix.
async function withEnv<T>(
  enabled: boolean | { gate: string | undefined },
  fn: (app: Awaited<ReturnType<typeof openTestApp>>) => Promise<T>,
): Promise<T> {
  const oldGate = process.env.SLOCK_DEVICE_LOGIN_ENABLED;
  const oldPepper = process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
  const oldAppUrl = process.env.APP_URL;
  if (typeof enabled === "object") {
    if (enabled.gate === undefined) delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
    else process.env.SLOCK_DEVICE_LOGIN_ENABLED = enabled.gate;
  } else if (enabled) {
    delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
  } else {
    process.env.SLOCK_DEVICE_LOGIN_ENABLED = "false";
  }
  process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = PEPPER;
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    return await fn(app);
  } finally {
    await app.close();
    if (oldGate === undefined) delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
    else process.env.SLOCK_DEVICE_LOGIN_ENABLED = oldGate;
    if (oldPepper === undefined) delete process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
    else process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = oldPepper;
    if (oldAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = oldAppUrl;
  }
}

async function seedUser(): Promise<{ id: string; bearer: string }> {
  const db = getDb();
  const suffix = randomUUID();
  const [u] = await db
    .insert(users)
    .values({
      email: `device-${suffix}@slock.test`,
      name: `device-${suffix}`,
      displayName: "Device Tester",
      passwordHash: await argon2.hash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    })
    .returning();
  return { id: u.id, bearer: await accessTokenForTest(u.id) };
}

/** An access token with no session family, as signed before families: refused everywhere now. */
function familylessAccessToken(userId: string): string {
  return jwt.sign({ sub: userId, type: "access" }, process.env.JWT_SECRET!, { expiresIn: "15m" });
}

test("device-code surface is NOT mounted when gate explicitly disabled", async () => {
  await withEnv(false, async (app) => {
    const res = await fetch(`${app.baseUrl}/api/auth/device/authorize`, {
      method: "POST",
      headers: jsonHeaders(),
      body: "{}",
    });
    assert.equal(res.status, 404);
  });
});

// v8.1 default-on (staging unblocker for PR-G). Unset / empty / any
// non-false value enables; explicit false / 0 / no / off disables.
test("device-code surface IS mounted when gate unset (default-on)", async () => {
  await withEnv({ gate: undefined }, async (app) => {
    const res = await fetch(`${app.baseUrl}/api/auth/device/authorize`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ clientName: "test" }),
    });
    // 201 created, NOT 404. We only care that the surface is mounted —
    // the lifecycle test below covers the happy-path body shape.
    assert.equal(res.status, 201);
  });
});

// The HTTP cases above cover the endpoint being disabled and default-on. The
// spelling matrix belongs to its parser; no database or HTTP server is needed.
for (const killValue of ["false", "0", "no", "off", "FALSE", "False"]) {
  test(`device-code gate rejects SLOCK_DEVICE_LOGIN_ENABLED="${killValue}"`, () => {
    assert.equal(isDeviceAuthSurfaceEnabled({ SLOCK_DEVICE_LOGIN_ENABLED: killValue }), false);
  });
}

for (const liveValue of ["", "true", "1", "yes", "on"]) {
  test(`device-code gate accepts SLOCK_DEVICE_LOGIN_ENABLED="${liveValue}"`, () => {
    assert.equal(isDeviceAuthSurfaceEnabled({ SLOCK_DEVICE_LOGIN_ENABLED: liveValue }), true);
  });
}

test("device-code full lifecycle: authorize → pending → approve → token → consumed", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();

    // authorize (public)
    const auth = await fetch(`${app.baseUrl}/api/auth/device/authorize`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ clientName: "raft-computer" }),
    });
    assert.equal(auth.status, 201);
    const grant = (await auth.json()) as {
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      expiresIn: number;
      interval: number;
    };
    assert.ok(grant.deviceCode && grant.userCode);
    assert.equal(grant.verificationUri, "http://127.0.0.1:4173/login/device");
    // No link carries the code: the person types the code their terminal shows.
    assert.equal("verificationUriComplete" in grant, false);
    assert.equal(JSON.stringify(grant).includes("user_code="), false);

    // token before approve → authorization_pending (public)
    const pending = await fetch(`${app.baseUrl}/api/auth/device/token`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ deviceCode: grant.deviceCode }),
    });
    assert.equal(pending.status, 400);
    assert.equal((await pending.json() as { code?: string }).code, "authorization_pending");

    // approve REQUIRES auth — unauthenticated rejected
    const noAuth = await fetch(`${app.baseUrl}/api/auth/device/approve`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ userCode: grant.userCode }),
    });
    assert.equal(noAuth.status, 401);

    // approve without describe's ticket: what an approval page from before
    // this check sends (code straight from its link). Refused, told to reload.
    const unchecked = await fetch(`${app.baseUrl}/api/auth/device/approve`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ userCode: grant.userCode, approve: true }),
    });
    assert.equal(unchecked.status, 400);
    assert.deepEqual(await unchecked.json(), { error: "Reload this page and type the code again.", code: "approval_ticket_required" });

    // approve (user-authenticated) with the ticket describe gave this person
    const described = await fetch(`${app.baseUrl}/api/auth/device/describe`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ userCode: grant.userCode }),
    });
    const { approvalTicket } = (await described.json()) as { approvalTicket: string };
    const approve = await fetch(`${app.baseUrl}/api/auth/device/approve`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ userCode: grant.userCode, approvalTicket }),
    });
    assert.equal(approve.status, 200);

    // token → issues a real user session for the approving user
    const tok = await fetch(`${app.baseUrl}/api/auth/device/token`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ deviceCode: grant.deviceCode }),
    });
    assert.equal(tok.status, 200);
    const session = (await tok.json()) as {
      accessToken: string;
      refreshToken: string;
      userId: string;
    };
    assert.ok(session.accessToken && session.refreshToken);
    assert.equal(session.userId, userId);
    // Viewer headers untrusted: the poller's address is not kept (never the edge's req.ip).
    const [consumedRow] = await getDb()
      .select({ consumedIp: deviceAuthorizations.consumedIp })
      .from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.userCode, grant.userCode));
    assert.equal(consumedRow?.consumedIp, null);

    // single-consume: second poll fails
    const again = await fetch(`${app.baseUrl}/api/auth/device/token`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ deviceCode: grant.deviceCode }),
    });
    assert.equal(again.status, 410);
    assert.equal((await again.json() as { code?: string }).code, "device_code_consumed");
  });
});

test("device-code authorize fails closed when APP_URL is unavailable", async () => {
  await withEnv(true, async (app) => {
    process.env.APP_URL = "";
    const res = await fetch(`${app.baseUrl}/api/auth/device/authorize`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ clientName: "raft-computer" }),
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json() as { code?: string }).code, "DEVICE_LOGIN_URL_UNAVAILABLE");
    // No grant is left behind for a URL nobody can open.
    assert.equal((await getDb().select({ id: deviceAuthorizations.id }).from(deviceAuthorizations)).length, 0);
  });
});

test("device-code denied → token returns access_denied", async () => {
  await withEnv(true, async (app) => {
    const { bearer } = await seedUser();
    const auth = await fetch(`${app.baseUrl}/api/auth/device/authorize`, {
      method: "POST", headers: jsonHeaders(), body: "{}",
    });
    const grant = (await auth.json()) as { deviceCode: string; userCode: string };

    const deny = await fetch(`${app.baseUrl}/api/auth/device/approve`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ userCode: grant.userCode, approve: false }),
    });
    assert.equal(deny.status, 200);

    const tok = await fetch(`${app.baseUrl}/api/auth/device/token`, {
      method: "POST", headers: jsonHeaders(),
      body: JSON.stringify({ deviceCode: grant.deviceCode }),
    });
    assert.equal(tok.status, 403);
    assert.equal((await tok.json() as { code?: string }).code, "access_denied");
  });
});

test("device-code zero-enumeration: unknown device_code / user_code are uniform invalid", async () => {
  await withEnv(true, async (app) => {
    const { bearer } = await seedUser();

    // unknown device_code on token → device_code_invalid (same as a real
    // miss; no signal whether any grant exists)
    const tok = await fetch(`${app.baseUrl}/api/auth/device/token`, {
      method: "POST", headers: jsonHeaders(),
      body: JSON.stringify({ deviceCode: "dvc_does-not-exist" }),
    });
    assert.equal(tok.status, 400);
    assert.equal((await tok.json() as { code?: string }).code, "device_code_invalid");

    // unknown user_code on approve → user_code_invalid (no existence leak)
    const ap = await fetch(`${app.baseUrl}/api/auth/device/approve`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ userCode: "ZZZZ-ZZZZ" }),
    });
    assert.equal(ap.status, 404);
    assert.equal((await ap.json() as { code?: string }).code, "user_code_invalid");
  });
});

async function startLogin(app: { baseUrl: string }, headers: Record<string, string> = {}, body: unknown = { clientName: "raft-computer" }) {
  const res = await fetch(`${app.baseUrl}/api/auth/device/authorize`, {
    method: "POST",
    headers: jsonHeaders(headers),
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { deviceCode: string; userCode: string };
}

async function describe(app: { baseUrl: string }, bearer: string | null, userCode: string) {
  const res = await fetch(`${app.baseUrl}/api/auth/device/describe`, {
    method: "POST",
    headers: jsonHeaders(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    body: JSON.stringify({ userCode }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function withTrustedViewerHeaders<T>(trusted: boolean, fn: () => Promise<T>): Promise<T> {
  const old = process.env.TRUST_CLOUDFRONT_VIEWER_HEADERS;
  if (trusted) process.env.TRUST_CLOUDFRONT_VIEWER_HEADERS = "true";
  else delete process.env.TRUST_CLOUDFRONT_VIEWER_HEADERS;
  try {
    return await fn();
  } finally {
    if (old === undefined) delete process.env.TRUST_CLOUDFRONT_VIEWER_HEADERS;
    else process.env.TRUST_CLOUDFRONT_VIEWER_HEADERS = old;
  }
}

const VIEWER_HEADERS = {
  "CloudFront-Viewer-Address": "203.0.113.7:51234",
  "CloudFront-Viewer-City": "S%C3%A3o%20Paulo",
  "CloudFront-Viewer-Country-Region-Name": "Sao Paulo",
  "CloudFront-Viewer-Country": "BR",
};

test("device-code describe: what the approval page shows before approving, signed in only", async () => {
  await withEnv(true, async (app) => {
    const { bearer } = await seedUser();
    const grant = await withTrustedViewerHeaders(false, () => startLogin(app, VIEWER_HEADERS, { clientName: "Raft official security check" }));

    assert.equal((await describe(app, null, grant.userCode)).status, 401);

    // Typed loosely: case, spaces and the dash don't matter.
    const loose = `${grant.userCode.slice(0, 4)} ${grant.userCode.slice(5)}`.toLowerCase();
    const described = await describe(app, bearer, loose);
    assert.equal(described.status, 200);
    assert.equal(described.body.userCode, grant.userCode);
    // The client name is passed through as given; the page says anyone can set it.
    assert.equal(described.body.clientName, "Raft official security check");
    assert.ok(Date.parse(described.body.requestedAt as string) <= Date.now());
    assert.equal(typeof described.body.approvalTicket, "string");
    assert.equal("expiresAt" in described.body, false);
    // Viewer headers not trusted (production today): forged headers are ignored,
    // and the edge's req.ip is never offered as the person's address.
    assert.deepEqual(described.body.requester, { ip: null, location: null });

    // Describing doesn't approve: the client is still waiting.
    const pending = await fetch(`${app.baseUrl}/api/auth/device/token`, {
      method: "POST", headers: jsonHeaders(), body: JSON.stringify({ deviceCode: grant.deviceCode }),
    });
    assert.equal((await pending.json() as { code?: string }).code, "authorization_pending");

    assert.deepEqual(await describe(app, bearer, "ZZZZ-ZZZZ"), { status: 404, body: { error: "Device authorization can't be approved", code: "user_code_invalid" } });

    // A ticket is this person's: another account's page can't use it.
    const other = await seedUser();
    const stolen = await fetch(`${app.baseUrl}/api/auth/device/approve`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${other.bearer}` }),
      body: JSON.stringify({ userCode: grant.userCode, approvalTicket: described.body.approvalTicket }),
    });
    assert.equal(stolen.status, 400);
    assert.equal((await stolen.json() as { code?: string }).code, "approval_ticket_required");

    const approve = await fetch(`${app.baseUrl}/api/auth/device/approve`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ userCode: grant.userCode, approvalTicket: described.body.approvalTicket }),
    });
    assert.equal(approve.status, 200);
    const resolved = await describe(app, bearer, grant.userCode);
    assert.equal(resolved.status, 409);
    assert.equal(resolved.body.code, "already_resolved");
  });
});

test("device-code describe: the visitor's IP and location when the viewer headers are trusted", async () => {
  await withEnv(true, async (app) => {
    const { bearer } = await seedUser();
    const grant = await withTrustedViewerHeaders(true, () => startLogin(app, VIEWER_HEADERS));
    const described = await describe(app, bearer, grant.userCode);
    assert.equal(described.status, 200);
    assert.deepEqual(described.body.requester, { ip: "203.0.113.7", location: "São Paulo, Sao Paulo, BR" });

  });
});

test("device-code requester details are cleared 30 days after the login started", async () => {
  await withEnv(true, async (app) => {
    const old = await withTrustedViewerHeaders(true, () => startLogin(app, VIEWER_HEADERS));
    const recent = await withTrustedViewerHeaders(true, () => startLogin(app, VIEWER_HEADERS));
    const db = getDb();
    await db
      .update(deviceAuthorizations)
      .set({ createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000), consumedIp: "198.51.100.1", consumedUserAgent: "raft-computer/1.0.56" })
      .where(eq(deviceAuthorizations.userCode, old.userCode));

    assert.equal(await scrubDeviceAuthorizationRequesterDetails(), 1);
    // Nothing left to clear: a second pass is a no-op.
    assert.equal(await scrubDeviceAuthorizationRequesterDetails(), 0);

    const rows = await db
      .select({
        userCode: deviceAuthorizations.userCode,
        ip: deviceAuthorizations.requestedIp,
        location: deviceAuthorizations.requestedLocation,
        consumedIp: deviceAuthorizations.consumedIp,
        consumedUserAgent: deviceAuthorizations.consumedUserAgent,
      })
      .from(deviceAuthorizations);
    const byCode = new Map(rows.map((row) => [row.userCode, row]));
    assert.deepEqual(byCode.get(old.userCode), { userCode: old.userCode, ip: null, location: null, consumedIp: null, consumedUserAgent: null });
    assert.equal(byCode.get(recent.userCode)?.ip, "203.0.113.7");

    // Bounded batches: three old rows in batches of one, then a stop at maxBatches.
    for (let i = 0; i < 3; i += 1) await withTrustedViewerHeaders(true, () => startLogin(app, VIEWER_HEADERS));
    await db
      .update(deviceAuthorizations)
      .set({ createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
      .where(isNotNull(deviceAuthorizations.requestedIp));
    assert.equal(await scrubDeviceAuthorizationRequesterDetails({ batchSize: 1, maxBatches: 2 }), 2);
    assert.equal(await scrubDeviceAuthorizationRequesterDetails({ batchSize: 1 }), 2);
    assert.equal(await scrubDeviceAuthorizationRequesterDetails({ batchSize: 1 }), 0);
  });
});

test("a login without a grant keeps the User-Agent it asked with, capped, and clears it after 30 days", async () => {
  await withEnv(true, async (app) => {
    const requestedUserAgent = async (userCode: string) => {
      const [row] = await getDb()
        .select({ userAgent: deviceAuthorizations.requestedUserAgent, clientName: deviceAuthorizations.clientName })
        .from(deviceAuthorizations)
        .where(eq(deviceAuthorizations.userCode, userCode));
      return row!;
    };
    const login = await startLogin(app, { "User-Agent": "raft-computer/1.0.56 (darwin)" });
    assert.deepEqual(await requestedUserAgent(login.userCode), { userAgent: "raft-computer/1.0.56 (darwin)", clientName: "raft-computer" });

    const long = await startLogin(app, { "User-Agent": `raft-computer/${"x".repeat(1000)}` });
    const capped = (await requestedUserAgent(long.userCode)).userAgent;
    assert.equal(capped?.length, 512);
    assert.ok(capped?.startsWith("raft-computer/x"));

    await getDb()
      .update(deviceAuthorizations)
      .set({ createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
      .where(eq(deviceAuthorizations.userCode, login.userCode));
    assert.equal(await scrubDeviceAuthorizationRequesterDetails(), 1);
    assert.equal((await requestedUserAgent(login.userCode)).userAgent, null);
    assert.equal((await requestedUserAgent(long.userCode)).userAgent?.length, 512);
  });
});

test("a typed code is read the way people type it", () => {
  assert.equal(normalizeUserCode("abcd-efgh"), "ABCD-EFGH");
  assert.equal(normalizeUserCode("ABCDEFGH"), "ABCD-EFGH");
  assert.equal(normalizeUserCode(" ab cd  ef gh "), "ABCD-EFGH");
  // Look-alikes the alphabet leaves out read as the digit.
  assert.equal(normalizeUserCode("O0IL-1234"), "0011-1234");
  assert.equal(normalizeUserCode("ABCD-EFG"), null);
  assert.equal(normalizeUserCode("ABCD-EFGHJ"), null);
  assert.equal(normalizeUserCode("A".repeat(40)), null);
  assert.equal(normalizeUserCode(42), null);
});

test("a client name is kept as the page may show it", () => {
  // Bidirectional overrides and controls dropped, whitespace collapsed.
  assert.equal(sanitizeClientName("\u202Eevil\u0007  name\u2066 \n x"), "evil name x");
  assert.equal(sanitizeClientName("\u200F\u0000 "), null);
  assert.equal(sanitizeClientName(null), null);
  assert.equal(sanitizeClientName("x".repeat(200))?.length, 64);
});

async function approveCode(app: { baseUrl: string }, bearer: string, userCode: string, approve = true) {
  // As the approval page does: describe first, for the ticket approving needs.
  const described = await describe(app, bearer, userCode);
  assert.equal(described.status, 200);
  const res = await fetch(`${app.baseUrl}/api/auth/device/approve`, {
    method: "POST",
    headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
    body: JSON.stringify({ userCode, approve, approvalTicket: described.body.approvalTicket }),
  });
  assert.equal(res.status, 200);
}

async function pollToken(app: { baseUrl: string }, deviceCode: string) {
  const res = await fetch(`${app.baseUrl}/api/auth/device/token`, {
    method: "POST", headers: jsonHeaders(), body: JSON.stringify({ deviceCode }),
  });
  return { status: res.status, body: (await res.json()) as { code?: string; accessToken?: string; refreshToken?: string } };
}

async function revoke(app: { baseUrl: string }, token: unknown) {
  const res = await fetch(`${app.baseUrl}/api/auth/device/revoke`, {
    method: "POST", headers: jsonHeaders(), body: JSON.stringify({ token }),
  });
  return { status: res.status, body: (await res.json()) as { code?: string; revoked?: string } };
}

async function withMailbox<T>(fn: (mailbox: EmailDelivery[]) => Promise<T>): Promise<T> {
  const mailbox: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => mailbox.push(delivery));
  try {
    return await fn(mailbox);
  } finally {
    __setEmailDeliveryObserverForTests(null);
  }
}

function revokeTokenFrom(delivery: EmailDelivery): string {
  const match = delivery.html.match(/revoke_device_login=(dvr_[A-Za-z0-9_-]+)/);
  assert.ok(match, "the email carries a revoke link");
  return match[1]!;
}

test("approving a device login mails the person what was approved and a revoke link; denying mails nothing", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const { id: userId, bearer } = await seedUser();
      const grant = await startLogin(app, {}, { clientName: "<b>Raft official</b>" });
      await approveCode(app, bearer, grant.userCode);

      assert.equal(mailbox.length, 1);
      const [email] = mailbox;
      const [user] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, userId));
      assert.equal(email!.to, user!.email);
      assert.equal(email!.subject, "New device login to your Raft account");
      // Requester-controlled text is escaped; the self-reported note and the unknown origin are said.
      // The requester-chosen name stays out of a mail from Raft (clients auto-link domain-like text).
      assert.ok(!email!.html.includes("Raft official"));
      assert.ok(email!.html.includes("Can&#39;t be determined") || email!.html.includes("Can't be determined"));
      // Revoking signs the session out; the email says what else to do.
      assert.ok(email!.html.includes("Then change or reset your password"));
      assert.ok(email!.html.includes("http://127.0.0.1:4173?revoke_device_login=dvr_"));
      revokeTokenFrom(email!);

      const denied = await startLogin(app);
      await approveCode(app, bearer, denied.userCode, false);
      assert.equal(mailbox.length, 1);
    });
  });
});

test("approve records the approving web session's family on the device login; a token with no family can't approve; a denial records none", async () => {
  await withEnv(true, async (app) => {
    const { id: userId } = await seedUser();
    const { familyId, token: webBearer } = await signInForTest(userId);
    const approverFamilyOf = async (userCode: string) => (await getDb()
      .select({ family: deviceAuthorizations.approverFamilyId })
      .from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.userCode, userCode)))[0]!.family;

    const withFamily = await startLogin(app);
    await approveCode(app, webBearer, withFamily.userCode);
    assert.equal(await approverFamilyOf(withFamily.userCode), familyId);

    // A token with no family is refused before it can describe or approve anything.
    const withoutFamily = await startLogin(app);
    const legacyBearer = familylessAccessToken(userId);
    assert.equal((await describe(app, legacyBearer, withoutFamily.userCode)).status, 401);
    const legacyApprove = await fetch(`${app.baseUrl}/api/auth/device/approve`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${legacyBearer}` }),
      body: JSON.stringify({ userCode: withoutFamily.userCode, approve: true }),
    });
    assert.equal(legacyApprove.status, 401);
    assert.equal(await approverFamilyOf(withoutFamily.userCode), null);

    const denied = await startLogin(app);
    await approveCode(app, webBearer, denied.userCode, false);
    assert.equal(await approverFamilyOf(denied.userCode), null);
  });
});

/** The person's device-scoped session families: what a poll issued. */
async function deviceFamiliesOf(userId: string) {
  return getDb().select({ id: sessionFamilies.id }).from(sessionFamilies)
    .where(and(eq(sessionFamilies.userId, userId), eq(sessionFamilies.scope, "device")));
}

async function deviceCodeRow(userCode: string) {
  const [row] = await getDb()
    .select({ status: deviceAuthorizations.status, denied: isNotNull(deviceAuthorizations.deniedAt), consumedAt: deviceAuthorizations.consumedAt })
    .from(deviceAuthorizations)
    .where(eq(deviceAuthorizations.userCode, userCode));
  return row!;
}

/** A code `bearer` approved, not yet polled. */
async function approvedCode(app: { baseUrl: string }, bearer: string) {
  const login = await startLogin(app);
  await approveCode(app, bearer, login.userCode);
  return login;
}

/** What the poll answers for a code the person denied: a dead sign-in's code must answer the same. */
async function deniedAnswer(app: { baseUrl: string }, bearer: string) {
  const login = await startLogin(app);
  await approveCode(app, bearer, login.userCode, false);
  const answer = await pollToken(app, login.deviceCode);
  assert.deepEqual(answer, { status: 403, body: { error: "Device authorization not ready", code: "access_denied" } as never });
  return answer;
}

test("a device code dies with the sign-in that approved it: polled after its logout or a password reset, refused as a denied code and nothing issued; a live sign-in's code still works", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const { id: userId, bearer } = await seedUser();
      const denied = await deniedAnswer(app, bearer);

      // Approved, then that sign-in signs out.
      const signedOut = await signInForTest(userId);
      const afterLogout = await approvedCode(app, signedOut.token);
      const logout = await fetch(`${app.baseUrl}/api/auth/logout`, {
        method: "POST", headers: jsonHeaders(), body: JSON.stringify({ refreshToken: signedOut.refreshToken }),
      });
      assert.equal(logout.status, 200);
      assert.deepEqual(await pollToken(app, afterLogout.deviceCode), denied);
      assert.deepEqual(await deviceFamiliesOf(userId), []);

      // Approved, then the password is reset: every sign-in goes.
      const beforeReset = await signInForTest(userId);
      const afterReset = await approvedCode(app, beforeReset.token);
      const [user] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, userId));
      await requestPasswordReset(user!.email);
      const resetToken = mailbox.at(-1)!.html.match(/\?reset=([0-9a-f]{64})/)?.[1];
      assert.ok(resetToken, "the reset email carries its token");
      const reset = await fetch(`${app.baseUrl}/api/auth/reset-password`, {
        method: "POST", headers: jsonHeaders(), body: JSON.stringify({ token: resetToken, password: "a-new-password-456" }),
      });
      assert.equal(reset.status, 200);
      assert.deepEqual(await pollToken(app, afterReset.deviceCode), denied);
      assert.deepEqual(await deviceFamiliesOf(userId), [], "no device session issued");

      // A sign-in still live: its code gets the device session, as before.
      const live = await signInForTest(userId);
      const liveCode = await approvedCode(app, live.token);
      const polled = await pollToken(app, liveCode.deviceCode);
      assert.equal(polled.status, 200);
      assert.equal((await verifyActiveAccessTokenWithAccount(polled.body.accessToken!, { deviceSession: "allow" }))?.scope, "device");
      assert.equal((await deviceFamiliesOf(userId)).length, 1);
    });
  });
});

test("a revoke of the approving sign-in denies the device codes it approved that nobody polled; another sign-in's, an expired and a polled one stay as they are", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async () => {
      const { id: userId } = await seedUser();
      const first = await signInForTest(userId);
      const second = await signInForTest(userId);
      const unpolled = await approvedCode(app, first.token);
      const polled = await approvedCode(app, first.token);
      assert.equal((await pollToken(app, polled.deviceCode)).status, 200);
      const expired = await approvedCode(app, first.token);
      await getDb().update(deviceAuthorizations).set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(deviceAuthorizations.userCode, expired.userCode));
      const other = await approvedCode(app, second.token);

      await sessionService.revokeSession(first.refreshToken);
      assert.deepEqual(await deviceCodeRow(unpolled.userCode), { status: "denied", denied: true, consumedAt: null });
      assert.equal((await deviceCodeRow(polled.userCode)).status, "consumed");
      assert.deepEqual(await deviceCodeRow(expired.userCode), { status: "approved", denied: false, consumedAt: null });
      assert.deepEqual(await deviceCodeRow(other.userCode), { status: "approved", denied: false, consumedAt: null });

      // Every sign-in at once (a password change or reset, an account deletion): the other's code too.
      await sessionService.revokeAllUserSessions(userId);
      assert.deepEqual(await deviceCodeRow(other.userCode), { status: "denied", denied: true, consumedAt: null });
    });
  });
});

test("the poll refuses a code whose approving sign-in is no longer live even when no revoke denied it, and a code that names no sign-in", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async () => {
      const { id: userId, bearer } = await seedUser();
      const denied = await deniedAnswer(app, bearer);

      // The family revoked behind the revokers' back: only the poll's check can see it.
      const web = await signInForTest(userId);
      const code = await approvedCode(app, web.token);
      await getDb().update(sessionFamilies).set({ revokedAt: new Date(), revokedReason: "logout" })
        .where(eq(sessionFamilies.id, web.familyId));
      assert.deepEqual(await pollToken(app, code.deviceCode), denied);
      assert.deepEqual(await deviceCodeRow(code.userCode), { status: "approved", denied: false, consumedAt: null });

      // Approved before device_authorizations.approver_family_id was recorded.
      const old = await approvedCode(app, bearer);
      await getDb().update(deviceAuthorizations).set({ approverFamilyId: null })
        .where(eq(deviceAuthorizations.userCode, old.userCode));
      assert.deepEqual(await pollToken(app, old.deviceCode), denied);
      assert.deepEqual(await deviceCodeRow(old.userCode), { status: "approved", denied: false, consumedAt: null });
      assert.deepEqual(await deviceFamiliesOf(userId), [], "no device session issued");
    });
  });
});

test("a revoke link used before the client polls cancels the login: the poll gets access_denied", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const { bearer } = await seedUser();
      const grant = await startLogin(app);
      await approveCode(app, bearer, grant.userCode);

      assert.deepEqual(await revoke(app, revokeTokenFrom(mailbox[0]!)), { status: 200, body: { ok: true, revoked: "grant" } as never });
      const polled = await pollToken(app, grant.deviceCode);
      assert.equal(polled.status, 403);
      assert.equal(polled.body.code, "access_denied");
    });
  });
});

test("a revoke link used after the client got its session signs that session out, refreshes included", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const { bearer } = await seedUser();
      const grant = await startLogin(app);
      await approveCode(app, bearer, grant.userCode);
      const session = await pollToken(app, grant.deviceCode);
      assert.equal(session.status, 200);

      // Rotate once: the link signs out the family, not just the first token.
      const refreshed = await fetch(`${app.baseUrl}/api/auth/refresh`, {
        method: "POST", headers: jsonHeaders(), body: JSON.stringify({ refreshToken: session.body.refreshToken }),
      });
      assert.equal(refreshed.status, 200);
      const rotated = (await refreshed.json()) as { accessToken: string; refreshToken: string };
      const me = await fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${rotated.accessToken}` } });
      assert.equal(me.status, 200);

      const token = revokeTokenFrom(mailbox[0]!);
      assert.deepEqual(await revoke(app, token), { status: 200, body: { ok: true, revoked: "session" } as never });

      const after = await fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${rotated.accessToken}` } });
      assert.equal(after.status, 401);
      const refreshAfter = await fetch(`${app.baseUrl}/api/auth/refresh`, {
        method: "POST", headers: jsonHeaders(), body: JSON.stringify({ refreshToken: rotated.refreshToken }),
      });
      assert.equal(refreshAfter.status, 401);
      // The person's own web session is untouched.
      const own = await fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${bearer}` } });
      assert.equal(own.status, 200);

      // Used once: a second use says so.
      assert.deepEqual(await revoke(app, token), { status: 409, body: { error: "This revoke link can't be used", code: "revoke_link_used" } as never });
    });
  });
});

test("a revoke link is refused when unknown, malformed or older than 24 hours", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const { bearer } = await seedUser();
      const grant = await startLogin(app);
      await approveCode(app, bearer, grant.userCode);
      const token = revokeTokenFrom(mailbox[0]!);

      assert.equal((await revoke(app, "dvr_unknown")).body.code, "revoke_link_invalid");
      assert.equal((await revoke(app, "not-a-token")).status, 404);
      assert.equal((await revoke(app, 42)).status, 404);

      await getDb()
        .update(deviceAuthorizationRevokeTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(deviceAuthorizationRevokeTokens.tokenLookupHash, computeTokenLookupHash(token)));
      assert.deepEqual(await revoke(app, token), { status: 410, body: { error: "This revoke link can't be used", code: "revoke_link_expired" } as never });
      // An expired link revoked nothing: the client still gets its session.
      assert.equal((await pollToken(app, grant.deviceCode)).status, 200);
    });
  });
});

test("a revoke link that lands between the consume and the session's record still signs the session out", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const { id: userId, bearer } = await seedUser();
      const grant = await startLogin(app);
      await approveCode(app, bearer, grant.userCode);
      // The token phase's steps one by one, with the link used in between.
      const consumed = await consumeDeviceAuthorization(grant.deviceCode);
      assert.ok(consumed.ok && consumed.session);
      // Exchanged, session not recorded yet: the link can't name it, so it says so
      // (the page then also sends the person to change their password).
      assert.deepEqual(await revokeDeviceLoginByLink(revokeTokenFrom(mailbox[0]!)), { ok: true, revoked: "session_unknown" });
      const { sessionId, familyId } = consumed.session;
      assert.deepEqual(await recordDeviceLoginSession(consumed.grantId, { sessionId, familyId }), { revoked: true });
      // What the token phase then does with it.
      await revokeDeviceLoginSession(userId, familyId);
      const me = await fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${signAccessToken(userId, familyId)}` } });
      assert.equal(me.status, 401);
    });
  });
});

test("the revoke route answers even with device login switched off", async () => {
  await withEnv(false, async (app) => {
    assert.deepEqual(await revoke(app, "dvr_unknown"), { status: 404, body: { error: "This revoke link can't be used", code: "revoke_link_invalid" } as never });
  });
});

test("two clicks on a revoke link at once: one revokes, the other is told it was used", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const { bearer } = await seedUser();
      const grant = await startLogin(app);
      await approveCode(app, bearer, grant.userCode);
      await pollToken(app, grant.deviceCode);
      const token = revokeTokenFrom(mailbox[0]!);

      const answers = await Promise.all([revoke(app, token), revoke(app, token)]);
      assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 409]);
    });
  });
});

test("an approval whose email fails still stands", async () => {
  await withEnv(true, async (app) => {
    __setEmailDeliveryObserverForTests(() => {
      throw new Error("mail provider down");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { bearer } = await seedUser();
      const grant = await startLogin(app);
      await approveCode(app, bearer, grant.userCode);
      assert.equal((await pollToken(app, grant.deviceCode)).status, 200);
      assert.ok(errors.mock.calls.some(([message]) => String(message).includes("approved notice email failed")));
    } finally {
      errors.mockRestore();
      __setEmailDeliveryObserverForTests(null);
    }
  });
});

test("a grant exchanged with no recorded session is reported as such, not as signed out", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const { bearer } = await seedUser();
      const grant = await startLogin(app);
      await approveCode(app, bearer, grant.userCode);
      assert.equal((await pollToken(app, grant.deviceCode)).status, 200);
      // As a server from before this change leaves it: consumed, session unrecorded.
      await getDb()
        .update(deviceAuthorizations)
        .set({ consumedSessionFamilyId: null, consumedSessionId: null })
        .where(eq(deviceAuthorizations.userCode, grant.userCode));

      assert.deepEqual(await revoke(app, revokeTokenFrom(mailbox[0]!)), { status: 200, body: { ok: true, revoked: "session_unknown" } as never });
    });
  });
});

test("the token route itself signs out a session whose link was used while it was being issued", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const { id: userId, bearer } = await seedUser();
      const grant = await startLogin(app);
      await approveCode(app, bearer, grant.userCode);
      const token = revokeTokenFrom(mailbox[0]!);

      // The link lands after the consume issued the session, before the session's record.
      const original = deviceAuthService.recordDeviceLoginSession;
      let issuedFamily: string | undefined;
      const spy = vi.spyOn(deviceAuthService, "recordDeviceLoginSession").mockImplementationOnce(async (grantId, session) => {
        assert.deepEqual(await revokeDeviceLoginByLink(token), { ok: true, revoked: "session_unknown" });
        issuedFamily = session.familyId;
        return original(grantId, session);
      });
      try {
        const polled = await pollToken(app, grant.deviceCode);
        assert.equal(polled.status, 403);
        assert.equal(polled.body.code, "access_denied");
      } finally {
        spy.mockRestore();
      }
      assert.ok(issuedFamily);
      const me = await fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${signAccessToken(userId, issuedFamily)}` } });
      assert.equal(me.status, 401);
    });
  });
});

/** A device login run end to end, as Raft Computer or the raft CLI would. */
async function deviceSession(app: { baseUrl: string }, bearer: string) {
  const grant = await startLogin(app);
  await approveCode(app, bearer, grant.userCode);
  const polled = await pollToken(app, grant.deviceCode);
  assert.equal(polled.status, 200);
  return { accessToken: polled.body.accessToken!, refreshToken: polled.body.refreshToken! };
}

async function call(app: { baseUrl: string }, method: string, path: string, token: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: jsonHeaders({ Authorization: `Bearer ${token}`, ...headers }),
    ...(method === "GET" ? {} : { body: "{}" }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as { code?: string } | null };
}

/** A request target sent as is: fetch normalizes `#` and `\\` away, a client of its own need not. */
async function rawCall(app: { baseUrl: string }, method: string, target: string, token: string) {
  const url = new URL(app.baseUrl);
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    let data = "";
    const socket = net.connect(Number(url.port), url.hostname, () => {
      socket.write(`${method} ${target} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${token}\r\n`
        + "Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
    });
    socket.on("data", (chunk) => { data += chunk.toString("utf8"); });
    socket.on("end", () => resolve({ status: Number(data.split(" ")[1]), body: data.slice(data.indexOf("\r\n\r\n") + 4) }));
    socket.on("error", reject);
  });
}

async function mailCount(mailbox: EmailDelivery[], count: number) {
  // Notices are sent after the response (never awaited by the route).
  for (let i = 0; i < 100 && mailbox.length < count; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(mailbox.length, count);
}

const DAY_MS = 24 * 60 * 60 * 1000;

test("a device login's session reaches only the routes Raft Computer and the raft CLI use", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async () => {
      const { id: userId, bearer } = await seedUser();
      const server = await createServer("Scope Co", `scope-${randomUUID()}`, userId);
      const agent = await createAgent(server.id, "scope-agent", { runtime: "external" });
      const device = await deviceSession(app, bearer);

      assert.equal((await call(app, "GET", "/api/auth/me", device.accessToken)).status, 200);
      assert.equal((await call(app, "GET", "/api/servers", device.accessToken)).status, 200);
      assert.equal((await call(app, "GET", "/api/servers/", device.accessToken)).status, 200);
      assert.equal((await call(app, "GET", "/api/agents/manageable", device.accessToken)).status, 200);
      // What Raft Computer reads while setting up and starting.
      assert.equal((await call(app, "GET", `/api/servers/${server.id}/machines`, device.accessToken, { "X-Server-Id": server.id })).status, 200);
      assert.equal((await call(app, "GET", `/api/computer/legacy-machines?serverSlug=${server.slug}`, device.accessToken)).status, 200);

      // Everything else: refused with its own code, before any handler runs,
      // including siblings under the same mounts and app-login's approval.
      for (const [method, path, headers] of [
        ["PATCH", "/api/auth/me", {}],
        ["POST", "/api/auth/device/describe", {}],
        ["POST", "/api/auth/device/approve", {}],
        ["POST", `/api/auth/app-login/requests/${randomUUID()}/approve`, {}],
        ["GET", "/api/agents", {}],
        ["POST", "/api/servers", {}],
        ["GET", `/api/servers/${server.id}`, { "X-Server-Id": server.id }],
        ["POST", `/api/servers/${server.id}/invites`, { "X-Server-Id": server.id }],
        ["POST", `/api/agents/${agent.id}/start`, { "X-Server-Id": server.id }],
      ] as const) {
        const refused = await call(app, method, path, device.accessToken, headers);
        assert.deepEqual([method, path, refused.status, refused.body?.code], [method, path, 403, "device_session_not_allowed"]);
      }
      // Targets Express reads differently from their text (cut at `#`, `\\` as `/`):
      // each would land on a handler outside the list, so none is admitted.
      for (const [method, target] of [
        ["GET", `/api/servers/${server.id}#/machines`],
        ["GET", `/api/servers/${server.id}\\members#/machines`],
        ["POST", `/api/servers/${server.id}\\invites#/machines/x/computer-lifecycle-operations`],
        ["POST", `/api/agents/${agent.id}\\start#/credentials`],
        ["POST", "/api/agents/#/credentials"],
      ] as const) {
        const refused = await rawCall(app, method, target, device.accessToken);
        assert.deepEqual([target, refused.status, refused.body.includes("device_session_not_allowed")], [target, 403, true]);
      }
      // Attachment links, sockets and optional-auth reads see no session at all.
      assert.equal((await fetch(`${app.baseUrl}/api/attachments/${randomUUID()}?token=${device.accessToken}`)).status, 401);
      assert.equal(await verifyActiveAccessToken(device.accessToken), null);
      assert.equal((await verifyActiveAccessTokenWithAccount(device.accessToken, { deviceSession: "allow" }))?.scope, "device");

      // The family is device-scoped; its refresh token lives 7 days, not 30.
      const [row] = await getDb()
        .select({ scope: sessionFamilies.scope, expiresAt: sessions.expiresAt })
        .from(sessions)
        .innerJoin(sessionFamilies, eq(sessionFamilies.id, sessions.familyId))
        .where(and(eq(sessions.userId, userId), eq(sessionFamilies.scope, "device")));
      assert.equal(row?.scope, "device");
      assert.ok(Math.abs(row!.expiresAt.getTime() - (Date.now() + 7 * DAY_MS)) < 60_000);
    });
  });
});

test("a device session keeps its scope and its 7-day window through a refresh", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async () => {
      const { id: userId, bearer } = await seedUser();
      const device = await deviceSession(app, bearer);
      const refreshed = await fetch(`${app.baseUrl}/api/auth/refresh`, {
        method: "POST", headers: jsonHeaders(), body: JSON.stringify({ refreshToken: device.refreshToken }),
      });
      assert.equal(refreshed.status, 200);
      const refreshedTokens = refreshed.json() as Promise<{ accessToken: string; refreshToken: string }>;
      const rotated = await refreshedTokens;

      assert.equal((await call(app, "GET", "/api/auth/me", rotated.accessToken)).status, 200);
      assert.equal((await call(app, "PATCH", "/api/auth/me", rotated.accessToken)).body?.code, "device_session_not_allowed");
      const rows = await getDb()
        .select({ expiresAt: sessions.expiresAt })
        .from(sessions)
        .innerJoin(sessionFamilies, eq(sessionFamilies.id, sessions.familyId))
        .where(and(eq(sessions.userId, userId), eq(sessionFamilies.scope, "device")));
      assert.equal(rows.length, 1);
      assert.ok(Math.abs(rows[0]!.expiresAt.getTime() - (Date.now() + 7 * DAY_MS)) < 60_000);

      // The durable refresh path (an installation-bound client) keeps them too.
      const durable = await fetch(`${app.baseUrl}/api/auth/refresh`, {
        method: "POST",
        headers: jsonHeaders({ "X-Slock-Auth-Installation-Id": `ari_${"a".repeat(32)}`, "X-Slock-Auth-Refresh-Attempt-Id": `arf_${"b".repeat(16)}` }),
        body: JSON.stringify({ refreshToken: (await refreshedTokens).refreshToken }),
      });
      assert.equal(durable.status, 200);
      const durableTokens = (await durable.json()) as { accessToken: string };
      assert.equal((await call(app, "PATCH", "/api/auth/me", durableTokens.accessToken)).body?.code, "device_session_not_allowed");
      const [latest] = await getDb()
        .select({ expiresAt: sessions.expiresAt })
        .from(sessions)
        .innerJoin(sessionFamilies, eq(sessionFamilies.id, sessions.familyId))
        .where(and(eq(sessions.userId, userId), eq(sessionFamilies.scope, "device")));
      assert.ok(Math.abs(latest!.expiresAt.getTime() - (Date.now() + 7 * DAY_MS)) < 60_000);

      // The person's own session is untouched by any of this.
      assert.equal((await call(app, "GET", "/api/auth/me", bearer)).status, 200);
    });
  });
});

test("a device session minting an agent credential or attaching a computer mails the person, with a revoke link", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const { id: userId, bearer } = await seedUser();
      const server = await createServer("Device Co", `device-${randomUUID()}`, userId);
      const agent = await createAgent(server.id, "notice-agent", { runtime: "external" });

      // A person's own session mints silently, and nothing records a family on it.
      const own = await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials`, {
        method: "POST", headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }), body: "{}",
      });
      assert.equal(own.status, 201);
      const ownKey = (await own.json()) as { credentialId: string; apiKey: string };
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(mailbox.length, 0);

      const device = await deviceSession(app, bearer);
      assert.equal(mailbox.length, 1, "the approval notice");

      const deviceMint = await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials`, {
        method: "POST", headers: jsonHeaders({ Authorization: `Bearer ${device.accessToken}` }), body: "{}",
      });
      assert.equal(deviceMint.status, 201);
      const deviceKey = (await deviceMint.json()) as { credentialId: string; apiKey: string };
      await mailCount(mailbox, 2);
      assert.equal(mailbox[1]!.subject, "A device login created an agent credential — Raft");
      assert.ok(mailbox[1]!.html.includes("<strong>Agent:</strong> notice-agent"));

      const attached = await fetch(`${app.baseUrl}/api/computer/attach`, {
        method: "POST",
        headers: jsonHeaders({ Authorization: `Bearer ${device.accessToken}` }),
        body: JSON.stringify({ serverSlug: server.slug, name: "raft-computer" }),
      });
      assert.equal(attached.status, 201);
      const computer = (await attached.json()) as { apiKey: string; serverMachineId: string; machineId: string };
      await mailCount(mailbox, 3);
      assert.equal(mailbox[2]!.subject, "A device login attached a computer — Raft");
      assert.ok(mailbox[2]!.html.includes(`<strong>Server:</strong> ${server.slug}`));
      // What the Computer then mints for its runner carries the family holding its key.
      await getDb().update(agents).set({ machineId: computer.machineId }).where(eq(agents.id, agent.id));
      const runnerRes = await fetch(`${app.baseUrl}/internal/computer/runners/${agent.id}/credentials`, {
        method: "POST", headers: jsonHeaders({ Authorization: `Bearer ${computer.apiKey}` }), body: "{}",
      });
      assert.equal(runnerRes.status, 201, await runnerRes.clone().text());
      const runner = (await runnerRes.json()) as { credentialId: string; apiKey: string };

      const [deviceFamily] = await getDb().select({ id: sessionFamilies.id }).from(sessionFamilies)
        .where(and(eq(sessionFamilies.userId, userId), eq(sessionFamilies.scope, "device")));
      const issued = async () => Object.fromEntries((await getDb()
        .select({ id: agentCredentials.id, family: agentCredentials.issuedBySessionFamilyId, reason: agentCredentials.revokedReason })
        .from(agentCredentials)
        .where(eq(agentCredentials.agentId, agent.id))).map((row) => [row.id, `${row.family ? "device" : "-"}:${row.reason ?? "live"}`]));
      assert.deepEqual(await issued(), {
        [ownKey.credentialId]: "-:live",
        [deviceKey.credentialId]: "device:live",
        [runner.credentialId]: "device:live",
      });
      const [computerRow] = await getDb().select({ family: computers.keyIssuedBySessionFamilyId }).from(computers)
        .where(eq(computers.id, computer.serverMachineId));
      assert.equal(computerRow?.family, deviceFamily!.id);

      // Each notice's link signs the device session out, and what it handed out with it.
      assert.deepEqual(await revoke(app, revokeTokenFrom(mailbox[2]!)), { status: 200, body: { ok: true, revoked: "session" } as never });
      assert.equal((await call(app, "GET", "/api/auth/me", device.accessToken)).status, 401);
      assert.deepEqual(await issued(), {
        [ownKey.credentialId]: "-:live",
        [deviceKey.credentialId]: "device:device_login_revoked",
        [runner.credentialId]: "device:device_login_revoked",
      });
      const agentApi = async (apiKey: string) => (await fetch(`${app.baseUrl}/internal/agent-api/`, { headers: { Authorization: `Bearer ${apiKey}` } })).status;
      assert.equal(await agentApi(deviceKey.apiKey), 401);
      assert.equal(await agentApi(runner.apiKey), 401);
      assert.equal(await agentApi(ownKey.apiKey), 200);
      const computerAuth = await findComputerByApiKeyWithReason(computer.apiKey);
      assert.equal(computerAuth.ok ? "found" : computerAuth.reason, "computer_revoked");
      // The revoked sk_computer_* key mints nothing more (never the sk_machine_* alias's unfenced mint).
      const afterRevokeMint = await fetch(`${app.baseUrl}/internal/computer/runners/${agent.id}/credentials`, {
        method: "POST", headers: jsonHeaders({ Authorization: `Bearer ${computer.apiKey}` }), body: "{}",
      });
      assert.equal(afterRevokeMint.status, 401);
      assert.equal(Object.keys(await issued()).length, 3);
      const audits = await getDb().select({ type: integrationAuditEvents.eventType, target: integrationAuditEvents.targetId })
        .from(integrationAuditEvents)
        .where(inArray(integrationAuditEvents.targetId, [deviceKey.credentialId, runner.credentialId, computer.serverMachineId]));
      assert.deepEqual(audits.map((row) => `${row.type}:${row.target}`).sort(), [
        `agent_credential.issued:${deviceKey.credentialId}`,
        `agent_credential.revoked:${deviceKey.credentialId}`,
        `agent_credential.revoked:${runner.credentialId}`,
        `computer.key_revoked:${computer.serverMachineId}`,
      ].sort());
    });
  });
});

test("the device-session route check reads a path only when the router would read it the same way", () => {
  assert.equal(isDeviceSessionRoute("GET", "/api/servers"), true);
  assert.equal(isDeviceSessionRoute("GET", "/api/servers/?x=1"), true);
  assert.equal(isDeviceSessionRoute("get", "/API/Servers/abc/machines"), true);
  assert.equal(isDeviceSessionRoute("HEAD", "/api/servers"), false);
  assert.equal(isDeviceSessionRoute("GET", "/api/servers/abc#/machines"), false);
  assert.equal(isDeviceSessionRoute("GET", "/api/servers/abc\\members/machines"), false);
  assert.equal(isDeviceSessionRoute("GET", "/api/servers/abc /machines"), false);
  assert.equal(isDeviceSessionRoute("GET", "/api/servers/abc\t/machines"), false);
  assert.equal(isDeviceSessionRoute("POST", "/api/agents//credentials"), false);
  assert.equal(isDeviceSessionRoute("GET", "/api/servers/abc/members"), false);
});

test("a device session can't retire an account, revoked or not; a person's own session still reaches the route", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const { id: userId, bearer } = await seedUser();
      const retire = async (token: string) => {
        const res = await fetch(`${app.baseUrl}/api/auth/staging-self-account/retire`, {
          method: "POST", headers: jsonHeaders({ Authorization: `Bearer ${token}` }), body: "{}",
        });
        return (await res.json().catch(() => ({})) as { code?: string }).code ?? `status:${res.status}`;
      };
      const device = await deviceSession(app, bearer);
      assert.equal(await retire(device.accessToken), "device_session_not_allowed");
      assert.deepEqual(await revoke(app, revokeTokenFrom(mailbox[0]!)), { status: 200, body: { ok: true, revoked: "session" } as never });
      assert.equal(await retire(device.accessToken), "device_session_not_allowed");
      // A token with no family is refused outright; a person's own family gets past the scope check (the route's own rules follow).
      assert.equal(await retire(familylessAccessToken(userId)), "auth_required");
      assert.notEqual(await retire(bearer), "device_session_not_allowed");
      assert.notEqual(await retire((await signInForTest(userId)).token), "device_session_not_allowed");
    });
  });
});

test("a used revoke link runs the cascade again, repairing a first click that left a key live", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const { id: userId, bearer } = await seedUser();
      const server = await createServer("Repair Co", `repair-${randomUUID()}`, userId);
      const agent = await createAgent(server.id, "repair-agent", { runtime: "external" });
      const device = await deviceSession(app, bearer);
      const minted = await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials`, {
        method: "POST", headers: jsonHeaders({ Authorization: `Bearer ${device.accessToken}` }), body: "{}",
      });
      const key = (await minted.json()) as { credentialId: string; apiKey: string };
      const token = revokeTokenFrom(mailbox[0]!);
      assert.equal((await revoke(app, token)).status, 200);
      // As if the first click's cascade had failed after the session's revoke committed.
      await getDb().update(agentCredentials).set({ revokedAt: null, revokedReason: null }).where(eq(agentCredentials.id, key.credentialId));
      assert.equal((await fetch(`${app.baseUrl}/internal/agent-api/`, { headers: { Authorization: `Bearer ${key.apiKey}` } })).status, 200);

      assert.equal((await revoke(app, token)).body.code, "revoke_link_used");
      assert.equal((await fetch(`${app.baseUrl}/internal/agent-api/`, { headers: { Authorization: `Bearer ${key.apiKey}` } })).status, 401);
    });
  });
});

test("a device session's write fence refuses a family revoked while the request ran", async () => {
  await withEnv(true, async () => {
    const { id: userId } = await seedUser();
    const { familyId } = await sessionService.createSession(await proofForDeviceLogin(userId, null), undefined, { scope: "device" });
    await getDb().transaction((tx) => lockLiveSessionFamily(tx, familyId, userId));
    // Another person's id never matches the family.
    await assert.rejects(getDb().transaction((tx) => lockLiveSessionFamily(tx, familyId, randomUUID())), DeviceSessionRevokedError);
    await revokeDeviceLoginSession(userId, familyId);
    await assert.rejects(getDb().transaction((tx) => lockLiveSessionFamily(tx, familyId, userId)), DeviceSessionRevokedError);
  });
});

test("adopting a legacy machine records the device family on the key; a later full-session resume clears it; the link revokes it", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const { id: userId, bearer } = await seedUser();
      const slug = `adopt-device-${randomUUID()}`;
      const server = await createServer("Adopt Device Co", slug, userId);
      const { machine } = await registerMachine(server.id, userId, "legacy-daemon");
      await getDb().update(machines).set({ apiKeyFingerprint: null }).where(eq(machines.id, machine.id));
      const device = await deviceSession(app, bearer);
      const [deviceFamily] = await getDb().select({ id: sessionFamilies.id }).from(sessionFamilies)
        .where(and(eq(sessionFamilies.userId, userId), eq(sessionFamilies.scope, "device")));
      const adopt = async (token: string) => {
        const res = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
          method: "POST",
          headers: jsonHeaders({ Authorization: `Bearer ${token}` }),
          body: JSON.stringify({ serverSlug: slug, daemonId: machine.id, name: "adopted-computer" }),
        });
        assert.equal(res.status, 201);
        return (await res.json()) as { computerId: string; resumed: boolean };
      };
      const holder = async (computerId: string) => (await getDb()
        .select({ family: computers.keyIssuedBySessionFamilyId, reason: computers.revokedReason })
        .from(computers).where(eq(computers.id, computerId)))[0];

      const first = await adopt(device.accessToken);
      assert.equal(first.resumed, false);
      assert.deepEqual(await holder(first.computerId), { family: deviceFamily!.id, reason: null });
      // A person's own session resuming it holds the key now: no family.
      assert.equal((await adopt(bearer)).resumed, true);
      assert.deepEqual(await holder(first.computerId), { family: null, reason: null });
      // The device session takes it back.
      assert.equal((await adopt(device.accessToken)).resumed, true);
      assert.deepEqual(await holder(first.computerId), { family: deviceFamily!.id, reason: null });

      assert.equal((await revoke(app, revokeTokenFrom(mailbox[0]!))).status, 200);
      assert.deepEqual(await holder(first.computerId), { family: deviceFamily!.id, reason: "device_login_revoked" });
    });
  });
});

/**
 * A person with a key of their own and, through a device login, an agent
 * credential, an attached Computer and the runner credential that Computer
 * minted. `state()` reads which of them still authenticate.
 */
async function deviceIssuedKeys(app: { baseUrl: string }, mailbox: EmailDelivery[]) {
  const { id: userId, bearer } = await seedUser();
  const server = await createServer("Sign-out Co", `sign-out-${randomUUID()}`, userId);
  const agent = await createAgent(server.id, "sign-out-agent", { runtime: "external" });
  const mint = async (token: string) => {
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials`, {
      method: "POST", headers: jsonHeaders({ Authorization: `Bearer ${token}` }), body: "{}",
    });
    assert.equal(res.status, 201);
    return ((await res.json()) as { apiKey: string }).apiKey;
  };
  // The person's own key, minted by a session of their own (a full family, revoked too by a sign-out everywhere).
  const own = await mint((await signInForTest(userId)).token);
  const device = await deviceSession(app, bearer);
  const [deviceFamily] = await getDb().select({ id: sessionFamilies.id }).from(sessionFamilies)
    .where(and(eq(sessionFamilies.userId, userId), eq(sessionFamilies.scope, "device")));
  const deviceKey = await mint(device.accessToken);
  const attached = await fetch(`${app.baseUrl}/api/computer/attach`, {
    method: "POST",
    headers: jsonHeaders({ Authorization: `Bearer ${device.accessToken}` }),
    body: JSON.stringify({ serverSlug: server.slug, name: "raft-computer" }),
  });
  assert.equal(attached.status, 201);
  const computer = (await attached.json()) as { apiKey: string; machineId: string };
  await getDb().update(agents).set({ machineId: computer.machineId }).where(eq(agents.id, agent.id));
  const runnerRes = await fetch(`${app.baseUrl}/internal/computer/runners/${agent.id}/credentials`, {
    method: "POST", headers: jsonHeaders({ Authorization: `Bearer ${computer.apiKey}` }), body: "{}",
  });
  assert.equal(runnerRes.status, 201);
  const runner = ((await runnerRes.json()) as { apiKey: string }).apiKey;
  await mailCount(mailbox, 3);
  const agentApi = async (apiKey: string) => {
    const { status } = await fetch(`${app.baseUrl}/internal/agent-api/`, { headers: { Authorization: `Bearer ${apiKey}` } });
    return status === 200 ? "live" : status === 401 ? "revoked" : `status:${status}`;
  };
  const state = async () => {
    const computerAuth = await findComputerByApiKeyWithReason(computer.apiKey);
    return {
      own: await agentApi(own),
      device: await agentApi(deviceKey),
      runner: await agentApi(runner),
      computer: computerAuth.ok ? "live" : computerAuth.reason,
    };
  };
  assert.deepEqual(await state(), { own: "live", device: "live", runner: "live", computer: "live" });
  return { userId, bearer, device, deviceFamilyId: deviceFamily!.id, state, server, computer };
}

const DEVICE_KEYS_REVOKED = { own: "live", device: "revoked", runner: "revoked", computer: "computer_revoked" };
// A password change or reset is a security revoke: it also takes the key the
// person's own web session minted (webSessionIssuedKeys.ts), which a plain
// sign-out, even everywhere, leaves alone.
const SECURITY_REVOKED = { ...DEVICE_KEYS_REVOKED, own: "revoked" };

test("changing the password revokes what a device login's session handed out, and the key the person's own web session minted", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const { bearer, state } = await deviceIssuedKeys(app, mailbox);
      const changed = await fetch(`${app.baseUrl}/api/auth/me`, {
        method: "PATCH",
        headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
        body: JSON.stringify({ currentPassword: "password123", newPassword: "a-new-password-456" }),
      });
      assert.equal(changed.status, 200, await changed.clone().text());
      assert.deepEqual(await state(), SECURITY_REVOKED);
    });
  });
});

test("signing out everywhere revokes what a device login's session handed out", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const { userId, state } = await deviceIssuedKeys(app, mailbox);
      await sessionService.revokeAllUserSessions(userId);
      assert.deepEqual(await state(), DEVICE_KEYS_REVOKED);
    });
  });
});

test("a password reset revokes what a device login's session handed out", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const { userId, state } = await deviceIssuedKeys(app, mailbox);
      const [user] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, userId));
      await requestPasswordReset(user!.email);
      const token = mailbox.at(-1)!.html.match(/\?reset=([0-9a-f]{64})/)?.[1];
      assert.ok(token, "the reset email carries its token");
      const reset = await fetch(`${app.baseUrl}/api/auth/reset-password`, {
        method: "POST", headers: jsonHeaders(), body: JSON.stringify({ token, password: "a-new-password-456" }),
      });
      assert.equal(reset.status, 200);
      assert.deepEqual(await state(), SECURITY_REVOKED);
    });
  });
});

test("a push revoke capability on a device login's session revokes what it handed out", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const { userId, deviceFamilyId, state } = await deviceIssuedKeys(app, mailbox);
      const capability = await ensureFamilyRevokeCapability({ familyId: deviceFamilyId, userId });
      assert.ok(capability);
      assert.equal(await revokePushFamilyByCapability(capability), "revoked");
      assert.deepEqual(await state(), DEVICE_KEYS_REVOKED);
    });
  });
});

test("retiring a staging account revokes what its device logins' sessions handed out", async () => {
  const oldBranch = process.env.SLOCK_RELEASE_BRANCH;
  process.env.SLOCK_RELEASE_BRANCH = "staging";
  try {
    await withEnv(true, async (app) => {
      await withMailbox(async (mailbox) => {
        const { userId, state } = await deviceIssuedKeys(app, mailbox);
        const capability = randomUUID();
        await getDb().update(users).set({
          email: `retire-${randomUUID()}@mail.build`,
          stagingSelfAccountCapabilityHash: createHash("sha256").update(capability).digest("hex"),
        }).where(eq(users.id, userId));
        assert.ok(await retireStagingSelfAccount(userId, userId, capability));
        const { own: _own, ...deviceKeys } = await state();
        assert.deepEqual(deviceKeys, { device: "revoked", runner: "revoked", computer: "computer_revoked" });
      });
    });
  } finally {
    if (oldBranch === undefined) delete process.env.SLOCK_RELEASE_BRANCH;
    else process.env.SLOCK_RELEASE_BRANCH = oldBranch;
  }
});

test("the device session signing itself out takes its keys too", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const { device, state } = await deviceIssuedKeys(app, mailbox);
      const out = await fetch(`${app.baseUrl}/api/auth/logout`, {
        method: "POST", headers: jsonHeaders(), body: JSON.stringify({ refreshToken: device.refreshToken }),
      });
      assert.equal(out.status, 200);
      assert.deepEqual(await state(), DEVICE_KEYS_REVOKED);
    });
  });
});

test("maintenance revokes the keys of a session revoked without them, and leaves a live session's keys alone", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const revoked = await deviceIssuedKeys(app, mailbox);
      mailbox.length = 0;
      const live = await deviceIssuedKeys(app, mailbox);
      // As if a revoker had failed between its commit and the cascade.
      await getDb().update(sessionFamilies).set({ revokedAt: new Date(), revokedReason: "revoke_all" })
        .where(and(eq(sessionFamilies.userId, revoked.userId), eq(sessionFamilies.scope, "device")));
      assert.equal(await revokeKeysOfRevokedDeviceSessions("everyone"), 1);
      assert.deepEqual(await revoked.state(), DEVICE_KEYS_REVOKED);
      assert.deepEqual(await live.state(), { own: "live", device: "live", runner: "live", computer: "live" });
      assert.equal(await revokeKeysOfRevokedDeviceSessions("everyone"), 0, "nothing live is left to revoke");
    });
  });
});

// --- Retiring a device session (device-auth design v2 §4 step 2) ---

async function retireSession(app: { baseUrl: string }, accessToken: string | null, computerKey: string | null) {
  const res = await fetch(`${app.baseUrl}/api/computer/retire-session`, {
    method: "POST",
    headers: jsonHeaders({
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(computerKey ? { "X-Raft-Computer-Key": computerKey } : {}),
    }),
    body: "{}",
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as { code?: string; retired?: boolean; alreadyRetired?: boolean } | null };
}

/** An access token signed like signAccessToken but already past its expiry. */
function expiredAccessToken(userId: string, familyId: string): string {
  return jwt.sign({ sub: userId, type: "access", familyId }, process.env.JWT_SECRET!, { expiresIn: -60 });
}

async function familyState(familyId: string) {
  const [family] = await getDb()
    .select({ revokedAt: sessionFamilies.revokedAt, retiredAt: sessionFamilies.retiredAt, retiredReason: sessionFamilies.retiredReason })
    .from(sessionFamilies).where(eq(sessionFamilies.id, familyId));
  return { revoked: Boolean(family?.revokedAt), retired: Boolean(family?.retiredAt), retiredReason: family?.retiredReason ?? null };
}

async function issuedCounts() {
  const db = getDb();
  return {
    credentials: (await db.select({ id: agentCredentials.id }).from(agentCredentials)).length,
    computers: (await db.select({ id: computers.id }).from(computers)).length,
    families: (await db.select({ id: sessionFamilies.id }).from(sessionFamilies)).length,
  };
}

test("retire-session needs both the session and a key that session issued; neither alone, nor another session's key", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const keys = await deviceIssuedKeys(app, mailbox);
      // Another device login of the same person, with a Computer of its own.
      const other = await deviceSession(app, keys.bearer);
      const otherAttach = await fetch(`${app.baseUrl}/api/computer/attach`, {
        method: "POST",
        headers: jsonHeaders({ Authorization: `Bearer ${other.accessToken}` }),
        body: JSON.stringify({ serverSlug: keys.server.slug, name: "other-computer" }),
      });
      assert.equal(otherAttach.status, 201);
      const otherKey = ((await otherAttach.json()) as { apiKey: string }).apiKey;
      // And a Computer the person's own session attached: its key names no family.
      const ownAttach = await fetch(`${app.baseUrl}/api/computer/attach`, {
        method: "POST",
        headers: jsonHeaders({ Authorization: `Bearer ${keys.bearer}` }),
        body: JSON.stringify({ serverSlug: keys.server.slug, name: "own-computer" }),
      });
      assert.equal(ownAttach.status, 201);
      const ownKey = ((await ownAttach.json()) as { apiKey: string }).apiKey;

      assert.deepEqual(await retireSession(app, keys.device.accessToken, otherKey), { status: 403, body: { error: "This Computer key wasn't issued by this session", code: "computer_key_family_mismatch" } });
      assert.equal((await retireSession(app, other.accessToken, keys.computer.apiKey)).body?.code, "computer_key_family_mismatch");
      assert.equal((await retireSession(app, keys.device.accessToken, ownKey)).body?.code, "computer_key_family_mismatch");
      // A legacy token with no family retires nothing: it is refused outright.
      assert.equal((await retireSession(app, familylessAccessToken(keys.userId), keys.computer.apiKey)).status, 401);
      // A full web session (what an older Desktop copied onto the machine) is told apart, so the Computer drops only its copy.
      const { familyId: fullFamilyId, token: fullSession } = await signInForTest(keys.userId);
      assert.deepEqual(await retireSession(app, fullSession, keys.computer.apiKey), { status: 409, body: { error: "This is not a device login session; there is nothing to retire", code: "session_not_device" } });
      assert.equal((await retireSession(app, expiredAccessToken(keys.userId, fullFamilyId), keys.computer.apiKey)).body?.code, "session_not_device");
      // The session alone; the key alone; a key that isn't one.
      assert.deepEqual(await retireSession(app, keys.device.accessToken, null), { status: 401, body: { error: "This needs the Computer's own key as well as its session", code: "computer_key_required" } });
      assert.deepEqual(await retireSession(app, null, keys.computer.apiKey), { status: 401, body: { error: "Invalid or expired token", code: "auth_required" } });
      assert.equal((await retireSession(app, keys.device.accessToken, `sk_computer_${"0".repeat(64)}`)).body?.code, "computer_key_invalid");
      // A refresh token is not an access token.
      assert.equal((await retireSession(app, keys.device.refreshToken, keys.computer.apiKey)).status, 401);

      // Nothing was retired by any of them.
      assert.deepEqual(await familyState(keys.deviceFamilyId), { revoked: false, retired: false, retiredReason: null });
      assert.equal((await call(app, "GET", "/api/auth/me", keys.device.accessToken)).status, 200);
      assert.equal((await call(app, "GET", "/api/auth/me", other.accessToken)).status, 200);
    });
  });
});

/** A Computer `userId`'s device session attaches, its key then made to record no issuer, as one attached before #11934. */
async function unrecordedKeyOf(app: { baseUrl: string }, userId: string, accessToken: string, serverSlug: string, name: string) {
  const res = await fetch(`${app.baseUrl}/api/computer/attach`, {
    method: "POST",
    headers: jsonHeaders({ Authorization: `Bearer ${accessToken}` }),
    body: JSON.stringify({ serverSlug, name }),
  });
  assert.equal(res.status, 201);
  const { apiKey, machineId } = (await res.json()) as { apiKey: string; machineId: string };
  const unrecorded = await getDb().update(computers)
    .set({ keyIssuedBySessionFamilyId: null, keyIssuedByWebSessionFamilyId: null, keyIssuedByGrantId: null })
    .where(and(eq(computers.machineId, machineId), eq(computers.attachedByUserId, userId)))
    .returning({ id: computers.id });
  assert.equal(unrecorded.length, 1);
  return apiKey;
}

test("retire-session takes a key that records no issuer when the session's person attached it; never another person's, and a recorded key must still be this session's (#wg-device-auth:#1)", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const keys = await deviceIssuedKeys(app, mailbox);
      const ownLegacyKey = await unrecordedKeyOf(app, keys.userId, keys.device.accessToken, keys.server.slug, "legacy-computer");
      // Another person, with a Computer of their own whose key records no issuer either.
      const stranger = await seedUser();
      const strangerServer = await createServer("Stranger Co", `stranger-${randomUUID()}`, stranger.id);
      const strangerDevice = await deviceSession(app, stranger.bearer);
      const strangerFamilyId = (await deviceFamiliesOf(stranger.id))[0]!.id;
      const strangerLegacyKey = await unrecordedKeyOf(app, stranger.id, strangerDevice.accessToken, strangerServer.slug, "stranger-computer");
      // A second device login of the first person, whose key records it.
      const other = await deviceSession(app, keys.bearer);
      const otherAttach = await fetch(`${app.baseUrl}/api/computer/attach`, {
        method: "POST",
        headers: jsonHeaders({ Authorization: `Bearer ${other.accessToken}` }),
        body: JSON.stringify({ serverSlug: keys.server.slug, name: "other-computer" }),
      });
      assert.equal(otherAttach.status, 201);
      const otherKey = ((await otherAttach.json()) as { apiKey: string }).apiKey;

      // Another person's key, either way round.
      assert.deepEqual(await retireSession(app, keys.device.accessToken, strangerLegacyKey), { status: 403, body: { error: "This Computer key wasn't issued by this session", code: "computer_key_family_mismatch" } });
      assert.equal((await retireSession(app, strangerDevice.accessToken, ownLegacyKey)).body?.code, "computer_key_family_mismatch");
      // A key that records another session of the same person.
      assert.equal((await retireSession(app, keys.device.accessToken, otherKey)).body?.code, "computer_key_family_mismatch");
      // A full web session is still no device login.
      const { token: fullSession } = await signInForTest(keys.userId);
      assert.equal((await retireSession(app, fullSession, ownLegacyKey)).body?.code, "session_not_device");
      assert.deepEqual(await familyState(keys.deviceFamilyId), { revoked: false, retired: false, retiredReason: null });
      assert.deepEqual(await familyState(strangerFamilyId), { revoked: false, retired: false, retiredReason: null });

      // The person's own key that records no issuer retires their session, expired token too.
      assert.deepEqual(
        await retireSession(app, expiredAccessToken(keys.userId, keys.deviceFamilyId), ownLegacyKey),
        { status: 200, body: { ok: true, retired: true, alreadyRetired: false } as never },
      );
      assert.deepEqual(await familyState(keys.deviceFamilyId), { revoked: false, retired: true, retiredReason: "migration" });
      assert.deepEqual(await familyState(strangerFamilyId), { revoked: false, retired: false, retiredReason: null });
      assert.deepEqual(await keys.state(), { own: "live", device: "live", runner: "live", computer: "live" });
      const [audit] = await getDb().select({ metadata: integrationAuditEvents.metadata })
        .from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "computer.device_session_retired"));
      assert.equal(audit!.metadata.keyMatch, "unrecorded_same_person");
      assert.equal(audit!.metadata.sessionFamilyId, keys.deviceFamilyId);
    });
  });
});

test("a retired session can't authenticate or refresh; retiring issues nothing and revokes nothing; again is ok", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const keys = await deviceIssuedKeys(app, mailbox);
      const before = await issuedCounts();
      const mailsBefore = mailbox.length;

      const retired = await retireSession(app, keys.device.accessToken, keys.computer.apiKey);
      assert.deepEqual(retired, { status: 200, body: { ok: true, retired: true, alreadyRetired: false } as never });
      assert.deepEqual(await familyState(keys.deviceFamilyId), { revoked: false, retired: true, retiredReason: "migration" });

      // Unusable, like a revoked session: no request, no refresh, no fenced write.
      assert.equal((await call(app, "GET", "/api/auth/me", keys.device.accessToken)).status, 401);
      assert.equal((await call(app, "GET", "/api/servers", keys.device.accessToken)).status, 401);
      const refreshed = await fetch(`${app.baseUrl}/api/auth/refresh`, {
        method: "POST", headers: jsonHeaders(), body: JSON.stringify({ refreshToken: keys.device.refreshToken }),
      });
      assert.equal(refreshed.status, 401);
      assert.equal((await verifyActiveAccessTokenWithAccount(keys.device.accessToken, { deviceSession: "allow" })), null);
      await assert.rejects(getDb().transaction((tx) => lockLiveSessionFamily(tx, keys.deviceFamilyId, keys.userId)), DeviceSessionRevokedError);
      assert.equal((await getDb().select({ id: sessions.id }).from(sessions).where(eq(sessions.familyId, keys.deviceFamilyId))).length, 0);

      // Issued nothing, revoked nothing, and every key still names the family.
      assert.deepEqual(await issuedCounts(), before);
      assert.deepEqual(await keys.state(), { own: "live", device: "live", runner: "live", computer: "live" });
      const [computer] = await getDb().select({ family: computers.keyIssuedBySessionFamilyId }).from(computers)
        .where(eq(computers.machineId, keys.computer.machineId));
      assert.equal(computer!.family, keys.deviceFamilyId);
      const familyCredentials = await getDb().select({ id: agentCredentials.id }).from(agentCredentials)
        .where(eq(agentCredentials.issuedBySessionFamilyId, keys.deviceFamilyId));
      assert.equal(familyCredentials.length, 2, "the device session's own credential and the runner's");
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(mailbox.length, mailsBefore, "nothing to mail");

      // Again: ok, and still one audit record.
      assert.deepEqual(await retireSession(app, keys.device.accessToken, keys.computer.apiKey), { status: 200, body: { ok: true, retired: true, alreadyRetired: true } as never });
      const audits = await getDb().select({ metadata: integrationAuditEvents.metadata, serverId: integrationAuditEvents.serverId, actorId: integrationAuditEvents.actorId })
        .from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "computer.device_session_retired"));
      assert.equal(audits.length, 1);
      assert.equal(audits[0]!.serverId, null);
      assert.equal(audits[0]!.actorId, keys.userId);
      assert.equal(audits[0]!.metadata.reason, "migration_retire");
      assert.equal(audits[0]!.metadata.keyMatch, "issued_by_session");
      assert.equal(audits[0]!.metadata.sessionFamilyId, keys.deviceFamilyId);
      assert.ok(typeof audits[0]!.metadata.computerId === "string");

      // Revoked afterwards (its revoke link): refused, nothing to retire.
      assert.equal((await revoke(app, revokeTokenFrom(mailbox[0]!))).status, 200);
      const afterRevoke = await retireSession(app, keys.device.accessToken, keys.computer.apiKey);
      assert.equal(afterRevoke.status, 401, "the Computer's key went with the family");
    });
  });
});

test("retire-session names the Computer and the reason in its request trace, for refusals too (#wg-device-auth:#1)", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const traceSink = new MemoryTraceSink();
      app.app.set("serverTracer", new BasicTracer({ sink: traceSink }));
      const keys = await deviceIssuedKeys(app, mailbox);
      const other = await deviceSession(app, keys.bearer);
      assert.equal((await retireSession(app, other.accessToken, keys.computer.apiKey)).body?.code, "computer_key_family_mismatch");
      assert.equal((await retireSession(app, keys.device.accessToken, keys.computer.apiKey)).status, 200);
      const retireSpans = traceSink.getAllSpans().filter((span) =>
        span.name === "server.http.request" && span.attrs?.route_pattern === "/api/computer/retire-session");
      assert.equal(retireSpans.length, 2);
      for (const span of retireSpans) {
        assert.equal(span.attrs?.machine_id_present, true);
        assert.equal(typeof span.attrs?.machine_id_hash, "string");
        // A hash, never the key or the token.
        assert.ok(!JSON.stringify(span.attrs).includes(keys.computer.apiKey));
        assert.ok(!JSON.stringify(span.attrs).includes(other.accessToken));
      }
      assert.equal(retireSpans[0]!.attrs?.error_code, "computer_key_family_mismatch");
      assert.equal(retireSpans[1]!.attrs?.error_code, undefined);

      // A token whose signature fails (a rotated JWT secret, a damaged file) is
      // the case the Computer keeps its session for: the answer is unchanged,
      // and the trace still names the Computer.
      const badSignature = jwt.sign({ sub: keys.userId, type: "access", familyId: "f" }, "not-the-server-secret", { expiresIn: 60 });
      assert.equal((await retireSession(app, badSignature, keys.computer.apiKey)).status, 401);
      const refused = traceSink.getAllSpans().filter((span) =>
        span.name === "server.http.request" && span.attrs?.route_pattern === "/api/computer/retire-session")[2];
      assert.equal(refused?.attrs?.error_code, "session_token_invalid");
      assert.equal(refused?.attrs?.machine_id_hash, retireSpans[0]!.attrs?.machine_id_hash);
    });
  });
});

test("retire-session accepts an expired access token of the session (the key is the live proof); no other route does", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const keys = await deviceIssuedKeys(app, mailbox);
      const expired = expiredAccessToken(keys.userId, keys.deviceFamilyId);
      // Expired: refused everywhere else, before and after.
      assert.equal((await call(app, "GET", "/api/auth/me", expired)).status, 401);
      assert.equal((await call(app, "GET", "/api/servers", expired)).status, 401);
      // Still needs the key, and the key of this family.
      assert.equal((await retireSession(app, expired, null)).body?.code, "computer_key_required");
      // A token with a wrong signature is not accepted just because expiry is not checked.
      const forged = jwt.sign({ sub: keys.userId, type: "access", familyId: keys.deviceFamilyId }, "not-the-secret", { expiresIn: -60 });
      assert.equal((await retireSession(app, forged, keys.computer.apiKey)).status, 401);
      assert.deepEqual(await familyState(keys.deviceFamilyId), { revoked: false, retired: false, retiredReason: null });

      assert.deepEqual(await retireSession(app, expired, keys.computer.apiKey), { status: 200, body: { ok: true, retired: true, alreadyRetired: false } as never });
      assert.deepEqual(await familyState(keys.deviceFamilyId), { revoked: false, retired: true, retiredReason: "migration" });
      assert.equal((await call(app, "GET", "/api/auth/me", expired)).status, 401);
      assert.deepEqual(await keys.state(), { own: "live", device: "live", runner: "live", computer: "live" });
    });
  });
});

test("only retire-session verifies a token without its expiry", () => {
  const src = join(import.meta.dirname, "..");
  const users = (readdirSync(src, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => readFileSync(join(src, f), "utf8").includes("verifyTokenSignatureIgnoringExpiry"))
    .map((f) => f.split("\\").join("/"))
    .sort();
  assert.deepEqual(users, ["middleware/auth.ts", "routes/computerRetireSession.ts"]);
});

test("retire-session refuses a revoked session, with an expired token too", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const keys = await deviceIssuedKeys(app, mailbox);
      await getDb().update(sessionFamilies).set({ revokedAt: new Date(), revokedReason: "logout" }).where(eq(sessionFamilies.id, keys.deviceFamilyId));
      assert.equal((await retireSession(app, expiredAccessToken(keys.userId, keys.deviceFamilyId), keys.computer.apiKey)).body?.code, "session_revoked");
    });
  });
});

test("retire-session refuses a revoked session", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const keys = await deviceIssuedKeys(app, mailbox);
      // Revoked without its keys (as if the cascade had not run yet): the key still authenticates.
      await getDb().update(sessionFamilies).set({ revokedAt: new Date(), revokedReason: "logout" }).where(eq(sessionFamilies.id, keys.deviceFamilyId));
      assert.deepEqual(await retireSession(app, keys.device.accessToken, keys.computer.apiKey), { status: 409, body: { error: "This session was revoked; there is nothing to retire", code: "session_revoked" } });
      assert.deepEqual(await familyState(keys.deviceFamilyId), { revoked: true, retired: false, retiredReason: null });
    });
  });
});

/** A device session with its keys, retired by its Computer: what every later revoke must still reach. */
async function retiredDeviceIssuedKeys(app: { baseUrl: string }, mailbox: EmailDelivery[]) {
  const keys = await deviceIssuedKeys(app, mailbox);
  assert.equal((await retireSession(app, keys.device.accessToken, keys.computer.apiKey)).status, 200);
  assert.deepEqual(await familyState(keys.deviceFamilyId), { revoked: false, retired: true, retiredReason: "migration" });
  assert.deepEqual(await keys.state(), { own: "live", device: "live", runner: "live", computer: "live" });
  return keys;
}

test("a retired session's revoke link still revokes it and everything it issued", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const keys = await retiredDeviceIssuedKeys(app, mailbox);
      assert.deepEqual(await revoke(app, revokeTokenFrom(mailbox[0]!)), { status: 200, body: { ok: true, revoked: "session" } as never });
      assert.deepEqual(await familyState(keys.deviceFamilyId), { revoked: true, retired: true, retiredReason: "migration" });
      assert.deepEqual(await keys.state(), DEVICE_KEYS_REVOKED);
    });
  });
});

test("changing the password revokes a retired session and everything it issued", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const keys = await retiredDeviceIssuedKeys(app, mailbox);
      const changed = await fetch(`${app.baseUrl}/api/auth/me`, {
        method: "PATCH",
        headers: jsonHeaders({ Authorization: `Bearer ${keys.bearer}` }),
        body: JSON.stringify({ currentPassword: "password123", newPassword: "a-new-password-456" }),
      });
      assert.equal(changed.status, 200, await changed.clone().text());
      assert.equal((await familyState(keys.deviceFamilyId)).revoked, true);
      assert.deepEqual(await keys.state(), SECURITY_REVOKED);
    });
  });
});

test("retiring the account revokes a retired session and everything it issued", async () => {
  const oldBranch = process.env.SLOCK_RELEASE_BRANCH;
  process.env.SLOCK_RELEASE_BRANCH = "staging";
  try {
    await withEnv(true, async (app) => {
      await withMailbox(async (mailbox) => {
        const keys = await retiredDeviceIssuedKeys(app, mailbox);
        const capability = randomUUID();
        await getDb().update(users).set({
          email: `retire-${randomUUID()}@mail.build`,
          stagingSelfAccountCapabilityHash: createHash("sha256").update(capability).digest("hex"),
        }).where(eq(users.id, keys.userId));
        assert.ok(await retireStagingSelfAccount(keys.userId, keys.userId, capability));
        assert.equal((await familyState(keys.deviceFamilyId)).revoked, true);
        const { own: _own, ...deviceKeys } = await keys.state();
        assert.deepEqual(deviceKeys, { device: "revoked", runner: "revoked", computer: "computer_revoked" });
      });
    });
  } finally {
    if (oldBranch === undefined) delete process.env.SLOCK_RELEASE_BRANCH;
    else process.env.SLOCK_RELEASE_BRANCH = oldBranch;
  }
});

test("maintenance revokes the keys of a retired session revoked without them", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const keys = await retiredDeviceIssuedKeys(app, mailbox);
      // Retired is not revoked: maintenance leaves its keys alone.
      assert.equal(await revokeKeysOfRevokedDeviceSessions({ familyId: keys.deviceFamilyId }), 0);
      assert.deepEqual(await keys.state(), { own: "live", device: "live", runner: "live", computer: "live" });
      await getDb().update(sessionFamilies).set({ revokedAt: new Date(), revokedReason: "revoke_all" }).where(eq(sessionFamilies.id, keys.deviceFamilyId));
      assert.equal(await revokeKeysOfRevokedDeviceSessions("everyone"), 1);
      assert.deepEqual(await keys.state(), DEVICE_KEYS_REVOKED);
    });
  });
});

test("the address a retire recorded is cleared after 30 days with the device login's other details; the record stays", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const keys = await deviceIssuedKeys(app, mailbox);
      const retired = await withTrustedViewerHeaders(true, async () => {
        const res = await fetch(`${app.baseUrl}/api/computer/retire-session`, {
          method: "POST",
          headers: jsonHeaders({ ...VIEWER_HEADERS, Authorization: `Bearer ${keys.device.accessToken}`, "X-Raft-Computer-Key": keys.computer.apiKey }),
          body: "{}",
        });
        return res.status;
      });
      assert.equal(retired, 200);
      const audit = async () => (await getDb().select({ id: integrationAuditEvents.id, metadata: integrationAuditEvents.metadata })
        .from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "computer.device_session_retired")))[0]!;
      assert.equal((await audit()).metadata.requestIp, "203.0.113.7");

      // Younger than 30 days: kept.
      await scrubDeviceAuthorizationRequesterDetails();
      assert.equal((await audit()).metadata.requestIp, "203.0.113.7");
      await getDb().update(integrationAuditEvents).set({ createdAt: new Date(Date.now() - 31 * DAY_MS) })
        .where(eq(integrationAuditEvents.eventType, "computer.device_session_retired"));
      await scrubDeviceAuthorizationRequesterDetails();
      const scrubbed = await audit();
      assert.equal("requestIp" in scrubbed.metadata, false);
      assert.equal(scrubbed.metadata.reason, "migration_retire");
      assert.equal(scrubbed.metadata.sessionFamilyId, keys.deviceFamilyId);
    });
  });
});

const requireWeb = createRequire(new URL("../../../web/package.json", import.meta.url));
const { io: clientIo } = requireWeb("socket.io-client");

/** A socket handshake with this access token: "connected", or the server's refusal. */
async function socketHandshake(app: { baseUrl: string }, token: string): Promise<string> {
  const socket = clientIo(app.baseUrl, { auth: { token }, transports: ["websocket"], autoConnect: false, reconnection: false });
  try {
    return await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), 4_000);
      socket.once("connect", () => { clearTimeout(timer); resolve("connected"); });
      socket.once("connect_error", (err: Error) => { clearTimeout(timer); resolve(err.message); });
      socket.connect();
    });
  } finally {
    socket.disconnect();
  }
}

test("a retired session's token is refused at the socket handshake", async () => {
  await withEnv(true, async (app) => {
    await withMailbox(async (mailbox) => {
      const keys = await retiredDeviceIssuedKeys(app, mailbox);
      assert.equal(await socketHandshake(app, keys.device.accessToken), "Invalid or expired token");
      // The retired check itself, not only the device scope: a family that may
      // open sockets connects, and once marked retired it is refused too.
      const { familyId, token } = await signInForTest(keys.userId);
      assert.equal(await socketHandshake(app, token), "connected");
      await getDb().update(sessionFamilies).set({ retiredAt: new Date(), retiredReason: "migration" }).where(eq(sessionFamilies.id, familyId));
      assert.equal(await socketHandshake(app, token), "Invalid or expired token");
    });
  });
});
