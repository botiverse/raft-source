import { AssistantCannotUseComputerError, lockMachineIfTakesAgents, lockMachineTakingAgents, machineRowTakesAgentsSql } from "./computerAgents";
import { revokeRunnerCredentialsOffMachine } from "./agentCredentialService";
import { retireAgentApprovals } from "./agentRuntimeApprovalService";
import { ensureAllChannelHumanRows } from "./allChannelMembership";
import { isDeepStrictEqual } from "node:util";
import { eq, and, inArray, isNull, sql, asc, ne, or, type SQL } from "drizzle-orm";
import { getDb, registerDatabaseCloseHookForTests, withDbTraceAttributes, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import { actorRoleHasServerCapability } from "../lib/actorPermissions";
import { FencedAuthorizationDeniedError, ServerMembershipRevokedError } from "../lib/actorMembershipFence";
import { raftbenchConfigs, raftbenchFindings, raftbenchLatestRuns, raftbenchServiceAgents, thirdPartyAgentEvents, agents, machines, channels, channelAgents, servers, serverMembers, serverAgentMembers, users, agentRuntimeProfiles, assistantCheckState, assistantChecks, assistantContactRules, assistantContactSettings, assistantTold, messages, tasks, taskEvents, agentProviderConnections, providerConnections, providerConnectionCredentials, oauthClientInstalls, inboxTargetMuteStates, agentCredentials, agentBootstrapTokens } from "../db/schema";
import { DEPRECATED_GRAVATAR_HASH, 
  replaceAgentLineBreaks, ALL_CHANNEL_TEAM_THRESHOLD, EXTERNAL_AGENT_RUNTIME_ID, PLAN_CONFIG, currentDate, currentTimeMs, getEffectiveLimits, type AgentRuntimeErrorState, type AgentStatus, type ServerPlan, type ReasoningEffort, type LegacyColumnReasoningEffort, type RuntimeConfig, getDefaultModel, isExternalAgentRuntime, validateAgentName, type ServerRole } from "@botiverse/raft-shared";
import { assertAgentCapacityAvailable, getServerBillingEntitlement, getServerBillingUsage, withAgentCreateLock } from "./planService";
import { untracedDbQuery, type DbQueryTracer } from "../tracing/dbQueryTrace";
import { assertAgentHandleAvailableInServer, AssistantReservedHandleError, isAssistantReservedAgentHandle, lockServerPrincipalHandles, PrincipalHandleConflictError } from "./principalHandleService";
import { AGENT_KIND_RULES, agentFindableBy, headcountAgent, listedServerAgent, type AgentFinder, type AgentKind } from "./agentMemberListPolicy";
import { refreshSubscriptionForServerIfStale } from "./billingService";
import { recordSecondAgentCreatedEvent } from "./productEventsService";
import { emitAppFacingMemberEvents, emitAppFacingNotificationEvent, kickAppNotificationDelivery } from "./appNotificationDeliveryService";
import { assertActionCardWritable, assertActionCardWritableInTransaction } from "./actionCardConversionService";
import { recordIntegrationAuditEvent } from "./integrationAuditService";
import { agentConfigValues, recordAgentConfigChange, type AgentConfigChangeActor, type AgentConfigChangeSource } from "./agentConfigChangeEvents";

export type CreatorType = "user" | "agent";

export type CreatorSummary =
  | {
      type: "human";
      id: string;
      name: string;
      displayName: string | null;
      avatarUrl: string | null;
      /** @deprecated Always ""; kept for older clients (DEPRECATED_GRAVATAR_HASH). */
      gravatarHash: string;
    }
  | {
      type: "agent";
      id: string;
      name: string;
      displayName: string | null;
      avatarUrl: string | null;
      deletedAt: Date | null;
    };

export type AgentCreatedSummary = {
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  runtime: string;
  external: boolean;
  status: AgentStatus;
};

export class ServerSetupChangedRetryError extends Error {
  readonly code = "SERVER_SETUP_CHANGED_RETRY";

  constructor() {
    super("SERVER_SETUP_CHANGED_RETRY: server setup changed while this request was waiting; retry from the current setup screen");
    this.name = "ServerSetupChangedRetryError";
  }
}

export async function createAgent(
  serverId: string,
  name: string,
  opts: {
    /** Defaults to the handle. */
    displayName?: string;
    description?: string;
    model?: string;
    runtime?: string;
    runtimeConfig?: RuntimeConfig | null;
    reasoningEffort?: LegacyColumnReasoningEffort;
    machineId?: string;
    envVars?: Record<string, string>;
    avatarUrl?: string;
    creatorType?: CreatorType;
    creatorId?: string;
    expectedSetupStatus?: "not_started" | "in_progress" | "deferred" | "complete" | null;
    providerConnection?: {
      id: string;
      configVersion: number;
      credentialVersion: number;
      updatedByUserId: string;
    };
    actionCardMessageId?: string;
    actionCardConfirmationVersion?: number;
    /**
     * Task #93 line G: the acting human and the capability that authorizes this create. When set, the create re-checks
     * it under row locks taken as the first step inside the agent-create lock, so a removal or demotion that commits
     * first leaves zero created Agents. See lockCreatorAndOwnerForAgentCreate for the lock order.
     */
    actorCapabilityFence?: { userId: string; capability: "createAgents" };
    /**
     * Runs inside the create transaction right after the agent row exists
     * (e.g. hosted-runtime provisioning mints the credential and records the
     * provisioning intent atomically with the agent).
     */
    afterInsert?: (tx: DatabaseTransaction, agent: typeof agents.$inferSelect) => Promise<void>;
    /**
     * What this agent is (default `ordinary`): its row in AGENT_KIND_RULES decides the seat check, the
     * `#all` threshold and whether Apps hear of it. A personal assistant may also take an assistant handle
     * (isAssistantReservedAgentHandle). An App's Bot isn't made here: see appBotIdentityService.
     */
    kind?: Exclude<AgentKind, "app_bot">;
    /** Names this create in agent_config_change_events (default `agent_create`). */
    configChangeSource?: AgentConfigChangeSource;
  } = {}
) {
  const nameError = validateAgentName(name, "Agent name");
  if (nameError) {
    throw new Error(nameError);
  }
  const kind = opts.kind ?? "ordinary";
  const rules = AGENT_KIND_RULES[kind];
  if (kind !== "personal_assistant" && isAssistantReservedAgentHandle(name)) {
    throw new AssistantReservedHandleError(name.trim().replace(/^@/, ""));
  }
  // A personal assistant is never on a machine (agents_assistant_not_on_machine).
  if (kind === "personal_assistant" && opts.machineId) throw new AssistantCannotUseComputerError();

  // This refresh persists subscription state.  For a dialog launched from an
  // action card, conversion authority must be checked before that first side
  // effect; the transactional gate below remains the final create/commit
  // guard for the TOCTOU window.
  if (opts.actionCardMessageId) {
    await assertActionCardWritable(serverId, opts.actionCardMessageId, opts.actionCardConfirmationVersion);
  }
  await refreshSubscriptionForServerIfStale(serverId);

  // Atomic quota check + insert under advisory lock (namespace 1 = agents)
  const agent = await withAgentCreateLock(serverId, async (tx) => {
    let ownerSetupStamp: OwnerSetupStamp = { kind: "unfenced" };
    if (opts.actorCapabilityFence) {
      const locked = await lockCreatorAndOwnerForAgentCreate(tx, serverId, opts.actorCapabilityFence.userId);
      if (!actorRoleHasServerCapability(locked.creatorRole, opts.actorCapabilityFence.capability)) {
        throw new FencedAuthorizationDeniedError("forbidden");
      }
      ownerSetupStamp = locked.ownerMemberLocked ? { kind: "owner_row_locked" } : { kind: "owner_row_missing" };
    }
    if (opts.actionCardMessageId) {
      await assertActionCardWritableInTransaction(tx, serverId, opts.actionCardMessageId, opts.actionCardConfirmationVersion);
    }
    // Capture/compare setup state around the lock. A create request that started before Start
    // over may queue behind reset; after reset writes not_started it must fail/retry, not
    // resurrect an Agent on revoked Computer credentials. A fresh direct API request made
    // after reset captures not_started and remains valid — direct creation is still a real
    // checkpoint, not an onboarding-only privilege.
    if (opts.expectedSetupStatus !== undefined) {
      const [server] = await tx
        .select({ ownerId: servers.ownerId })
        .from(servers)
        .where(eq(servers.id, serverId));
      const [ownerSetup] = server?.ownerId
        ? await tx
            .select({ status: serverMembers.setupStatus })
            .from(serverMembers)
            .where(and(
              eq(serverMembers.serverId, serverId),
              eq(serverMembers.userId, server.ownerId),
            ))
        : [];
      if ((ownerSetup?.status ?? null) !== opts.expectedSetupStatus) {
        throw new ServerSetupChangedRetryError();
      }
    }

    if (rules.seat) {
      const entitlement = await getServerBillingEntitlement(tx, serverId);
      const usage = await getServerBillingUsage(tx, serverId);
      assertAgentCapacityAvailable(entitlement, usage);
    }

    // Prevent new same-server agent handle collisions. Human/agent handle
    // conflicts remain allowed for now and will be handled separately.
    await assertAgentHandleAvailableInServer(tx, serverId, name);

    const runtime = opts.runtime || "claude";
    // Use provided machineId, or auto-assign first available machine for
    // managed runtimes. External agents are supplied by a user-owned process,
    // so `runtime` is the canonical discriminator for skipping assignment.
    // Never a machine whose Computer key was revoked (computerAgents.ts): a
    // named one is refused, the auto-assigned one is the first that still takes agents.
    let machineId: string | null = opts.machineId || null;
    if (machineId) {
      await lockMachineTakingAgents(tx, machineId);
    } else if (!isExternalAgentRuntime(runtime) && kind !== "personal_assistant") {
      const [firstMachine] = await tx
        .select({ id: machines.id })
        .from(machines)
        .where(and(eq(machines.serverId, serverId), machineRowTakesAgentsSql))
        .limit(1);
      if (firstMachine) {
        machineId = firstMachine.id;
        await lockMachineTakingAgents(tx, machineId);
      }
    }

    const [newAgent] = await tx
      .insert(agents)
      .values({
        serverId,
        name,
        displayName: replaceAgentLineBreaks(opts.displayName ?? name, " "),
        description: opts.description === undefined ? undefined : replaceAgentLineBreaks(opts.description, "\n"),
        avatarUrl: opts.avatarUrl || null,
        runtime,
        model: opts.model || getDefaultModel(runtime),
        runtimeConfig: opts.runtimeConfig || null,
        reasoningEffort: opts.reasoningEffort || null,
        envVars: opts.envVars || null,
        creatorType: opts.creatorType || null,
        creatorId: opts.creatorId || null,
        executionMode: "byoc",
        machineId,
      })
      .returning();
    await recordAgentConfigChange(tx, {
      serverId,
      agentId: newAgent.id,
      source: opts.configChangeSource ?? "agent_create",
      actor: opts.creatorType && opts.creatorId ? { kind: opts.creatorType, id: opts.creatorId } : null,
      before: null,
      after: agentConfigValues(newAgent),
      changedAt: newAgent.createdAt,
    });

    const [joined] = await tx.insert(serverAgentMembers).values({
      serverId,
      agentId: newAgent.id,
      role: "member",
    }).onConflictDoNothing().returning({ role: serverAgentMembers.role });
    // A personal assistant is no App's business (agentFindableBy): its row is
    // marked with its owner only in afterInsert, below, so decide by the input.
    if (joined && rules.findable === "anyone") {
      // Same commit as the insert: the event row is the outbox.
      await emitAppFacingMemberEvents({
        serverId,
        eventType: "server.member_added",
        members: [{ principalType: "agent", principalId: newAgent.id, role: joined.role }],
        provenance: { source: "agent_service", actor_type: opts.creatorType === "agent" ? "agent" : "human", reason: "created" },
      }, tx);
    }

    if (opts.afterInsert) {
      await opts.afterInsert(tx, newAgent);
    }

    if (opts.providerConnection) {
      await tx.insert(agentProviderConnections).values({
        serverId,
        agentId: newAgent.id,
        connectionId: opts.providerConnection.id,
        expectedConfigVersion: opts.providerConnection.configVersion,
        expectedCredentialVersion: opts.providerConnection.credentialVersion,
        updatedByUserId: opts.providerConnection.updatedByUserId,
      });
    }

    // Feature-activation evidence, not the activation definition: when a
    // human creates the second-ever agent in this server, persist one durable
    // analytical receipt in the same transaction as the agent row. Count all
    // historical rows, including later-deleted agents, because this is a
    // once-reached creation milestone rather than current inventory.
    if (opts.creatorType === "user" && opts.creatorId) {
      const [{ agentCount }] = await tx
        .select({ agentCount: sql<number>`count(*)::int` })
        .from(agents)
        .where(eq(agents.serverId, serverId));
      if (Number(agentCount) === 2) {
        await recordSecondAgentCreatedEvent(tx, {
          serverId,
          secondAgentId: newAgent.id,
          actorUserId: opts.creatorId,
          occurredAt: newAgent.createdAt,
        });
      }
    }

    // Opener onboarding: #all is born hidden and reveals once the server grows
    // into a team — total members (humans + agents) >= 3. The 3rd member may be
    // an agent (this path) OR a human (see serverService.addMember).
    // Personal assistants are not members, and adding one grows no team.
    const [{ agentCount }] = await tx
      .select({ agentCount: sql<number>`count(*)::int` })
      .from(agents)
      .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt), headcountAgent()));
    const [{ humanCount }] = await tx
      .select({ humanCount: sql<number>`count(*)::int` })
      .from(serverMembers)
      .where(eq(serverMembers.serverId, serverId));
    if (rules.headcount && agentCount + humanCount >= ALL_CHANNEL_TEAM_THRESHOLD) {
      const [ownerUnlock] = await tx
        .select({ sentAt: serverMembers.allChannelUnlockInstructionSentAt })
        .from(servers)
        .innerJoin(serverMembers, and(
          eq(serverMembers.serverId, servers.id),
          eq(serverMembers.userId, servers.ownerId),
        ))
        .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));
      if (!ownerUnlock?.sentAt) {
        await tx
          .update(channels)
          .set({ type: "channel" })
          .where(and(
            eq(channels.serverId, serverId),
            eq(channels.name, "all"),
            eq(channels.type, "private"),
          ));
        // #all just became enabled: every human member gets their row now.
        await ensureAllChannelHumanRows(tx, serverId);
      }
    }

    // A server with an agent is set up. Say so, durably, IN THE SAME TRANSACTION.
    //
    // The onboarding modal was the ONLY thing that ever wrote `setup_status`. Someone who
    // configured their server the ordinary way — Add Computer, Create Agent, no modal —
    // stayed `not_started` forever, so the gate kept demanding setup they had already done:
    // "Meet Cindy" (blocking chat) on a server that HAS Cindy, or "Connect a computer" on a
    // server that HAS one, depending only on whether their laptop happened to be awake.
    //
    // This lives in createAgent, not in the routes, because the routes are where it was
    // forgotten. Every path that produces an agent someone runs passes through here, so the
    // fact cannot be created without the record of it. An App's Bot does not
    // (appBotIdentityService, inside its install's transaction): installing an App doesn't
    // set a server up, and a Bot has no seat check or membership row to take here either.
    //
    // It was briefly a best-effort call AFTER the transaction, on the reasoning that a
    // failed write only costs one extra prompt. That reasoning expired. Onboarding is now a
    // transaction whose commit point is "this server has ever had an agent", and a server
    // short of that point is offered a destructive reset ("throw these computers away and
    // start over") on the promise that nothing is lost. A crash in the window between the
    // agent row and this write would leave a server that HAS an agent looking like one that
    // never did — and the cost of the gap stops being an extra prompt and becomes offering
    // to wipe someone's work. So the record commits with the fact, or neither does.
    //
    // `transitionServerSetupState("complete")` is deliberately not used: it requires a
    // USABLE official onboarding agent, and this path is precisely the one where the agent
    // may not be Cindy. Someone running a non-Cindy agent has still set their server up.
    await markServerSetupCompleteOnFirstAgent(tx, serverId, ownerSetupStamp);

    return newAgent;
  });

  kickAppNotificationDelivery();
  return agent;
}

