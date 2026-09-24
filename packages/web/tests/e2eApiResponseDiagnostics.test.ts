import assert from "node:assert/strict";
import test from "node:test";
import type { APIResponse } from "@playwright/test";
import { assertApiOk } from "../tests/e2e/fixtures/apiResponse";

/**
 * The point of `assertApiOk` is that a failing e2e setup call leaves behind
 * enough evidence to tell 403 from 429 from 500. `expect(response.ok())` did
 * not: seven consecutive `e2e (4)` reds on staging reported only
 * `Received: false`. These teeth pin the diagnostic content, so a future
 * refactor cannot quietly go back to a verdict-only failure.
 */

function fakeResponse(init: {
  ok: boolean;
  status: number;
  statusText: string;
  url?: string;
  text?: () => Promise<string>;
}): APIResponse {
  return {
    ok: () => init.ok,
    status: () => init.status,
    statusText: () => init.statusText,
    url: () => init.url ?? "http://127.0.0.1:4174/api/messages",
    text: init.text ?? (async () => ""),
  } as unknown as APIResponse;
}

async function messageFrom(response: APIResponse, label: string): Promise<string> {
  try {
    await assertApiOk(response, label);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "<did not throw>";
}

test("a successful response does not throw and does not read the body", async () => {
  let bodyReads = 0;
  const response = fakeResponse({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => {
      bodyReads += 1;
      return "should not be read";
    },
  });

  await assertApiOk(response, "POST /api/messages");

  assert.equal(bodyReads, 0, "success path must not consume the response body");
});

test("a rejected request reports the status code, not just a false verdict", async () => {
  const message = await messageFrom(
    fakeResponse({ ok: false, status: 403, statusText: "Forbidden" }),
    "POST /api/messages (channelId=c1)",
  );

  assert.match(message, /403/);
  assert.match(message, /Forbidden/);
  assert.match(message, /POST \/api\/messages \(channelId=c1\)/);
});

test("the server's reason survives in the failure — 403 and 429 stay distinguishable", async () => {
  const forbidden = await messageFrom(
    fakeResponse({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => JSON.stringify({ error: "Not a member of this server" }),
    }),
    "POST /api/messages",
  );
  const throttled = await messageFrom(
    fakeResponse({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: async () => JSON.stringify({ error: "rate limited" }),
    }),
    "POST /api/messages",
  );

  assert.match(forbidden, /Not a member of this server/);
  assert.match(throttled, /rate limited/);
  assert.notEqual(forbidden, throttled);
});

test("the failing url is reported", async () => {
  const message = await messageFrom(
    fakeResponse({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      url: "http://127.0.0.1:4174/api/channels/abc/read-all",
    }),
    "POST read-all",
  );

  assert.match(message, /http:\/\/127\.0\.0\.1:4174\/api\/channels\/abc\/read-all/);
});

test("an oversized body is truncated rather than flooding the CI log", async () => {
  const message = await messageFrom(
    fakeResponse({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "x".repeat(5000),
    }),
    "POST /api/messages",
  );

  assert.match(message, /truncated/);
  assert.ok(message.length < 1500, `failure message should stay readable, got ${message.length} chars`);
});

test("an empty body is labelled instead of vanishing", async () => {
  const message = await messageFrom(
    fakeResponse({ ok: false, status: 502, statusText: "Bad Gateway", text: async () => "" }),
    "POST /api/messages",
  );

  assert.match(message, /<empty>/);
  assert.match(message, /502/);
});

test("an unreadable body still yields the status instead of masking it", async () => {
  const message = await messageFrom(
    fakeResponse({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: async () => {
        throw new Error("socket hang up");
      },
    }),
    "POST /api/messages",
  );

  assert.match(message, /503/);
  assert.match(message, /socket hang up/);
});
