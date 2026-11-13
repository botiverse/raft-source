import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "vitest";

import argon2 from "argon2";
import jwt from "jsonwebtoken";

import { getDb } from "../db/index";
import { accountDeletionRequests, appLoginRequests, passwordResets, sessionFamilies, sessions, users } from "../db/schema";
import { eq } from "drizzle-orm";
import { openTestApp } from "../test/integration/app";
import { appLoginClientForReturnUri, isLoopbackAppLoginReturnUri } from "../services/appLoginService";
import { resetPassword } from "../services/userService";
import { accessTokenForTest, signInForTest } from "../test/integration/credentials";

// App login handoff (HarmonyOS web login): app starts with a PKCE challenge,
// the signed-in web user explicitly approves, the app exchanges the one-time
// code + verifier for a normal session. Pins: return-URI allowlist, explicit
// approve/deny, callback carries only code/error, single use, PKCE binding,
// expiry, and a usable session at the end.

const RETURN_URI = "raft://login/callback";

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function withApp<T>(fn: (app: Awaited<ReturnType<typeof openTestApp>>) => Promise<T>): Promise<T> {
  const oldAppUrl = process.env.APP_URL;
  process.env.APP_URL = "https://app.raft.test";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    return await fn(app);
  } finally {
    await app.close();
    if (oldAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = oldAppUrl;
  }
}

async function seedUser(): Promise<{ id: string; email: string; bearer: string }> {
  const suffix = randomUUID();
  const [u] = await getDb()
    .insert(users)
    .values({
      email: `app-login-${suffix}@slock.test`,
      name: `app-login-${suffix}`,
      displayName: "App Login Tester",
      passwordHash: await argon2.hash("password123"),
      emailVerified: true,
    })
    .returning();
  return { id: u.id, email: u.email, bearer: await accessTokenForTest(u.id) };
}

async function start(baseUrl: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/auth/app-login/start`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(body) });
}

test("app login: start → explicit approve → one-time code exchange issues a working session", async () => {
  await withApp(async (app) => {
    const user = await seedUser();
    const { verifier, challenge } = pkcePair();

    const startRes = await start(app.baseUrl, { returnUri: RETURN_URI, codeChallenge: challenge });
    assert.equal(startRes.status, 201);
    const started = await startRes.json() as { requestId: string; loginUrl: string; expiresAt: string };
    assert.equal(started.loginUrl, `https://app.raft.test/login/app?request=${started.requestId}`);

    // The confirmation page can read the request only when signed in.
    const anonymous = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${started.requestId}`);
    assert.equal(anonymous.status, 401);
    const described = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${started.requestId}`, {
      headers: { Authorization: `Bearer ${user.bearer}` },
    });
    assert.equal(described.status, 200);

    const approveRes = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${started.requestId}/approve`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${user.bearer}` }),
    });
    assert.equal(approveRes.status, 200);
    const { redirectUrl } = await approveRes.json() as { redirectUrl: string };
    const callback = new URL(redirectUrl);
    assert.equal(`${callback.protocol}//${callback.host}${callback.pathname}`, RETURN_URI);
    assert.deepEqual([...callback.searchParams.keys()], ["requestId", "code"], "callback carries the request id and the one-time code only");
    assert.equal(callback.searchParams.get("requestId"), started.requestId);
    const code = callback.searchParams.get("code")!;

    // A second approval cannot mint another code.
    const again = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${started.requestId}/approve`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${user.bearer}` }),
    });
    assert.equal(again.status, 409);

    // Wrong verifier is refused and does not burn the code.
    const wrong = await fetch(`${app.baseUrl}/api/auth/app-login/complete`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ code, codeVerifier: pkcePair().verifier }),
    });
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json() as { code: string }).code, "pkce_mismatch");

    const completeRes = await fetch(`${app.baseUrl}/api/auth/app-login/complete`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ code, codeVerifier: verifier }),
    });
    assert.equal(completeRes.status, 200);
    const session = await completeRes.json() as { user: { id: string }; accessToken: string; refreshToken: string };
    assert.equal(session.user.id, user.id);
    assert.ok(session.refreshToken);
    const me = await fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${session.accessToken}` } });
    assert.equal(me.status, 200);

    const replay = await fetch(`${app.baseUrl}/api/auth/app-login/complete`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ code, codeVerifier: verifier }),
    });
    assert.equal(replay.status, 410);
    assert.equal((await replay.json() as { code: string }).code, "code_consumed");
  });
});

test("app login: approve records the approving web session's family; a token with no family is refused", async () => {
  await withApp(async (app) => {
    const user = await seedUser();
    const { familyId, token } = await signInForTest(user.id);
    const approverFamilyOf = async (requestId: string) => (await getDb()
      .select({ family: appLoginRequests.approverFamilyId })
      .from(appLoginRequests)
      .where(eq(appLoginRequests.id, requestId)))[0]!.family;
    const approveWith = async (bearer: string, expectedStatus = 200) => {
      const started = await (await start(app.baseUrl, { returnUri: RETURN_URI, codeChallenge: pkcePair().challenge })).json() as { requestId: string };
      const res = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${started.requestId}/approve`, {
        method: "POST",
        headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      });
      assert.equal(res.status, expectedStatus);
      return started.requestId;
    };

    assert.equal(await approverFamilyOf(await approveWith(token)), familyId);
    // A (legacy) access token without a session family no longer authenticates at all.
    const familyless = jwt.sign({ sub: user.id, type: "access" }, process.env.JWT_SECRET!, { expiresIn: "15m" });
    assert.equal(await approverFamilyOf(await approveWith(familyless, 401)), null);
  });
});