/**
 * How a fenced Agent create reached the owner's setup row: `owner_row_locked` — locked FOR UPDATE before any write;
 * `owner_row_missing` — the Server owner has no member row, so there is nothing to stamp; `unfenced` — creator-less and
 * agent-created paths, unchanged.
 */
type OwnerSetupStamp = { kind: "owner_row_locked" } | { kind: "owner_row_missing" } | { kind: "unfenced" };

/**
 * Task #93 line G lock acquisition for a human-created Agent (see `actorCapabilityFence`).
 *
 * Order, compatible with transitionMemberRole and owner promotion (both lock `servers` FOR UPDATE, then member rows):
 *   1. `servers` row FOR SHARE — role transitions and owner promotion serialize with this create instead of interleaving
 *      on member rows. Member removal (removeMember) deliberately takes no `servers` lock: it conflicts with this create
 *      only on the removed member's own row, which step 2 locks directly.
 *   2. The creator's and the owner's `server_members` rows through this one routine, in ascending user-id order: the
 *      creator FOR SHARE, the owner FOR UPDATE (markServerSetupCompleteOnFirstAgent updates it later in this transaction),
 *      and a single FOR UPDATE when they are the same person. No row is upgraded from share to update later.
 *
 * A missing creator row throws ServerMembershipRevokedError before any write. A missing owner row is reported as
 * `ownerMemberLocked: false`.
 */
async function lockCreatorAndOwnerForAgentCreate(
  tx: DatabaseTransaction,
  serverId: string,
  creatorId: string,
): Promise<{ creatorRole: ServerRole; ownerMemberLocked: boolean }> {
  const serverRows = await tx.execute(sql`
    SELECT owner_id
    FROM servers
    WHERE id = ${serverId}
    FOR SHARE
  `);
  const ownerId = (serverRows.rows[0] as { owner_id: string | null } | undefined)?.owner_id ?? null;
  const userIds = [...new Set([creatorId, ownerId].filter((id): id is string => Boolean(id)))].sort();
  let creatorRole: ServerRole | null = null;
  let ownerMemberLocked = false;
  for (const userId of userIds) {
    const mode = userId === ownerId ? "update" : "share";
    const rows = mode === "update"
      ? await tx.execute(sql`
        SELECT role
        FROM server_members
        WHERE server_id = ${serverId}
          AND user_id = ${userId}
        FOR UPDATE
      `)
      : await tx.execute(sql`
        SELECT role
        FROM server_members
        WHERE server_id = ${serverId}
          AND user_id = ${userId}
        FOR SHARE
      `);
    const row = rows.rows[0] as { role: ServerRole } | undefined;
    if (userId === ownerId && row) ownerMemberLocked = true;
    if (userId === creatorId) {
      if (!row) throw new ServerMembershipRevokedError(serverId, creatorId);
      creatorRole = row.role;
    }
  }
  if (!creatorRole) throw new ServerMembershipRevokedError(serverId, creatorId);
  return { creatorRole, ownerMemberLocked };
}

