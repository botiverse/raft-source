import assert from "node:assert/strict";
import test from "node:test";

import { cookieHeaderForUrl, cookiePathMatches, type SessionCookie } from "./_session.js";

function cookie(overrides: Partial<SessionCookie> = {}): SessionCookie {
  return {
    pair: "session=secret",
    host: "app.example",
    path: "/",
    secure: true,
    ...overrides,
  };
}

test("cookieHeaderForUrl enforces exact host, path, Secure, and expiry scope", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  const cookies = [
    cookie({ pair: "root=1", expiresAt: future }),
    cookie({ pair: "narrow=1", path: "/api/private", expiresAt: future }),
    cookie({ pair: "wrong-host=1", host: "other.example", expiresAt: future }),
    cookie({ pair: "wrong-path=1", path: "/admin", expiresAt: future }),
    cookie({ pair: "expired=1", expiresAt: past }),
  ];

  assert.equal(
    cookieHeaderForUrl(cookies, new URL("https://app.example/api/private/action")),
    "narrow=1; root=1",
  );
  assert.equal(cookieHeaderForUrl(cookies, new URL("https://api.app.example/api/private/action")), null);
  assert.equal(cookieHeaderForUrl(cookies, new URL("http://app.example/api/private/action")), null);
});

test("cookie path matching honors browser path-segment boundaries", () => {
  assert.equal(cookiePathMatches("/api", "/api"), true);
  assert.equal(cookiePathMatches("/api/action", "/api"), true);
  assert.equal(cookiePathMatches("/apix", "/api"), false);
  assert.equal(cookiePathMatches("/api/action", "/api/"), true);
});
