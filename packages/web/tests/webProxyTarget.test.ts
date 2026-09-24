import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWebProxyTarget,
  WEB_PROXY_TARGET_ORIGINS,
} from "../scripts/webProxyTarget.ts";

test("defaults to the local server port", () => {
  assert.deepEqual(resolveWebProxyTarget({}), {
    name: "local",
    origin: "http://localhost:3001",
  });
  assert.deepEqual(resolveWebProxyTarget({ SLOCK_SERVER_PORT: "4317" }), {
    name: "local",
    origin: "http://localhost:4317",
  });
});

test("resolves the closed staging and prod target set", () => {
  assert.deepEqual(WEB_PROXY_TARGET_ORIGINS, {
    staging: "https://api-aws-staging.botiverse.dev",
    prod: "https://api.raft.build",
  });
  assert.deepEqual(resolveWebProxyTarget({ SLOCK_WEB_PROXY_TARGET: "staging" }), {
    name: "staging",
    origin: WEB_PROXY_TARGET_ORIGINS.staging,
  });
  assert.deepEqual(resolveWebProxyTarget({ SLOCK_WEB_PROXY_TARGET: "prod" }), {
    name: "prod",
    origin: WEB_PROXY_TARGET_ORIGINS.prod,
  });
});

test("accepts an operator override only as a pathless HTTPS origin", () => {
  assert.deepEqual(resolveWebProxyTarget({
    SLOCK_WEB_PROXY_TARGET: "staging",
    SLOCK_WEB_PROXY_STAGING_ORIGIN: "https://api-staging.example.com/",
  }), {
    name: "staging",
    origin: "https://api-staging.example.com",
  });

  for (const origin of [
    "http://api.example.com",
    "https://api.example.com/path",
    "https://api.example.com/?target=prod",
    "not-a-url",
  ]) {
    assert.throws(
      () => resolveWebProxyTarget({
        SLOCK_WEB_PROXY_TARGET: "staging",
        SLOCK_WEB_PROXY_STAGING_ORIGIN: origin,
      }),
      /HTTPS origin/,
    );
  }
});

test("rejects arbitrary target names and invalid local ports", () => {
  assert.throws(
    () => resolveWebProxyTarget({ SLOCK_WEB_PROXY_TARGET: "https://api.raft.build" }),
    /either staging or prod/,
  );
  assert.throws(() => resolveWebProxyTarget({ SLOCK_SERVER_PORT: "70000" }), /between 1 and 65535/);
});