/**
 * Stamp the OWNER's setup as complete because the server now has an agent.
 *
 * Takes the caller's transaction, and is only ever called inside the one that inserts the
 * agent: this write and the agent row are the same fact, and must not be able to disagree.
 *
 * Idempotent (only touches rows that are not already `complete`) and owner-only: setup is
 * the owner's flow, and a member creating an agent does not complete someone else's setup.
 *
 * Note what this does NOT license. A destructive "start over" must still count the agents
 * itself before it destroys anything, rather than trusting `setup_status` to have been
 * written correctly. Atomicity closes the window; it does not make a projected column safe
 * to key demolition on. Storing a fact the source of truth already knows is how 486 servers
 * came to disagree with themselves in the first place.
 */
async function markServerSetupCompleteOnFirstAgent(
  tx: DatabaseTransaction,
  serverId: string,
  stamp: OwnerSetupStamp = { kind: "unfenced" },
): Promise<void> {
  // Task #93 line G: a fenced create whose Server owner has no member row has nothing to stamp. Skipping is the explicit
  // result; issuing an UPDATE that silently affects zero rows is not.
  if (stamp.kind === "owner_row_missing") return;
  const [server] = await tx.select({ ownerId: servers.ownerId }).from(servers).where(eq(servers.id, serverId));
  if (!server?.ownerId) return;

  await tx
    .update(serverMembers)
    .set({ setupStatus: "complete", setupCompletionReason: "normal" })
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.userId, server.ownerId),
      ne(serverMembers.setupStatus, "complete"),
    ));
}

/**
 * This server's agents, oldest first. `memberListsOnly` narrows it to the
 * agents a member list shows (listedServerAgent): use it for every list, count
 * and candidate set, and leave it off for directory and history lookups, which
 * must still resolve a removed App Bot or a personal assistant.
 */
export async function listAgents(
  serverId: string,
  includeDeleted = false,
  opts: { traceQuery?: DbQueryTracer; memberListsOnly?: boolean; agentIds?: readonly string[] } = {},
) {
  const db = getDb();
  const conditions = [eq(agents.serverId, serverId)];
  if (!includeDeleted) conditions.push(isNull(agents.deletedAt));
  if (opts.memberListsOnly) conditions.push(listedServerAgent());
  // Only these agents (GET /api/sync/changes rebuilding changed rows).
  if (opts.agentIds) {
    if (opts.agentIds.length === 0) return [];
    conditions.push(inArray(agents.id, [...new Set(opts.agentIds)]));
  }
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  return traceQuery(
    "agents.list_by_server",
    () => db
      .select()
      .from(agents)
      .where(and(...conditions))
      .orderBy(asc(agents.createdAt)),
    (rows) => ({
      row_count: rows.length,
      include_deleted: includeDeleted,
    }),
  );
}

/**
 * Of these agents, the ones that belong to `serverId` (live) and that `finder`
 * may find: whose detailed activity they already receive (the server room push,
 * agentEventRoom), so a capable client may subscribe to it (socket/index.ts).
 */
export async function filterAgentIdsInServer(serverId: string, agentIds: readonly string[], finder: AgentFinder): Promise<Set<string>> {
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return new Set();
  const rows = await getDb()
    .select({ id: agents.id })
    .from(agents)
    .where(and(inArray(agents.id, ids), eq(agents.serverId, serverId), isNull(agents.deletedAt), agentFindableBy(finder)));
  return new Set(rows.map((row) => row.id));
}

/**
 * Of these agents, the ones a member list shows (live, and listedServerAgent).
 * The agent directory carries every agent, for history; it marks App Bots and
 * personal assistants with this so clients can leave them out of their member
 * lists without the directory losing them.
 */
export async function filterAgentIdsInMemberLists(agentIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return new Set();
  const rows = await getDb()
    .select({ id: agents.id })
    .from(agents)
    .where(and(inArray(agents.id, ids), isNull(agents.deletedAt), listedServerAgent()));
  return new Set(rows.map((row) => row.id));
}

export async function getAgent(
  agentId: string,
  includeDeleted = false,
  opts: { dbCallsite?: string } = {},
) {
  const db = getDb();
  const conditions = [eq(agents.id, agentId)];
  if (!includeDeleted) conditions.push(isNull(agents.deletedAt));
  const rows = await withDbTraceAttributes(
    { db_callsite: opts.dbCallsite ?? "agent_service.get_agent.unspecified" },
    async () => {
      const rows = await db
        .select()
        .from(agents)
        .where(and(...conditions));
      return rows;
    },
  );
  const [agent] = rows;
  return agent || null;
}

export async function getAgentCreator(agent: { serverId: string; creatorType: string | null; creatorId: string | null }): Promise<CreatorSummary | null> {
  if (!agent.creatorType || !agent.creatorId) return null;
  const db = getDb();

  if (agent.creatorType === "user") {
    const [creator] = await db
      .select({
        id: users.id,
        name: users.name,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .innerJoin(serverMembers, and(
        eq(serverMembers.userId, users.id),
        eq(serverMembers.serverId, agent.serverId),
      ))
      .where(eq(users.id, agent.creatorId));
    return creator ? {
      type: "human",
      id: creator.id,
      name: creator.name,
      displayName: creator.displayName,
      avatarUrl: creator.avatarUrl,
      gravatarHash: DEPRECATED_GRAVATAR_HASH,
    } : null;
  }

  if (agent.creatorType === "agent") {
    const [creator] = await db
      .select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        deletedAt: agents.deletedAt,
      })
      .from(agents)
      .where(and(eq(agents.id, agent.creatorId), eq(agents.serverId, agent.serverId)));
    return creator ? { type: "agent", ...creator } : null;
  }

  return null;
}

/**
 * The live agents `creatorId` created, as `finder` may find them: a personal
 * assistant's creator is its owner, so only they (and the assistant itself)
 * see it in the list (agentFindableBy).
 */
export async function listCreatedAgents(serverId: string, creatorType: CreatorType, creatorId: string, finder: AgentFinder): Promise<AgentCreatedSummary[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
      avatarUrl: agents.avatarUrl,
      runtime: agents.runtime,
      status: agents.status,
    })
    .from(agents)
    .where(and(
      eq(agents.serverId, serverId),
      eq(agents.creatorType, creatorType),
      eq(agents.creatorId, creatorId),
      isNull(agents.deletedAt),
      agentFindableBy(finder),
    ))
    .orderBy(asc(agents.createdAt));
  return rows.map((row) => ({
    ...row,
    external: isExternalAgentRuntime(row.runtime),
  }));
}

export async function enrichAgentWithCreatorProfile<T extends { id: string; serverId: string; creatorType: string | null; creatorId: string | null }>(agent: T) {
  const [creator, createdAgents] = await Promise.all([
    getAgentCreator(agent),
    // An agent never creates a personal assistant (its owner does), so `{}`,
    // which finds none, leaves this list as it was.
    listCreatedAgents(agent.serverId, "agent", agent.id, {}),
  ]);
  return { ...agent, creator, createdAgents };
}

/**
 * Batch version of `enrichAgentWithCreatorProfile`. Replaces the 2N-query pattern
 * (per-agent `getAgentCreator` + `listCreatedAgents`) with at most 4 batched
 * queries regardless of input size:
 *   1. user-typed creators by `(creatorId IN userIds)` joined to `serverMembers`
 *   2. agent-typed creators by `(creatorId IN agentIds AND serverId)`
 *   3. created-agents by `(creatorType="agent" AND creatorId IN agentIds AND serverId)`
 *
 * Result preserves input order. Empty input → empty array (no DB calls).
 *
 * Profiled at 1000 agents on PGlite fixture (#37): per-agent enrichment ~314ms
 * total → batched ~5-12ms total. Drives `GET /api/agents` p50 from ~347ms to
 * the listAgents floor of ~10ms.
 */
export async function batchEnrichAgentsWithCreatorProfile<
  T extends { id: string; serverId: string; creatorType: string | null; creatorId: string | null },