test("app login: only allowlisted return URIs and S256 challenges start a request", async () => {
  await withApp(async (app) => {
    const { challenge } = pkcePair();
    for (const returnUri of ["raft://oauth/callback", "https://evil.test/cb", "raft://login/callback/extra"]) {
      const res = await start(app.baseUrl, { returnUri, codeChallenge: challenge });
      assert.equal(res.status, 400, returnUri);
      assert.equal((await res.json() as { code: string }).code, "return_uri_not_allowed");
    }
    // HarmonyOS's shared request DTO also sends platform / appEnv / method.
    const debug = await start(app.baseUrl, {
      returnUri: "raft-debug://login/callback",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      platform: "ohos",
      appEnv: "staging",
    });
    assert.equal(debug.status, 201);
    // The Mac app (Compose desktop) has its own scheme, not raft:// (claimed by the Electron app).
    const mac = await start(app.baseUrl, { returnUri: "raft-mac://login/callback", codeChallenge: challenge });
    assert.equal(mac.status, 201);
    for (const returnUri of ["raft-mac://oauth/callback", "raft-macos://login/callback"]) {
      const res = await start(app.baseUrl, { returnUri, codeChallenge: challenge });
      assert.equal(res.status, 400, returnUri);
    }
    const plainMethod = await start(app.baseUrl, { returnUri: RETURN_URI, codeChallenge: challenge, codeChallengeMethod: "plain" });
    assert.equal(plainMethod.status, 400);
    const plain = await start(app.baseUrl, { returnUri: RETURN_URI, codeChallenge: "short" });
    assert.equal(plain.status, 400);
    assert.equal((await plain.json() as { code: string }).code, "code_challenge_invalid");
  });
});

test("app login: deny returns access_denied to the app, and an expired request reports expired", async () => {
  await withApp(async (app) => {
    const user = await seedUser();
    const auth = jsonHeaders({ Authorization: `Bearer ${user.bearer}` });

    const denied = await (await start(app.baseUrl, { returnUri: RETURN_URI, codeChallenge: pkcePair().challenge })).json() as { requestId: string };
    const denyRes = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${denied.requestId}/deny`, { method: "POST", headers: auth });
    assert.equal(denyRes.status, 200);
    assert.equal((await denyRes.json() as { redirectUrl: string }).redirectUrl, `${RETURN_URI}?requestId=${denied.requestId}&error=access_denied`);
    const approveAfterDeny = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${denied.requestId}/approve`, { method: "POST", headers: auth });
    assert.equal(approveAfterDeny.status, 409);

    const expired = await (await start(app.baseUrl, { returnUri: RETURN_URI, codeChallenge: pkcePair().challenge })).json() as { requestId: string };
    await getDb().update(appLoginRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(appLoginRequests.id, expired.requestId));
    const approveExpired = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${expired.requestId}/approve`, { method: "POST", headers: auth });
    assert.equal(approveExpired.status, 410);
    const body = await approveExpired.json() as { code: string; redirectUrl: string };
    assert.equal(body.code, "request_expired");
    assert.equal(body.redirectUrl, `${RETURN_URI}?requestId=${expired.requestId}&error=expired`);

    const unknown = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${randomUUID()}/approve`, { method: "POST", headers: auth });
    assert.equal(unknown.status, 404);
  });
});

