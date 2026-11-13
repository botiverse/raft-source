/**
 * Hosted Cindy (step 4, #raft-antiproton:8008c6f0): the onboarding agent as a
 * hosted (Antiproton) agent, briefed once its workspace import lands instead
 * of when a computer comes online.
 */
import { AssistantCannotUseComputerError, lockMachineTakingAgents } from "./computerAgents";
import { revokeRunnerCredentialsOffMachine } from "./agentCredentialService";
import { agentConfigValues, recordAgentConfigChange } from "./agentConfigChangeEvents";
import type { Server as SocketServer } from "socket.io";
import { and, count, eq, gte, isNotNull, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { clearClockInterval, currentDate, EXTERNAL_AGENT_RUNTIME_ID, EXTERNAL_AGENT_RUNTIME_MODEL, noopTracer, setClockInterval, type ReasoningEffort, type LegacyColumnReasoningEffort, type RuntimeConfig, type Tracer } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentRuntimeProvisions, agents, inboxNotificationFacts, reminders, serverMembers, servers } from "../db/schema";
import { fireReminder } from "../apps/reminder/service";
import { getOrCreateThread, recordThreadFollow } from "./channelService";
import { broadcastSystemMessage } from "./messageService";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { getServerOwnerId, isAgentRuntimeProviderEnabledForServer } from "./agentRuntimeProviderFeature";
import { onProvisionImported, onProvisionImportFailed } from "./agentRuntimeProvisionImport";
import { assertProviderProvisioningAvailable, deleteProviderAgentNow, kickAgentRuntimeProvisionWorker, recordAgentProvisioning, retryAgentProvisioning, settleProvisionDeleted } from "./agentRuntimeProvisionService";
import { kickAppNotificationDelivery } from "./appNotificationDeliveryService";
import { createAgent } from "./agentService";
import { PrincipalHandleConflictError } from "./principalHandleService";
import { OFFICIAL_ONBOARDING_AGENT_IDENTITY } from "./officialOnboardingAgentIdentity";
import * as serverService from "./serverService";
import { ANTIPROTON_CINDY_FEATURE_FLAG_KEY, evaluateFeatureFlag } from "./featureFlagService";
import { addTraceEvent, recordTraceEvent, withTraceRoot } from "../tracing/semanticTrace";

/** The import source hosted Cindy is provisioned with (agentRuntimeProvisionImport). */
export const HOSTED_CINDY_IMPORT_SOURCE = "cindy_seed";

/**
 * `antiproton_cindy` and `antiproton_hosted_runtime` both on; any evaluation failure reads as off.
 * Gates creating a hosted Cindy only: one that exists keeps her status and recap whatever the
 * flag says later. Both flags are evaluated for the server's owner, so `user` rules on one
 * account cover every server it owns.
 */
