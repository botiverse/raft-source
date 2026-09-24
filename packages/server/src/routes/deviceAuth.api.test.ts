import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import argon2 from "argon2";

import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { openTestApp } from "../test/integration/app.js";
import { signAccessToken } from "../middleware/auth.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
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
    })
    .returning();
  return { id: u.id, bearer: signAccessToken(u.id) };
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

for (const killValue of ["false", "0", "no", "off", "FALSE", "False"]) {
  test(`device-code surface is killed by SLOCK_DEVICE_LOGIN_ENABLED="${killValue}"`, async () => {
    await withEnv({ gate: killValue }, async (app) => {
      const res = await fetch(`${app.baseUrl}/api/auth/device/authorize`, {
        method: "POST",
        headers: jsonHeaders(),
        body: "{}",
      });
      assert.equal(res.status, 404);
    });
  });
}

for (const liveValue of ["", "true", "1", "yes", "on"]) {
  test(`device-code surface is enabled by SLOCK_DEVICE_LOGIN_ENABLED="${liveValue}"`, async () => {
    await withEnv({ gate: liveValue }, async (app) => {
      const res = await fetch(`${app.baseUrl}/api/auth/device/authorize`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ clientName: "test" }),
      });
      assert.equal(res.status, 201);
    });
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
      verificationUriComplete: string;
      expiresIn: number;
      interval: number;
    };
    assert.ok(grant.deviceCode && grant.userCode);
    assert.equal(grant.verificationUri, "http://127.0.0.1:4173/login/device");
    assert.equal(grant.verificationUriComplete, `http://127.0.0.1:4173/login/device?user_code=${encodeURIComponent(grant.userCode)}`);

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

    // approve (user-authenticated)
    const approve = await fetch(`${app.baseUrl}/api/auth/device/approve`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ userCode: grant.userCode }),
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
