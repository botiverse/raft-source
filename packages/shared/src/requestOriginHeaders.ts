// Headers a first-party client names itself with on API requests
// (#proj-analytics task #15). The server records them on its request span
// (`server.http.request`, requestObservability.ts). They are the caller's own
// claims: they split traces by version and runtime, never steer access.

/**
 * The version of the code that sent the request: the `raft` CLI's package
 * version, or the web build (in a browser, an installed web app, or the
 * desktop app, whose bundled build carries the desktop release's version).
 * The Apps name theirs in the User-Agent instead.
 */
export const RAFT_CLIENT_VERSION_HEADER = "X-Raft-Client-Version";
/** Set by the daemon's agent proxy: the Computer hosting the agent. */
export const RAFT_COMPUTER_VERSION_HEADER = "X-Raft-Computer-Version";
/** Set by the daemon's agent proxy: the daemon forwarding the request. */
export const RAFT_DAEMON_VERSION_HEADER = "X-Raft-Daemon-Version";
/** Set by the daemon's agent proxy: the agent's runtime (`claude`, `codex`, ...). */
export const RAFT_RUNTIME_HEADER = "X-Raft-Runtime";
