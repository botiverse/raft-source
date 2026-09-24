import { createHash } from "crypto";
import { isDeepStrictEqual } from "node:util";
import { eq, and, inArray, isNull, sql, asc, ne } from "drizzle-orm";
import { getDb, withDbTraceAttributes, type DatabaseExecutor, type DatabaseTransaction } from "../db/index.js";
import { agents, machines, channels, channelAgents, servers, serverMembers, serverAgentMembers, users, agentRuntimeProfiles, messages, tasks, taskEvents, agentProviderConnections } from "../db/schema.js";
import { ALL_CHANNEL_TEAM_THRESHOLD, EXTERNAL_AGENT_RUNTIME_ID, PLAN_CONFIG, currentDate, getEffectiveLimits, type AgentRuntimeErrorState, type AgentStatus, type ServerPlan, type ReasoningEffort, type RuntimeConfig, getDefaultModel, isExternalAgentRuntime, validateAgentName } from "@botiverse/raft-shared";
import { assertAgentCapacityAvailable, getServerBillingEntitlement, getServerBillingUsage, withAgentCreateLock } from "./planService.js";
import { untracedDbQuery, type DbQueryTracer } from "../tracing/dbQueryTrace.js";
import { assertAgentHandleAvailableInServer, lockServerPrincipalHandles, PrincipalHandleConflictError } from "./principalHandleService.js";
import { refreshSubscriptionForServerIfStale } from "./billingService.js";
import { evaluateFeatureFlag } from "./featureFlagService.js";
import { recordSecondAgentCreatedEvent } from "./productEventsService.js";
import { emitAppFacingNotificationEvent } from "./appNotificationDeliveryService.js";
import { requestExternalAuthorAvatarSync } from "./externalAuthorAvatarSyncRuntime.js";

export type CreatorType = "user" | "agent";

