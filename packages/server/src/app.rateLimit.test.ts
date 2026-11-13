import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request } from "express";
import { MemoryStore } from "express-rate-limit";
import { asMachineId } from "@botiverse/raft-shared";
import {
  oauthIdentityTokenLimiter,
  rateLimitUserMachineOrIpKey,
  rateLimitUserOrIpKey,
  shouldSkipAttachmentRateLimit,
  shouldSkipAuthRateLimit,
  shouldSkipProductFeedbackRateLimit,
} from "./app";
import { oauthIdentityTokenRateLimitKey } from "./routes/oauth";

test("rate limit keys preserve authenticated principal identity before IP fallback", () => {
  assert.equal(rateLimitUserOrIpKey({ userId: "user-1", ip: "2001:db8::1" }), "user-1");
  assert.equal(
    rateLimitUserMachineOrIpKey({
      userId: undefined,
      machineId: asMachineId("machine-1"),
      ip: "2001:db8::1",
    }),
    "machine-1",
  );
});

test("rate limit IP fallback normalizes IPv6 subnets", () => {
  assert.equal(rateLimitUserOrIpKey({ ip: "2001:db8::1" }), "2001:db8::/56");
  assert.equal(rateLimitUserMachineOrIpKey({ ip: "2001:db8::abcd:1" }), "2001:db8::/56");
});

test("rate limit IP fallback keeps IPv4 addresses as exact buckets", () => {
  assert.equal(rateLimitUserOrIpKey({ ip: "192.0.2.128" }), "192.0.2.128");
  assert.equal(rateLimitUserMachineOrIpKey({ ip: "::ffff:192.0.2.128" }), "192.0.2.128");
});

test("attachment rate limits isolate the pglite harness without weakening production", () => {
  const harnessRequests = [
    { method: "POST", surface: "upload" },
    { method: "GET", surface: "download" },
    // The download limiter is mounted before the upload router, so the upload
    // POST also traverses this surface.
    { method: "POST", surface: "download" },
  ] as const;

  for (const request of harnessRequests) {
    assert.equal(
      shouldSkipAttachmentRateLimit({ isTestEnv: true, ...request }),
      true,
      `${request.method} ${request.surface} should not inherit a finite shared bucket in the pglite harness`,
    );
  }

  assert.equal(
    shouldSkipAttachmentRateLimit({ isTestEnv: false, method: "POST", surface: "upload" }),
    false,
  );
  assert.equal(
    shouldSkipAttachmentRateLimit({ isTestEnv: false, method: "GET", surface: "download" }),
    false,
  );
  assert.equal(
    shouldSkipAttachmentRateLimit({ isTestEnv: false, method: "GET", surface: "upload" }),
    true,
  );
});

test("auth rate-limit override is explicit and confined to the pglite test harness", () => {
  assert.equal(
    shouldSkipAuthRateLimit({ isTestEnv: true, skipInTestHarness: true, path: "/login" }),
    true,
  );
  assert.equal(
    shouldSkipAuthRateLimit({ isTestEnv: true, skipInTestHarness: false, path: "/login" }),
    false,
  );
  assert.equal(
    shouldSkipAuthRateLimit({ isTestEnv: false, skipInTestHarness: true, path: "/login" }),
    false,
  );

  for (const path of ["/invite-info", "/accept-invite"]) {
    assert.equal(
      shouldSkipAuthRateLimit({ isTestEnv: false, skipInTestHarness: false, path }),
      true,
      `${path} keeps its existing dedicated-limiter exemption`,
    );
  }

  // A request the OAuth identity endpoints' per-token limit counted is not
  // counted again per IP, wherever it runs; one it did not count (no Bearer
  // token) is counted per IP as before.
  for (const isTestEnv of [false, true]) {
    for (const skipInTestHarness of [false, true]) {
      assert.equal(
        shouldSkipAuthRateLimit({ isTestEnv, skipInTestHarness, path: "/membership", countedPerAccessToken: true }),
        true,
        `counted per token (isTestEnv ${isTestEnv}, skipInTestHarness ${skipInTestHarness})`,
      );
    }
  }
  for (const path of ["/membership", "/userinfo", "/authorize", "/token"]) {
    assert.equal(
      shouldSkipAuthRateLimit({ isTestEnv: false, skipInTestHarness: false, path, countedPerAccessToken: false }),
      false,
      `${path} not counted per token stays counted per IP`,
    );
  }
});

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