>(
  items: T[],
  opts: { traceQuery?: DbQueryTracer } = {},
): Promise<(T & { creator: CreatorSummary | null; createdAgents: AgentCreatedSummary[] })[]> {
  if (items.length === 0) return [];
  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;

  // All items in one /api/agents call share the same serverId — assert it
  // explicitly so we never accidentally cross-server-leak in batch lookups.
  const serverId = items[0]!.serverId;
  if (items.some((i) => i.serverId !== serverId)) {
    throw new Error("batchEnrichAgentsWithCreatorProfile: all items must share serverId");
  }

  const userCreatorIds = new Set<string>();
  const agentCreatorIds = new Set<string>();
  for (const item of items) {
    if (!item.creatorType || !item.creatorId) continue;
    if (item.creatorType === "user") userCreatorIds.add(item.creatorId);
    else if (item.creatorType === "agent") agentCreatorIds.add(item.creatorId);
  }

  // Created-agents: every owning-agent in `items` whose record may have created
  // other agents. We query by `creatorId IN items.id` (not creatorIds) — every
  // input item is potentially a creator-of-something.
  const ownerAgentIds = items.map((i) => i.id);

  const userCreatorRowsPromise = userCreatorIds.size > 0
    ? traceQuery(
        "agents.batch_creator_enrich.user_creators",
        () => db
          .select({
            id: users.id,
            name: users.name,
            displayName: users.displayName,
            avatarUrl: users.avatarUrl,
          })
          .from(users)
          .innerJoin(serverMembers, and(
            eq(serverMembers.userId, users.id),
            eq(serverMembers.serverId, serverId),
          ))
          .where(inArray(users.id, [...userCreatorIds])),
        (rows) => ({
          row_count: rows.length,
          input_count: userCreatorIds.size,
        }),
      )
    : Promise.resolve([] as { id: string; name: string; displayName: string | null; avatarUrl: string | null }[]);

  const agentCreatorRowsPromise = agentCreatorIds.size > 0
    ? traceQuery(
        "agents.batch_creator_enrich.agent_creators",
        () => db
          .select({
            id: agents.id,
            name: agents.name,
            displayName: agents.displayName,
            avatarUrl: agents.avatarUrl,
            deletedAt: agents.deletedAt,
          })
          .from(agents)
          .where(and(
            eq(agents.serverId, serverId),
            inArray(agents.id, [...agentCreatorIds]),
          )),
        (rows) => ({
          row_count: rows.length,
          input_count: agentCreatorIds.size,
        }),
      )
    : Promise.resolve([] as { id: string; name: string; displayName: string | null; avatarUrl: string | null; deletedAt: Date | null }[]);

  const createdAgentRowsPromise = ownerAgentIds.length > 0
    ? traceQuery(
        "agents.batch_creator_enrich.created_agents",
        () => db
          .select({
            id: agents.id,
            name: agents.name,
            displayName: agents.displayName,
            avatarUrl: agents.avatarUrl,
            runtime: agents.runtime,
            status: agents.status,
            creatorId: agents.creatorId,
          })
          .from(agents)
          .where(and(
            eq(agents.serverId, serverId),
            eq(agents.creatorType, "agent"),
            inArray(agents.creatorId, ownerAgentIds),
            isNull(agents.deletedAt),
          ))
          .orderBy(asc(agents.createdAt)),
        (rows) => ({
          row_count: rows.length,
          input_count: ownerAgentIds.length,
        }),
      )
    : Promise.resolve([] as { id: string; name: string; displayName: string | null; avatarUrl: string | null; runtime: string; status: AgentStatus; creatorId: string | null }[]);

  const [userCreatorRows, agentCreatorRows, createdAgentRows] = await Promise.all([
    userCreatorRowsPromise,
    agentCreatorRowsPromise,
    createdAgentRowsPromise,
  ]);

  const userCreatorById = new Map<string, CreatorSummary>();
  for (const row of userCreatorRows) {
    userCreatorById.set(row.id, {
      type: "human",
      id: row.id,
      name: row.name,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      gravatarHash: DEPRECATED_GRAVATAR_HASH,
    });
  }
  const agentCreatorById = new Map<string, CreatorSummary>();
  for (const row of agentCreatorRows) {
    agentCreatorById.set(row.id, {
      type: "agent",
      id: row.id,
      name: row.name,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      deletedAt: row.deletedAt,
    });
  }
  const createdByOwner = new Map<string, AgentCreatedSummary[]>();
  for (const row of createdAgentRows) {
    if (!row.creatorId) continue;
    const list = createdByOwner.get(row.creatorId) ?? [];
    list.push({
      id: row.id,
      name: row.name,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      runtime: row.runtime,
      external: isExternalAgentRuntime(row.runtime),
      status: row.status,
    });
    createdByOwner.set(row.creatorId, list);
  }

  return items.map((item) => {
    let creator: CreatorSummary | null = null;
    if (item.creatorType === "user" && item.creatorId) {
      creator = userCreatorById.get(item.creatorId) ?? null;
    } else if (item.creatorType === "agent" && item.creatorId) {
      creator = agentCreatorById.get(item.creatorId) ?? null;
    }
    return {
      ...item,
      creator,
      createdAgents: createdByOwner.get(item.id) ?? [],
    };
  });
}

type AgentNotificationEventType =
  | "agent.status_changed"
  | "agent.profile_updated"
  | "agent.runtime_changed"
  | "agent.model_changed";

async function emitAgentNotificationEvent(
  executor: DatabaseExecutor,
  agent: { id: string; serverId: string },
  eventType: AgentNotificationEventType,
  changedFields: string[],
  occurredAt: Date,
): Promise<void> {
  await emitAppFacingNotificationEvent({
    serverId: agent.serverId,
    eventType,
    subjectType: "agent",
    subjectId: agent.id,
    occurredAt,
    provenance: {
      source: "agent_service",
      changed_fields: changedFields,
    },
  }, executor);
}

function runtimeConfigWithoutModel(config: RuntimeConfig | null): Omit<RuntimeConfig, "model"> | null {
  if (!config) return null;
  const { model: _model, ...rest } = config;
  return rest;
}

export async function updateAgentStatus(
  agentId: string,
  status: AgentStatus,
  sessionId?: string
) {
  const db = getDb();
  await db.transaction(async (tx) => {
    const [existing] = await tx.select({
      id: agents.id,
      serverId: agents.serverId,
      status: agents.status,
    }).from(agents)
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
      .limit(1)
      .for("update");
    if (!existing || (status === "inactive" && existing.status === "stopped")) return;

    const now = currentDate();
    await tx.update(agents)
      .set({
        status,
        ...(sessionId !== undefined ? { sessionId } : {}),
        updatedAt: now,
      })
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)));
    if (existing.status !== status) {
      await emitAgentNotificationEvent(tx, existing, "agent.status_changed", ["status"], now);
    }
  });
}

/** What a daemon-signal status write did; `machine_fenced`: the agent no longer lives on the signal's Computer. */
export type AgentSignalStatusWriteOutcome = "applied" | "rejected" | "machine_fenced";

/**
 * Persist a status update that originated from a daemon signal (status / session /
 * ready-reconcile), as opposed to an explicit lifecycle action like start/stop/reset.
 *
 * Signal paths read `agent.status` and `agent.machineId` from the in-memory
 * cache, but the cache is local to a single replica and never invalidated
 * cross-replica. Two DB-layer guards keep a stale entry from letting a daemon
 * signal through:
 * - a signal never writes over a persisted `stopped`;
 * - a signal writes only while the agent still lives on the Computer the
 *   signal came from (`machine_id` in the UPDATE's WHERE). A process left on a
 *   Computer the agent was moved away from cannot overwrite `status` or
 *   `sessionId` (reconciler step 14, PR 1).
 *
 * Explicit start/reset paths must keep using `updateAgentStatus` so the user can
 * resurrect a stopped agent intentionally.
 */
export async function updateAgentStatusFromSignal(
  agentId: string,
  status: AgentStatus,
  write: { machineId: string; sessionId?: string },
): Promise<AgentSignalStatusWriteOutcome> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({
      id: agents.id,
      serverId: agents.serverId,
      status: agents.status,
      machineId: agents.machineId,
    }).from(agents)
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
      .limit(1)
      .for("update");
    if (!existing || existing.status === "stopped") return "rejected";

    const now = currentDate();
    const [updated] = await tx.update(agents)
      .set({
        status,
        ...(write.sessionId !== undefined ? { sessionId: write.sessionId } : {}),
        updatedAt: now,
      })
      .where(and(
        eq(agents.id, agentId),
        eq(agents.machineId, write.machineId),
        isNull(agents.deletedAt),
        ne(agents.status, "stopped"),
      ))
      .returning({ id: agents.id });
    if (!updated) {
      // The row is locked above, so its machine is the one the UPDATE saw.
      return existing.machineId !== write.machineId ? "machine_fenced" : "rejected";
    }
    if (existing.status !== status) {
      await emitAgentNotificationEvent(tx, existing, "agent.status_changed", ["status"], now);
    }
    return "applied";
  });
}

export async function invalidateAgentSessionFromSignal(
  agentId: string,
  expectedSessionId: string,
  expectedMachineId: string,
): Promise<boolean> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({
      id: agents.id,
      sessionId: agents.sessionId,
      status: agents.status,
      machineId: agents.machineId,
    }).from(agents)
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
      .limit(1)
      .for("update");
    if (
      !existing ||
      existing.status === "stopped" ||
      existing.sessionId !== expectedSessionId ||
      existing.machineId !== expectedMachineId
    ) {
      return false;
    }

    const [updated] = await tx.update(agents)
      .set({
        sessionId: null,
        updatedAt: currentDate(),
      })
      .where(and(
        eq(agents.id, agentId),
        eq(agents.sessionId, expectedSessionId),
        eq(agents.machineId, expectedMachineId),
        ne(agents.status, "stopped"),
        isNull(agents.deletedAt),
      ))
      .returning({ id: agents.id });
    return Boolean(updated);
  });
}

// A runtime error the agent reports again (crash loop: relaunch, same error)
// within this window keeps the stored row instead of rewriting it.
export const AGENT_RUNTIME_ERROR_REWRITE_WINDOW_MS = 5 * 60 * 1000;

/** task #1351: the order of a daemon activity frame: its launch, daemon process and per-agent sequence. */
export interface RuntimeErrorFrameEvidence {
  launchId?: string | null;
  daemonInstanceId?: string | null;
  clientSeq?: number | null;
}

function frameEvidenceParams(frame: RuntimeErrorFrameEvidence) {
  return {
    launchId: typeof frame.launchId === "string" && frame.launchId !== "" ? frame.launchId : null,
    daemonInstanceId: typeof frame.daemonInstanceId === "string" && frame.daemonInstanceId !== "" ? frame.daemonInstanceId : null,
    clientSeq: Number.isSafeInteger(frame.clientSeq) ? frame.clientSeq as number : null,
  };
}

/**
 * task #1351 R1: `frame` is from the stored record's own clientSeq domain and
 * later in it. A domain is a confirmed launch AND daemon process: both ids
 * non-null on both sides and equal (a missing launch is not "the same
 * launch"), and both sequences present.
 */
