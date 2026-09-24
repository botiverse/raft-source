import { test } from "node:test";
import assert from "node:assert/strict";
import { armOAuthLoopback, cancelOAuthLoopback, isAllowedAuthorizationUrl } from "./oauthLoopback.js";

const NONCE = "desktop_nonce_0123456789abcdef";

function delay(ms: number): Promise<"pending"> {
  return new Promise((resolve) => setTimeout(() => resolve("pending"), ms));
}

// Resolve to "resolved" / "rejected" / "pending" so a never-settling promise is
// observable without hanging the test.
async function settleState(p: Promise<unknown>, withinMs = 150): Promise<string> {
  return Promise.race([
    p.then(() => "resolved", () => "rejected"),
    delay(withinMs),
  ]);
}

async function postDone(port: number, payload: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/auth/done`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

test("isAllowedAuthorizationUrl allows only https provider/API hosts", () => {
  for (const ok of [
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
    "https://github.com/login/oauth/authorize?client_id=x",
    "https://appleid.apple.com/auth/authorize?client_id=x",
    "https://api.raft.build/api/auth/google/start",
  ]) {
    assert.equal(isAllowedAuthorizationUrl(ok), true, ok);
  }
  for (const bad of [
    "http://accounts.google.com/o/oauth2/v2/auth", // not https
    "https://evil.com/o/oauth2/v2/auth", // host not allowlisted
    "https://accounts.google.com.evil.com/x", // look-alike host
    "https://user:pw@accounts.google.com/x", // userinfo
    "javascript:alert(1)",
    "file:///etc/passwd",
    "mailto:a@b.com",
    "raft://auth#token=x",
    "not a url",
    123,
    null,
    undefined,
  ]) {
    assert.equal(isAllowedAuthorizationUrl(bad as unknown), false, String(bad));
  }
});

test("GET /auth/done serves the handoff page", async () => {
  const { port, code } = await armOAuthLoopback(NONCE);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/auth/done`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /location\.hash/); // reads the fragment state client-side
  } finally {
    cancelOAuthLoopback();
    await settleState(code);
  }
});

test("POST with the matching state resolves the code once", async () => {
  const { port, code } = await armOAuthLoopback(NONCE);
  const res = await postDone(port, { code: "handoff-123", state: NONCE });
  assert.equal(res.status, 200);
  assert.equal(await code, "handoff-123");
});

test("POST with a wrong state is rejected and never resolves the code", async () => {
  const { port, code } = await armOAuthLoopback(NONCE);
  try {
    const res = await postDone(port, { code: "handoff-123", state: "wrong_nonce_value" });
    assert.equal(res.status, 400);
    assert.equal(await settleState(code), "pending");
  } finally {
    cancelOAuthLoopback();
    await settleState(code);
  }
});

test("POST without a code is rejected and never resolves", async () => {
  const { port, code } = await armOAuthLoopback(NONCE);
  try {
    const res = await postDone(port, { state: NONCE });
    assert.equal(res.status, 400);
    assert.equal(await settleState(code), "pending");
  } finally {
    cancelOAuthLoopback();
    await settleState(code);
  }
});

test("re-arming supersedes and rejects the previous code promise", async () => {
  const first = await armOAuthLoopback(NONCE);
  const second = await armOAuthLoopback("second_nonce_0123456789abcdef");
  try {
    assert.equal(await settleState(first.code), "rejected");
    // The new attempt is independent and still live.
    assert.equal(await settleState(second.code), "pending");
  } finally {
    cancelOAuthLoopback();
    await settleState(second.code);
  }
});

test("cancel rejects the pending code promise", async () => {
  const { code } = await armOAuthLoopback(NONCE);
  cancelOAuthLoopback();
  assert.equal(await settleState(code), "rejected");
});

test("timeout rejects the pending code promise", async () => {
  const { code } = await armOAuthLoopback(NONCE, 40);
  assert.equal(await settleState(code, 300), "rejected");
});

test("concurrent (un-awaited) arms keep only one live loopback", async () => {
  // Both arm() calls run their synchronous critical section back-to-back; the
  // second must supersede the first even though the first hasn't finished
  // listening. The superseded arm rejects; only the second is live.
  const [a, b] = await Promise.allSettled([
    armOAuthLoopback(NONCE),
    armOAuthLoopback("second_nonce_0123456789abcdef"),
  ]);
  assert.equal(a.status, "rejected");
  assert.equal(b.status, "fulfilled");
  const live = (b as PromiseFulfilledResult<{ port: number; code: Promise<string> }>).value;
  try {
    // The live loopback answers to its own nonce.
    const res = await postDone(live.port, { code: "handoff-b", state: "second_nonce_0123456789abcdef" });
    assert.equal(res.status, 200);
    assert.equal(await live.code, "handoff-b");
  } finally {
    cancelOAuthLoopback();
    await settleState(live.code);
  }
});

test("a duplicate POST after success is rejected and does not change the code", async () => {
  const { port, code } = await armOAuthLoopback(NONCE);
  const first = await postDone(port, { code: "handoff-1", state: NONCE });
  assert.equal(first.status, 200);
  assert.equal(await code, "handoff-1");
  // The server stays open briefly; a second POST must not re-resolve.
  const dup = await postDone(port, { code: "handoff-2", state: NONCE }).catch(() => ({ status: 0 }));
  assert.notEqual(dup.status, 200);
  assert.equal(await code, "handoff-1"); // unchanged
});

test("an oversize body is rejected with 413 and never resolves the code", async () => {
  const { port, code } = await armOAuthLoopback(NONCE);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/auth/done`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "x".repeat(20000), state: NONCE }),
    }).catch(() => ({ status: 413 }));
    // Either a clean 413 or a torn connection — both leave the code pending.
    assert.ok(res.status === 413 || res.status === 0);
    assert.equal(await settleState(code), "pending");
  } finally {
    cancelOAuthLoopback();
    await settleState(code);
  }
});
