import type { Server as SocketServer } from "socket.io";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { servers } from "../db/schema.js";
import type { AgentOrchestrator } from "./agentOrchestrator.js";
import * as onboardingService from "./onboardingService.js";

/**
 * Brief Cindy when her COMPUTER comes back — because she herself never wakes up.
 *
 * The briefing (who the owner is, what they answered in the survey, "do not repeat the
 * opener") is a transient delivery: sent to an agent whose machine is dark it is dropped, not
 * queued. `onboardingService` knows that and declines to send, leaving the work to "the next
 * activation" — a retry wired to four HTTP routes. Turn the computer on the next morning and
 * none of those routes is touched, so Cindy came up having never been told anything, and the
 * only cure was for the user to guess that pressing Start would fix it.
 *
 * The obvious hook is "the agent became active". It is a trap, and I fell in it twice.
 * Switching a computer off does NOT set its agents inactive: the row reads `active` while the
 * machine is dark and `active` when it returns. So there is no inactive→active EDGE to catch —
 * and, as the second attempt proved in a live run, no level either: no agent lifecycle event
 * is emitted at all. From the server's point of view Cindy has no wake-up. Both times the unit
 * tests agreed with me, because both times I had fabricated the event by hand.
 *
 * What DOES happen — observed in a live run, with a probe, BEFORE this was written: the daemon
 * reconnects, `registerMachine` marks the machine online, and `machine:online` is emitted.
 * That is the real "the computer came back" moment, and it is the only one.
 *
 * Idempotent by construction: `triggerOwnerOnboardingOnAgentActivation` no-ops once the ledger
 * is recorded, and the visible opener messages are keyed by `agentSendKey`, so a replay is
 * invisible to the human. Idempotence belongs to the trigger, which knows what "already done"
 * means — it was never this listener's to guess at.
 */
export function startOnboardingBriefingOnActivation(deps: {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  /** Injectable for tests; defaults to the real trigger. */
  trigger?: typeof onboardingService.triggerOwnerOnboardingOnAgentActivation;
  /** Injectable for tests; defaults to the real one. */
  deliverOwnerFacts?: typeof onboardingService.deliverOwnerFactsContext;
  onError?: (error: unknown, serverId: string) => void;
}): () => void {
  const trigger = deps.trigger ?? onboardingService.triggerOwnerOnboardingOnAgentActivation;
  const deliverOwnerFacts = deps.deliverOwnerFacts ?? onboardingService.deliverOwnerFactsContext;
  const onError = deps.onError ?? ((error: unknown, serverId: string) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Onboarding] Briefing retry failed for server ${serverId}: ${message}`);
  });

  const listener = (event: { machineId: string; serverId: string }) => {
    void (async () => {
      try {
        // Only this server's onboarding agent is owed a briefing. Read it fresh from the row:
        // this runs on reconnect, which is precisely when a cache is least likely to have
        // caught up with reality.
        const [server] = await getDb()
          .select({ onboardingAgentId: servers.onboardingAgentId })
          .from(servers)
          .where(and(eq(servers.id, event.serverId), isNull(servers.deletedAt)));
        if (!server?.onboardingAgentId) return;

        // Who she is working for, EVERY time she comes back. Not once.
        //
        // The opener is a message: sent once, lives in history. The owner facts are context:
        // a session starts with them or it does not have them. We used to hand them over
        // exactly once, inside the transient wake that also produced the opener — so the
        // session the user actually talks to had never heard of them, and a fully onboarded
        // Cindy answered "you never told me" when asked what the survey said. She was right.
        //
        // Deliberately before the opener trigger and deliberately not gated on it: a server
        // that finished onboarding weeks ago still needs its Cindy to know who she works for
        // when her laptop wakes up.
        await deliverOwnerFacts(
          deps.orchestrator,
          event.serverId,
          server.onboardingAgentId,
        );

        await trigger(deps.io, deps.orchestrator, event.serverId, server.onboardingAgentId);
      } catch (error) {
        // This runs on every machine reconnect in the system. It must never be the reason one
        // fails to come back.
        onError(error, event.serverId);
      }
    })();
  };

  deps.orchestrator.on("machine:online", listener);
  return () => {
    deps.orchestrator.off("machine:online", listener);
  };
}
