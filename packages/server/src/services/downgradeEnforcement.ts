import { eq, and, isNotNull, isNull, ne, lt, asc } from "drizzle-orm";
import { getDb } from "../db/index";
import { servers, agents } from "../db/schema";
import { seatAgent } from "./agentMemberListPolicy";
import { PLAN_CONFIG, DOWNGRADE_GRACE_PERIOD_DAYS, getEffectiveLimits, noopTracer, type Tracer } from "@botiverse/raft-shared";
import { errorClassOf, getCurrentTraceContext, recordTraceEvent, runWithTraceSpan } from "../tracing/semanticTrace";
import type { AgentOrchestrator } from "./agentOrchestrator";

/**
 * Enforce free-plan limits after the grace period expires.
 *
 * For each server where plan=free AND planDowngradedAt + 7 days < now:
 * - Count non-inactive agents
 * - If over the free limit, stop the newest agents beyond the limit (keep oldest N)
 * - Clear planDowngradedAt after enforcement (done, no need to repeat)
 *
 * Idempotent — already-inactive agents are skipped.
 */
export async function enforceDowngradeLimits(
  orchestrator: AgentOrchestrator,
  tracer: Tracer = noopTracer,
): Promise<void> {
  const db = getDb();
  const freeAgentLimit = getEffectiveLimits("free").maxAgents;

  // Find servers past grace period
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DOWNGRADE_GRACE_PERIOD_DAYS);

  const expiredServers = await db
    .select({ id: servers.id })
    .from(servers)
    .where(
      and(
        eq(servers.plan, "free"),
        isNotNull(servers.planDowngradedAt),
        lt(servers.planDowngradedAt, cutoff),
        isNull(servers.deletedAt),
      ),
    );

  for (const server of expiredServers) {
    const serverSpan = tracer.startSpan("server.downgrade_enforcement.server", {
      surface: "server",
      kind: "internal",
      parent: getCurrentTraceContext(),
      attrs: { server_id: server.id },
    });
    try {
      const outcome = await runWithTraceSpan(
        serverSpan,
        () => enforceServerLimit(db, orchestrator, tracer, server.id, freeAgentLimit),
        tracer,
      );
      serverSpan.end(outcome === "incomplete" ? "error" : "ok", { attrs: { outcome } });
    } catch (err) {
      console.error(`[Enforcement] Error processing server ${server.id}:`, err);
      const errorClass = errorClassOf(err);
      runWithTraceSpan(serverSpan, () => recordTraceEvent("server.downgrade_enforcement.error", {
        site: "server_sweep",
        outcome: "error",
        reason: "enforcement_sweep_threw",
        error_class: errorClass,
        server_id: server.id,
      }), tracer);
      serverSpan.end("error", { attrs: { outcome: "error", error_class: errorClass } });
    }
  }
}

/**
 * The agents to stop on a downgraded server: the newest ones beyond the free
 * limit, keeping the oldest N (the list is ordered oldest first). -1 means the
 * free plan has no agent limit, so nothing is stopped; without that check
 * `length > -1` was always true and `slice(-1)` stopped the newest agent.
 */
export function agentsOverFreeLimit<T>(activeAgentsOldestFirst: readonly T[], freeAgentLimit: number): T[] {
  if (freeAgentLimit < 0 || activeAgentsOldestFirst.length <= freeAgentLimit) return [];
  return activeAgentsOldestFirst.slice(freeAgentLimit);
}

async function enforceServerLimit(
  db: ReturnType<typeof getDb>,
  orchestrator: AgentOrchestrator,
  tracer: Tracer,
  serverId: string,
  freeAgentLimit: number,
): Promise<"completed" | "incomplete"> {
  // Get non-inactive agents ordered by createdAt ascending (oldest first)
  const activeAgents = await db
    .select({ id: agents.id, createdAt: agents.createdAt })
    .from(agents)
    .where(
      and(
        eq(agents.serverId, serverId),
        ne(agents.status, "inactive"),
        isNull(agents.deletedAt),
        // App-owned bots and personal assistants do not count against the
        // free agent limit (they are not a billable seat) and are not subject
        // to downgrade stop.
        seatAgent(),
      ),
    )
    .orderBy(asc(agents.createdAt));

  const toStop = agentsOverFreeLimit(activeAgents, freeAgentLimit);
  if (toStop.length > 0) {
    let failCount = 0;
    for (const agent of toStop) {
      const stopSpan = tracer.startSpan("server.downgrade_enforcement.agent_stop", {
        surface: "server",
        kind: "internal",
        parent: getCurrentTraceContext(),
        attrs: { server_id: serverId, agent_id: agent.id },
      });
      try {
        await runWithTraceSpan(stopSpan, () => orchestrator.stopAgent(agent.id), tracer);
        stopSpan.end("ok");
        console.log(`[Enforcement] Stopped agent ${agent.id} on server ${serverId} (over free limit)`);
      } catch (err) {
        failCount++;
        console.error(`[Enforcement] Failed to stop agent ${agent.id}:`, err);
        const errorClass = errorClassOf(err);
        runWithTraceSpan(stopSpan, () => recordTraceEvent("server.downgrade_enforcement.error", {
          site: "agent_stop",
          outcome: "error",
          reason: "agent_stop_threw",
          error_class: errorClass,
          server_id: serverId,
          agent_id: agent.id,
        }), tracer);
        stopSpan.end("error", { attrs: { error_class: errorClass } });
      }
    }

    if (failCount > 0) {
      console.warn(`[Enforcement] ${failCount}/${toStop.length} agent stops failed on server ${serverId}, will retry next cycle`);
      // Aggregate state, not one exception: closed reason plus counts, no
      // error_class (per agent identity is on the agent_stop spans above).
      recordTraceEvent("server.downgrade_enforcement.error", {
        site: "agent_stop",
        outcome: "error",
        reason: "enforcement_incomplete",
        server_id: serverId,
        fail_count: failCount,
        to_stop_count: toStop.length,
      });
      // Keep planDowngradedAt so the next enforcement run retries.
      return "incomplete";
    }
  }

  // All stops succeeded (or none needed), so clear planDowngradedAt
  await db
    .update(servers)
    .set({ planDowngradedAt: null, updatedAt: new Date() })
    .where(eq(servers.id, serverId));

  console.log(`[Enforcement] Completed for server ${serverId} (${activeAgents.length} non-inactive agents, limit ${freeAgentLimit})`);
  return "completed";
}