function sameDomainHigherSeqSql(stored: SQL, frame: RuntimeErrorFrameEvidence) {
  const { launchId, daemonInstanceId, clientSeq } = frameEvidenceParams(frame);
  return sql`(
    ${daemonInstanceId}::text IS NOT NULL
    AND ${launchId}::text IS NOT NULL
    AND ${clientSeq}::bigint IS NOT NULL
    AND (${stored}->>'daemonInstanceId') IS NOT NULL
    AND (${stored}->>'launchId') IS NOT NULL
    AND (${stored}->>'clientSeq') IS NOT NULL
    AND ${stored}->>'daemonInstanceId' = ${daemonInstanceId}::text
    AND ${stored}->>'launchId' = ${launchId}::text
    AND ${clientSeq}::bigint > (${stored}->>'clientSeq')::bigint
  )`;
}

/**
 * task #1351: SQL that is true when `incoming` (a BillingError) provably came
 * after the stored BillingError, with no clock comparison:
 * - R1 (sameDomainHigherSeqSql); or
 * - the stored record was stamped with the incoming error's launch at arm time
 *   (that launch was armed while the record was stored, so after it).
 */
function billingErrorIsNewerThanStoredSql(incoming: AgentRuntimeErrorState) {
  const stored = sql`${agents.lastRuntimeError}`;
  const { launchId } = frameEvidenceParams(incoming);
  return sql`COALESCE((
    ${sameDomainHigherSeqSql(stored, incoming)}
    OR (
      ${launchId}::text IS NOT NULL
      AND ${stored}->>'recoveryLaunchId' = ${launchId}::text
    )
  ), false)`;
}

/**
 * Persist the agent's runtime error and return the error state that is now
 * durable, or null when the agent is gone (deleted / missing).
 *
 * The same error (message, errorClass, actionRequired; launchId and at are
 * ignored) reported again within AGENT_RUNTIME_ERROR_REWRITE_WINDOW_MS of the
 * stored one's `at` is not rewritten: the stored state is returned instead, so
 * callers publish exactly what the row holds. Agents in an error loop wrote
 * the same error on every relaunch (~18 writes/min on prod, 29 agents).
 *
 * task #1351: a BillingError is not merged that way: each one is a new
 * occurrence (its own occurrenceId and set-frame evidence, no recovery stamp).
 * It replaces a stored BillingError only when it provably came after it
 * (billingErrorIsNewerThanStoredSql); a replay or a late 402 from another
 * launch leaves the stored one.
 */
export async function setAgentLastRuntimeError(
  agentId: string,
  lastRuntimeError: AgentRuntimeErrorState,
): Promise<AgentRuntimeErrorState | null> {
  const db = getDb();
  const stored = agents.lastRuntimeError;
  const writeAllowed = lastRuntimeError.errorClass === "BillingError"
    // NULL-safe throughout: an old untyped record (no errorClass) is not a
    // BillingError, so a typed 402 replaces it.
    ? sql`NOT (
      ${stored} IS NOT NULL
      AND (${stored}->>'errorClass') IS NOT DISTINCT FROM 'BillingError'
      AND NOT ${billingErrorIsNewerThanStoredSql(lastRuntimeError)}
    )`
    : sql`NOT (
      ${stored} IS NOT NULL
      AND ${stored}->>'message' IS NOT DISTINCT FROM ${lastRuntimeError.message}
      AND ${stored}->>'errorClass' IS NOT DISTINCT FROM ${lastRuntimeError.errorClass ?? null}::text
      AND (${stored}->>'actionRequired')::boolean IS NOT DISTINCT FROM ${lastRuntimeError.actionRequired}
      AND (${stored}->>'at')::timestamptz > ${lastRuntimeError.at}::timestamptz - make_interval(secs => ${AGENT_RUNTIME_ERROR_REWRITE_WINDOW_MS / 1000})
    )`;
  const [updated] = await db.update(agents)
    .set({
      lastRuntimeError,
      updatedAt: new Date(),
    })
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt), writeAllowed))
    .returning({ id: agents.id });
  if (updated) return lastRuntimeError;

  // Not written: either the agent is gone, or the stored error stays.
  return loadAgentLastRuntimeErrorRow(agentId).then((row) => row?.lastRuntimeError ?? null);
}

async function loadAgentLastRuntimeErrorRow(agentId: string): Promise<{ lastRuntimeError: AgentRuntimeErrorState | null } | null> {
  const [row] = await getDb().select({ lastRuntimeError: agents.lastRuntimeError })
    .from(agents)
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .limit(1);
  return row ? { lastRuntimeError: row.lastRuntimeError ?? null } : null;
}

/**
 * #wg-rbac:#57: the users who may read this agent's runtime error text, as
 * decideAgentResourceAuthority answers `editAgents`: its human creator and the
 * server's members whose role has `editAgents`; for a personal assistant, its
 * owner alone. Empty when the agent is gone.
 */
export async function listAgentRuntimeErrorDetailViewerUserIds(agentId: string): Promise<string[]> {
  const [agent] = await getDb().select({
    serverId: agents.serverId,
    creatorType: agents.creatorType,
    creatorId: agents.creatorId,
    assistantOwnerUserId: agents.assistantOwnerUserId,
  }).from(agents).where(and(eq(agents.id, agentId), isNull(agents.deletedAt))).limit(1);
  if (!agent) return [];
  if (agent.assistantOwnerUserId) return [agent.assistantOwnerUserId];
  // A guest never reads it, the creator included (a guest gets the channel
  // summary profile only).
  const editRoles = (["owner", "admin", "member"] as const).filter((role) => actorRoleHasServerCapability(role, "editAgents"));
  const creatorUserId = agent.creatorType === "user" ? agent.creatorId : null;
  const viewer = creatorUserId
    ? or(inArray(serverMembers.role, editRoles), eq(serverMembers.userId, creatorUserId))
    : inArray(serverMembers.role, editRoles);
  const rows = await getDb().select({ userId: serverMembers.userId }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, agent.serverId), ne(serverMembers.role, "guest"), viewer));
  return rows.map((row) => row.userId);
}

/** The agent's stored runtime error as the database holds it now; undefined when the agent is gone. */
export async function getAgentLastRuntimeError(agentId: string): Promise<AgentRuntimeErrorState | null | undefined> {
  const row = await loadAgentLastRuntimeErrorRow(agentId);
  return row ? row.lastRuntimeError : undefined;
}

export interface AgentRuntimeErrorClearResult {
  /** A stored error was removed by this call. */
  cleared: boolean;
  /** What the row holds after the call. */
  current: AgentRuntimeErrorState | null;
}

/**
 * Clear any stored runtime error except a BillingError (a session report,
 * generic progress, a manual Stop; task #1351: a stale replica cache that
 * thinks the error is generic cannot clear a BillingError). Null when the
 * agent is gone.
 */
export async function clearAgentLastRuntimeErrorUnlessBilling(agentId: string): Promise<AgentRuntimeErrorClearResult | null> {
  const db = getDb();
  const stored = agents.lastRuntimeError;
  // Called on every new daemon session, error or not: only write when there is
  // a matching error to clear, so a no-op does not lock and rewrite the row.
  const [updated] = await db.update(agents)
    .set({
      lastRuntimeError: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(agents.id, agentId),
      isNull(agents.deletedAt),
      sql`${stored} IS NOT NULL AND (${stored}->>'errorClass') IS DISTINCT FROM 'BillingError'`,
    ))
    .returning({ id: agents.id });
  if (updated) return { cleared: true, current: null };
  const row = await loadAgentLastRuntimeErrorRow(agentId);
  return row ? { cleared: false, current: row.lastRuntimeError } : null;
}

/**
 * task #1351 proof-and-clear: one statement that clears the stored error only
 * when it is a BillingError AND this model-output frame proves the provider
 * served a request after it:
 * - R1: the record's own daemon process and launch (both confirmed), higher clientSeq;
 * - R2: the frame's launch is the one a start stamped on this record
 *   (stampAgentRuntimeErrorRecoveryLaunch), and the 402 did not come from it.
 * The decision is made on the row as it is at the UPDATE (locked), so a 402
 * written before it is the one judged. Returns the record it removed, or null
 * (no write when nothing matches, including when no error is stored).
 */
export async function clearAgentBillingErrorOnRecovery(
  agentId: string,
  frame: RuntimeErrorFrameEvidence,
): Promise<AgentRuntimeErrorState | null> {
  const stored = sql.raw("last_runtime_error");
  const { launchId } = frameEvidenceParams(frame);
  const result = await getDb().execute<{ removed: AgentRuntimeErrorState }>(sql`
    WITH judged AS (
      SELECT id, last_runtime_error AS removed
      FROM agents
      WHERE id = ${agentId}
        AND deleted_at IS NULL
        AND (last_runtime_error->>'errorClass') = 'BillingError'
        AND COALESCE((
          ${sameDomainHigherSeqSql(stored, frame)}
          OR (
            ${launchId}::text IS NOT NULL
            AND last_runtime_error->>'recoveryLaunchId' = ${launchId}::text
            AND (last_runtime_error->>'launchId') IS DISTINCT FROM ${launchId}::text
          )
        ), false)
      FOR UPDATE
    )
    UPDATE agents
    SET last_runtime_error = NULL, updated_at = now()
    FROM judged
    WHERE agents.id = judged.id
    RETURNING judged.removed AS removed
  `);
  return (result.rows[0] as { removed: AgentRuntimeErrorState } | undefined)?.removed ?? null;
}

/**
 * task #1351: a start armed `launchId` while a BillingError is stored, so that
 * launch came after the error. Stamp it on the record the row holds now (any
 * shape, old records included), unless the error came from that launch. A
 * later 402 replaces the record and drops the stamp. Returns the stamped record.
 */
