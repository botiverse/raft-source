// The agent API's write budgets (the server's services/agentApiWriteLimits.ts,
// routes/internalAgentApi.ts AGENT_API_WRITE_BUDGET_ROUTES;
// docs/development/first-party-apps.md): core's writes that post or fan out
// (messages, reactions, tasks, channels, ...) and every first-party app's
// write (Artifacts': pushes, comments, reviews, uploads, ...) count per
// calling agent and per Server, across replicas. Past a budget the route answers 429 with this body
// and a `Retry-After` header (the same whole seconds as `retryAfterSeconds`),
// before the request's body is read. Re-exported by agentApiContract.ts; a
// leaf, so the agent operations' outcome (agentOps/outcome.ts) reads it
// without loading the contract.

export const AGENT_API_RATE_LIMITED_CODE = "RATE_LIMITED";

export interface AgentApiRateLimitedDetails {
  /** The refused route's key (an AgentApiRouteKey; a newer Server may send one this client doesn't know). */
  operation: string;
  /** Requests of the budget an agent may make per window. */
  limit: number;
  windowSeconds: number;
  /** Whole seconds until the agent's window resets, at least 1. */
  retryAfterSeconds: number;
}

/**
 * The 429 body. `error` is a sentence for the agent (which writes were
 * limited, the limit and the wait), the one Server sentence agent clients
 * show as it is: "This agent made too many artifact changes: the limit is 60
 * a minute. Retry in 23 seconds."
 */
export interface AgentApiRateLimitedBody {
  error: string;
  code: typeof AGENT_API_RATE_LIMITED_CODE;
  details: AgentApiRateLimitedDetails;
}

const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

/** A 429 body as declared above, or null for anything else. */
export function parseAgentApiRateLimitedBody(body: unknown): AgentApiRateLimitedBody | null {
  if (!body || typeof body !== "object") return null;
  const { error, code, details } = body as Record<string, unknown>;
  if (code !== AGENT_API_RATE_LIMITED_CODE || typeof error !== "string" || !details || typeof details !== "object") return null;
  const { operation, limit, windowSeconds, retryAfterSeconds } = details as Record<string, unknown>;
  if (typeof operation !== "string" || !positiveInteger(limit) || !positiveInteger(windowSeconds) || !positiveInteger(retryAfterSeconds)) return null;
  return { error, code, details: { operation, limit, windowSeconds, retryAfterSeconds } };
}

const RATE_LIMITED_SENTENCE_MAX_CHARS = 300;

/**
 * The sentence an agent client shows for a 429 body: the Server's own (which
 * writes, the limit, the wait) when it is one short line, else a stand-in
 * from its details. The limit may be the agent's or the whole Server's, so
 * the stand-in names neither.
 */
export function agentApiRateLimitedSentence(body: AgentApiRateLimitedBody): string {
  const sentence = body.error.trim();
  if (sentence && !/[\r\n]/.test(sentence) && sentence.length <= RATE_LIMITED_SENTENCE_MAX_CHARS) return sentence;
  const { limit, windowSeconds, retryAfterSeconds } = body.details;
  return `Too many writes of this kind: the limit is ${limit} per ${windowSeconds} seconds. Retry in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}.`;
}
