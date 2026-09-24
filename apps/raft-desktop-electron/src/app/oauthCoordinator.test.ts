import { test } from "node:test";
import assert from "node:assert/strict";
import { createOAuthCoordinator } from "./oauthCoordinator.js";
import type { OAuthCoordinatorDeps } from "./oauthCoordinator.js";

const GOOD_URL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x";

interface Counters {
  open: string[];
  cancel: number;
  arm: number;
}

function makeCoordinator(over: Partial<OAuthCoordinatorDeps> = {}) {
  const counters: Counters = { open: [], cancel: 0, arm: 0 };
  let tokenN = 0;
  const deps: OAuthCoordinatorDeps = {
    arm: async (nonce: string) => {
      counters.arm += 1;
      return { port: 40000 + counters.arm, code: Promise.resolve(`code-${nonce}`) };
    },
    cancel: () => {
      counters.cancel += 1;
    },
    openExternal: async (url: string) => {
      counters.open.push(url);
    },
    isAllowedUrl: (url: unknown) => typeof url === "string" && url.startsWith("https://accounts.google.com"),
    randomToken: () => `tok-${(tokenN += 1)}`,
    ...over,
  };
  return { coordinator: createOAuthCoordinator(deps), counters };
}

test("a disallowed authorization URL is rejected without calling openExternal", async () => {
  const { coordinator, counters } = makeCoordinator();
  const { token } = await coordinator.arm("nonce_0123456789abcdef", 1);
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "https://evil.com/x", "raft://auth"]) {
    await assert.rejects(
      coordinator.openAwait({ authorizationUrl: bad, token }, 1),
      /oauth_bad_authorization_url|oauth_not_armed/,
    );
  }
  assert.equal(counters.open.length, 0, "openExternal must never be called for a rejected URL");
});

test("a wrong token or sender is rejected without calling openExternal", async () => {
  const { coordinator, counters } = makeCoordinator();
  await coordinator.arm("nonce_0123456789abcdef", 1);
  await assert.rejects(coordinator.openAwait({ authorizationUrl: GOOD_URL, token: "wrong" }, 1), /oauth_not_armed/);
  await assert.rejects(coordinator.openAwait({ authorizationUrl: GOOD_URL, token: "tok-1" }, 2), /oauth_not_armed/);
  assert.equal(counters.open.length, 0);
});

test("the happy path opens the browser once and returns the code", async () => {
  const { coordinator, counters } = makeCoordinator();
  const { token } = await coordinator.arm("nonce_0123456789abcdef", 1);
  const result = await coordinator.openAwait({ authorizationUrl: GOOD_URL, token }, 1);
  assert.equal(result.code, "code-nonce_0123456789abcdef");
  assert.deepEqual(counters.open, [GOOD_URL]);
});

test("a stale superseded attempt's cancel does not cancel the new one", async () => {
  const { coordinator, counters } = makeCoordinator();
  const a = await coordinator.arm("nonce_a_0123456789abcdef", 1);
  const b = await coordinator.arm("nonce_b_0123456789abcdef", 1); // supersedes A; pending = B
  coordinator.cancel(a.token, 1); // stale — must be a no-op
  assert.equal(counters.cancel, 0, "old attempt's cancel must not cancel the live one");
  coordinator.cancel(b.token, 1); // the live one
  assert.equal(counters.cancel, 1);
});

// A controllable deps.arm: the first arm resolves immediately, the second stalls
// until `release(...)` — so we can act during B's arm window.
function deferredArmSetup() {
  const counters: Counters = { open: [], cancel: 0, arm: 0 };
  let tokenN = 0;
  let release!: (v: { port: number; code: Promise<string> }) => void;
  const bArm = new Promise<{ port: number; code: Promise<string> }>((res) => {
    release = res;
  });
  const deps: OAuthCoordinatorDeps = {
    arm: (nonce: string) => {
      counters.arm += 1;
      if (counters.arm === 1) return Promise.resolve({ port: 41001, code: Promise.resolve(`code-${nonce}`) });
      return bArm; // second arm stays pending until release()
    },
    cancel: () => {
      counters.cancel += 1;
    },
    openExternal: async (url: string) => {
      counters.open.push(url);
    },
    isAllowedUrl: (url: unknown) => typeof url === "string" && url.startsWith("https://accounts.google.com"),
    randomToken: () => `tok-${(tokenN += 1)}`,
  };
  return { coordinator: createOAuthCoordinator(deps), counters, release };
}

test("a stale cancel DURING the new attempt's arm window is a no-op", async () => {
  const { coordinator, counters, release } = deferredArmSetup();
  const a = await coordinator.arm("nonce_a_0123456789abcdef", 1); // token tok-1
  const bPromise = coordinator.arm("nonce_b_0123456789abcdef", 1); // token tok-2, stalls in deps.arm
  // Still inside B's arm window (deps.arm not resolved). A stale A cancel must
  // not cancel B — this is the exact window ApplePI reproduced RED.
  coordinator.cancel(a.token, 1);
  assert.equal(counters.cancel, 0);
  // Let B finish arming — it must be fully usable.
  release({ port: 41002, code: Promise.resolve("code-b") });
  const b = await bPromise;
  assert.equal(b.token, "tok-2");
  const result = await coordinator.openAwait({ authorizationUrl: GOOD_URL, token: b.token }, 1);
  assert.equal(result.code, "code-b");
});

test("cancelling B while its own arm is still pending rejects B deterministically", async () => {
  const { coordinator, counters, release } = deferredArmSetup();
  await coordinator.arm("nonce_a_0123456789abcdef", 1); // token tok-1
  const bPromise = coordinator.arm("nonce_b_0123456789abcdef", 1); // token tok-2, stalls
  coordinator.cancel("tok-2", 1); // cancel B during its own arm window
  assert.equal(counters.cancel, 1);
  release({ port: 41002, code: Promise.resolve("code-b") });
  await assert.rejects(bPromise, /oauth_superseded/);
});
