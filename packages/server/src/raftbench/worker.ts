import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { thirdPartyAgentEvents } from "../db/schema";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { deliverSystemAppAgentEvent } from "../services/systemAppAgentEvents";
import { advanceServer, enrolledServers } from "./controls";
import { dispatchTriage } from "./triageRunner";

/** Assigns bounded hosted runs and dispatches first-pass triage batches (behind its own flag). */
export async function tickRaftbench(orchestrator: Pick<AgentOrchestrator, "deliverMessage">) {
  if (process.env.DEPLOYMENT_ENV !== "staging") return;
  for (const { serverId } of await enrolledServers()) {
    // Triage is independent of the hosted run; its model calls continue after dispatch returns.
    try { await dispatchTriage(serverId); }
    catch { console.error("[RaftBench] triage dispatch failed; next tick will retry"); }
    await advanceServer(serverId);
    const events = await getDb().select().from(thirdPartyAgentEvents).where(and(eq(thirdPartyAgentEvents.serverId, serverId), eq(thirdPartyAgentEvents.systemApp, "system.raftbench"), eq(thirdPartyAgentEvents.status, "queued"))).limit(1);
    for (const event of events) {
      await deliverSystemAppAgentEvent({ event, deliverer: orchestrator });
    }
  }
}
export function startRaftbenchWorker(orchestrator: Pick<AgentOrchestrator, "deliverMessage">) {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try { await tickRaftbench(orchestrator); }
    catch { console.error("[RaftBench] assignment sweep failed; next tick will retry"); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 30_000);
  timer.unref();
  void tick();
  return { stop() { stopped = true; clearInterval(timer); } };
}
