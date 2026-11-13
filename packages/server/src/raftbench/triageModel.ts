import Anthropic from "@anthropic-ai/sdk";

export type TriageCompletion = { text: string; inputTokens: number; outputTokens: number };
export type TriageModelRequest = { model: string; system: string; user: string; maxTokens: number; signal: AbortSignal };
export type TriageModelClient = { complete(request: TriageModelRequest): Promise<TriageCompletion> };
/** Refusals, truncation and transport errors are distinct batch outcomes; none of them writes labels. */
export class TriageModelError extends Error {
  /** `usage` is the billed amount when the API reported it; `text` is the partial output of a truncated call. */
  constructor(readonly code: "refused" | "truncated" | "rate_limited" | "unavailable" | "rejected" | "aborted",
    readonly usage?: { inputTokens: number; outputTokens: number }, readonly text?: string) { super(`RaftBench triage model ${code}`); }
}

export const TRIAGE_MODEL = "claude-haiku-5-5";
export const REVIEW_MODEL = "claude-sonnet-5-5";

let override: TriageModelClient | null | undefined;
/** Tests only: a synthetic model, or null to simulate a missing key. */
export function __setTriageModelForTests(client: TriageModelClient | null | undefined): void { override = client; }

/** Optional secret, injected from SSM like other optional staging secrets. Absent means triage stays off. */
export function triageModelClient(env: NodeJS.ProcessEnv = process.env): TriageModelClient | null {
  if (override !== undefined) return override;
  const apiKey = env.RAFTBENCH_MODEL_API_KEY?.trim();
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 120_000 });
  return {
    async complete(request) {
      let response: Anthropic.Message;
      try {
        response = await client.messages.create({ model: request.model, max_tokens: request.maxTokens, output_config: { effort: "low" },
          system: request.system, messages: [{ role: "user", content: request.user }] }, { signal: request.signal });
      } catch (error) {
        if (request.signal.aborted || error instanceof Anthropic.APIUserAbortError) throw new TriageModelError("aborted");
        if (error instanceof Anthropic.RateLimitError) throw new TriageModelError("rate_limited");
        if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError || error instanceof Anthropic.NotFoundError) throw new TriageModelError("rejected");
        throw new TriageModelError("unavailable");
      }
      const text = response.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
      const usage = { inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0), outputTokens: response.usage.output_tokens };
      if (response.stop_reason === "refusal") throw new TriageModelError("refused", usage);
      if (response.stop_reason === "max_tokens") throw new TriageModelError("truncated", usage, text);
      return { text, ...usage };
    },
  };
}