export async function isHostedCindyEnabled(serverId: string): Promise<boolean> {
  try {
    const userId = await getServerOwnerId(serverId);
    const cindy = await evaluateFeatureFlag({ key: ANTIPROTON_CINDY_FEATURE_FLAG_KEY, serverId, userId });
    return cindy.enabled === true && await isAgentRuntimeProviderEnabledForServer(serverId, "antiproton");
  } catch (error) {
    console.warn(`[HostedCindy] ${ANTIPROTON_CINDY_FEATURE_FLAG_KEY} evaluation failed; leaving it off`, error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * The staging-only test entry (tygg, #raft-antiproton:f5f3e410): the setup
 * screen's "Use cloud agent" link creates a hosted Cindy on a server whose
 * `antiproton_cindy` is off. Never on any other deployment, so production
 * cannot reach it whatever its flags say.
 */
export function isHostedCindyTestEntryDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEPLOYMENT_ENV === "staging";
}

/** Whether the test entry applies to this server for this user: owner, no onboarding agent yet, hosted runtime on. */
export async function isHostedCindyTestEntryAvailable(input: { serverId: string; userId: string }): Promise<boolean> {
  if (!isHostedCindyTestEntryDeployment()) return false;
  const server = await serverService.getServer(input.serverId);
  if (!server || server.ownerId !== input.userId || server.onboardingAgentId) return false;
  try {
    return await isAgentRuntimeProviderEnabledForServer(input.serverId, "antiproton");
  } catch {
    return false;
  }
}

export type HostedOnboardingAgentState = "ready" | "pending" | "failed";

/**
 * Where a hosted onboarding agent stands: `ready` once the provider accepted
 * it AND its workspace import landed, `failed` if either step stopped, else
 * `pending`. null when the agent is not a hosted Cindy, so callers keep the
 * computer path's rules. Independent of antiproton_cindy: the flag only gates
 * creating one.
 */
export async function getHostedOnboardingAgentState(serverId: string, agentId: string): Promise<HostedOnboardingAgentState | null> {
  const [row] = await getDb().select({
    state: agentRuntimeProvisions.state,
    importedAt: agentRuntimeProvisions.importedAt,
    importFailedAt: agentRuntimeProvisions.importFailedAt,
  }).from(agentRuntimeProvisions).where(and(
    eq(agentRuntimeProvisions.agentId, agentId),
    eq(agentRuntimeProvisions.serverId, serverId),
    eq(agentRuntimeProvisions.importSource, HOSTED_CINDY_IMPORT_SOURCE),
  )).limit(1);
  if (!row) return null;
  if (row.state === "active" && row.importedAt) return "ready";
  if (row.state === "failed" || row.importFailedAt) return "failed";
  return "pending";
}

/** How long a new hosted Cindy may take to be ready before setup treats her as failed. */
export const HOSTED_CINDY_READY_TIMEOUT_MS = 3 * 60_000;

export type HostedCindySetupState = "usable" | "failed";

/** Record once how the automatic retry ended (onboarding.hosted_cindy.setup_retry_result). */
async function recordSetupRetryOutcome(agentId: string, serverId: string, outcome: "ok" | "failed", tracer?: Tracer): Promise<void> {
  const settled = await getDb().update(agentRuntimeProvisions).set({ setupRetryOutcome: outcome })
    .where(and(eq(agentRuntimeProvisions.agentId, agentId), isNull(agentRuntimeProvisions.setupRetryOutcome)))
    .returning({ agentId: agentRuntimeProvisions.agentId });
  if (settled.length > 0) {
    recordTraceEvent("onboarding.hosted_cindy.setup_retry_result", { server_id: serverId, agent_id: agentId, outcome }, tracer);
  }
}

export class HostedCindyConversionError extends Error {}

function sinceFirstFailureBucket(firstFailureAt: Date | null, now: Date): string {
  if (!firstFailureAt) return "unknown";
  const hours = (now.getTime() - firstFailureAt.getTime()) / 3_600_000;
  return hours < 1 ? "lt_1h" : hours < 24 ? "1h_24h" : "gte_24h";
}

/**
 * Where setup stands with a hosted Cindy (Tenny, #raft-antiproton:8008c6f0):
 * `usable` while she is ready or still on her way (provisioned, import not yet
 * landed: Antiproton holds pushes until it does); `failed` once provisioning or
 * the import stopped, or she is not ready within 3 minutes. The first failure
 * gets one automatic retry (a hiccup should not cost the owner a computer
 * setup); the second sends setup to the computer fallback. null when the agent
 * is not a hosted Cindy. Independent of antiproton_cindy (Tenny): turning the
 * flag off must not strand a Cindy that already exists.
 */
export async function resolveHostedCindySetupState(input: {
  serverId: string;
  agentId: string;
  now?: Date;
  tracer?: Tracer;
}): Promise<HostedCindySetupState | null> {
  const [row] = await getDb().select().from(agentRuntimeProvisions).where(and(
    eq(agentRuntimeProvisions.agentId, input.agentId),
    eq(agentRuntimeProvisions.serverId, input.serverId),
    eq(agentRuntimeProvisions.importSource, HOSTED_CINDY_IMPORT_SOURCE),
    notInArray(agentRuntimeProvisions.state, ["deleting", "deleted"]),
  )).limit(1);
  // No flag check: antiproton_cindy only decides whether new hosted Cindys are
  // created. One that exists keeps her state and her fallback after a rollback.
  if (!row) return null;
  const now = input.now ?? currentDate();
  if (row.state === "active" && row.importedAt) {
    if (row.setupRetryAt && !row.setupRetryOutcome) await recordSetupRetryOutcome(row.agentId, input.serverId, "ok", input.tracer);
    return "usable";
  }
  const stopped = row.state === "failed" || row.importFailedAt !== null;
  const since = row.setupRetryAt ?? row.createdAt;
  const timedOut = now.getTime() - since.getTime() > HOSTED_CINDY_READY_TIMEOUT_MS;
  if (!stopped && !timedOut) return "usable";
  if (row.setupRetryAt) {
    if (!row.setupRetryOutcome) await recordSetupRetryOutcome(row.agentId, input.serverId, "failed", input.tracer);
    return "failed";
  }

  // One automatic retry, claimed so concurrent setup loads retry once.
  const claimed = await getDb().update(agentRuntimeProvisions).set({ setupRetryAt: now })
    .where(and(eq(agentRuntimeProvisions.agentId, row.agentId), isNull(agentRuntimeProvisions.setupRetryAt)))
    .returning({ agentId: agentRuntimeProvisions.agentId });
  if (claimed.length === 0) return "usable";
  if (timedOut && !stopped) {
    recordTraceEvent("onboarding.hosted_cindy.timed_out", { server_id: input.serverId, agent_id: row.agentId, state: row.state }, input.tracer);
  }
  recordTraceEvent("onboarding.hosted_cindy.setup_retry", {
    server_id: input.serverId,
    agent_id: row.agentId,
    reason: stopped ? (row.state === "failed" ? "provision_failed" : "import_failed") : "timed_out",
  }, input.tracer);
  const outcome = await getDb().transaction((tx) => retryAgentProvisioning(tx, row.agentId));
  if (outcome === "nothing_to_retry") {
    // Waiting on its import with no error yet: make it due now.
    await getDb().update(agentRuntimeProvisions).set({ nextAttemptAt: now, attemptCount: 0 })
      .where(eq(agentRuntimeProvisions.agentId, row.agentId));
  }
  kickAgentRuntimeProvisionWorker();
  return "usable";
}

/**
 * The computer fallback (Tenny's option (a)): a hosted Cindy that failed setup
 * becomes a computer Cindy in place, so her name, id, DMs and server role stay.
 * The hosted side is cleaned up through the deletion path (her credentials are
 * revoked and the provision becomes a tombstone whose worker DELETEs the
 * provider agent), then the agent takes the computer runtime the owner picked.
 * Afterwards she follows the computer Cindy path: the daemon seeds her
 * workspace on first start and machine:online briefs her; the opener claim
 * keeps it to one opener.
 */
export async function convertFailedHostedCindyToComputer(input: {
  serverId: string;
  agentId: string;
  actorUserId: string;
  runtime: string;
  model: string;
  runtimeConfig: RuntimeConfig;
  reasoningEffort: LegacyColumnReasoningEffort | null;
  envVars: Record<string, string> | null;
  machineId: string | null;
  tracer?: Tracer;
  now?: Date;
}): Promise<void> {
  const [failure] = await getDb().select({
    lastErrorCode: agentRuntimeProvisions.lastErrorCode,
    importErrorCode: agentRuntimeProvisions.importErrorCode,
    setupRetryAt: agentRuntimeProvisions.setupRetryAt,
  }).from(agentRuntimeProvisions).where(eq(agentRuntimeProvisions.agentId, input.agentId)).limit(1);
  // Never a personal assistant (agents_assistant_not_on_machine; Cindy is not
  // one): refused before anything is deleted. assistant_owner_user_id is only
  // ever set when an assistant is created, so it cannot appear afterwards.
  if (input.machineId) {
    const [subject] = await getDb().select({ assistantOwnerUserId: agents.assistantOwnerUserId }).from(agents).where(eq(agents.id, input.agentId)).limit(1);
    if (subject?.assistantOwnerUserId) throw new AssistantCannotUseComputerError();
  }
  // The provider side goes first, and must be confirmed gone: never both sides alive.
  if (!await deleteProviderAgentNow(input.agentId, input.serverId)) {
    throw new HostedCindyConversionError("The cloud runtime did not confirm the delete; nothing was changed, try again");
  }
  await getDb().transaction(async (tx) => {
    await settleProvisionDeleted(tx, input.agentId, input.actorUserId);
    const [before] = await tx.select({ serverId: agents.serverId, runtime: agents.runtime, model: agents.model, reasoningEffort: agents.reasoningEffort })
      .from(agents).where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt))).limit(1).for("update");
    // Not onto a computer whose key was revoked (computerAgents.ts).
    if (input.machineId) await lockMachineTakingAgents(tx, input.machineId);
    // Runtime columns only (her profile, name and role stay): the computer runtime and
    // seed the owner picked, on the computer they picked.
    const now = currentDate();
    const converted = await tx.update(agents).set({
      runtime: input.runtime,
      model: input.model,
      runtimeConfig: input.runtimeConfig,
      reasoningEffort: input.reasoningEffort,
      envVars: input.envVars,
      sessionId: null,
      machineId: input.machineId,
      ...(input.machineId ? { machineReleaseReason: null, machineReleasedAt: null } : {}),
      updatedAt: now,
    }).where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt)))
      .returning({ runtime: agents.runtime, model: agents.model, reasoningEffort: agents.reasoningEffort });
    await revokeRunnerCredentialsOffMachine(tx, { agentIds: [input.agentId], machineId: input.machineId, now });
    if (before && converted[0]) {
      await recordAgentConfigChange(tx, {
        serverId: before.serverId,
        agentId: input.agentId,
        source: "hosted_cindy_convert_to_computer",
        actor: { kind: "user", id: input.actorUserId },
        before: agentConfigValues(before),
        after: agentConfigValues(converted[0]),
        changedAt: now,
      });
    }
  });
  recordTraceEvent("onboarding.hosted_cindy.converted_to_computer", {
    server_id: input.serverId,
    agent_id: input.agentId,
    failure_code: failure?.importErrorCode ?? failure?.lastErrorCode ?? "timed_out",
    since_first_failure: sinceFirstFailureBucket(failure?.setupRetryAt ?? null, input.now ?? currentDate()),
  }, input.tracer);
}

