import assert from "node:assert/strict";
import { appEnabledPerEnv, enabledAppsEnvValue, RAFT_ENABLED_APPS_ENV } from "./enabledAppsEnv";

test("the daemon's value reads back per app; no variable means unknown", () => {
  assert.equal(appEnabledPerEnv({ [RAFT_ENABLED_APPS_ENV]: enabledAppsEnvValue(["artifacts", "other"]) }, "artifacts"), true);
  assert.equal(appEnabledPerEnv({ [RAFT_ENABLED_APPS_ENV]: enabledAppsEnvValue([]) }, "artifacts"), false, "none on");
  assert.equal(appEnabledPerEnv({ [RAFT_ENABLED_APPS_ENV]: "other" }, "artifacts"), false);
  assert.equal(appEnabledPerEnv({}, "artifacts"), undefined, "an older daemon or a self-hosted runner");
});