export type CreatorSummary =
  | {
      type: "human";
      id: string;
      name: string;
      displayName: string | null;
      avatarUrl: string | null;
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
    description?: string;
    model?: string;
    runtime?: string;
    runtimeConfig?: RuntimeConfig | null;
    reasoningEffort?: ReasoningEffort;
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
  } = {}
) {
  const nameError = validateAgentName(name, "Agent name");
  if (nameError) {
    throw new Error(nameError);
  }

  await refreshSubscriptionForServerIfStale(serverId);

  // Atomic quota check + insert under advisory lock (namespace 1 = agents)
  const agent = await withAgentCreateLock(serverId, async (tx) => {
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

    const entitlement = await getServerBillingEntitlement(tx, serverId);
    const usage = await getServerBillingUsage(tx, serverId);
    assertAgentCapacityAvailable(entitlement, usage);

    // Prevent new same-server agent handle collisions. Human/agent handle
    // conflicts remain allowed for now and will be handled separately.
    await assertAgentHandleAvailableInServer(tx, serverId, name);

    const runtime = opts.runtime || "claude";
    // Use provided machineId, or auto-assign first available machine for
    // managed runtimes. External agents are supplied by a user-owned process,
    // so `runtime` is the canonical discriminator for skipping assignment.
    let machineId: string | null = opts.machineId || null;
    if (!machineId && !isExternalAgentRuntime(runtime)) {
      const [firstMachine] = await tx
        .select({ id: machines.id })
        .from(machines)
        .where(eq(machines.serverId, serverId))
        .limit(1);
      if (firstMachine) {
        machineId = firstMachine.id;
      }
    }

    const [newAgent] = await tx
      .insert(agents)
      .values({
        serverId,
        name,
        displayName: name,
        description: opts.description,
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

    await tx.insert(serverAgentMembers).values({
      serverId,
      agentId: newAgent.id,
      role: "member",
    }).onConflictDoNothing();

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
    const openerFlag = await evaluateFeatureFlag({ key: "onboarding_opener_v2", serverId }, tx);
    if (openerFlag.enabled) {
      const [{ agentCount }] = await tx
        .select({ agentCount: sql<number>`count(*)::int` })
        .from(agents)
        .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt)));
      const [{ humanCount }] = await tx
        .select({ humanCount: sql<number>`count(*)::int` })
        .from(serverMembers)
        .where(eq(serverMembers.serverId, serverId));
      if (agentCount + humanCount >= ALL_CHANNEL_TEAM_THRESHOLD) {
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
        }
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
    // forgotten. Every path that produces an agent passes through here, so the fact cannot
    // be created without the record of it.
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
    await markServerSetupCompleteOnFirstAgent(tx, serverId);

    return newAgent;
  });

  return agent;
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
): Promise<void> {
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

export async function listAgents(
  serverId: string,
  includeDeleted = false,
  opts: { traceQuery?: DbQueryTracer } = {},
) {
  const db = getDb();
  const conditions = [eq(agents.serverId, serverId)];
  if (!includeDeleted) conditions.push(isNull(agents.deletedAt));
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
        email: users.email,
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
      gravatarHash: createHash("sha256").update(creator.email.trim().toLowerCase()).digest("hex"),
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

export async function listCreatedAgents(serverId: string, creatorType: CreatorType, creatorId: string): Promise<AgentCreatedSummary[]> {
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
    listCreatedAgents(agent.serverId, "agent", agent.id),
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
            email: users.email,
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
    : Promise.resolve([] as { id: string; name: string; displayName: string | null; avatarUrl: string | null; email: string }[]);

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
      gravatarHash: createHash("sha256").update(row.email.trim().toLowerCase()).digest("hex"),
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

/**
 * Persist a status update that originated from a daemon signal (status / session /
 * ready-reconcile), as opposed to an explicit lifecycle action like start/stop/reset.
 *
 * Signal paths read `agent.status` from the in-memory cache and gate against
 * `stopped`, but the cache is local to a single replica and never invalidated
 * cross-replica. A stale `active` cache entry on Replica B can let a daemon
 * signal flow past the cache gate; this DB-layer guard ensures any signal-driven
 * write is still rejected when the persisted status is `stopped`.
 *
 * Explicit start/reset paths must keep using `updateAgentStatus` so the user can
 * resurrect a stopped agent intentionally.
 */
export async function updateAgentStatusFromSignal(
  agentId: string,
  status: AgentStatus,
  sessionId?: string
): Promise<boolean> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({
      id: agents.id,
      serverId: agents.serverId,
      status: agents.status,
    }).from(agents)
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
      .limit(1)
      .for("update");
    if (!existing || existing.status === "stopped") return false;

    const now = currentDate();
    const [updated] = await tx.update(agents)
      .set({
        status,
        ...(sessionId !== undefined ? { sessionId } : {}),
        updatedAt: now,
      })
      .where(and(
        eq(agents.id, agentId),
        isNull(agents.deletedAt),
        ne(agents.status, "stopped"),
      ))
      .returning({ id: agents.id });
    if (updated && existing.status !== status) {
      await emitAgentNotificationEvent(tx, existing, "agent.status_changed", ["status"], now);
    }
    return Boolean(updated);
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

export async function setAgentLastRuntimeError(
  agentId: string,
  lastRuntimeError: AgentRuntimeErrorState,
): Promise<boolean> {
  const db = getDb();
  const [updated] = await db.update(agents)
    .set({
      lastRuntimeError,
      updatedAt: new Date(),
    })
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .returning({ id: agents.id });
  return Boolean(updated);
}

export async function clearAgentLastRuntimeError(agentId: string): Promise<boolean> {
  const db = getDb();
  const [updated] = await db.update(agents)
    .set({
      lastRuntimeError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .returning({ id: agents.id });
  return Boolean(updated);
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
    reasoningEffort?: ReasoningEffort | null;
    envVars?: Record<string, string> | null;
    sessionId?: string | null;
    providerConnection?: {
      id: string;
      configVersion: number;
      credentialVersion: number;
      updatedByUserId: string;
    } | null;
  }
) {
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(agents)
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
      .limit(1)
      .for("update");
    if (!existing) return null;

    const { reasoningEffort, envVars, runtimeConfig, sessionId, providerConnection, ...rest } = fields;
    const now = currentDate();
    const [updated] = await tx.update(agents)
      .set({
        ...rest,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(envVars !== undefined ? { envVars } : {}),
        ...(runtimeConfig !== undefined ? { runtimeConfig } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        updatedAt: now,
      })
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
      .returning();
    if (!updated) return null;

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
  if (fields.avatarUrl !== undefined && result) {
    await requestExternalAuthorAvatarSync({ authorType: "agent", authorId: agentId });
  }
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
) {
  const db = getDb();
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

export async function deleteAgent(agentId: string) {
  const db = getDb();
  const deletedAt = new Date();

  await db.transaction(async (tx) => {
    await tx.update(agents)
      .set({
        deletedAt,
        status: "inactive",
        sessionId: null,
        machineId: null,
        updatedAt: deletedAt,
      })
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)));

    await tx.delete(agentRuntimeProfiles)
      .where(eq(agentRuntimeProfiles.agentId, agentId));

    await tx.delete(serverAgentMembers)
      .where(eq(serverAgentMembers.agentId, agentId));

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

    const dmChannelIds = await tx
      .select({ id: channels.id })
      .from(channels)
      .innerJoin(channelAgents, eq(channels.id, channelAgents.channelId))
      .where(and(
        eq(channelAgents.agentId, agentId),
        eq(channels.type, "dm"),
        isNull(channels.deletedAt),
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
      .where(eq(channelAgents.agentId, agentId));
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

export async function assignMachine(agentId: string, machineId: string | null) {
  const db = getDb();
  await db.update(agents)
    .set({ machineId, updatedAt: new Date() })
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)));
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
  await db.update(agents)
    .set({ machineId, updatedAt: new Date() })
    .where(
      and(
        eq(agents.serverId, serverId),
        eq(agents.executionMode, "byoc"),
        ne(agents.runtime, EXTERNAL_AGENT_RUNTIME_ID),
        isNull(agents.machineId),
        isNull(agents.deletedAt),
      )
    );
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