/**
 * Brief hosted Cindy as soon as her import lands. This in-process hook only
 * makes the welcome fast: the survey save and the setup backstop run the same
 * idempotent trigger, so a lost hook is caught there.
 */
export function registerHostedCindyTriggers(input: {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  trigger: (io: SocketServer, orchestrator: AgentOrchestrator, serverId: string, agentId: string) => Promise<unknown>;
  tracer?: Tracer;
}): () => void {
  const offImported = onProvisionImported(async (event) => {
    if (event.importSource !== HOSTED_CINDY_IMPORT_SOURCE) return;
    await input.trigger(input.io, input.orchestrator, event.serverId, event.agentId);
  });
  const offFailed = onProvisionImportFailed((event) => {
    if (event.importSource !== HOSTED_CINDY_IMPORT_SOURCE) return;
    // A new owner would face a silent Cindy: alert (the setup page falls back to "add a computer").
    recordTraceEvent("onboarding.hosted_cindy.import_failed", {
      agent_id: event.agentId,
      server_id: event.serverId,
      outcome: "error",
      error_code: event.code,
      ...(event.httpStatus !== null ? { http_status: event.httpStatus } : {}),
    }, input.tracer);
    console.error(`[HostedCindy] workspace import failed agent=${event.agentId} server=${event.serverId} code=${event.code}`);
  });
  return () => { offImported(); offFailed(); };
}