test("app login: an approved code expires with its request", async () => {
  await withApp(async (app) => {
    const user = await seedUser();
    const { verifier, challenge } = pkcePair();
    const started = await (await start(app.baseUrl, { returnUri: RETURN_URI, codeChallenge: challenge })).json() as { requestId: string };
    const approved = await (await fetch(`${app.baseUrl}/api/auth/app-login/requests/${started.requestId}/approve`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${user.bearer}` }),
    })).json() as { redirectUrl: string };
    const code = new URL(approved.redirectUrl).searchParams.get("code")!;
    await getDb().update(appLoginRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(appLoginRequests.id, started.requestId));
    const res = await fetch(`${app.baseUrl}/api/auth/app-login/complete`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ code, codeVerifier: verifier }),
    });
    assert.equal(res.status, 410);
    assert.equal((await res.json() as { code: string }).code, "code_expired");
  });
});

// Raft Desktop (Electron) uses an RFC 8252 loopback redirect on a random port.

const ACCEPTED_LOOPBACK = [
  "http://127.0.0.1:1/callback",
  "http://127.0.0.1:8080/callback",
  "http://127.0.0.1:49152/callback",
  "http://127.0.0.1:65535/callback",
  "http://[::1]:1/callback",
  "http://[::1]:53682/callback",
  "http://[::1]:65535/callback",
];

const REJECTED_LOOPBACK = [
  "http://localhost:53682/callback",
  "http://LOCALHOST:53682/callback",
  "https://127.0.0.1:53682/callback",
  "https://[::1]:53682/callback",
  "HTTP://127.0.0.1:53682/callback",
  "http://127.0.0.1:53682/CALLBACK",
  "http://127.0.0.1:53682/callback/",
  "http://127.0.0.1:53682/callback/extra",
  "http://127.0.0.1:53682/oauth/callback",
  "http://127.0.0.1:53682/",
  "http://127.0.0.1:53682",
  "http://127.0.0.1:53682/%63allback",
  "http://127.0.0.1:53682/./callback",
  "http://127.0.0.1:53682/x/../callback",
  "http://127.0.0.1:53682/callback?x=1",
  "http://127.0.0.1:53682/callback?",
  "http://127.0.0.1:53682/callback#frag",
  "http://127.0.0.1:53682/callback#",
  "http://user@127.0.0.1:53682/callback",
  "http://user:pass@127.0.0.1:53682/callback",
  "http://@127.0.0.1:53682/callback",
  "http://127.0.0.1/callback",
  "http://127.0.0.1:/callback",
  "http://[::1]/callback",
  "http://127.0.0.1:0/callback",
  "http://127.0.0.1:00080/callback",
  "http://127.0.0.1:080/callback",
  "http://127.0.0.1:80/callback",
  "http://[::1]:80/callback",
  "http://127.0.0.1:65536/callback",
  "http://127.0.0.1:99999/callback",
  "http://127.0.0.1:123456/callback",
  "http://127.0.0.1:-1/callback",
  "http://127.1:53682/callback",
  "http://127.0.1:53682/callback",
  "http://0x7f.0.0.1:53682/callback",
  "http://0x7f000001:53682/callback",
  "http://2130706433:53682/callback",
  "http://0177.0.0.1:53682/callback",
  "http://127.000.000.001:53682/callback",
  "http://127.0.0.2:53682/callback",
  "http://0.0.0.0:53682/callback",
  "http://127.0.0.1.nip.io:53682/callback",
  "http://127.0.0.1%2e:53682/callback",
  "http://127%2e0%2e0%2e1:53682/callback",
  "http://127.0.0.1.:53682/callback",
  "http://[0:0:0:0:0:0:0:1]:53682/callback",
  "http://[::ffff:127.0.0.1]:53682/callback",
  "http://[::1%25lo0]:53682/callback",
  "http://::1:53682/callback",
  "http://127.0.0.1:53682\\callback",
  "http:/127.0.0.1:53682/callback",
  "http:\\\\127.0.0.1:53682/callback",
  "//127.0.0.1:53682/callback",
  " http://127.0.0.1:53682/callback",
  "http://127.0.0.1:53682/callback ",
  "http://127.0.0.1:53682/callback\n",
  "http://127.0.0.1:53682/call\tback",
  "http://evil.test@127.0.0.1:53682/callback",
  "http://127.0.0.1:53682@evil.test/callback",
  "raft://127.0.0.1:53682/callback",
];

test("app login loopback: strict acceptance of http://127.0.0.1|[::1]:<port>/callback", () => {
  for (const uri of ACCEPTED_LOOPBACK) {
    assert.equal(isLoopbackAppLoginReturnUri(uri), true, uri);
    assert.deepEqual(appLoginClientForReturnUri(uri, {}), { id: "raft-desktop", name: "Raft Desktop" }, uri);
  }
  for (const uri of REJECTED_LOOPBACK) {
    assert.equal(isLoopbackAppLoginReturnUri(uri), false, JSON.stringify(uri));
    assert.equal(appLoginClientForReturnUri(uri, {}), null, JSON.stringify(uri));
  }
});

test("app login clients: derived from the return URI; env override keeps working", () => {
  const expected: Array<[string, { id: string; name: string } | null]> = [
    ["raft://login/callback", { id: "raft-app", name: "Raft" }],
    ["raft-alpha://login/callback", { id: "raft-app", name: "Raft" }],
    ["raft-beta://login/callback", { id: "raft-app", name: "Raft" }],
    ["raft-debug://login/callback", { id: "raft-app", name: "Raft" }],
    ["raft-mac://login/callback", { id: "raft-mac", name: "Raft for Mac" }],
    ["http://127.0.0.1:53682/callback", { id: "raft-desktop", name: "Raft Desktop" }],
    ["raft://oauth/callback", null],
    ["https://evil.test/cb", null],
  ];
  for (const [uri, client] of expected) assert.deepEqual(appLoginClientForReturnUri(uri, {}), client, uri);

  // APP_LOGIN_RETURN_URIS replaces the exact-URI allowlist, as before: a
  // registry URI keeps its client, an env-only URI gets the generic client,
  // and an unlisted registry URI is refused. Loopback stays pattern-based.
  const env = { APP_LOGIN_RETURN_URIS: "raft-mac://login/callback, raft-staging://login/callback" };
  assert.deepEqual(appLoginClientForReturnUri("raft-mac://login/callback", env), { id: "raft-mac", name: "Raft for Mac" });
  assert.deepEqual(appLoginClientForReturnUri("raft-staging://login/callback", env), { id: "custom", name: "Raft" });
  assert.equal(appLoginClientForReturnUri("raft://login/callback", env), null);
  assert.deepEqual(appLoginClientForReturnUri("http://[::1]:4000/callback", env), { id: "raft-desktop", name: "Raft Desktop" });
  assert.equal(appLoginClientForReturnUri("http://localhost:4000/callback", env), null);
});

async function approveFor(baseUrl: string, bearer: string, requestId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/app-login/requests/${requestId}/approve`, {
    method: "POST",
    headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
  });
  assert.equal(res.status, 200);
  return (await res.json() as { redirectUrl: string }).redirectUrl;
}

async function complete(baseUrl: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/auth/app-login/complete`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(body) });
}

test("app login loopback: start → describe (client, createdAt) → approve → callback on the loopback port → exchange", async () => {
  await withApp(async (app) => {
    const user = await seedUser();
    for (const returnUri of ["http://127.0.0.1:53682/callback", "http://[::1]:61001/callback"]) {
      const { verifier, challenge } = pkcePair();
      const before = Date.now();
      const startRes = await start(app.baseUrl, { returnUri, codeChallenge: challenge, codeChallengeMethod: "S256" });
      assert.equal(startRes.status, 201, returnUri);
      const started = await startRes.json() as { requestId: string; client: { id: string; name: string } };
      assert.deepEqual(started.client, { id: "raft-desktop", name: "Raft Desktop" });

      const described = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${started.requestId}`, {
        headers: { Authorization: `Bearer ${user.bearer}` },
      });
      assert.equal(described.status, 200);
      const info = await described.json() as { expiresAt: string; createdAt: string; client: { id: string; name: string } };
      assert.deepEqual(info.client, { id: "raft-desktop", name: "Raft Desktop" });
      assert.equal(new Date(info.createdAt).toISOString(), info.createdAt);
      assert.ok(Math.abs(new Date(info.createdAt).getTime() - before) < 60_000);
      assert.ok(new Date(info.createdAt).getTime() < new Date(info.expiresAt).getTime());

      const redirectUrl = await approveFor(app.baseUrl, user.bearer, started.requestId);
      const callback = new URL(redirectUrl);
      assert.equal(`${callback.protocol}//${callback.host}${callback.pathname}`, returnUri);
      assert.deepEqual([...callback.searchParams.keys()], ["requestId", "code"]);
      const code = callback.searchParams.get("code")!;

      // Wrong verifier, then a mismatched return URI: refused, neither burns the code.
      const wrongVerifier = await complete(app.baseUrl, { code, codeVerifier: pkcePair().verifier, returnUri });
      assert.equal(wrongVerifier.status, 400);
      assert.equal((await wrongVerifier.json() as { code: string }).code, "pkce_mismatch");
      for (const other of ["http://127.0.0.1:53683/callback", "raft://login/callback", ""]) {
        const wrongUri = await complete(app.baseUrl, { code, codeVerifier: verifier, returnUri: other });
        assert.equal(wrongUri.status, 400, other);
        assert.equal((await wrongUri.json() as { code: string }).code, "return_uri_mismatch");
      }
      // A loopback client must send its return URI.
      const missingUri = await complete(app.baseUrl, { code, codeVerifier: verifier });
      assert.equal(missingUri.status, 400);
      assert.equal((await missingUri.json() as { code: string }).code, "return_uri_mismatch");
      const badType = await complete(app.baseUrl, { code, codeVerifier: verifier, returnUri: 1 });
      assert.equal(badType.status, 400);
      assert.equal((await badType.json() as { code: string }).code, "invalid_request");

      const ok = await complete(app.baseUrl, { code, codeVerifier: verifier, returnUri });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json() as { user: { id: string } }).user.id, user.id);

      const replay = await complete(app.baseUrl, { code, codeVerifier: verifier, returnUri });
      assert.equal(replay.status, 410);
      assert.equal((await replay.json() as { code: string }).code, "code_consumed");
    }
  });
});

