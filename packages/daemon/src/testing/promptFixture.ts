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

const STARTUP_MEMORY_BLOCK_PREFIX = /^<memory-index file="MEMORY\.md"[^>]*>\n[\s\S]*?\n<\/memory-index>\n\n/;

/**
 * A fresh session's first input opens with the startup MEMORY.md block (RFC
 * 070, always on). Returns the wake input that follows it, so a test about
 * that input can keep anchoring on its first line. Throws if the block is
 * missing, so the test also proves the block is there.
 */
export function afterStartupMemoryBlock(prompt: string): string {
  const match = STARTUP_MEMORY_BLOCK_PREFIX.exec(prompt);
  if (!match) throw new Error(`expected the fresh-session input to open with the startup MEMORY.md block, got: ${prompt.slice(0, 120)}`);
  return prompt.slice(match[0].length);
}

/**
 * A fresh session of a driver without a native standing prompt opens with the
 * full standing prompt, ahead of everything else in the composed first input
 * (only the spawn-time memory-limit note and server-context prefix, when they
 * apply, go in front of it). Returns what follows it; throws if the input does
 * not open with it.
 */
export function afterFreshSessionStandingPrompt(spawn: { prompt: string; standingPrompt: string }): string {
  const prefix = `${spawn.standingPrompt}\n\n`;
  if (!spawn.standingPrompt || !spawn.prompt.startsWith(prefix)) {
    throw new Error(`expected the fresh-session input to open with the standing prompt, got: ${spawn.prompt.slice(0, 120)}`);
  }
  return spawn.prompt.slice(prefix.length);
}