/**
 * The Day-2 recap reminder of a hosted Cindy. A computer fires reminders for
 * the agents it runs; a hosted Cindy has none, so the server fires her D2
 * recap itself (Tenny: option (a), no Reminder app dependency). fireReminder
 * is a compare-and-swap on the row version, so replicas sweeping together
 * fire it once. The wake is a persisted system message in the reminder's
 * anchor thread, targeted at her and recorded unread for her (born-read for
 * the owner): if the push fails she still finds it in her inbox. A recap that fired but could not be posted records
 * onboarding.hosted_cindy.recap_undelivered. Independent of antiproton_cindy:
 * a hosted Cindy that exists gets her recap even after the flag is lowered.
 */
export async function fireDueHostedCindyRecaps(input: {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  now?: Date;
  limit?: number;
  tracer?: Tracer;
}): Promise<{ due: number; fired: number; delivered: number }> {
  const now = input.now ?? currentDate();
  const due = await getDb().select({
    id: reminders.id,
    version: reminders.version,
    serverId: reminders.serverId,
  }).from(reminders)
    .innerJoin(agentRuntimeProvisions, eq(agentRuntimeProvisions.agentId, reminders.ownerAgentId))
    .where(and(
      eq(reminders.status, "scheduled"),
      lte(reminders.fireAt, now),
      sql`${reminders.payload}->>'kind' = 'onboarding_d2_recap'`,
      eq(agentRuntimeProvisions.importSource, HOSTED_CINDY_IMPORT_SOURCE),
      eq(agentRuntimeProvisions.state, "active"),
      isNotNull(agentRuntimeProvisions.importedAt),
    ))
    .limit(input.limit ?? 20);
  const counts = { due: due.length, fired: 0, delivered: 0 };
  for (const candidate of due) {
    const result = await fireReminder(candidate.id, candidate.version, { clock: { now: () => now } });
    if (!result.ok || !result.fired) continue;
    counts.fired += 1;
    const row = result.row;
    const undelivered = (reason: string) => {
      recordTraceEvent("onboarding.hosted_cindy.recap_undelivered", {
        agent_id: row.ownerAgentId,
        server_id: row.serverId,
        reason,
        outcome: "error",
      }, input.tracer);
      console.error(`[HostedCindy] D2 recap ${row.id} fired but was not posted (${reason})`);
    };
    try {
      let target = row.targetChannelId;
      if (row.msgId) {
        target = (await getOrCreateThread(row.msgId, row.ownerAgentId, "agent")).id;
        // A thread notice reaches the parent's author and the thread's followers. Follow
        // it for her (idempotent; an explicit unfollow of hers stands), so she gets the
        // wake whoever wrote the anchor; the read position starts at the latest message.
        await recordThreadFollow("agent", row.ownerAgentId, target, row.msgId, "manual", {
          preserveExistingReason: true,
          joinedThroughSeq: "latest",
        });
      }
      if (!target) {
        undelivered("no_anchor");
        continue;
      }
      const [server] = await getDb().select({ ownerId: servers.ownerId }).from(servers).where(eq(servers.id, row.serverId)).limit(1);
      if (!server) {
        undelivered("server_gone");
        continue;
      }
      const posted = await broadcastSystemMessage(input.io, input.orchestrator, target, [
        `Reminder fired: ${row.title}`,
        `This reminder was set by the system when onboarding began (reminder ${row.id}). Reply in this thread.`,
      ].join("\n"), {
        // Unread for her (so a failed push still leaves it in her inbox), born-read
        // for the owner whose thread it lands in.
        inboxFactPolicy: {
          mode: "record",
          producer: "onboarding.hosted_recap_wake",
          reason: "a hosted Cindy's Day-2 recap wake; for her inbox, not the owner's",
          causalActor: { type: "user", id: server.ownerId },
        },
        targetAgentIds: [row.ownerAgentId],
      });
      // Delivered means unread in her inbox, not just persisted.
      const [fact] = await getDb().select({ unreadEligible: inboxNotificationFacts.unreadEligible })
        .from(inboxNotificationFacts)
        .where(and(
          eq(inboxNotificationFacts.messageId, posted.id),
          eq(inboxNotificationFacts.receiverType, "agent"),
          eq(inboxNotificationFacts.receiverId, row.ownerAgentId),
        ))
        .limit(1);
      if (!fact?.unreadEligible) {
        undelivered("not_thread_participant");
        continue;
      }
      counts.delivered += 1;
    } catch (error) {
      undelivered(error instanceof Error ? error.name : "post_failed");
    }
  }
  return counts;
}

