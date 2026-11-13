import { defineConfig } from "vitest/config";

// A managed runner's identity, credentials, and transport/context signal belong
// to the host, not test fixtures. Clear them before workers fork; tests set
// their own environment explicitly. Preserve the artifact selector and the
// execution manifest reporter's output path, both owned by the test harness.
for (const key of Object.keys(process.env)) {
  if (
    /^(RAFT_|SLOCK_)/.test(key)
    && key !== "RAFT_TEST_CLI_ENTRY"
    && key !== "RAFT_CLI_TEST_EVENT_LOG"
  ) {
    delete process.env[key];
  }
}

// Display-time assertions (e.g. "+08:00" in message search output) follow the
// host timezone. CI pins TZ=Asia/Singapore for this suite in
// .github/workflows/test.yml; pin the same zone here so local runs on any
// host match CI instead of failing outside UTC+8. Set before the fork pool
// spawns so every worker inherits it.
process.env.TZ = "Asia/Singapore";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    // These suites ran on node:test, which imposes no per-test or per-hook timeout.
    testTimeout: 0,
    hookTimeout: 0,
  },
});
