import { createFixedWindowCounter, type FixedWindowAdmission } from "./fixedWindowRateLimit";

// Budgets on the agent API's writes that post or fan out (routes/
// internalAgentApi.ts: AGENT_API_WRITE_BUDGET_ROUTES): the web's posting
// limit (app.ts messageLimiter, per person) does not cover an agent, so a
// person's own agents would otherwise post without one. Each class has a
// per-agent budget and, where set, a per-Server budget across all its agents
// (so many agents on one Server can't multiply the per-agent one); a request
// must be admitted by both. They count in Redis across replicas
// (fixedWindowRateLimit.ts); without Redis the server is one replica and its
// memory is the whole count. First-party apps' agent API writes (Artifacts')
// are in the same budgets: an app's route that isn't a GET has a class here
// or the server doesn't start (internalAgentApi.ts agentApiMountOf).
// The numbers are first proposals, not load-tested: tune them here.

export type AgentApiWriteBudgetClass = "messages" | "reactions" | "mentionActions" | "taskWrites" | "channelWrites" | "otherWrites" | "reconcile" | "artifactWrites" | "artifactUploads";

export interface AgentApiWriteBudget {
  /** Units one agent may spend per window. */
  perAgent: number;
  /** Units all agents of one Server together may spend per window. */
  perServer: number;
  /** What the units are, in the refusal's sentence ("messages"). */
  what: string;
}

/** One fixed window for every class: a minute. */
export const AGENT_API_WRITE_WINDOW_SECONDS = 60;

/**
 * Per minute. A unit is one request, except: a mention action execute spends
 * one per resolution id (each notifies or adds someone), a task create one per
 * task in its batch, an Artifact review one per comment in it.
 */
// Sized from the fleet-wide 1-minute peaks over 7 days (2026-11-01..08, no
// 429s): every limit is at least twice the busiest real agent and server.
// Peaks per agent / per server: messages 56 / 57, reactions 8 / 12, mention
// actions 6 / 6, task writes 273 / 290 (one burst of status updates),
// channel writes 22 / 22, other writes 24 / 24. Artifacts' agent writes
// (same days, all replicas): pushes 5 / 7, its other writes (mostly comments)
// 6 / 6, both in artifactWrites, apart from core's other writes so each keeps
// at least twice its headroom; file uploads 82 / 82.
export const AGENT_API_WRITE_BUDGETS: Record<AgentApiWriteBudgetClass, AgentApiWriteBudget> = {
  /** send, v2 send, task reply, the assistant's send/forward as owner and notify. */
  messages: { perAgent: 120, perServer: 600, what: "messages" },
  reactions: { perAgent: 60, perServer: 600, what: "reactions" },
  mentionActions: { perAgent: 100, perServer: 1000, what: "mention notifications" },
  /** create, assign, update status, amend, convert, delete, claim, unclaim. */
  taskWrites: { perAgent: 600, perServer: 1200, what: "task changes" },
  /** create, join, member add. */
  channelWrites: { perAgent: 60, perServer: 300, what: "channel changes" },
  /** attachment comments, uploads, thread follows, action and app prepares. */
  otherWrites: { perAgent: 60, perServer: 600, what: "writes of this kind" },
  /**
   * A send's `reconcileOnly` lookup (send, v2 send, task reply): asks whether
   * an earlier send committed and writes nothing. Its own budget, so a client
   * near the messages limit can still learn whether its send landed, while a
   * loop of lookups stays bounded.
   */
  reconcile: { perAgent: 60, perServer: 600, what: "send status checks" },
  /**
   * Artifacts' writes but a push's file uploads: pushes, imports, comments,
   * reviews (one per comment), comment images, follows, unfollows, moves,
   * deletes and attachment saves. Peaks: pushes 5 / 7, the rest 6 / 6.
   */
  artifactWrites: { perAgent: 60, perServer: 600, what: "artifact changes" },
  /**
   * An Artifact push's file uploads (`PUT /artifacts/uploads/:sha256`, one
   * request per new file). Peak 82 / 82; 600 an agent keeps a version of
   * AGENT_API_ARTIFACT_MAX_FILES_PER_VERSION (500) new files pushable within
   * a minute. Their bytes are bounded by the upload quotas besides.
   */
  artifactUploads: { perAgent: 600, perServer: 1200, what: "artifact file uploads" },
};

export type AgentApiWriteAdmission =
  | { admitted: true }
  | { admitted: false; scope: "agent" | "server"; limit: number; retryAfterSeconds: number }
  /** One request larger than a whole minute's budget: refused outright, never charged at the limit. */
  | { admitted: false; scope: "request"; limit: number };

const counter = createFixedWindowCounter();
let budgetsForTests: Partial<Record<AgentApiWriteBudgetClass, Partial<AgentApiWriteBudget>>> | null = null;

// The pglite harness (Playwright shards share one server and one seeded
// owner) skips the budgets unless a test sets them, as app.ts's limiters do.
function budgetOf(kind: AgentApiWriteBudgetClass): AgentApiWriteBudget | null {
  if (budgetsForTests) {
    const override = budgetsForTests[kind];
    return override ? { ...AGENT_API_WRITE_BUDGETS[kind], ...override } : null;
  }
  if (process.env.DATABASE_URL?.startsWith("pglite")) return null;
  return AGENT_API_WRITE_BUDGETS[kind];
}

/**
 * Spends `units` of the agent's budget for `kind`, then of its Server's;
 * refused past either. A request whose real size exceeds either whole budget
 * is refused outright (scope "request"): it is never charged at the limit.
 */
export async function admitAgentApiWrite(
  kind: AgentApiWriteBudgetClass,
  input: { agentId: string; serverId: string; units?: number },
  nowMs = Date.now(),
): Promise<AgentApiWriteAdmission> {
  const budget = budgetOf(kind);
  if (!budget) return { admitted: true };
  const units = Math.max(1, Math.floor(input.units ?? 1));
  const largest = Math.min(budget.perAgent, budget.perServer);
  if (units > largest) return { admitted: false, scope: "request", limit: largest };
  const window = AGENT_API_WRITE_WINDOW_SECONDS;
  const byAgent: FixedWindowAdmission = await counter.admit(`slock:agent-api-write:${kind}:agent:${input.agentId}`, budget.perAgent, window, nowMs, units);
  if (!byAgent.admitted) return { admitted: false, scope: "agent", limit: budget.perAgent, retryAfterSeconds: byAgent.retryAfterSeconds };
  const byServer = await counter.admit(`slock:agent-api-write:${kind}:server:${input.serverId}`, budget.perServer, window, nowMs, units);
  if (!byServer.admitted) return { admitted: false, scope: "server", limit: budget.perServer, retryAfterSeconds: byServer.retryAfterSeconds };
  return { admitted: true };
}

/** The noun for `kind`'s units in a refusal. */
export function agentApiWriteBudgetNoun(kind: AgentApiWriteBudgetClass): string {
  return AGENT_API_WRITE_BUDGETS[kind].what;
}

/**
 * Tests only: enforce the listed classes (also in the pglite harness) at the
 * given numbers (defaults for the rest of a class's fields); classes not
 * listed are skipped. null restores the defaults. Forgets the counts.
 */
export function __setAgentApiWriteBudgetsForTests(budgets: Partial<Record<AgentApiWriteBudgetClass, Partial<AgentApiWriteBudget>>> | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Agent API write budget hooks are test-only");
  budgetsForTests = budgets;
  counter.clear();
}