/**
 * Settle hosted Cindys that are past their timeout without anyone looking (Tenny):
 * the setup state is otherwise only computed when her DM or setup loads, so an
 * owner who never comes back would never get the retry, and the daily report
 * would never see the outcome. Returns how many were checked.
 */
export async function settleOverdueHostedCindys(input: { now?: Date; limit?: number; tracer?: Tracer } = {}): Promise<number> {
  const now = input.now ?? currentDate();
  const overdueBefore = new Date(now.getTime() - HOSTED_CINDY_READY_TIMEOUT_MS);
  const rows = await getDb().select({ agentId: agentRuntimeProvisions.agentId, serverId: agentRuntimeProvisions.serverId })
    .from(agentRuntimeProvisions)
    .where(and(
      eq(agentRuntimeProvisions.importSource, HOSTED_CINDY_IMPORT_SOURCE),
      notInArray(agentRuntimeProvisions.state, ["deleting", "deleted"]),
      isNull(agentRuntimeProvisions.setupRetryOutcome),
      // Not ready yet, or retried (a retry that worked still owes its `ok` result).
      or(isNull(agentRuntimeProvisions.importedAt), isNotNull(agentRuntimeProvisions.setupRetryAt)),
      lte(agentRuntimeProvisions.createdAt, overdueBefore),
    ))
    .limit(input.limit ?? 50);
  for (const row of rows) {
    await resolveHostedCindySetupState({ serverId: row.serverId, agentId: row.agentId, now, tracer: input.tracer });
  }
  return rows.length;
}

