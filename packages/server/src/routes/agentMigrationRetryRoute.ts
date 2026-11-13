// POST /internal/agent-api/migrations/retry (agentApiContract `migrationRetry`,
// `raft migration retry`): the acting agent retries, once, its latest
// migration to another Computer after it failed because its workspace was too
// big. No parameters: everything is copied from the failed migration, and it
// runs on behalf of the person who started that one. Approved by Artea
// (product) and Tenny (CTO), #wg-agent-migration 7746de27 msg f607ea47.
//
// Checks, each a refusal that changes nothing (so it does not use up the
// retry): the failed migration (services/agentMigrationRetry.ts), the source
// Computer's AGENT_MIGRATION_AGENT_RETRY_CAPABILITY, the starter's authority,
// then exactly the checks and provisioning of the owner's start
// (routes/agentMigrationStart.ts). The write transaction re-checks the starter
// and the failed migration under the start's row locks, and
// idx_agent_migrations_retry_of keeps it to one retry under a race.
import type { Request, Response } from "express";
import type { Server as SocketServer } from "socket.io";
import {
  AGENT_MIGRATION_AGENT_RETRY_CAPABILITY,
  AGENT_MIGRATION_RETRY_NOTE,
  currentDate,
  type AgentApiMigrationRetryResponse,
  type AgentMigrationRetryRefusalCode,
  type AgentMigrationUserErrorCode,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { FencedAuthorizationDeniedError, ServerMembershipRevokedError } from "../lib/actorMembershipFence";
import { getActorServerRoleInServer, userCanActOnAgentResource } from "../lib/actorPermissions";
import { refuse, sentenceQuoting, type RefusalStatus } from "../lib/refusal";
import { setRequestTraceErrorCode } from "../middleware/requestObservability";
import * as agentService from "../services/agentService";
import { emitAgentMigrationUpdated } from "../services/agentMigrationRealtime";
import {
  AgentMigrationRetryRefusedError,
  agentMigrationHasRetry,
  agentMigrationRetryRefusal,
  readNewestAgentMigration,
} from "../services/agentMigrationRetry";
import { notifyStarterOfAgentMigrationRetry } from "../services/agentMigrationRetryNotice";
import { BuiltInModelCatalogError } from "../services/builtinModelCatalogCompatibility";
import { MachineCatalogStaleError } from "../services/machineCatalogAuthority";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { recordIntegrationAuditEvent } from "../services/integrationAuditService";
import { recordTraceEvent } from "../tracing/semanticTrace";
import {
  acquireMigrationTargetCatalogAuthority,
  getMigrationTransferProvisioner,
  provisionComputerMigrationStart,
  sendBuiltInCatalogError,
  sendComputerMigrationLeases,
  validateComputerMigrationStart,
} from "./agentMigrationStart";
import { sendJsonServerError } from "./errorResponse";
import { notePaywallHit } from "./paywallHit";

const RETRY = "raft migration retry";
const ASK_OWNER = "Ask your owner to start the move again from the web app (Move to Another Computer on your profile).";
const NO_RETRYABLE_ERROR = "Your latest move did not fail because your workspace was too big, so there is nothing for you to retry.";
const MOVED_SINCE_ERROR = "You are no longer on the Computer that move started from, so it can't be retried.";
const TARGET_UNAVAILABLE_NEXT = `Run ${RETRY} again in a few minutes (this refusal did not use up the retry); if it keeps failing, ask your owner.`;

/**
 * Per code: `error` is the reason only (it says "move", like the CLI), and
 * `suggestedNextAction` the one thing to do instead (#wg-ax:#13: the Server
 * sends the next step, so agents on the SDK or a tool call see it too).
 */
const REFUSALS: Record<AgentMigrationRetryRefusalCode, { status: RefusalStatus; error: string; next: string }> = {
  NO_RETRYABLE_MIGRATION: {
    status: 409,
    error: NO_RETRYABLE_ERROR,
    next: "Nothing to retry. If you still need to move, ask your owner to start the move from the web app (Move to Another Computer on your profile).",
  },
  ALREADY_RETRIED: { status: 409, error: "That move was already retried once.", next: ASK_OWNER },
  RETRY_WINDOW_EXPIRED: { status: 409, error: "That move failed more than 24 hours ago, so it can no longer be retried.", next: ASK_OWNER },
  SOURCE_UNSUPPORTED: {
    status: 409,
    error: "The Computer you run on does not support retrying a move yet, or it is not connected right now.",
    next: "Ask your owner to update this Computer, or to start the move again from the web app (Move to Another Computer on your profile).",
  },
  STARTER_NOT_AUTHORIZED: {
    status: 403,
    error: "The person who started that move may no longer move you, so it can't be retried for them.",
    next: "Ask someone who may move you to start it from the web app (Move to Another Computer on your profile).",
  },
  PLAN_REQUIRED: {
    status: 403,
    error: "Moving agents needs the Pro plan on this server.",
    next: "Ask a server owner about the plan; the move can't be retried until then.",
  },
  MIGRATION_ACTIVE: {
    status: 409,
    error: "Another move of yours is already in progress.",
    next: "Nothing to run; finish your current work. That move stops you when you are idle and moves you, or its receipt says why it failed.",
  },
  TARGET_UNAVAILABLE: { status: 409, error: "The target Computer can't take you right now.", next: TARGET_UNAVAILABLE_NEXT },
};

type RetryTrace = { agentId: string; serverId: string; retryOfMigrationId: string | null };

function trace(context: RetryTrace, attrs: Record<string, string | number | boolean | null>): void {
  recordTraceEvent("server.agent.migration_retry", {
    agent_id: context.agentId,
    server_id: context.serverId,
    retry_of_migration_id: context.retryOfMigrationId,
    triggered_by: "agent",
    ...attrs,
  });
}

function refuseRetry(
  res: Response,
  context: RetryTrace,
  code: AgentMigrationRetryRefusalCode,
  error?: string,
): void {
  trace(context, { outcome: "refused", code });
  const refusal = REFUSALS[code];
  refuse(res, refusal.status, { code, error: error ?? refusal.error, suggestedNextAction: refusal.next });
}

/** The owner start's target refusal codes, answered as TARGET_UNAVAILABLE with the reason in words. */
function refuseTargetUnavailable(
  res: Response,
  context: RetryTrace,
  targetMachineName: string,
  failure: { code: AgentMigrationUserErrorCode; error: string },
): void {
  trace(context, { outcome: "refused", code: "TARGET_UNAVAILABLE", start_code: failure.code });
  const reason = failure.error.replace(/\.$/, "");
  const error = sentenceQuoting(
    [targetMachineName, reason],
    `The target Computer ${targetMachineName} can't take you right now (${reason}).`,
    sentenceQuoting([reason], `The target Computer can't take you right now (${reason}).`, REFUSALS.TARGET_UNAVAILABLE.error),
  );
  const retryAfterSeconds = failure.code === "TARGET_RUNTIME_DETECTION_PENDING" ? 30 : undefined;
  refuse(res, 409, {
    code: "TARGET_UNAVAILABLE",
    error,
    suggestedNextAction: retryAfterSeconds === undefined
      ? TARGET_UNAVAILABLE_NEXT
      : `Run ${RETRY} again in ${retryAfterSeconds} seconds (this refusal did not use up the retry).`,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
}

export async function handleAgentMigrationRetry(req: Request, res: Response): Promise<void> {
  const agentId = req.actingAgentId!;
  const serverId = req.serverId!;
  const context: RetryTrace = { agentId, serverId, retryOfMigrationId: null };
  try {
    const now = currentDate();
    const agent = await agentService.getAgent(agentId);
    if (!agent || agent.serverId !== serverId) {
      refuseRetry(res, context, "NO_RETRYABLE_MIGRATION");
      return;
    }

    // 1. The failed migration: the agent's newest, a size failure of a move to
    //    another Computer, within the window, not retried, the agent still on its source.
    const failed = await readNewestAgentMigration(getDb(), agentId);
    if (failed) context.retryOfMigrationId = failed.id;
    const refusal = agentMigrationRetryRefusal({
      failed,
      agentMachineId: agent.machineId ?? null,
      retried: failed ? await agentMigrationHasRetry(getDb(), failed.id) : false,
      now,
    });
    if (refusal || !failed?.targetMachineId) {
      const code = refusal ?? "NO_RETRYABLE_MIGRATION";
      const movedSince = code === "NO_RETRYABLE_MIGRATION" && failed?.state === "failed" && agent.machineId !== failed.sourceMachineId;
      refuseRetry(res, context, code, movedSince ? MOVED_SINCE_ERROR : undefined);
      return;
    }
    const targetMachineName = failed.targetMachineNameSnapshot ?? "the target computer";

    // 2. The source (where the agent runs and trimmed its workspace) must support it.
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    const sourceTransport = await orchestrator?.getMachineMigrationTransport(failed.sourceMachineId) ?? null;
    if (!sourceTransport?.capabilities?.includes(AGENT_MIGRATION_AGENT_RETRY_CAPABILITY)) {
      refuseRetry(res, context, "SOURCE_UNSUPPORTED");
      return;
    }

    // 3. The starter: the same rule as the owner's start (migrateAgents, or the
    //    agent's human creator). Re-checked under row locks in the write.
    const starterUserId = failed.initiatedByUserId;
    const starterRole = starterUserId ? await getActorServerRoleInServer(serverId, "user", starterUserId) : null;
    if (!starterUserId || !userCanActOnAgentResource(starterRole, starterUserId, agent, "migrateAgents")) {
      refuseRetry(res, context, "STARTER_NOT_AUTHORIZED");
      return;
    }

    // 4. The owner start's checks, on the failed migration's target.
    const validation = await validateComputerMigrationStart({
      serverId,
      agentId,
      targetComputer: failed.targetMachineId,
      orchestrator,
      now,
    });
    if ("failure" in validation) {
      const { failure } = validation;
      if (failure.code === "MIGRATION_ALREADY_IN_PROGRESS") {
        refuseRetry(res, context, "MIGRATION_ACTIVE");
      } else if (failure.code === "AGENT_NOT_FOUND" || failure.code === "AGENT_HAS_NO_SOURCE_MACHINE" || failure.code === "TARGET_COMPUTER_MATCHES_SOURCE") {
        refuseRetry(res, context, "NO_RETRYABLE_MIGRATION", MOVED_SINCE_ERROR);
      } else {
        refuseTargetUnavailable(res, context, targetMachineName, failure);
      }
      return;
    }
    const validated = validation.validated;
    // Its Computer's access was revoked since: nothing can be brought over from it.
    if (validated.placeWithoutSource || validated.sourceMachineId !== failed.sourceMachineId) {
      refuseRetry(res, context, "NO_RETRYABLE_MIGRATION", MOVED_SINCE_ERROR);
      return;
    }

    const releaseCatalogAuthority = await acquireMigrationTargetCatalogAuthority(req, res, orchestrator, validated);
    if (releaseCatalogAuthority === "handled") {
      trace(context, { outcome: "refused", code: "builtin_catalog" });
      return;
    }
    try {
      // 5. Pro plan, transport, then the row: everything from the failed migration.
      const started = await provisionComputerMigrationStart({
        serverId,
        validated,
        initiatedByUserId: starterUserId,
        actorFence: { serverId, userId: starterUserId, capability: "migrateAgents" },
        agentRetry: { retryOfMigrationId: failed.id, triggeredByAgentId: agentId },
        provisioner: getMigrationTransferProvisioner(req),
        now,
        inStartTransaction: async (tx, provisioning) => {
          await recordIntegrationAuditEvent({
            serverId,
            eventType: "agent.migration_retry_started",
            outcome: "success",
            source: "api",
            actor: { type: "agent", id: agentId },
            requester: { type: "human", id: starterUserId },
            target: { type: "agent", id: agentId },
            metadata: {
              agentId,
              migrationId: provisioning.migration.id,
              retryOfMigrationId: failed.id,
              onBehalfOfUserId: starterUserId,
              sourceMachineId: provisioning.migration.sourceMachineId,
              targetMachineId: provisioning.migration.targetMachineId,
            },
          }, tx);
          await notifyStarterOfAgentMigrationRetry(provisioning.migration, "started", tx);
        },
      });
      if ("failure" in started) {
        const { failure } = started;
        if ("planRequired" in failure) {
          notePaywallHit(req, "agent_migration");
          refuseRetry(res, context, "PLAN_REQUIRED");
        } else if (failure.code === "MIGRATION_ALREADY_IN_PROGRESS") {
          refuseRetry(res, context, "MIGRATION_ACTIVE");
        } else {
          // The transfer could not be provisioned: nothing was written.
          trace(context, { outcome: "failed", code: failure.code });
          setRequestTraceErrorCode(res, failure.code);
          res.status(503).json({
            error: "The move could not be prepared right now; nothing was started and the retry was not used up.",
            code: failure.code,
            suggestedNextAction: `Run ${RETRY} again in a few minutes.`,
          });
        }
        return;
      }

      const { provisioning } = started;
      const io = req.app.get("io") as SocketServer | undefined;
      await emitAgentMigrationUpdated(io, provisioning.migration);
      const leaseFailure = await sendComputerMigrationLeases({ io, orchestrator, provisioning });
      if (leaseFailure) {
        // The row exists and failed (its failed receipt says the retry is used up).
        trace(context, { outcome: "failed", code: leaseFailure.code, migration_id: provisioning.migration.id });
        setRequestTraceErrorCode(res, leaseFailure.code);
        res.status(503).json({
          error: "The move started but its Computers could not be reached, so it failed and used up the retry.",
          code: leaseFailure.code,
          suggestedNextAction: ASK_OWNER,
        });
        return;
      }
      trace(context, { outcome: "started", migration_id: provisioning.migration.id, target_machine_id: provisioning.migration.targetMachineId });
      const body: AgentApiMigrationRetryResponse = {
        migrationId: provisioning.migration.id,
        supportRef: provisioning.migration.supportRef,
        targetMachineName: provisioning.migration.targetMachineNameSnapshot ?? targetMachineName,
        note: AGENT_MIGRATION_RETRY_NOTE,
      };
      res.json(body);
    } finally {
      releaseCatalogAuthority();
    }
  } catch (err) {
    if (err instanceof AgentMigrationRetryRefusedError) {
      refuseRetry(res, context, err.code);
      return;
    }
    if (err instanceof BuiltInModelCatalogError || err instanceof MachineCatalogStaleError) {
      trace(context, { outcome: "refused", code: err.code });
      sendBuiltInCatalogError(res, err);
      return;
    }
    if (err instanceof ServerMembershipRevokedError || err instanceof FencedAuthorizationDeniedError) {
      refuseRetry(res, context, "STARTER_NOT_AUTHORIZED");
      return;
    }
    trace(context, { outcome: "error" });
    sendJsonServerError(req, res, {
      error: "Failed to retry the migration",
      code: "agent_api_migration_retry_failed",
      logPrefix: "[AgentAPI] Failed to retry the migration",
      err,
    });
  }
}
