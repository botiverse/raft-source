/**
 * The command that installs a runtime's own CLI on macOS or Linux, by Raft
 * runtime id, for the places that tell someone how to get one: Add
 * Computer's runtime list and a runtime card whose web sign-in needs the CLI
 * (#triage:#253). Kimi Code's line is the one Moonshot documents (OAR's
 * runtimes/kimi/install.js): the agent runs the SDK built into Raft, but
 * `kimi login` needs this CLI.
 */
export const RUNTIME_INSTALL_COMMANDS: Readonly<Record<string, string>> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  "kimi-sdk": "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
  // OAR's documented method for CodeBuddy Code (runtimes/codebuddy/install.js).
  codebuddy: "npm install -g @tencent-ai/codebuddy-code",
};