/** Sweep due hosted-Cindy recaps every minute (a recap is a day-scale event). */
export function startHostedCindyRecapWorker(input: {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  tracer?: Tracer;
  intervalMs?: number;
}) {
  const tracer = input.tracer ?? noopTracer;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void withTraceRoot(tracer, "server.hosted_cindy.recap_sweep", { surface: "server", kind: "internal" }, async () => {
      const counts = await fireDueHostedCindyRecaps({ io: input.io, orchestrator: input.orchestrator, tracer });
      const overdue = await settleOverdueHostedCindys({ tracer });
      addTraceEvent("server.hosted_cindy.recap_sweep.result", { ...counts, overdue_checked: overdue });
    })
      .catch((error: unknown) => {
        console.error("[HostedCindy] recap sweep failed", error instanceof Error ? error.name : "unknown");
      })
      .finally(() => { running = false; });
  };
  const handle = setClockInterval(tick, input.intervalMs ?? 60_000);
  if (typeof handle === "object" && handle && "unref" in handle && typeof handle.unref === "function") handle.unref();
  return { stop() { clearClockInterval(handle); } };
}

/** Platform-wide hosted Cindys per UTC day; past it, new servers keep the "connect a computer" flow. */
export function hostedCindyDailyCap(): number {
  const raw = Number(process.env.HOSTED_CINDY_DAILY_CAP);
  return Number.isFinite(raw) && raw >= 0 ? raw : 500;
}

/**
 * Hosted Cindy's model: none by default, so the provider decides (its admin's
 * per-server model, then its deployment default, DeepSeek Flash). An explicit
 * id would override an admin's choice, and on an admin-locked server the
 * provider refuses it (409 model_locked) and she would not be created (cody).
 * `HOSTED_CINDY_MODEL` still pins one.
 */
export function hostedCindyModel(): string | null {
  return process.env.HOSTED_CINDY_MODEL?.trim() || null;
}

class HostedCindyExistsError extends Error {}

export type HostedCindyProvisionOutcome =
  | { outcome: "created"; agentId: string }
  | { outcome: "exists" | "disabled" | "unavailable" | "cap_reached" | "name_taken" };

