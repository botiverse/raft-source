import type { AgentConfig, RuntimeConfig } from "@botiverse/raft-shared";
import { runtimeConfigModelValue } from "@botiverse/raft-shared";

const CLAUDE_DEFAULT_CONTEXT_TOKENS = 200_000;
const CLAUDE_FABLE_CONTEXT_TOKENS = 1_000_000;
const CLAUDE_INPUT_TOKEN_RESERVE = 32_000;

export class ClaudeStartupPayloadTooLargeError extends Error {
  constructor(readonly details: {
    estimatedTokens: number;
    budgetTokens: number;
    contextLimitTokens: number;
    model: string;
  }) {
    super(
      `INPUT_TOO_LARGE: Claude daemon-owned startup payload is too large before command launch `
      + `(estimated ${details.estimatedTokens} tokens, budget ${details.budgetTokens}, `
      + `context limit ${details.contextLimitTokens}, model ${details.model}). `
      + "Reduce the current prompt or daemon-injected startup context before retrying.",
    );
    this.name = "ClaudeStartupPayloadTooLargeError";
  }
}

export function assertClaudeStartupPayloadWithinBudget(config: AgentConfig, input: string): void {
  const model = claudeModelName(config);
  const contextLimitTokens = claudeContextLimitTokens(model);
  const budgetTokens = Math.max(1, contextLimitTokens - CLAUDE_INPUT_TOKEN_RESERVE);
  const estimatedTokens = estimateClaudeInputTokens(input);
  if (estimatedTokens <= budgetTokens) return;
  throw new ClaudeStartupPayloadTooLargeError({
    estimatedTokens,
    budgetTokens,
    contextLimitTokens,
    model,
  });
}

export function estimateClaudeInputTokens(input: string): number {
  // This estimate covers only text the daemon owns and passes at startup. A
  // resumed Claude Code session loads its native history inside Claude Code;
  // that history is not present here and is explicitly outside this preflight.
  // Use a conservative UTF-8 byte estimate for the visible startup payload.
  return Math.ceil(Buffer.byteLength(input, "utf8") / 3);
}

function claudeModelName(config: AgentConfig): string {
  const runtimeConfig = config.runtimeConfig as RuntimeConfig | null | undefined;
  if (runtimeConfig?.runtime === "claude") {
    return runtimeConfigModelValue(runtimeConfig);
  }
  return config.model || "unknown";
}

function claudeContextLimitTokens(model: string): number {
  return /\bfable\b/i.test(model)
    ? CLAUDE_FABLE_CONTEXT_TOKENS
    : CLAUDE_DEFAULT_CONTEXT_TOKENS;
}
