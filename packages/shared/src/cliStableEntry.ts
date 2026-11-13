// A managed agent's stable CLI entry (#proj-raft-computer:#58). The daemon
// writes one `raft` wrapper per launch under
// `<SLOCK_HOME>/cli-transport/<agent>/<launch>/`; a process that outlives its
// launch (nohup, a background job) keeps calling that launch's wrapper after
// a newer session of the agent replaced it. The stable entry
// `<SLOCK_HOME>/cli-transport/<agent>/current/` is rewritten at every launch
// to use that launch's own proxy credential: no credential of its own, so it
// stops working when the agent's current launch ends.

/** Set by the stable entry wrapper on the CLI process it runs. New, so only the canonical RAFT_ name. */
export const RAFT_CLI_ENTRY_ENV = "RAFT_CLI_ENTRY";
/** The CLI sends it to the daemon proxy; the proxy checks it and names it to the Server (`via` on the request span). */
export const RAFT_CLI_ENTRY_HEADER = "X-Raft-Cli-Entry";
/** The one value of RAFT_CLI_ENTRY / X-Raft-Cli-Entry. */
export const RAFT_CLI_STABLE_ENTRY = "stable_entry";
/** The stable entry's directory name under `cli-transport/<agent>/`. Not a launch part: launch parts are UUIDs or `pid-<n>`. */
export const CLI_STABLE_ENTRY_DIRNAME = "current";

/**
 * The daemon proxy's answers for a request it can no longer serve, and the
 * CLI codes it shows for them. Never names the newer launch or where its
 * credential lives: only the stable entry.
 */
export const LOCAL_PROXY_LIFECYCLE_CODES = {
  /** The request's launch ended and a newer launch of the same agent is live. */
  launch_superseded: "LAUNCH_SUPERSEDED",
  /** The request's launch ended and the agent has no live launch on this Computer. */
  agent_not_running: "AGENT_NOT_RUNNING",
  /** A stable-entry request named an agent other than its credential's. */
  agent_proxy_agent_mismatch: "AGENT_ID_MISMATCH",
} as const;

export type LocalProxyLifecycleWireCode = keyof typeof LOCAL_PROXY_LIFECYCLE_CODES;
export type LocalProxyLifecycleCliCode = (typeof LOCAL_PROXY_LIFECYCLE_CODES)[LocalProxyLifecycleWireCode];

export function localProxyLifecycleCliCode(code: unknown): LocalProxyLifecycleCliCode | null {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(LOCAL_PROXY_LIFECYCLE_CODES, code)
    ? LOCAL_PROXY_LIFECYCLE_CODES[code as LocalProxyLifecycleWireCode]
    : null;
}
