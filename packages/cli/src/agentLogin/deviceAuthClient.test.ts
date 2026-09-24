import assert from "node:assert/strict";
import test from "node:test";

import type { fetch as undiciFetch } from "undici";

import {
  authorizeDeviceCode,
  DeviceCodeLoginError,
  describeDeviceCodeLoginError,
  pollDeviceToken,
  runDeviceCodeLogin,
} from "./deviceAuthClient.js";

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

test("authorizeDeviceCode returns the handle + absolutized verificationUriComplete", async () => {
  const fakeFetch = (async (input: FetchInput) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.endsWith("/api/auth/device/authorize")) {
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

  assert.equal(auth.deviceCode, "dc-9");
  assert.equal(auth.userCode, "WXYZ-7777");
  assert.equal(auth.verificationUri, "https://server.example.com/device");
  assert.equal(auth.verificationUriComplete, "https://server.example.com/device?user_code=WXYZ-7777");
  assert.equal(auth.intervalMs, 5000);
});

test("runDeviceCodeLogin surfaces verificationUriComplete to onUserAction", async () => {
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

  let seenComplete: string | undefined;
  await runDeviceCodeLogin({
    serverUrl: "https://server.example.com",
    fetchImpl: fakeFetch,
    pollIntervalOverrideMs: 0,
    onUserAction: ({ verificationUriComplete }) => {
      seenComplete = verificationUriComplete;
    },
  });

  assert.equal(seenComplete, "https://server.example.com/device?user_code=AAAA-1111");
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