export async function stampAgentRuntimeErrorRecoveryLaunch(
  agentId: string,
  launchId: string,
): Promise<AgentRuntimeErrorState | null> {
  const stored = agents.lastRuntimeError;
  const [updated] = await getDb().update(agents)
    .set({ lastRuntimeError: sql`jsonb_set(${stored}, '{recoveryLaunchId}', to_jsonb(${launchId}::text))` })
    .where(and(
      eq(agents.id, agentId),
      isNull(agents.deletedAt),
      sql`${stored}->>'errorClass' = 'BillingError'`,
      sql`(${stored}->>'launchId') IS DISTINCT FROM ${launchId}::text`,
    ))
    .returning({ lastRuntimeError: agents.lastRuntimeError });
  return updated?.lastRuntimeError ?? null;
}

export async function updateAgent(
  agentId: string,
  fields: {
    displayName?: string | null;
    description?: string | null;
    avatarUrl?: string | null;
    model?: string;
    runtime?: string;
    runtimeConfig?: RuntimeConfig | null;
    reasoningEffort?: LegacyColumnReasoningEffort | null;
    envVars?: Record<string, string> | null;
    sessionId?: string | null;
    providerConnection?: {
      id: string;
      configVersion: number;
      credentialVersion: number;
      updatedByUserId: string;
    } | null;
  },
  options: {
    executor?: DatabaseExecutor;
    /** Who and which code path, for agent_config_change_events (default `agent_update`, actor unknown). */
    configChange?: { source: AgentConfigChangeSource; actor?: AgentConfigChangeActor | null };
  } = {},
) {
  const db = options.executor ?? getDb();
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(agents)
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
      .limit(1)
      .for("update");
    if (!existing) return null;
    if (fields.runtime !== undefined && fields.runtime !== EXTERNAL_AGENT_RUNTIME_ID) {
      const [binding] = await tx.select({ serverId: raftbenchServiceAgents.serverId }).from(raftbenchServiceAgents).where(eq(raftbenchServiceAgents.agentId, agentId)).limit(1);
      if (binding) throw new FencedAuthorizationDeniedError("forbidden");
    }

    const { reasoningEffort, envVars, runtimeConfig, sessionId, providerConnection, ...rest } = fields;
    const now = currentDate();
    const [updated] = await tx.update(agents)
      .set({
        ...rest,
        // Free text other agents read: a display name has no line break, a description only `\n`.
        ...(typeof rest.displayName === "string" ? { displayName: replaceAgentLineBreaks(rest.displayName, " ") } : {}),
        ...(typeof rest.description === "string" ? { description: replaceAgentLineBreaks(rest.description, "\n") } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(envVars !== undefined ? { envVars } : {}),
        ...(runtimeConfig !== undefined ? { runtimeConfig } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        updatedAt: now,
      })
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
      .returning();
    if (!updated) return null;
    await recordAgentConfigChange(tx, {
      serverId: updated.serverId,
      agentId: updated.id,
      source: options.configChange?.source ?? "agent_update",
      actor: options.configChange?.actor ?? null,
      before: agentConfigValues(existing),
      after: agentConfigValues(updated),
      changedAt: now,
    });

    if (providerConnection === null) {
      await tx.delete(agentProviderConnections).where(and(
        eq(agentProviderConnections.serverId, updated.serverId),
        eq(agentProviderConnections.agentId, updated.id),
      ));
    } else if (providerConnection !== undefined) {
      await tx.insert(agentProviderConnections).values({
        serverId: updated.serverId,
        agentId: updated.id,
        connectionId: providerConnection.id,
        expectedConfigVersion: providerConnection.configVersion,
        expectedCredentialVersion: providerConnection.credentialVersion,
        updatedByUserId: providerConnection.updatedByUserId,
      }).onConflictDoUpdate({
        target: agentProviderConnections.agentId,
        set: {
          connectionId: providerConnection.id,
          expectedConfigVersion: providerConnection.configVersion,
          expectedCredentialVersion: providerConnection.credentialVersion,
          updatedByUserId: providerConnection.updatedByUserId,
          updatedAt: now,
        },
      });
    }

    const profileFields = [
      existing.displayName !== updated.displayName ? "display_name" : null,
      existing.description !== updated.description ? "description" : null,
      existing.avatarUrl !== updated.avatarUrl ? "avatar_url" : null,
    ].filter((field): field is string => field !== null);
    if (profileFields.length > 0) {
      await emitAgentNotificationEvent(tx, updated, "agent.profile_updated", profileFields, now);
    }

    const runtimeFields = [
      existing.runtime !== updated.runtime ? "runtime" : null,
      existing.reasoningEffort !== updated.reasoningEffort ? "reasoning_effort" : null,
      !isDeepStrictEqual(existing.envVars, updated.envVars) ? "env_vars" : null,
      !isDeepStrictEqual(runtimeConfigWithoutModel(existing.runtimeConfig), runtimeConfigWithoutModel(updated.runtimeConfig))
        ? "runtime_config"
        : null,
    ].filter((field): field is string => field !== null);
    if (runtimeFields.length > 0) {
      await emitAgentNotificationEvent(tx, updated, "agent.runtime_changed", runtimeFields, now);
    }
    if (existing.model !== updated.model) {
      await emitAgentNotificationEvent(tx, updated, "agent.model_changed", ["model"], now);
    }
    return updated;
  });
  return result;
}

export async function adoptOfficialOnboardingAgentIdentity(
  serverId: string,
  agentId: string,
  identity: {
    name: string;
    displayName: string;
    description: string;
    avatarUrl: string;
    serverRole: "admin";
  },
  options: { executor?: DatabaseExecutor } = {},
) {
  const db = options.executor ?? getDb();
  return db.transaction(async (tx) => {
    await lockServerPrincipalHandles(tx, serverId);

    const [existing] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.serverId, serverId), isNull(agents.deletedAt)));
    if (!existing) return null;

    if (existing.name !== identity.name) {
      const [conflict] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(
          eq(agents.serverId, serverId),
          eq(agents.name, identity.name),
          isNull(agents.deletedAt),
          ne(agents.id, agentId),
        ));
      if (conflict) {
        throw new PrincipalHandleConflictError(`Agent name "${identity.name}" is already taken`);
      }
    }

    const [updated] = await tx
      .update(agents)
      .set({
        name: identity.name,
        displayName: identity.displayName,
        description: identity.description,
        avatarUrl: identity.avatarUrl,
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, agentId), eq(agents.serverId, serverId), isNull(agents.deletedAt)))
      .returning();
    if (updated) {
      const changedFields = [
        existing.name !== updated.name ? "handle" : null,
        existing.displayName !== updated.displayName ? "display_name" : null,
        existing.description !== updated.description ? "description" : null,
        existing.avatarUrl !== updated.avatarUrl ? "avatar_url" : null,
      ].filter((field): field is string => field !== null);
      if (changedFields.length > 0) {
        await emitAgentNotificationEvent(
          tx,
          updated,
          "agent.profile_updated",
          changedFields,
          updated.updatedAt,
        );
      }
      await tx
        .insert(serverAgentMembers)
        .values({
          serverId,
          agentId,
          role: identity.serverRole,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [serverAgentMembers.serverId, serverAgentMembers.agentId],
          set: {
            role: identity.serverRole,
            updatedAt: new Date(),
          },
        });
    }
    return updated || null;
  });
}

/**
 * The single source of truth for an App bot's avatar: its stored
 * `agents.avatar_url` IS its App's `oauth_clients.logo_url` (null when the App
 * has no logo, so every surface shows the same generated avatar).
 *
 * Why write-side: every surface (message authors, DM header, sidebar, mentions,
 * search, task assignee, joint-channel peers, the mobile app) renders
 * `agent.avatarUrl`; projecting the logo in each serializer is the list that
 * was incomplete. Bot creation copies the logo at insert time
 * (createManagedAppBot); every logo write (upload, clear, App deletion) calls
 * this from its route, in the transaction that writes the logo, for the bots
 * of every installation (all servers), and broadcasts `agent:updated` for each
 * returned bot after commit. The agent avatar routes refuse direct edits for
 * the same reason (`app_bot_avatar_managed`).
 *
 * Returns the bots whose avatar changed, each with its own server.
 */
export async function syncAppBotAvatarsToLogo(
  executor: DatabaseExecutor,
  input: { clientId: string; logoUrl: string | null; now?: Date },
): Promise<Array<{ serverId: string; agentId: string }>> {
  return executor
    .update(agents)
    .set({ avatarUrl: input.logoUrl, updatedAt: input.now ?? new Date() })
    .where(and(
      inArray(
        agents.managedByAppInstallId,
        executor
          .select({ id: oauthClientInstalls.id })
          .from(oauthClientInstalls)
          .where(eq(oauthClientInstalls.clientId, input.clientId)),
      ),
      sql`${agents.avatarUrl} is distinct from ${input.logoUrl}::text`,
    ))
    .returning({ serverId: agents.serverId, agentId: agents.id });
}

export async function tryMarkAllChannelIntroSent(agentId: string, sentAt: Date) {
  const db = getDb();
  const [updated] = await db.update(agents)
    .set({
      allChannelIntroSentAt: sentAt,
      updatedAt: sentAt,
    })
    .where(and(
      eq(agents.id, agentId),
      isNull(agents.deletedAt),
      isNull(agents.allChannelIntroSentAt),
    ))
    .returning({ id: agents.id });
  return !!updated;
}

export async function clearAllChannelIntroSentClaim(agentId: string, claimedAt: Date) {
  const db = getDb();
  await db.update(agents)
    .set({
      allChannelIntroSentAt: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(agents.id, agentId),
      isNull(agents.deletedAt),
      eq(agents.allChannelIntroSentAt, claimedAt),
    ));
}

/**
 * `revokedByUserId`: who deleted it (the route's caller, the departing
 * account), recorded on the revoked credentials; null for system deletions.
 */
