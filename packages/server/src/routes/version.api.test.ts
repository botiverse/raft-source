import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { openTestApp } from "../test/integration/app.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const BUILD_ENV_KEYS = [
  "SLOCK_RELEASE_SHA",
  "SLOCK_BUILD_AT",
  "SLOCK_RELEASE_BRANCH",
] as const;

async function withBuildEnv<T>(
  values: Partial<Record<typeof BUILD_ENV_KEYS[number], string>>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<typeof BUILD_ENV_KEYS[number], string | undefined>();
  for (const key of BUILD_ENV_KEYS) {
    previous.set(key, process.env[key]);
    const next = values[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  try {
    return await run();
  } finally {
    for (const key of BUILD_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("GET /api/version returns the build-time git identity without auth", async () => {
  await withBuildEnv({
    SLOCK_RELEASE_SHA: "0123456789abcdef0123456789abcdef01234567",
    SLOCK_BUILD_AT: "2026-07-13T04:52:55Z",
    SLOCK_RELEASE_BRANCH: "staging",
  }, async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const response = await fetch(`${app.baseUrl}/api/version`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        sha: "0123456789abcdef0123456789abcdef01234567",
        builtAt: "2026-07-13T04:52:55Z",
        branch: "staging",
      });
    } finally {
      await app.close();
    }
  });
});

test("GET /api/version fails explicitly instead of returning unknown identity", async () => {
  await withBuildEnv({
    SLOCK_BUILD_AT: "2026-07-13T04:52:55Z",
    SLOCK_RELEASE_BRANCH: "staging",
  }, async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const response = await fetch(`${app.baseUrl}/api/version`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "Build identity unavailable",
        code: "build_identity_unavailable",
        detail: "RAFT_RELEASE_SHA is missing or disagrees with its legacy alias",
        sha: null,
        builtAt: "2026-07-13T04:52:55Z",
        branch: "staging",
      });
    } finally {
      await app.close();
    }
  });
});