test("app login: GET request returns client + createdAt per return URI", async () => {
  await withApp(async (app) => {
    const user = await seedUser();
    const cases: Array<[string, { id: string; name: string }]> = [
      ["raft://login/callback", { id: "raft-app", name: "Raft" }],
      ["raft-debug://login/callback", { id: "raft-app", name: "Raft" }],
      ["raft-mac://login/callback", { id: "raft-mac", name: "Raft for Mac" }],
      ["http://127.0.0.1:40000/callback", { id: "raft-desktop", name: "Raft Desktop" }],
    ];
    for (const [returnUri, client] of cases) {
      const started = await (await start(app.baseUrl, { returnUri, codeChallenge: pkcePair().challenge })).json() as { requestId: string };
      const res = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${started.requestId}`, {
        headers: { Authorization: `Bearer ${user.bearer}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { client: unknown; createdAt: string; expiresAt: string };
      assert.deepEqual(Object.keys(body).sort(), ["client", "createdAt", "expiresAt"]);
      assert.deepEqual(body.client, client, returnUri);
      const [row] = await getDb().select({ createdAt: appLoginRequests.createdAt }).from(appLoginRequests).where(eq(appLoginRequests.id, started.requestId));
      assert.equal(body.createdAt, row!.createdAt.toISOString());
    }
  });
});