/** A request beneath an OAuth mount (`server`: the Server-scoped one's segment). */
function oauthRequest(input: { method?: string; path: string; authorization?: string; server?: string }): Pick<Request, "method" | "path" | "headers" | "params"> {
  const headers: Request["headers"] = {};
  if (input.authorization !== undefined) headers.authorization = input.authorization;
  const params: Request["params"] = {};
  if (input.server !== undefined) params.server = input.server;
  return { method: input.method ?? "GET", path: input.path, headers, params };
}

test("the OAuth identity endpoints' per-token key is the token's SHA-256, for those five routes with a Bearer token only", () => {
  const token = "slock_at_identity-limit-example";
  const bearer = `Bearer ${token}`;
  for (const path of ["/userinfo", "/servers", "/membership", "/serverinfo", "/agents"]) {
    const key = oauthIdentityTokenRateLimitKey(oauthRequest({ path, authorization: bearer }));
    assert.equal(key, sha256Hex(token), path);
    assert.ok(key !== null && !key.includes(token), `${path}: the key never carries the token`);
  }
  // As the router matches: HEAD answers as GET, a trailing slash is the same route.
  assert.equal(oauthIdentityTokenRateLimitKey(oauthRequest({ method: "HEAD", path: "/membership", authorization: bearer })), sha256Hex(token));
  assert.equal(oauthIdentityTokenRateLimitKey(oauthRequest({ path: "/userinfo/", authorization: bearer })), sha256Hex(token));
  // The Server-scoped mount serves three of them; servers and membership are 404 there and stay per IP.
  for (const path of ["/userinfo", "/serverinfo", "/agents"]) {
    assert.equal(oauthIdentityTokenRateLimitKey(oauthRequest({ path, authorization: bearer, server: "acme" })), sha256Hex(token), `scoped ${path}`);
  }
  for (const path of ["/servers", "/membership"]) {
    assert.equal(oauthIdentityTokenRateLimitKey(oauthRequest({ path, authorization: bearer, server: "acme" })), null, `scoped ${path}`);
  }

  // No Bearer token (no header, another scheme, an empty token): the per-IP limit takes it.
  for (const authorization of [undefined, `Basic ${Buffer.from("client:secret").toString("base64")}`, `bearer ${token}`, "Bearer", "Bearer "]) {
    assert.equal(oauthIdentityTokenRateLimitKey(oauthRequest({ path: "/userinfo", authorization })), null, `Authorization: ${authorization}`);
  }
  // Every other route of the router keeps the per-IP limit, Bearer token or not.
  for (const [method, path] of [
    ["GET", "/authorize"], ["POST", "/authorize/human"], ["POST", "/authorize/account"], ["POST", "/token"], ["GET", "/clients/lookup"],
    ["POST", "/installations/lookup"], ["POST", "/requests/agent"], ["POST", "/agent-events"], ["GET", "/link-preview"],
    ["GET", "/jwks"], ["GET", "/.well-known/openid-configuration"], ["POST", "/userinfo"], ["DELETE", "/membership"],
  ]) {
    assert.equal(oauthIdentityTokenRateLimitKey(oauthRequest({ method, path, authorization: bearer })), null, `${method} ${path}`);
  }
});

/** A MemoryStore that records every key it is asked to count. */
class RecordingStore extends MemoryStore {
  readonly keys: string[] = [];

  override async increment(key: string) {
    this.keys.push(key);
    return super.increment(key);
  }
}

/**
 * The limiter in front of a stand-in route: 204, or 401 for a token starting
 * `bad` (as the identity routes answer an invalid token).
 */
