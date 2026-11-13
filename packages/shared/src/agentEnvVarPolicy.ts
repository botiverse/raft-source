/**
 * Agent env var names that can make a process on the agent's computer run
 * other code. One list for the server (refuses saving settings that add or
 * change one, routes/agents.ts) and the Computer (records them at launch,
 * daemon agentEnvVarPolicy.ts).
 */
/**
 * Environment variables an agent's settings may not set, because they make a
 * process on this computer run other code: loaders and preloads, shell
 * startup files and shell choice, interpreter option variables, the
 * executable search path and home directory, and the git/ssh hooks that run a
 * command. The agent's env vars come from the server, so accepting these
 * would let the server (or anyone who controls it) run code here without
 * going through the agent at all.
 *
 * Left out on purpose, and NOT because they are safe: each of these can also
 * make a process run a command. Commands people set to tame tools (`PAGER`,
 * `GIT_PAGER`, `EDITOR`: `GIT_PAGER="sh -c ..."` runs it), runtime config
 * directories (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`: the
 * MCP servers, hooks and extensions they configure run as commands or code)
 * and config content (`OPENCODE_CONFIG_CONTENT`). They are in common use
 * (`CODEX_HOME` alone: 251 agents), so refusing them would break those agents;
 * they are a known gap for the local-confirmation design. POSIX `ENV` (read
 * only by interactive `sh`) is a common app variable.
 *
 * Names compare case-insensitively (Windows env names do). Local machine
 * defaults (`defaultAgentEnvVarsProvider`) and the daemon's own environment
 * are not checked: they come from this computer.
 *
 * This is the narrow first step; which other settings decide what an agent
 * listens to (base URLs, proxies, the launch command) is a separate design.
 */
const DISALLOWED_NAMES: ReadonlySet<string> = new Set([
  // Executable search path and home directory (dotfiles, runtime config dirs).
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "COMSPEC",
  // Node.js
  "NODE_OPTIONS",
  // Which shell runs commands, or a command put in front of each one
  "SHELL",
  "CLAUDE_CODE_SHELL",
  "CLAUDE_CODE_SHELL_PREFIX",
  "CLAUDE_CODE_GIT_BASH_PATH",
  // A file Claude Code sources before each shell command
  "CLAUDE_ENV_FILE",
  // Shell startup and prompt hooks
  "BASH_ENV",
  "ZDOTDIR",
  "PROMPT_COMMAND",
  "PS4",
  "SHELLOPTS",
  "BASHOPTS",
  // Other interpreters
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  // PYTHONWARNINGS can import a module that opens $BROWSER at startup
  "PYTHONWARNINGS",
  "BROWSER",
  "PERL5OPT",
  "PERL5LIB",
  "PERLLIB",
  "RUBYOPT",
  "RUBYLIB",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "NPM_CONFIG_SCRIPT_SHELL",
  "NPM_CONFIG_NODE_OPTIONS",
  // git and ssh run these as commands
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_EXEC_PATH",
  "GIT_PROXY_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  // git copies hooks from the template dir into each new repository, and runs
  // the hooks of whichever repository GIT_DIR names
  "GIT_TEMPLATE_DIR",
  "GIT_DIR",
]);

const DISALLOWED_PREFIXES: readonly string[] = [
  // Dynamic loader (LD_PRELOAD, LD_LIBRARY_PATH, LD_AUDIT, DYLD_INSERT_LIBRARIES, ...)
  "LD_",
  "DYLD_",
  // Exported bash functions
  "BASH_FUNC_",
  // GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> set arbitrary git config (core.sshCommand, ...)
  "GIT_CONFIG_KEY_",
  "GIT_CONFIG_VALUE_",
];

/**
 * What a POSIX or Windows env name may be. The server's write paths enforce
 * the same, but a key outside it (one holding `=`, say) would set some other
 * variable once the process environment is built, so the daemon refuses it
 * rather than trust the server's check.
 */
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isDisallowedAgentEnvVarName(name: string): boolean {
  const upper = name.toUpperCase();
  return DISALLOWED_NAMES.has(upper) || DISALLOWED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** The disallowed (valid) names among `envVars`, sorted, as the settings spell them. */
export function disallowedAgentEnvVarNames(envVars: Record<string, string> | null | undefined): string[] {
  if (!envVars) return [];
  return Object.keys(envVars).filter((name) => VALID_NAME.test(name) && isDisallowedAgentEnvVarName(name)).sort();
}

/** How many keys of `envVars` are not valid env names (never echoed: such a key can hold a value). */
export function invalidAgentEnvVarNameCount(envVars: Record<string, string> | null | undefined): number {
  if (!envVars) return 0;
  return Object.keys(envVars).filter((name) => !VALID_NAME.test(name)).length;
}


/**
 * The disallowed names a save would add or change, sorted: in `next` and not
 * in `previous` with the same value. A value the agent already had and the
 * save leaves as it is still saves (xxchan, #proj-raft-computer:bbea62a0:
 * refuse new writes, leave existing agents running).
 */
export function newlyWrittenDisallowedAgentEnvVarNames(
  previous: Record<string, string> | null | undefined,
  next: Record<string, string> | null | undefined,
): string[] {
  return disallowedAgentEnvVarNames(next).filter((name) => previous?.[name] !== next?.[name]);
}