/**
 * Create the server's onboarding agent as a hosted Cindy (step 4): an external
 * agent provisioned on Antiproton with her seed imported (`cindy_seed`), linked
 * as the server's onboarding agent with the admin role. Never creates a second
 * one: agent creates are serialized per server, and inside that lock any live
 * Cindy provision on the server means "exists". Callers: server creation (right
 * after it commits) and the setup backstop; both may run, one wins.
 */
export async function provisionHostedCindy(input: {
  serverId: string;
  ownerUserId: string;
  tracer?: Tracer;
  now?: Date;
  /** The staging test entry: `antiproton_cindy` is not required, the hosted runtime still is. */
  testEntry?: boolean;
}): Promise<HostedCindyProvisionOutcome> {
  const enabled = input.testEntry
    ? isHostedCindyTestEntryDeployment() && await isAgentRuntimeProviderEnabledForServer(input.serverId, "antiproton")
    : await isHostedCindyEnabled(input.serverId);
  if (!enabled) return { outcome: "disabled" };
  const server = await serverService.getServer(input.serverId);
  if (!server) return { outcome: "unavailable" };
  if (server.onboardingAgentId) return { outcome: "exists" };
  // A Cindy whose server link was lost (created before links committed together): relink her.
  const [orphan] = await getDb().select({ agentId: agentRuntimeProvisions.agentId }).from(agentRuntimeProvisions).where(and(
    eq(agentRuntimeProvisions.serverId, input.serverId),
    eq(agentRuntimeProvisions.importSource, HOSTED_CINDY_IMPORT_SOURCE),
    notInArray(agentRuntimeProvisions.state, ["deleting", "deleted"]),
  )).limit(1);
  if (orphan) {
    await getDb().transaction(async (tx) => {
      await serverService.grantOnboardingAgentRole(input.serverId, orphan.agentId, OFFICIAL_ONBOARDING_AGENT_IDENTITY.serverRole, { executor: tx });
    });
    recordTraceEvent("onboarding.hosted_cindy.relinked", { server_id: input.serverId, agent_id: orphan.agentId }, input.tracer);
    return { outcome: "exists" };
  }
  try {
    await assertProviderProvisioningAvailable(input.serverId, "antiproton");
  } catch {
    return { outcome: "unavailable" };
  }
  const now = input.now ?? currentDate();
  // A soft cap: counted before the create, so concurrent creates can overshoot it by a few.
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [{ value: today } = { value: 0 }] = await getDb().select({ value: count() }).from(agentRuntimeProvisions).where(and(
    eq(agentRuntimeProvisions.importSource, HOSTED_CINDY_IMPORT_SOURCE),
    gte(agentRuntimeProvisions.createdAt, dayStart),
  ));
  if (today >= hostedCindyDailyCap()) {
    recordTraceEvent("onboarding.hosted_cindy.cap_reached", { server_id: input.serverId, count: today }, input.tracer);
    return { outcome: "cap_reached" };
  }
  let agentId: string;
  try {
    const agent = await createAgent(input.serverId, OFFICIAL_ONBOARDING_AGENT_IDENTITY.name, {
      runtime: EXTERNAL_AGENT_RUNTIME_ID,
      model: EXTERNAL_AGENT_RUNTIME_MODEL,
      description: OFFICIAL_ONBOARDING_AGENT_IDENTITY.description,
      avatarUrl: OFFICIAL_ONBOARDING_AGENT_IDENTITY.avatarUrl,
      creatorType: "user",
      creatorId: input.ownerUserId,
      configChangeSource: "hosted_cindy_create",
      afterInsert: async (tx, created) => {
        const [existing] = await tx.select({ agentId: agentRuntimeProvisions.agentId }).from(agentRuntimeProvisions).where(and(
          eq(agentRuntimeProvisions.serverId, input.serverId),
          eq(agentRuntimeProvisions.importSource, HOSTED_CINDY_IMPORT_SOURCE),
          notInArray(agentRuntimeProvisions.state, ["deleting", "deleted"]),
        )).limit(1);
        if (existing) throw new HostedCindyExistsError();
        await recordAgentProvisioning(tx, {
          agent: created,
          provider: "antiproton",
          createdByUserId: input.ownerUserId,
          model: hostedCindyModel(),
          importSource: HOSTED_CINDY_IMPORT_SOURCE,
        });
        // The link and role commit with the agent and its provision: a crash cannot
        // leave a Cindy the server does not point at.
        // The owner is about to go through the real flow (survey, then handoff), so stamp
        // them `normal` first, as the computer path does when they create Cindy. Linking
        // her crosses the setup checkpoint, which marks every owner still in setup as
        // `grandfathered`, and a grandfathered owner is owed neither screen: no survey,
        // so no opener and no welcome either. The servers row is locked first, keeping
        // the servers → server_members order every owner-setup writer uses.
        await tx.select({ id: servers.id }).from(servers).where(eq(servers.id, input.serverId)).for("update");
        await tx.update(serverMembers)
          .set({ setupStatus: "complete", setupCompletionReason: "normal" })
          .where(and(
            eq(serverMembers.serverId, input.serverId),
            eq(serverMembers.userId, input.ownerUserId),
            eq(serverMembers.role, "owner"),
            ne(serverMembers.setupStatus, "complete"),
          ));
        await serverService.grantOnboardingAgentRole(input.serverId, created.id, OFFICIAL_ONBOARDING_AGENT_IDENTITY.serverRole, { executor: tx });
      },
    });
    agentId = agent.id;
  } catch (error) {
    if (error instanceof HostedCindyExistsError) return { outcome: "exists" };
    // A concurrent caller created her first (the agent-create lock serializes the
    // name check too); or someone's own agent already holds the name "Cindy".
    if (error instanceof PrincipalHandleConflictError) {
      const [existing] = await getDb().select({ agentId: agentRuntimeProvisions.agentId }).from(agentRuntimeProvisions).where(and(
        eq(agentRuntimeProvisions.serverId, input.serverId),
        eq(agentRuntimeProvisions.importSource, HOSTED_CINDY_IMPORT_SOURCE),
        notInArray(agentRuntimeProvisions.state, ["deleting", "deleted"]),
      )).limit(1);
      return { outcome: existing ? "exists" : "name_taken" };
    }
    throw error;
  }
  kickAppNotificationDelivery();
  kickAgentRuntimeProvisionWorker();
  return { outcome: "created", agentId };
}

