// The answer tool: besides typing `cont <id> [choice]` in a shell, an agent
// whose launch offers it answers a paused command with the daemon's local
// MCP tool `answer_continuation` (daemon/src/continuationAnswerTool.ts), which
// runs that same `raft __continue` for it (server flag continuation_tool_v0,
// CONTINUATION_TOOL_FEATURE_FLAG_KEY). The names both sides agree on.

/** The tool's name on the launch's managed MCP server, without any catalog prefix. */
export const CONTINUATION_ANSWER_TOOL_NAME = "answer_continuation";

/**
 * Set by the daemon in the runtime's environment (to
 * CONTINUATION_ANSWER_TOOL_NAME) when the launch offers the tool: the CLI's
 * pause text then names the tool instead of a `cont` line per option.
 * Unset, or any other value, keeps the `cont` lines.
 */
export const RAFT_CONTINUATION_TOOL_ENV = "RAFT_CONTINUATION_TOOL";

/**
 * Set to "tool" by the daemon only in the `raft __continue` it runs for the
 * tool, so the CLI's continuation spans can say how the answer came in.
 */
export const RAFT_CONTINUATION_VIA_ENV = "RAFT_CONTINUATION_VIA";

/** How an answer came in: the daemon's tool, or `cont` (or `raft __continue`) typed in a shell. */
export type ContinuationAnswerVia = "tool" | "cont";

type EnvLike = Readonly<Record<string, string | undefined>>;

/** Whether this process's launch offers the answer tool (RAFT_CONTINUATION_TOOL). */
export function continuationAnswerToolOffered(env: EnvLike): boolean {
  return env[RAFT_CONTINUATION_TOOL_ENV] === CONTINUATION_ANSWER_TOOL_NAME;
}

/** How this `raft __continue` was started (RAFT_CONTINUATION_VIA). */
export function continuationAnswerVia(env: EnvLike): ContinuationAnswerVia {
  return env[RAFT_CONTINUATION_VIA_ENV] === "tool" ? "tool" : "cont";
}
