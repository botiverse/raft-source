import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

test("Vitest config removes inherited Raft state and preserves test harness controls", () => {
  const config = new URL("../vitest.config.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    await import(${JSON.stringify(config)});
    console.log(JSON.stringify({
      raft: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(RAFT_|SLOCK_)/.test(key))),
      unrelated: process.env.TEST_UNRELATED_SETTING,
      timezone: process.env.TZ,
    }));
  `], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: {
      // Keep failure diagnostics synthetic even if the config cleanup regresses.
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^(RAFT_|SLOCK_)/.test(key)),
      ),
      RAFT_HOME: "/synthetic/host-home",
      RAFT_PROFILE: "synthetic-profile",
      RAFT_FUTURE_HOST_SETTING: "must-not-leak",
      SLOCK_AGENT_ID: "synthetic-agent",
      SLOCK_CURRENT_AGENT_ID: "synthetic-agent",
      SLOCK_CLI_TRANSPORT_DIR: "/synthetic/transport",
      SLOCK_AGENT_PROXY_TOKEN: "synthetic-not-a-credential",
      SLOCK_FUTURE_HOST_SETTING: "must-not-leak",
      RAFT_TEST_CLI_ENTRY: "dist/raft.js",
      RAFT_CLI_TEST_EVENT_LOG: "/synthetic/test-events.ndjson",
      TEST_UNRELATED_SETTING: "preserved",
      TZ: "UTC",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    raft: {
      RAFT_TEST_CLI_ENTRY: "dist/raft.js",
      RAFT_CLI_TEST_EVENT_LOG: "/synthetic/test-events.ndjson",
    },
    unrelated: "preserved",
    timezone: "Asia/Singapore",
  });
});
