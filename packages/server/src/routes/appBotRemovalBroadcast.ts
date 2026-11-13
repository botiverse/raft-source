import type { Request } from "express";
import type { Server as SocketServer } from "socket.io";
import { broadcastAgentCredentialRevocation } from "../replicaRouter";
import type { AgentOrchestrator } from "../services/agentOrchestrator";

/** What the removal broadcast needs: the socket server and the orchestrator, either may be absent (a test app, a job). */
export type AppBotRemovalRuntime = {
  io?: Pick<SocketServer, "to"> | null;
  agentOrchestrator?: Pick<AgentOrchestrator, "forgetAgentActivity"> | null;
};

/**
 * After a commit that soft-deleted App Bots on their installing Servers (an
 * offline review, or deleting the App): each Server's clients drop the Bot,
 * its activity is forgotten, and its open credential streams close on every
 * replica.
 */
export async function announceRemovedAppBots(
  req: Request,
  bots: ReadonlyArray<{ agentId: string; serverId: string }>,
): Promise<void> {
  await emitRemovedAppBots({
    io: req.app.get("io") as SocketServer | undefined,
    agentOrchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator | undefined,
  }, bots);
}

/**
 * announceRemovedAppBots without a request: the marketplace review outbox
 * (services/marketplaceReviewOutbox.ts) sends an offline approval's removed
 * bots through it, whoever decided. Each part is harmless to repeat: the web
 * re-reads its agents on `agent:deleted`, and the revocation signal only makes
 * open streams re-validate against the database.
 */
export async function emitRemovedAppBots(
  runtime: AppBotRemovalRuntime,
  bots: ReadonlyArray<{ agentId: string; serverId: string }>,
): Promise<void> {
  for (const bot of bots) {
    runtime.agentOrchestrator?.forgetAgentActivity?.(bot.agentId);
    runtime.io?.to(`server:${bot.serverId}`).emit("agent:deleted", { agentId: bot.agentId });
    await broadcastAgentCredentialRevocation(bot.agentId);
  }
}
