import type { AgentConfig } from "@botiverse/raft-shared";

/** Fixed, fictional inputs: snapshots must not depend on host identity or credentials. */
export function promptConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "alice",
    displayName: "Alice",
    description: "",
    runtime: "codex",
    model: "test-model",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "https://raft.example.test",
    authToken: "test-token",
    ...overrides,
  };
}