async function withLimiter(
  store: RecordingStore,
  enforce: boolean,
  run: (get: (path: string, authorization?: string) => Promise<Response>) => Promise<void>,
  invalidTokensPerIp = 100,
) {
  const app = express();
  app.use("/api/oauth", oauthIdentityTokenLimiter({ perToken: 2, invalidTokensPerIp, enforce, validate: false, store }), (req, res) => {
    res.status(req.headers.authorization?.startsWith("Bearer bad") ? 401 : 204).end();
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run((path, authorization) => fetch(`${baseUrl}${path}`, authorization === undefined ? {} : { headers: { authorization } }));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.shutdown();
  }
}

test("the per-token limiter's store holds the token's hash, never the token; past the limit it answers the auth limiter's 429 with Retry-After", async () => {
  const token = "slock_at_identity-limit-store";
  const store = new RecordingStore();
  await withLimiter(store, true, async (get) => {
    assert.equal((await get("/api/oauth/userinfo")).status, 204, "no Bearer token passes on uncounted");
    assert.equal((await get("/api/oauth/authorize", `Bearer ${token}`)).status, 204, "another route passes on uncounted");
    assert.deepEqual(store.keys, []);

    assert.equal((await get("/api/oauth/userinfo", `Bearer ${token}`)).status, 204);
    assert.equal((await get("/api/oauth/membership?server_id=x", `Bearer ${token}`)).status, 204);
    const limited = await get("/api/oauth/agents", `Bearer ${token}`);
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "Too many requests, please try again later" });
    assert.ok(Number(limited.headers.get("retry-after")) > 0, `Retry-After: ${limited.headers.get("retry-after")}`);
  });
  assert.deepEqual(store.keys, [sha256Hex(token), sha256Hex(token), sha256Hex(token)]);
  for (const key of store.keys) assert.ok(key !== token && !key.includes(token), "a store key never is or carries the token");
});

test("invalid tokens spend the IP's budget and are refused once it is spent, whatever the token; valid tokens never spend it", async () => {
  const store = new RecordingStore();
  await withLimiter(store, true, async (get) => {
    // More valid requests than the IP's invalid-token budget (2), each with its own token: none is refused.
    for (let i = 0; i < 4; i += 1) assert.equal((await get("/api/oauth/userinfo", `Bearer good-${i}`)).status, 204, `valid token ${i}`);
    // A new invalid token each time: 401 until the IP's budget is spent, then 429 before the route runs.
    assert.equal((await get("/api/oauth/userinfo", "Bearer bad-1")).status, 401);
    assert.equal((await get("/api/oauth/membership", "Bearer bad-2")).status, 401);
    const sprayed = await get("/api/oauth/agents", "Bearer bad-3");
    assert.equal(sprayed.status, 429);
    assert.deepEqual(await sprayed.json(), { error: "Too many requests, please try again later" });
    assert.equal(sprayed.headers.get("ratelimit-limit"), "2", "refused by the IP's invalid-token limit");
    assert.ok(Number(sprayed.headers.get("retry-after")) > 0, `Retry-After: ${sprayed.headers.get("retry-after")}`);
    // Checked before the lookup: the IP's valid tokens wait too, until the window resets.
    assert.equal((await get("/api/oauth/userinfo", "Bearer good-new")).status, 429);
    // A request with no Bearer token is not this limit's (the auth limiter's, per IP).
    assert.equal((await get("/api/oauth/userinfo")).status, 204);
  }, 2);
  // bad-3 and good-new were refused before the per-token limit.
  assert.equal(store.keys.length, 6);
});

test("the per-token limiter counts nothing while not enforced (the pglite harness), leaving those routes to the per-IP limit", async () => {
  const store = new RecordingStore();
  await withLimiter(store, false, async (get) => {
    for (let i = 0; i < 3; i += 1) assert.equal((await get("/api/oauth/userinfo", "Bearer slock_at_unenforced")).status, 204);
  });
  assert.deepEqual(store.keys, []);
});

test("product feedback keeps production writes limited while tests and slockdev stay repeatable", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    assert.equal(
      shouldSkipProductFeedbackRateLimit({
        isSlockdev: false,
        isTestEnv: false,
        method,
      }),
      true,
      `${method} is a read-only feedback operation`,
    );
  }

  assert.equal(
    shouldSkipProductFeedbackRateLimit({
      isSlockdev: false,
      isTestEnv: false,
      method: "POST",
    }),
    false,
  );
  assert.equal(
    shouldSkipProductFeedbackRateLimit({
      isSlockdev: false,
      isTestEnv: true,
      method: "POST",
    }),
    true,
  );
  assert.equal(
    shouldSkipProductFeedbackRateLimit({
      isSlockdev: true,
      isTestEnv: false,
      method: "POST",
    }),
    true,
  );
});