export async function deleteAgent(agentId: string, options: { executor?: DatabaseExecutor; revokedByUserId?: string | null } = {}) {
  const db = options.executor ?? getDb();
  const deletedAt = new Date();

  await db.transaction(async (tx) => {
    const [dedicated] = await tx.select({ serverId: raftbenchServiceAgents.serverId })
      .from(raftbenchServiceAgents).where(eq(raftbenchServiceAgents.agentId, agentId));
    if (dedicated) {
      const [config] = await tx.select().from(raftbenchConfigs)
        .where(eq(raftbenchConfigs.serverId, dedicated.serverId)).for("update");
      if (config?.agentId === agentId) {
        await tx.delete(raftbenchLatestRuns).where(eq(raftbenchLatestRuns.serverId, dedicated.serverId));
        await tx.delete(raftbenchFindings).where(eq(raftbenchFindings.serverId, dedicated.serverId));
        await tx.delete(thirdPartyAgentEvents).where(and(eq(thirdPartyAgentEvents.serverId, dedicated.serverId), eq(thirdPartyAgentEvents.systemApp, "system.raftbench")));
        await tx.update(raftbenchConfigs).set({ agentId: null, enabled: false, revision: config.revision + 1, readMessages: 0, readThroughSeq: 0, completedBatches: 0, scannedThroughAt: null, updatedAt: deletedAt })
          .where(eq(raftbenchConfigs.serverId, dedicated.serverId));
      }
    }
    await tx.update(agents)
      .set({
        deletedAt,
        status: "inactive",
        sessionId: null,
        machineId: null,
        updatedAt: deletedAt,
      })
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)));

    // A deleted agent's keys die with it (#wg-rbac:#27): every credential and
    // unused bootstrap token, whoever issued it (a Computer's runner keys, a
    // person's keys). Only cloud-runtime agents were revoked before
    // (beginProvisionedAgentDeletion), so a Computer-run agent's keys stayed
    // live and were refused only because the agent lookup failed.
    await revokeDeletedAgentCredentials(tx, agentId, deletedAt, options.revokedByUserId ?? null);

    await tx.delete(agentRuntimeProfiles)
      .where(eq(agentRuntimeProfiles.agentId, agentId));
    // Its held calls can no longer be decided here: they end `unavailable`, on every card.
    await retireAgentApprovals(tx as ReturnType<typeof getDb>, agentId);
    // RFC 077: a personal assistant's contact rules, settings and "already told" facts go with it.
    await tx.delete(assistantContactRules).where(eq(assistantContactRules.agentId, agentId));
    await tx.delete(assistantContactSettings).where(eq(assistantContactSettings.agentId, agentId));
    await tx.delete(assistantTold).where(eq(assistantTold.agentId, agentId));
    await tx.delete(assistantCheckState).where(eq(assistantCheckState.agentId, agentId));
    await tx.delete(assistantChecks).where(eq(assistantChecks.agentId, agentId));
    // Its DM, which stayed out of its owner's Activity (assistantService
    // keepAssistantDmOutOfActivity), is an ordinary DM again. Only that row:
    // push_muted false is never a person's own mute.
    await tx.delete(inboxTargetMuteStates).where(and(
      eq(inboxTargetMuteStates.pushMuted, false),
      sql`${inboxTargetMuteStates.sourceChannelId} in (
        select ca.channel_id from channel_agents ca
        join channels c on c.id = ca.channel_id and c.type = 'dm'
        where ca.agent_id = ${agentId}
      )`,
    ));

    const removedMemberships = await tx.delete(serverAgentMembers)
      .where(eq(serverAgentMembers.agentId, agentId))
      .returning({ serverId: serverAgentMembers.serverId, role: serverAgentMembers.role });
    // Same commit as the delete: the event row is the outbox. The caller
    // kicks app delivery after its own commit.
    for (const membership of removedMemberships) {
      await emitAppFacingMemberEvents({
        serverId: membership.serverId,
        eventType: "server.member_removed",
        members: [{ principalType: "agent", principalId: agentId, role: membership.role }],
        occurredAt: deletedAt,
        provenance: { source: "agent_service", actor_type: "human", reason: "removed" },
      }, tx);
    }

    // A deleted Agent can never launch again, so its provider connection
    // assignment is dead weight. Keeping the row would leave the connection
    // permanently undeletable with no reachable Agent to unbind it from —
    // the same release already applied to task claims below.
    const [releasedProviderAssignment] = await tx.select({
      serverId: agentProviderConnections.serverId,
      connectionId: agentProviderConnections.connectionId,
      providerId: providerConnections.providerId,
      configVersion: providerConnections.configVersion,
      credentialVersion: providerConnectionCredentials.credentialVersion,
    }).from(agentProviderConnections)
      .innerJoin(providerConnections, and(
        eq(providerConnections.serverId, agentProviderConnections.serverId),
        eq(providerConnections.id, agentProviderConnections.connectionId),
      ))
      .leftJoin(providerConnectionCredentials, and(
        eq(providerConnectionCredentials.serverId, agentProviderConnections.serverId),
        eq(providerConnectionCredentials.connectionId, agentProviderConnections.connectionId),
      ))
      .where(eq(agentProviderConnections.agentId, agentId))
      .limit(1);

    if (releasedProviderAssignment) {
      await tx.delete(agentProviderConnections)
        .where(eq(agentProviderConnections.agentId, agentId));
      await recordIntegrationAuditEvent({
        serverId: releasedProviderAssignment.serverId,
        eventType: "provider_connection.assignment_detached",
        outcome: "success",
        source: "system",
        actor: { type: "system" },
        subject: { type: "agent", id: agentId },
        target: { type: "provider_connection", id: releasedProviderAssignment.connectionId },
        metadata: {
          providerId: releasedProviderAssignment.providerId,
          configVersion: releasedProviderAssignment.configVersion,
          credentialVersion: releasedProviderAssignment.credentialVersion,
          agentId,
          reason: "agent_deleted",
        },
      }, tx);
    }

    // Tasks reference agents via `taskAssigneeId` (text column, no FK).
    // Soft-deleting the agent leaves those tasks claimed by a deleted
    // agent — users can't re-assign or unclaim because the assignee row
    // is gone. Release the claim while preserving the task's status so
    // the user can pick it up or close it themselves.
    await tx.update(messages)
      .set({
        taskAssigneeType: null,
        taskAssigneeId: null,
        taskClaimedAt: null,
        updatedAt: deletedAt,
      })
      .where(and(
        eq(messages.taskAssigneeType, "agent"),
        eq(messages.taskAssigneeId, agentId),
      ));

    // v1.4: the same release has to run against the canonical `tasks` table —
    // a task claimed by this agent may live on either side during the mixed
    // window, and releasing only the legacy side would leave canonical tasks
    // permanently claimed by a deleted agent.
    const releasedTasks = await tx.update(tasks)
      .set({
        claimedByType: null,
        claimedById: null,
        claimedAt: null,
        revision: sql`${tasks.revision} + 1`,
        updatedAt: deletedAt,
        // An assignee change: Tasks-page activity (taskService.TASK_ACTIVITY_NOW).
        lastActivityAt: sql`now()`,
      })
      .where(and(
        eq(tasks.claimedByType, "agent"),
        eq(tasks.claimedById, agentId),
      ))
      .returning({ id: tasks.id });

    if (releasedTasks.length > 0) {
      await tx.insert(taskEvents).values(releasedTasks.map((task) => ({
        taskId: task.id,
        eventType: "assignee_changed" as const,
        actorType: "system" as const,
        actorId: null,
        payload: { assigneeType: null, assigneeId: null, reason: "assignee_agent_deleted", agentId },
      })));
    }

    // Receipt DMs are identity-immutable (#5983). Tombstoning them or
    // deleting their channel_agents row raises, so a migrated agent cannot
    // be deleted. Skip those surfaces; they stay as historical records on
    // the soft-deleted agent. RESTRICT on receipt_channels.agent_id is
    // unused here because this path never hard-deletes the agents row.
    const notReceiptChannel = sql`${channels.id} NOT IN (
      SELECT channel_id FROM agent_migration_receipt_channels WHERE agent_id = ${agentId}
    )`;
    const notReceiptMembership = sql`${channelAgents.channelId} NOT IN (
      SELECT channel_id FROM agent_migration_receipt_channels WHERE agent_id = ${agentId}
    )`;

    const dmChannelIds = await tx
      .select({ id: channels.id })
      .from(channels)
      .innerJoin(channelAgents, eq(channels.id, channelAgents.channelId))
      .where(and(
        eq(channelAgents.agentId, agentId),
        eq(channels.type, "dm"),
        isNull(channels.deletedAt),
        notReceiptChannel,
      ));

    // Preserve provenance before mutable memberships are removed. The schema
    // migration backfills exact legacy shapes, while this transaction closes
    // the migration/deploy race and protects legacy rows that were never
    // touched by a find/create lazy-adoption path.
    await tx.execute(sql`
      INSERT INTO dm_channel_identities (channel_id, server_id, kind, peer_key)
      SELECT c.id, c.server_id, 'human_agent',
        CASE WHEN ch.user_id::text < ca.agent_id::text
          THEN ch.user_id::text || ':' || ca.agent_id::text
          ELSE ca.agent_id::text || ':' || ch.user_id::text
        END
      FROM channels c
      INNER JOIN channel_agents ca ON ca.channel_id = c.id
      INNER JOIN channel_humans ch ON ch.channel_id = c.id
      WHERE ca.agent_id = ${agentId}
        AND c.type = 'dm'
        AND (SELECT count(*) FROM channel_humans WHERE channel_id = c.id) = 1
        AND (SELECT count(*) FROM channel_agents WHERE channel_id = c.id) = 1
      ON CONFLICT (channel_id) DO NOTHING
    `);
    await tx.execute(sql`
      INSERT INTO dm_channel_identities (channel_id, server_id, kind, peer_key)
      SELECT c.id, c.server_id, 'agent_agent',
        CASE WHEN ca.agent_id::text < peer.agent_id::text
          THEN ca.agent_id::text || ':' || peer.agent_id::text
          ELSE peer.agent_id::text || ':' || ca.agent_id::text
        END
      FROM channels c
      INNER JOIN channel_agents ca ON ca.channel_id = c.id
      INNER JOIN channel_agents peer ON peer.channel_id = c.id AND peer.agent_id <> ca.agent_id
      WHERE ca.agent_id = ${agentId}
        AND c.type = 'dm'
        AND (SELECT count(*) FROM channel_humans WHERE channel_id = c.id) = 0
        AND (SELECT count(*) FROM channel_agents WHERE channel_id = c.id) = 2
      ON CONFLICT (channel_id) DO NOTHING
    `);

    if (dmChannelIds.length > 0) {
      await tx.update(channels)
        .set({ deletedAt })
        .where(inArray(channels.id, dmChannelIds.map((channel) => channel.id)));
    }

    await tx.delete(channelAgents)
      .where(and(
        eq(channelAgents.agentId, agentId),
        notReceiptMembership,
      ));
  });
}