test("app login: client is derived, never self-declared; loopback forms rejected at start", async () => {
  await withApp(async (app) => {
    const { challenge } = pkcePair();
    for (const returnUri of REJECTED_LOOPBACK) {
      const res = await start(app.baseUrl, { returnUri, codeChallenge: challenge });
      assert.equal(res.status, 400, JSON.stringify(returnUri));
      assert.equal((await res.json() as { code: string }).code, "return_uri_not_allowed");
    }
    // A matching optional clientId is accepted; any other is refused.
    const matching: Array<[string, string]> = [
      ["http://127.0.0.1:53682/callback", "raft-desktop"],
      ["raft://login/callback", "raft-app"],
      ["raft-mac://login/callback", "raft-mac"],
    ];
    for (const [returnUri, clientId] of matching) {
      const res = await start(app.baseUrl, { returnUri, codeChallenge: challenge, clientId });
      assert.equal(res.status, 201, `${returnUri} ${clientId}`);
    }
    const mismatched: Array<[string, string]> = [
      ["raft://login/callback", "raft-desktop"],
      ["raft-mac://login/callback", "raft-app"],
      ["http://127.0.0.1:53682/callback", "raft-app"],
      ["http://127.0.0.1:53682/callback", "raft-mac"],
      ["http://[::1]:53682/callback", "custom"],
    ];
    for (const [returnUri, clientId] of mismatched) {
      const res = await start(app.baseUrl, { returnUri, codeChallenge: challenge, clientId });
      assert.equal(res.status, 400, `${returnUri} ${clientId}`);
      assert.equal((await res.json() as { code: string }).code, "client_mismatch");
    }
    const badType = await start(app.baseUrl, { returnUri: RETURN_URI, codeChallenge: challenge, clientId: 7 });
    assert.equal(badType.status, 400);
    // PKCE S256 is still required for loopback.
    const plain = await start(app.baseUrl, { returnUri: "http://127.0.0.1:53682/callback", codeChallenge: challenge, codeChallengeMethod: "plain" });
    assert.equal(plain.status, 400);
    const short = await start(app.baseUrl, { returnUri: "http://127.0.0.1:53682/callback", codeChallenge: "short" });
    assert.equal(short.status, 400);
    assert.equal((await short.json() as { code: string }).code, "code_challenge_invalid");
  });
});

