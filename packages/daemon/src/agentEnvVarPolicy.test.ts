import assert from "node:assert/strict";
import { agentEnvVarsRefusal, disallowedAgentEnvVarNames, isDisallowedAgentEnvVarName } from "./agentEnvVarPolicy";
import { classifySpawnFailure } from "./spawnFailureClassification";

test("names that make a process run other code are refused, in any case", () => {
  for (const name of [
    "PATH", "Path", "HOME", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
    "BASH_ENV", "BASH_FUNC_ls", "SHELL", "CLAUDE_CODE_SHELL", "CLAUDE_CODE_SHELL_PREFIX", "CLAUDE_CODE_GIT_BASH_PATH", "CLAUDE_ENV_FILE",
    "PYTHONWARNINGS", "BROWSER", "HOMEDRIVE", "HOMEPATH", "PYTHONPATH", "PERL5OPT", "JAVA_TOOL_OPTIONS",
    "GIT_SSH_COMMAND", "GIT_TEMPLATE_DIR", "GIT_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "npm_config_script_shell",
  ]) {
    assert.equal(isDisallowedAgentEnvVarName(name), true, name);
  }
});

test("provider, model and runtime settings people set today stay allowed", () => {
  // The most used names in production (Tenny, #proj-raft-computer:38b688ec).
  for (const name of [
    "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_MODEL_OPTION", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
    "DEEPSEEK_API_KEY", "CODEX_HOME", "HTTPS_PROXY", "http_proxy", "OPENAI_API_KEY", "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "npm_config_registry", "PAGER", "SLOCK_ONBOARDING_MEMORY_SEED",
    "RAFT_PI_SESSION_ROTATION_MIN_BYTES", "PATH_PREFIX", "HOMEBREW_NO_AUTO_UPDATE", "ENV", "GIT_PAGER", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR",
  ]) {
    assert.equal(isDisallowedAgentEnvVarName(name), false, name);
  }
});

test("the refusal names every disallowed variable from both env var sources, never a value", () => {
  assert.deepEqual(disallowedAgentEnvVarNames(null), []);
  const refusal = agentEnvVarsRefusal({
    runtime: "claude",
    envVars: { PATH: "/opt/secret-bin:/usr/bin", ANTHROPIC_API_KEY: "sk-ant-SECRET" },
    runtimeConfig: { envVars: { NODE_OPTIONS: "--require /tmp/x.js", PATH: "/opt/secret-bin" } } as never,
  });
  assert.ok(refusal);
  assert.deepEqual(refusal.names, ["NODE_OPTIONS", "PATH"]);
  assert.equal(refusal.code, "env_var_not_allowed");
  assert.doesNotMatch(refusal.message, /secret-bin|SECRET|require/);
  assert.equal(agentEnvVarsRefusal({ runtime: "claude", envVars: { ANTHROPIC_API_KEY: "k" }, runtimeConfig: null }), null);
});

test("a refused start is classified with the names and the way out, also when wrapped", () => {
  const refusal = agentEnvVarsRefusal({ runtime: "claude", envVars: { PATH: "/x", NODE_OPTIONS: "y" }, runtimeConfig: null })!;
  for (const error of [refusal, Object.assign(new Error("start failed", { cause: refusal }), { spawnFailureCode: "env_var_not_allowed" })]) {
    const classification = classifySpawnFailure(error);
    assert.equal(classification.reason, "env_var_not_allowed");
    assert.equal(
      classification.userMessage,
      "This agent's settings set NODE_OPTIONS, PATH, which this Computer no longer accepts from the server because they can make it run other programs. "
        + "Remove them from the agent's environment variables, then restart the agent. "
        + "Agents get PATH from this computer: on macOS and Linux add the directory in your login shell's startup file (such as ~/.zshrc or ~/.profile) and restart the Computer service; on Windows add it to your user PATH.",
    );
  }
  const one = classifySpawnFailure(agentEnvVarsRefusal({ runtime: "codex", envVars: { HOME: "/x" }, runtimeConfig: null }));
  assert.equal(
    one.userMessage,
    "This agent's settings set HOME, which this Computer no longer accepts from the server because it can make it run other programs. "
      + "Remove it from the agent's environment variables, then restart the agent.",
  );
});

test("a key that is not a valid env name is refused and only counted, never echoed", () => {
  // A key holding "=" would set the variable before it once the environment is built.
  const refusal = agentEnvVarsRefusal({
    runtime: "claude",
    envVars: { "FOO=x NODE_OPTIONS": "--require /tmp/evil.js", ANTHROPIC_API_KEY: "k" },
    runtimeConfig: null,
  });
  assert.ok(refusal);
  assert.deepEqual(refusal.names, []);
  assert.equal(refusal.invalidNameCount, 1);
  assert.doesNotMatch(refusal.message, /NODE_OPTIONS|evil|FOO/);
  const classification = classifySpawnFailure(refusal);
  assert.equal(classification.reason, "env_var_not_allowed");
  assert.equal(
    classification.userMessage,
    "This agent's environment variables include a name that is not a valid variable name (only letters, digits and underscores, not starting with a digit). "
      + "Fix or remove it in the agent's settings, then restart the agent.",
  );
  assert.doesNotMatch(classification.userMessage, /NODE_OPTIONS|evil|FOO/);
  // A malformed key is not also matched as a refused name.
  assert.deepEqual(disallowedAgentEnvVarNames({ "PATH=": "x" }), []);
});