export async function resetAgentSession(agentId: string, status: AgentStatus = "inactive") {
  const db = getDb();
  await db.transaction(async (tx) => {
    const [existing] = await tx.select({
      id: agents.id,
      serverId: agents.serverId,
      status: agents.status,
    }).from(agents)
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
      .limit(1)
      .for("update");
    if (!existing) return;
    const now = currentDate();
    await tx.update(agents)
      .set({
        sessionId: null,
        status,
        updatedAt: now,
      })
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)));
    if (existing.status !== status) {
      await emitAgentNotificationEvent(tx, existing, "agent.status_changed", ["status"], now);
    }
  });
}

/**
 * Where each of these agents is placed now, deleted ones included (an id with
 * no row at all is absent from the result). Reads the primary.
 */
export async function getAgentPlacements(agentIds: string[]) {
  if (agentIds.length === 0) return [];
  const db = getDb();
  return db
    .select({ id: agents.id, machineId: agents.machineId, deletedAt: agents.deletedAt })
    .from(agents)
    .where(inArray(agents.id, agentIds));
}

/** getAgent for several ids in one query; missing or deleted ids are absent. */
export async function getAgentsByIds(agentIds: readonly string[]) {
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return [];
  const db = getDb();
  return db
    .select()
    .from(agents)
    .where(and(inArray(agents.id, ids), isNull(agents.deletedAt)));
}

export async function getAgentsForMachine(machineId: string) {
  const db = getDb();
  return db
    .select()
    .from(agents)
    .where(and(eq(agents.machineId, machineId), isNull(agents.deletedAt)));
}

export async function autoAssignMachine(serverId: string, machineId: string) {
  const db = getDb();
  // External agents are never machine-assigned (SHA-V0-006C). They are
  // created with the default executionMode and no machine, so without this
  // exclusion the machine-online sweep silently binds them to the first
  // connected machine and the wake path then tries to launch them as
  // managed runtimes (daemon: "Unknown runtime: external") — dropping
  // their deliveries instead of surfacing /wake-hints.
  await db.transaction(async (tx) => {
    // Not onto a machine whose Computer key was revoked: its row FOR SHARE
    // first, so a revoke holding it FOR UPDATE is seen (computerAgents.ts).
    if (!await lockMachineIfTakesAgents(tx, machineId)) return;
    const now = new Date();
    const assigned = await tx.update(agents)
      .set({ machineId, updatedAt: now })
      .where(
        and(
          eq(agents.serverId, serverId),
          eq(agents.executionMode, "byoc"),
          ne(agents.runtime, EXTERNAL_AGENT_RUNTIME_ID),
          // Never a personal assistant (agents_assistant_not_on_machine).
          isNull(agents.assistantOwnerUserId),
          isNull(agents.machineId),
          isNull(agents.deletedAt),
          // Not an agent forced off its Computer, until it is bound again on purpose (computerAgents.ts).
          isNull(agents.machineReleaseReason),
        )
      )
      .returning({ id: agents.id });
    await revokeRunnerCredentialsOffMachine(tx, { agentIds: assigned.map((agent) => agent.id), machineId, now });
  });
}

/** Reset all active agents to inactive on server startup (no running processes exist yet). */
export async function resetAllAgentStatuses() {
  const db = getDb();
  await db.transaction(async (tx) => {
    const activeAgents = await tx.select({ id: agents.id, serverId: agents.serverId })
      .from(agents)
      .where(and(eq(agents.status, "active"), isNull(agents.deletedAt)))
      .for("update");
    if (activeAgents.length === 0) return;
    const now = currentDate();
    await tx.update(agents)
      .set({ status: "inactive", updatedAt: now })
      .where(and(eq(agents.status, "active"), isNull(agents.deletedAt)));
    for (const agent of activeAgents) {
      await emitAgentNotificationEvent(tx, agent, "agent.status_changed", ["status"], now);
    }
  });
}

/**
 * raft-agent-status.v1 adoption flag. Returns when the agent first had a
 * status report accepted, or null when it never adopted the standard.
 */
export async function getAgentStatusProtocolAdoptedAt(agentId: string): Promise<Date | null> {
  const db = getDb();
  const [row] = await db
    .select({ adoptedAt: agents.statusProtocolAdoptedAt })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return row?.adoptedAt ?? null;
}

/**
 * Durably mark the agent as a raft-agent-status.v1 reporter. Idempotent: the
 * first accepted report wins and later calls leave the timestamp unchanged.
 * Returns the stored adoption time.
 */
export async function markAgentStatusProtocolAdopted(agentId: string, adoptedAt: Date): Promise<Date> {
  const db = getDb();
  const [updated] = await db
    .update(agents)
    .set({ statusProtocolAdoptedAt: adoptedAt })
    .where(and(eq(agents.id, agentId), isNull(agents.statusProtocolAdoptedAt)))
    .returning({ adoptedAt: agents.statusProtocolAdoptedAt });
  if (updated?.adoptedAt) return updated.adoptedAt;
  return (await getAgentStatusProtocolAdoptedAt(agentId)) ?? adoptedAt;
}

const RAFTBENCH_BINDINGS_TTL_MS = 30_000;
let raftbenchBindings: { ids: Set<string>; expiresAt: number } | null = null;
let raftbenchBindingsEpoch = 0;
let raftbenchBindingsRefresh: Promise<Set<string>> | null = null;

/** Invalidate after the binding transaction commits, before provider work starts. */
export function invalidateRaftBenchServiceAgentBindings(): void {
  raftbenchBindings = null;
  raftbenchBindingsEpoch += 1;
  raftbenchBindingsRefresh = null;
}
registerDatabaseCloseHookForTests(async () => { invalidateRaftBenchServiceAgentBindings(); });

/** Dedicated identity survives Disable and unassignment; cache the complete tiny set. */
export async function raftBenchServiceAgentIds(agentIds: readonly string[]): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const cached = raftbenchBindings;
  if (cached && cached.expiresAt > currentTimeMs()) {
    return new Set(agentIds.filter(id => cached.ids.has(id)));
  }
  const epoch = raftbenchBindingsEpoch;
  if (!raftbenchBindingsRefresh) {
    const refresh = getDb().select({ agentId: raftbenchServiceAgents.agentId }).from(raftbenchServiceAgents)
      .then(bindings => {
        const ids = new Set(bindings.map(row => row.agentId));
        if (epoch === raftbenchBindingsEpoch) raftbenchBindings = { ids, expiresAt: currentTimeMs() + RAFTBENCH_BINDINGS_TTL_MS };
        return ids;
      });
    raftbenchBindingsRefresh = refresh;
    void refresh.finally(() => {
      if (raftbenchBindingsRefresh === refresh) raftbenchBindingsRefresh = null;
    }).catch(() => {}); // The awaiting callers receive refresh failures; never cache them.
  }
  const ids = await raftbenchBindingsRefresh;
  // A binding changed while the read was in flight: do not publish its old answer.
  if (epoch !== raftbenchBindingsEpoch) return raftBenchServiceAgentIds(agentIds);
  return new Set(agentIds.filter(id => ids.has(id)));
}

export async function isRaftBenchServiceAgent(agentId: string): Promise<boolean> {
  return (await raftBenchServiceAgentIds([agentId])).has(agentId);
}

async function revokeDeletedAgentCredentials(tx: DatabaseExecutor, agentId: string, now: Date, revokedByUserId: string | null): Promise<void> {
  const [agent] = await tx.select({ serverId: agents.serverId }).from(agents).where(eq(agents.id, agentId));
  const revoked = await tx.update(agentCredentials).set({
    revokedAt: now,
    revokedReason: "agent_deleted",
    ...(revokedByUserId ? { revokedByUserId } : {}),
  }).where(and(eq(agentCredentials.agentId, agentId), isNull(agentCredentials.revokedAt)))
    .returning({ id: agentCredentials.id });
  if (agent) {
    const { recordAgentCredentialsBulkRevoked } = await import("./integrationAuditService");
    await recordAgentCredentialsBulkRevoked({
      serverId: agent.serverId, agentId, actorUserId: revokedByUserId, revokedCount: revoked.length, reason: "agent_deleted",
    }, tx);
  }
  await tx.update(agentBootstrapTokens).set({
    revokedAt: now,
    revokedReason: "agent_deleted",
    ...(revokedByUserId ? { revokedByUserId } : {}),
  }).where(and(
    eq(agentBootstrapTokens.targetAgentId, agentId),
    isNull(agentBootstrapTokens.revokedAt),
    isNull(agentBootstrapTokens.consumedAt),
  ));
}
