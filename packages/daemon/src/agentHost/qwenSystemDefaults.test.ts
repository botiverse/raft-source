import assert from "node:assert/strict";
import path from "node:path";
import {
  QWEN_RAFT_SYSTEM_DEFAULTS,
  QWEN_SYSTEM_DEFAULTS_PATH_ENV,
  qwenPlatformSystemDefaultsPath,
  withQwenRaftSystemDefaults,
} from "./qwenSystemDefaults";

test("a Qwen launch points Qwen at Raft's system defaults, which turn its background memory off", () => {
  const written: Array<[string, string]> = [];
  const env = withQwenRaftSystemDefaults({ PATH: "/bin" }, "/raft-home", {
    exists: () => false,
    write: (file, content) => { written.push([file, content]); },
    platform: "linux",
  });
  const file = path.join("/raft-home", "qwen", "system-defaults.json");
  assert.equal(env[QWEN_SYSTEM_DEFAULTS_PATH_ENV], file);
  assert.equal(env.PATH, "/bin");
  assert.deepEqual(written.map(([target]) => target), [file]);
  assert.deepEqual(JSON.parse(written[0]![1]), QWEN_RAFT_SYSTEM_DEFAULTS);
  assert.deepEqual(QWEN_RAFT_SYSTEM_DEFAULTS.memory, { enableManagedAutoMemory: false, enableManagedAutoDream: false, enableAutoSkill: false });
});

test("system defaults someone already chose are left alone", () => {
  const neverWrite = () => { throw new Error("must not write"); };
  const chosen = { [QWEN_SYSTEM_DEFAULTS_PATH_ENV]: "/my/defaults.json" };
  assert.equal(withQwenRaftSystemDefaults(chosen, "/raft-home", { exists: () => false, write: neverWrite }), chosen);
  const machineFile = qwenPlatformSystemDefaultsPath("darwin");
  const env = { PATH: "/bin" };
  assert.equal(withQwenRaftSystemDefaults(env, "/raft-home", { exists: (file) => file === machineFile, write: neverWrite, platform: "darwin" }), env);
});
