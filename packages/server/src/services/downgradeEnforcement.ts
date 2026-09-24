import { eq, and, isNotNull, isNull, ne, lt, asc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { servers, agents } from "../db/schema.js";
import { PLAN_CONFIG, DOWNGRADE_GRACE_PERIOD_DAYS, getEffectiveLimits } from "@botiverse/raft-shared";
import type { AgentOrchestrator } from "./agentOrchestrator.js";

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
export async function enforceDowngradeLimits(orchestrator: AgentOrchestrator): Promise<void> {
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
    try {
      // Get non-inactive agents ordered by createdAt ascending (oldest first)
      const activeAgents = await db
        .select({ id: agents.id, createdAt: agents.createdAt })
        .from(agents)
        .where(
          and(
            eq(agents.serverId, server.id),
            ne(agents.status, "inactive"),
            isNull(agents.deletedAt),
          ),
        )
        .orderBy(asc(agents.createdAt));

      if (activeAgents.length > freeAgentLimit) {
        // Stop the newest agents beyond the limit (keep oldest N)
        const toStop = activeAgents.slice(freeAgentLimit);
        let failCount = 0;
        for (const agent of toStop) {
          try {
            await orchestrator.stopAgent(agent.id);
            console.log(`[Enforcement] Stopped agent ${agent.id} on server ${server.id} (over free limit)`);
          } catch (err) {
            failCount++;
            console.error(`[Enforcement] Failed to stop agent ${agent.id}:`, err);
          }
        }

        if (failCount > 0) {
          console.warn(`[Enforcement] ${failCount}/${toStop.length} agent stops failed on server ${server.id} — will retry next cycle`);
          continue; // Don't clear planDowngradedAt; retry on next enforcement run
        }
      }

      // All stops succeeded (or none needed) — clear planDowngradedAt
      await db
        .update(servers)
        .set({ planDowngradedAt: null, updatedAt: new Date() })
        .where(eq(servers.id, server.id));

      console.log(`[Enforcement] Completed for server ${server.id} (${activeAgents.length} non-inactive agents, limit ${freeAgentLimit})`);
    } catch (err) {
      console.error(`[Enforcement] Error processing server ${server.id}:`, err);
    }
  }
}
