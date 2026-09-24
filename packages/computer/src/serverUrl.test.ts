import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DEFAULT_SLOCK_SERVER_URL,
  LEGACY_PRODUCTION_SERVER_URL,
  RAFT_SERVER_URL_ENV,
  canonicalizeServerUrl,
  resolveServerUrl,
  resolveServerUrlEnv,
  SLOCK_SERVER_URL_ENV,
} from "./serverUrl.js";

test("resolveServerUrl falls back to the production API", () => {
  assert.equal(resolveServerUrl(undefined, "", "   "), DEFAULT_SLOCK_SERVER_URL);
});

test("resolveServerUrl preserves explicit precedence", () => {
  assert.equal(
    resolveServerUrl(undefined, " https://session.example.test ", "https://env.example.test"),
    "https://session.example.test",
  );
  assert.equal(
    resolveServerUrl(" https://flag.example.test ", "https://session.example.test"),
    "https://flag.example.test",
  );
});

test("resolveServerUrl canonicalizes the legacy production API domain", () => {
  assert.equal(canonicalizeServerUrl(LEGACY_PRODUCTION_SERVER_URL), DEFAULT_SLOCK_SERVER_URL);
  assert.equal(canonicalizeServerUrl(`${LEGACY_PRODUCTION_SERVER_URL}/`), DEFAULT_SLOCK_SERVER_URL);
  assert.equal(resolveServerUrl(LEGACY_PRODUCTION_SERVER_URL), DEFAULT_SLOCK_SERVER_URL);
  assert.equal(resolveServerUrl(undefined, LEGACY_PRODUCTION_SERVER_URL), DEFAULT_SLOCK_SERVER_URL);
});

test("resolveServerUrlEnv accepts RAFT alias while preserving SLOCK precedence", () => {
  assert.equal(
    resolveServerUrlEnv({ [RAFT_SERVER_URL_ENV]: "https://raft.example.test" }),
    "https://raft.example.test",
  );
  assert.equal(
    resolveServerUrlEnv({
      [SLOCK_SERVER_URL_ENV]: "https://slock.example.test",
      [RAFT_SERVER_URL_ENV]: "https://raft.example.test",
    }),
    "https://slock.example.test",
  );
});