/**
 * Best-effort entry for both callers: server creation and the setup-projection
 * backstop (a server that committed without its Cindy, e.g. a crash or a failed
 * create). Idempotent through provisionHostedCindy; never throws.
 */
export async function ensureHostedCindy(input: { serverId: string; ownerUserId: string; tracer?: Tracer; site: "server_create" | "setup_backstop" | "test_entry" }): Promise<HostedCindyProvisionOutcome | null> {
  try {
    const result = await provisionHostedCindy({ ...input, testEntry: input.site === "test_entry" });
    if (result.outcome === "created") {
      recordTraceEvent("onboarding.hosted_cindy.created", { server_id: input.serverId, agent_id: result.agentId, site: input.site }, input.tracer);
    } else if (
      result.outcome === "name_taken"
      || result.outcome === "unavailable"
      // Once per server: the backstop runs on every owner setup load of a flag-off server.
      || (result.outcome === "disabled" && input.site !== "setup_backstop")
    ) {
      // The owner keeps the "connect a computer" flow (cap_reached has its own event).
      recordTraceEvent("onboarding.hosted_cindy.skipped", { server_id: input.serverId, reason: result.outcome, site: input.site }, input.tracer);
    }
    return result;
  } catch (error) {
    recordTraceEvent("onboarding.hosted_cindy.create_failed", {
      server_id: input.serverId,
      site: input.site,
      outcome: "error",
      error_class: error instanceof Error ? error.name : "unknown",
    }, input.tracer);
    console.error(`[HostedCindy] create failed server=${input.serverId} site=${input.site}:`, error instanceof Error ? error.message : error);
    return null;
  }
}