test("app login: raft:// exchange still works without returnUri, and checks it when sent", async () => {
  await withApp(async (app) => {
    const user = await seedUser();
    const exchangeWith = async (returnUri: string | undefined) => {
      const { verifier, challenge } = pkcePair();
      const started = await (await start(app.baseUrl, { returnUri: RETURN_URI, codeChallenge: challenge })).json() as { requestId: string };
      const code = new URL(await approveFor(app.baseUrl, user.bearer, started.requestId)).searchParams.get("code")!;
      return complete(app.baseUrl, { code, codeVerifier: verifier, ...(returnUri === undefined ? {} : { returnUri }) });
    };
    assert.equal((await exchangeWith(undefined)).status, 200);
    assert.equal((await exchangeWith(RETURN_URI)).status, 200);
    const mismatch = await exchangeWith("raft-mac://login/callback");
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json() as { code: string }).code, "return_uri_mismatch");
  });
});

test("app login loopback: an approved code cannot be exchanged after expiry, and an expired request cancels to the loopback URI", async () => {
  await withApp(async (app) => {
    const user = await seedUser();
    const returnUri = "http://[::1]:50123/callback";
    const { verifier, challenge } = pkcePair();
    const started = await (await start(app.baseUrl, { returnUri, codeChallenge: challenge })).json() as { requestId: string };
    const code = new URL(await approveFor(app.baseUrl, user.bearer, started.requestId)).searchParams.get("code")!;
    await getDb().update(appLoginRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(appLoginRequests.id, started.requestId));
    const res = await complete(app.baseUrl, { code, codeVerifier: verifier, returnUri });
    assert.equal(res.status, 410);
    assert.equal((await res.json() as { code: string }).code, "code_expired");

    const pending = await (await start(app.baseUrl, { returnUri, codeChallenge: challenge })).json() as { requestId: string };
    await getDb().update(appLoginRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(appLoginRequests.id, pending.requestId));
    const described = await fetch(`${app.baseUrl}/api/auth/app-login/requests/${pending.requestId}`, {
      headers: { Authorization: `Bearer ${user.bearer}` },
    });
    assert.equal(described.status, 410);
    assert.equal((await described.json() as { redirectUrl: string }).redirectUrl, `${returnUri}?requestId=${pending.requestId}&error=expired`);
  });
});

