import assert from "node:assert/strict";
import { newlyWrittenDisallowedAgentEnvVarNames } from "./agentEnvVarPolicy";

test("a save is refused only for disallowed names it adds or changes", () => {
  assert.deepEqual(newlyWrittenDisallowedAgentEnvVarNames(null, { PATH: "/a", NODE_OPTIONS: "x", TEAM: "1" }), ["NODE_OPTIONS", "PATH"]);
  assert.deepEqual(newlyWrittenDisallowedAgentEnvVarNames({ PATH: "/a" }, { PATH: "/a", TEAM: "2" }), []);
  assert.deepEqual(newlyWrittenDisallowedAgentEnvVarNames({ PATH: "/a" }, { PATH: "/b" }), ["PATH"]);
  assert.deepEqual(newlyWrittenDisallowedAgentEnvVarNames({ PATH: "/a" }, { PATH: "/a", ld_preload: "/x.so" }), ["ld_preload"]);
  assert.deepEqual(newlyWrittenDisallowedAgentEnvVarNames({ PATH: "/a" }, null), []);
  assert.deepEqual(newlyWrittenDisallowedAgentEnvVarNames(null, { CODEX_HOME: "/c", ANTHROPIC_BASE_URL: "https://g" }), []);
});
