import assert from "node:assert/strict";

import type { fetch as undiciFetch } from "undici";

import {
  authorizeDeviceCode,
  DeviceCodeLoginError,
  describeDeviceCodeLoginError,
  pollAgentKey,
  pollDeviceToken,
  runDeviceCodeLogin,
} from "./deviceAuthClient";

type UndiciFetch = typeof undiciFetch;
type FetchInput = Parameters<UndiciFetch>[0];
type FetchInit = Parameters<UndiciFetch>[1];

function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("runDeviceCodeLogin drives authorize → onUserAction → token poll", async () => {
  const recorded: Array<{ url: string; init?: FetchInit }> = [];
  let polledOnce = false;
  const fakeFetch = (async (input: FetchInput, init?: FetchInit) => {
    const url = typeof input === "string" ? input : String(input);
    recorded.push({ url, init });
    if (url.endsWith("/api/auth/device/authorize")) {
      return makeJsonResponse(201, {
        deviceCode: "dc-1",
        userCode: "ABCD-1234",
        verificationUri: "/device",
        expiresIn: 600,
        interval: 0,
      });
    }
    if (url.endsWith("/api/auth/device/token")) {
      if (!polledOnce) {
        polledOnce = true;
        return makeJsonResponse(400, { code: "authorization_pending", error: "..." });
      }
      return makeJsonResponse(200, {
        accessToken: "user-access-1",
        refreshToken: "user-refresh-1",
        userId: "user-1",
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as UndiciFetch;

  let userActionCalls = 0;
  const result = await runDeviceCodeLogin({
    serverUrl: "https://server.example.com/",
    clientName: "slock-cli/test",
    fetchImpl: fakeFetch,
    pollIntervalOverrideMs: 0,
    onUserAction: ({ verificationUri, userCode }) => {
      userActionCalls += 1;
      assert.equal(userCode, "ABCD-1234");
      assert.equal(verificationUri, "https://server.example.com/device");
    },
  });

  assert.equal(result.accessToken, "user-access-1");
  assert.equal(result.refreshToken, "user-refresh-1");
  assert.equal(result.userId, "user-1");
  assert.equal(userActionCalls, 1);
  // 3 calls: authorize + pending + success
  assert.equal(recorded.length, 3);
  assert.match(recorded[0]!.url, /\/api\/auth\/device\/authorize$/);
  assert.match(recorded[1]!.url, /\/api\/auth\/device\/token$/);
  assert.match(recorded[2]!.url, /\/api\/auth\/device\/token$/);
});

test("runDeviceCodeLogin throws DeviceCodeLoginError on access_denied", async () => {
  const fakeFetch = (async (input: FetchInput) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.endsWith("/authorize")) {
      return makeJsonResponse(201, {
        deviceCode: "dc-2",
        userCode: "ZZZZ-9999",
        verificationUri: "/device",
        expiresIn: 600,
        interval: 0,
      });
    }
    if (url.endsWith("/token")) {
      return makeJsonResponse(403, { code: "access_denied", error: "denied" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as UndiciFetch;

  await assert.rejects(
    () =>
      runDeviceCodeLogin({
        serverUrl: "https://server.example.com",
        fetchImpl: fakeFetch,
        pollIntervalOverrideMs: 0,
        onUserAction: () => {},
      }),
    (err: unknown) =>
      err instanceof DeviceCodeLoginError &&
      err.code === "access_denied" &&
      err.message === describeDeviceCodeLoginError("access_denied"),
  );
});

test("runDeviceCodeLogin throws on device_login_disabled (authorize-side 404)", async () => {
  const fakeFetch = (async () =>
    makeJsonResponse(404, { code: "device_login_disabled", error: "..." })) as unknown as UndiciFetch;

  await assert.rejects(
    () =>
      runDeviceCodeLogin({
        serverUrl: "https://server.example.com",
        fetchImpl: fakeFetch,
        pollIntervalOverrideMs: 0,
        onUserAction: () => {},
      }),
    (err: unknown) =>
      err instanceof DeviceCodeLoginError && err.code === "device_login_disabled",
  );
});

test("authorizeDeviceCode returns the handle + absolutized verificationUri, never a link with the code in it", async () => {
  const bodies: unknown[] = [];
  const fakeFetch = (async (input: FetchInput, init?: FetchInit) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.endsWith("/api/auth/device/authorize")) {
      bodies.push(JSON.parse(String(init?.body)));
      // An older server still sends verification_uri_complete: ignored.
      return makeJsonResponse(201, {
        deviceCode: "dc-9",
        userCode: "WXYZ-7777",
        verificationUri: "/device",
        verificationUriComplete: "/device?user_code=WXYZ-7777",
        expiresIn: 600,
        interval: 5,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as UndiciFetch;

  const auth = await authorizeDeviceCode({
    serverUrl: "https://server.example.com/",
    fetchImpl: fakeFetch,
  });

  assert.deepEqual(auth, {
    deviceCode: "dc-9",
    userCode: "WXYZ-7777",
    verificationUri: "https://server.example.com/device",
    expiresInSeconds: 600,
    intervalMs: 5000,
  });
  // The approval page names the program: the CLI's own name unless the caller gives one.
  assert.deepEqual(bodies, [{ clientName: "raft-cli" }]);
});

test("runDeviceCodeLogin hands onUserAction the approval page and the code to type, not a pre-filled link", async () => {
  let polledOnce = false;
  const fakeFetch = (async (input: FetchInput) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.endsWith("/authorize")) {
      return makeJsonResponse(201, {
        deviceCode: "dc-10",
        userCode: "AAAA-1111",
        verificationUri: "https://server.example.com/device",
        verificationUriComplete: "https://server.example.com/device?user_code=AAAA-1111",
        expiresIn: 600,
        interval: 0,
      });
    }
    if (url.endsWith("/token")) {
      if (!polledOnce) {
        polledOnce = true;
        return makeJsonResponse(400, { code: "authorization_pending" });
      }
      return makeJsonResponse(200, {
        accessToken: "a",
        refreshToken: "r",
        userId: "u",
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as UndiciFetch;

  let seen: unknown;
  await runDeviceCodeLogin({
    serverUrl: "https://server.example.com",
    fetchImpl: fakeFetch,
    pollIntervalOverrideMs: 0,
    onUserAction: (action) => {
      seen = action;
    },
  });

  assert.deepEqual(seen, { verificationUri: "https://server.example.com/device", userCode: "AAAA-1111", expiresInSeconds: 600 });
});

test("pollDeviceToken resumes polling with a device_code and returns the session", async () => {
  let polls = 0;
  const fakeFetch = (async (input: FetchInput, init?: FetchInit) => {
    const url = typeof input === "string" ? input : String(input);
    assert.match(url, /\/api\/auth\/device\/token$/);
    assert.equal(JSON.parse(String(init?.body)).deviceCode, "dc-resume");
    polls += 1;
    if (polls < 2) {
      return makeJsonResponse(400, { code: "authorization_pending" });
    }
    return makeJsonResponse(200, {
      accessToken: "resume-access",
      refreshToken: "resume-refresh",
      userId: "resume-user",
    });
  }) as unknown as UndiciFetch;

  const result = await pollDeviceToken({
    serverUrl: "https://server.example.com",
    deviceCode: "dc-resume",
    pollIntervalMs: 0,
    deadlineMs: Date.now() + 60_000,
    fetchImpl: fakeFetch,
  });

  assert.equal(result.accessToken, "resume-access");
  assert.equal(polls, 2);
});

test("pollDeviceToken throws expired_token once the deadline passes", async () => {
  const fakeFetch = (async () =>
    makeJsonResponse(400, { code: "authorization_pending" })) as unknown as UndiciFetch;

  await assert.rejects(
    () =>
      pollDeviceToken({
        serverUrl: "https://server.example.com",
        deviceCode: "dc-dead",
        pollIntervalMs: 0,
        deadlineMs: Date.now() - 1, // already past
        fetchImpl: fakeFetch,
      }),
    (err: unknown) => err instanceof DeviceCodeLoginError && err.code === "expired_token",
  );
});

test("authorizeDeviceCode sends an agent_key grant only when asked for one", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fakeFetch = (async (_input: FetchInput, init?: FetchInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return makeJsonResponse(201, { deviceCode: "dc", userCode: "UC", verificationUri: "/login/device", expiresIn: 600, interval: 5 });
  }) as unknown as UndiciFetch;
  const grant = { kind: "agent_key" as const, machineName: "raft-cli", hostname: "host", os: "Linux", agentId: "11111111-2222-3333-4444-555555555555" };
  await authorizeDeviceCode({ serverUrl: "https://server.example.com", grant, fetchImpl: fakeFetch });
  await authorizeDeviceCode({ serverUrl: "https://server.example.com", fetchImpl: fakeFetch });
  assert.deepEqual(bodies[0], { clientName: "raft-cli", grant });
  assert.deepEqual(bodies[1], { clientName: "raft-cli" });
});

test("pollAgentKey returns the agent key, reads a session only from an older server's non-grant answer, and refuses anything else", async () => {
  const poll = (body: unknown) => pollAgentKey({
    serverUrl: "https://server.example.com",
    deviceCode: "dc",
    pollIntervalMs: 0,
    deadlineMs: Date.now() + 60_000,
    fetchImpl: (async () => makeJsonResponse(200, body)) as unknown as UndiciFetch,
  });
  const key = { credentialId: "cred-1", apiKey: "sk_agent_abc", scopes: ["read"], agentId: "agent-1", agentName: "Keyed", serverId: "server-1" };
  assert.deepEqual(await poll({ kind: "agent_key", ...key }), { kind: "agent_key", credential: key });

  const session = { accessToken: "a", refreshToken: "r", userId: "u" };
  assert.deepEqual(await poll(session), { kind: "legacy_session", session });

  for (const bad of [
    { kind: "agent_key", ...key, apiKey: "not-a-key" },
    { kind: "agent_key", ...key, serverId: undefined },
    { kind: "agent_key", ...session },
    { kind: "computer_attach", ...session },
    {},
  ]) {
    await assert.rejects(poll(bad), (err: unknown) => err instanceof DeviceCodeLoginError && err.code === "token_response_invalid");
  }
});