test("app login: the one-time code expires 2 minutes after approval, capped by the request expiry", async () => {
  await withApp(async (app) => {
    const user = await seedUser();
    // Approve, then backdate approvedAt by `ageMs` (the request itself stays valid).
    const approvedCode = async (ageMs: number, returnUri = RETURN_URI) => {
      const { verifier, challenge } = pkcePair();
      const started = await (await start(app.baseUrl, { returnUri, codeChallenge: challenge })).json() as { requestId: string };
      const code = new URL(await approveFor(app.baseUrl, user.bearer, started.requestId)).searchParams.get("code")!;
      await getDb().update(appLoginRequests).set({ approvedAt: new Date(Date.now() - ageMs) }).where(eq(appLoginRequests.id, started.requestId));
      return { code, verifier, requestId: started.requestId };
    };

    for (const returnUri of [RETURN_URI, "raft-mac://login/callback", "http://127.0.0.1:53682/callback"]) {
      const fresh = await approvedCode(119_000, returnUri);
      const ok = await complete(app.baseUrl, { code: fresh.code, codeVerifier: fresh.verifier, returnUri });
      assert.equal(ok.status, 200, `${returnUri} at approval+119s`);

      const stale = await approvedCode(121_000, returnUri);
      const expired = await complete(app.baseUrl, { code: stale.code, codeVerifier: stale.verifier, returnUri });
      assert.equal(expired.status, 410, `${returnUri} at approval+121s`);
      assert.equal((await expired.json() as { code: string }).code, "code_expired");
    }

    // Approved moments ago, but the request expired: the request cap wins.
    const capped = await approvedCode(1_000);
    await getDb().update(appLoginRequests).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(appLoginRequests.id, capped.requestId));
    const cappedRes = await complete(app.baseUrl, { code: capped.code, codeVerifier: capped.verifier });
    assert.equal(cappedRes.status, 410);
    assert.equal((await cappedRes.json() as { code: string }).code, "code_expired");
  });
});

// The code dies with the sign-in that approved it (#raft-architecture
// msg=532a7a40, B1). Two guards, each enough alone: the exchange refuses a
// code whose approver is no longer live, and every revoke of the approver
// denies the codes it approved.

type Approver = Awaited<ReturnType<typeof signInForTest>>;

async function approvedCodeBy(baseUrl: string, approver: Approver) {
  const { verifier, challenge } = pkcePair();
  const started = await (await start(baseUrl, { returnUri: RETURN_URI, codeChallenge: challenge })).json() as { requestId: string };
  const code = new URL(await approveFor(baseUrl, approver.token, started.requestId)).searchParams.get("code")!;
  return { code, verifier, requestId: started.requestId };
}

async function familyIdsOf(userId: string): Promise<string[]> {
  return (await getDb().select({ id: sessionFamilies.id }).from(sessionFamilies).where(eq(sessionFamilies.userId, userId)))
    .map((family) => family.id).sort();
}

async function statusOf(requestId: string) {
  return (await getDb().select({ status: appLoginRequests.status }).from(appLoginRequests).where(eq(appLoginRequests.id, requestId)))[0]!.status;
}

async function logout(baseUrl: string, approver: Approver) {
  const res = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ refreshToken: approver.refreshToken }) });
  assert.equal(res.status, 200);
}

async function resetThePassword(userId: string) {
  const token = randomUUID();
  await getDb().insert(passwordResets).values({
    userId, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60_000),
  });
  assert.deepEqual(await resetPassword(token, "a-new-password-456"), { success: true, userId });
}

/** Exchanged after its approver went: the expired code's answer, and no session issued. */
async function assertRefused(baseUrl: string, userId: string, approved: { code: string; verifier: string }, label: string) {
  const families = await familyIdsOf(userId);
  const res = await complete(baseUrl, { code: approved.code, codeVerifier: approved.verifier });
  assert.equal(res.status, 410, label);
  assert.deepEqual(await res.json(), { error: "App login code could not be exchanged", code: "code_expired" }, label);
  assert.deepEqual(await familyIdsOf(userId), families, `${label}: no session issued`);
}

