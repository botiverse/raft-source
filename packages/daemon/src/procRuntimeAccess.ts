/**
 * `raft proc` (#proj-raft-computer:#59): which runtimes run their agent with
 * full access (no sandbox, no approval prompts). A job runs as the daemon's
 * user, outside the runtime, with whatever access that user has; that grants
 * nothing new only while the runtime itself already has that access. The
 * daemon starts a job only for an agent whose runtime is listed here.
 *
 * Each driver decides its own permission mode in its launch arguments or
 * session setup; there is no single setting. This table names where, and
 * `drivers/runtimeFullAccess.test.ts` pins it to what the drivers actually
 * pass. A runtime not listed (an OAR-only runtime whose mode the OAR host
 * decides, a new driver, an unknown or missing runtime id) is refused. A
 * driver that ever runs sandboxed must be removed from this table.
 */
export const RUNTIME_FULL_ACCESS: Readonly<Record<string, string>> = {
  claude: "claudeLaunch.ts buildClaudeArgs: --dangerously-skip-permissions --permission-mode bypassPermissions",
  codex: "codex.ts buildCodexThreadRequest: approvalPolicy never, sandbox danger-full-access",
  grok: "grok.ts GROK_AGENT_ARGS: --always-approve",
  copilot: "copilot.ts buildCopilotArgs: --allow-all-tools --allow-all-paths",
  cursor: "cursor.ts buildCursorArgs: --force",
  gemini: "gemini.ts buildGeminiArgs: --yolo",
  kimi: "kimi.ts buildKimiArgs: --yolo",
  "kimi-sdk": "kimi-sdk.ts: the session's approval handler approves every call",
  opencode: "opencode.ts: --dangerously-skip-permissions (1.x), --auto (2.x)",
  antigravity: "antigravity.deprecated.ts buildAntigravityArgs: --dangerously-skip-permissions",
  pi: "pi.ts / piCommandTool.ts: an in-process bash tool with no sandbox",
  builtin: "pi.ts BuiltInDriver: the pi bash tool with no sandbox",
};

/** Whether jobs may be started for an agent on this runtime. Unknown or missing: no. */
export function runtimeRunsWithFullAccess(runtime: string | null | undefined): boolean {
  return typeof runtime === "string" && Object.prototype.hasOwnProperty.call(RUNTIME_FULL_ACCESS, runtime);
}
