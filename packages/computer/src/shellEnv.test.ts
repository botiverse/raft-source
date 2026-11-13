import assert from "node:assert/strict";

import * as shellEnv from "./shellEnv";

// slock#8610: Raft Desktop's app-hosted `__service` needs the SAME login-shell
// environment contract as the CLI-hosted carrier (task #326). The capture must
// run BEFORE the service module graph loads, so the `./shell-env` entry has to
// stay free of that graph.

test("the shell-env entry exposes the service-boot seam", () => {
  for (const name of ["bootstrapServiceEnv", "captureShellEnv", "printEnvMode"] as const) {
    assert.equal(typeof shellEnv[name], "function", name);
  }
  assert.equal(shellEnv.LOGIN_CARRIER_ENV_VAR, "RAFT_COMPUTER_LOGIN_CARRIER");
  assert.equal(shellEnv.SHELL_ENV_STATE_ENV_VAR, "RAFT_COMPUTER_SHELL_ENV_STATE");
});