test("app login: a code dies with the sign-in that approved it (a logout, a password reset); a live sign-in's code still works", async () => {
  await withApp(async (app) => {
    const user = await seedUser();
    const signedOut = await signInForTest(user.id);
    const live = await signInForTest(user.id);
    const ofSignedOut = await approvedCodeBy(app.baseUrl, signedOut);
    const ofLive = await approvedCodeBy(app.baseUrl, live);

    await logout(app.baseUrl, signedOut);
    await assertRefused(app.baseUrl, user.id, ofSignedOut, "approver signed out");
    // Another sign-in of the same person is untouched.
    const ok = await complete(app.baseUrl, { code: ofLive.code, codeVerifier: ofLive.verifier });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json() as { user: { id: string } }).user.id, user.id);

    const beforeReset = await approvedCodeBy(app.baseUrl, await signInForTest(user.id));
    await resetThePassword(user.id);
    await assertRefused(app.baseUrl, user.id, beforeReset, "password reset after approval");
  });
});

test("app login: revoking a sign-in denies the codes it approved that nobody exchanged; a password reset denies every one of the person's", async () => {
  await withApp(async (app) => {
    const user = await seedUser();
    const signedOut = await signInForTest(user.id);
    const other = await signInForTest(user.id);
    const ofSignedOut = await approvedCodeBy(app.baseUrl, signedOut);
    const ofOther = await approvedCodeBy(app.baseUrl, other);
    const pending = await (await start(app.baseUrl, { returnUri: RETURN_URI, codeChallenge: pkcePair().challenge })).json() as { requestId: string };

    await logout(app.baseUrl, signedOut);
    assert.equal(await statusOf(ofSignedOut.requestId), "denied");
    assert.equal(await statusOf(ofOther.requestId), "approved", "another sign-in's code stays");
    assert.equal(await statusOf(pending.requestId), "pending", "an unapproved request is no one's yet");

    await resetThePassword(user.id);
    assert.equal(await statusOf(ofOther.requestId), "denied");
    assert.equal(await statusOf(pending.requestId), "pending");
  });
});

test("app login: the exchange itself refuses a code whose approver is no longer live, though nothing denied it", async () => {
  await withApp(async (app) => {
    // Each case changes state the way no revoker does here, so the code stays `approved`.
    const cases: Array<[string, (userId: string, approver: Approver, requestId: string) => Promise<void>]> = [
      ["family revoked", async (_userId, approver) => {
        await getDb().update(sessionFamilies).set({ revokedAt: new Date(), revokedReason: "logout" }).where(eq(sessionFamilies.id, approver.familyId));
      }],
      ["family retired", async (_userId, approver) => {
        await getDb().update(sessionFamilies).set({ retiredAt: new Date(), retiredReason: "migration" }).where(eq(sessionFamilies.id, approver.familyId));
      }],
      ["family's sessions expired", async (_userId, approver) => {
        await getDb().update(sessions).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(sessions.familyId, approver.familyId));
      }],
      ["person retired", async (userId) => {
        await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, userId));
      }],
      ["account deletion pending", async (userId) => {
        await getDb().insert(accountDeletionRequests).values({
          userId, source: "self", requestedAt: new Date(), scheduledFor: new Date(Date.now() + 86_400_000), state: "pending",
        });
      }],
      ["no approver recorded (approved before the column)", async (_userId, _approver, requestId) => {
        await getDb().update(appLoginRequests).set({ approverFamilyId: null }).where(eq(appLoginRequests.id, requestId));
      }],
    ];
    for (const [label, kill] of cases) {
      const user = await seedUser();
      const approver = await signInForTest(user.id);
      const approved = await approvedCodeBy(app.baseUrl, approver);
      await kill(user.id, approver, approved.requestId);
      await assertRefused(app.baseUrl, user.id, approved, label);
      assert.equal(await statusOf(approved.requestId), "approved", `${label}: refused at the exchange, not consumed`);
    }
  });
});
