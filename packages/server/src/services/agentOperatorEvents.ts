import { and, desc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import {
  AGENT_OPERATOR_EVENTS_PAGE_LIMIT,
  type AgentOperatorEventDetails,
  type AgentOperatorEventStoredKind,
  type AgentOperatorEventView,
  type AgentOperatorEventsPage,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentConfigChangeEvents, agentOperatorEvents, agents, machines, serverMembers, users } from "../db/schema";
import { recordTraceEvent } from "../tracing/semanticTrace";

/**
 * #proj-runtime:#51: what a person did to an agent, and the restarts Raft did
 * by itself, for the Activity overview.
 *
 * The route that accepted the action records it, after the action was
 * accepted, with the person from the request. Recording never fails the
 * action: a write error is traced and dropped. Model changes are not written
 * here; the overview reads them from agent_config_change_events, which has
 * them with their actor.
 */

/** One system restart row per agent per this window: a crash loop folds into one line. */
export const SYSTEM_RESTART_DEDUPE_MS = 60_000;

export type AgentOperatorEventDetailsInput = {
  /** migration_*: ids of the Computers; the overview resolves their names. */
  fromMachineId?: string | null;
  toMachineId?: string | null;
};

export type RecordAgentOperatorEventInput = {
  serverId: string;
  agentId: string;
  kind: AgentOperatorEventStoredKind;
  /** The person who did it; omit for `system_restart`. */
  actorUserId?: string | null;
  details?: AgentOperatorEventDetailsInput;
  occurredAt?: Date;
};

function storedDetails(details: AgentOperatorEventDetailsInput | undefined): Record<string, string> | null {
  if (!details) return null;
  const stored: Record<string, string> = {};
  if (details.fromMachineId) stored.fromMachineId = details.fromMachineId;
  if (details.toMachineId) stored.toMachineId = details.toMachineId;
  return Object.keys(stored).length > 0 ? stored : null;
}

/** Record one event. Returns whether a row was written; never throws. */
export async function recordAgentOperatorEvent(input: RecordAgentOperatorEventInput): Promise<boolean> {
  const system = input.kind === "system_restart";
  try {
    const db = getDb();
    const occurredAt = input.occurredAt ?? new Date();
    if (system) {
      const [recent] = await db.select({ id: agentOperatorEvents.id }).from(agentOperatorEvents)
        .where(and(
          eq(agentOperatorEvents.agentId, input.agentId),
          eq(agentOperatorEvents.kind, "system_restart"),
          gte(agentOperatorEvents.occurredAt, new Date(occurredAt.getTime() - SYSTEM_RESTART_DEDUPE_MS)),
        ))
        .limit(1);
      if (recent) return false;
    }
    await db.insert(agentOperatorEvents).values({
      serverId: input.serverId,
      agentId: input.agentId,
      occurredAt,
      actorKind: system ? "system" : "user",
      actorUserId: system ? null : input.actorUserId ?? null,
      kind: input.kind,
      details: storedDetails(input.details),
    });
    return true;
  } catch (error) {
    recordTraceEvent("server.agent.operator_event.record_failed", {
      agent_id: input.agentId,
      kind: input.kind,
      error_name: error instanceof Error ? error.name : "unknown",
    });
    return false;
  }
}

/**
 * A start Raft made by itself after failed starts (the retry after a
 * retry-once failure, a paused agent's timed try), once it was dispatched.
 * The daemon's own respawns are not recorded: their frame says no why, and
 * most are routine idle restarts.
 */
export async function recordAgentSystemRestart(agentId: string, occurredAt?: Date): Promise<boolean> {
  try {
    const [agent] = await getDb().select({ serverId: agents.serverId }).from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!agent) return false;
    return await recordAgentOperatorEvent({ serverId: agent.serverId, agentId, kind: "system_restart", occurredAt });
  } catch {
    return false;
  }
}

export type ListAgentOperatorEventsOptions = {
  /** Epoch ms, inclusive. */
  sinceMs?: number;
  /** Epoch ms, inclusive. */
  untilMs?: number;
  limit?: number;
};

/**
 * The agent's events in the window, newest first: its operator events and
 * its runtime / model / reasoning effort changes (not its creation). A
 * person's name is given only while they are a member of the agent's server.
 */
export async function listAgentOperatorEvents(
  agent: { id: string; serverId: string },
  options: ListAgentOperatorEventsOptions = {},
): Promise<AgentOperatorEventsPage> {
  const db = getDb();
  const limit = Math.min(Math.max(options.limit ?? AGENT_OPERATOR_EVENTS_PAGE_LIMIT, 1), AGENT_OPERATOR_EVENTS_PAGE_LIMIT);
  const since = options.sinceMs !== undefined ? new Date(options.sinceMs) : null;
  const until = options.untilMs !== undefined ? new Date(options.untilMs) : null;

  const operatorRows = await db.select().from(agentOperatorEvents)
    .where(and(
      eq(agentOperatorEvents.agentId, agent.id),
      ...(since ? [gte(agentOperatorEvents.occurredAt, since)] : []),
      ...(until ? [lte(agentOperatorEvents.occurredAt, until)] : []),
    ))
    .orderBy(desc(agentOperatorEvents.occurredAt))
    .limit(limit + 1);
  const configRows = await db.select().from(agentConfigChangeEvents)
    .where(and(
      eq(agentConfigChangeEvents.agentId, agent.id),
      // A creation has no before: not a change anyone made to this agent.
      isNotNull(agentConfigChangeEvents.beforeModel),
      ...(since ? [gte(agentConfigChangeEvents.changedAt, since)] : []),
      ...(until ? [lte(agentConfigChangeEvents.changedAt, until)] : []),
    ))
    .orderBy(desc(agentConfigChangeEvents.changedAt))
    .limit(limit + 1);

  type Draft = { view: Omit<AgentOperatorEventView, "actor">; actorUserId: string | null; system: boolean; machineIds: string[] };
  const drafts: Draft[] = [];
  for (const row of operatorRows) {
    const details = (row.details ?? {}) as Record<string, string>;
    drafts.push({
      view: { id: row.id, at: row.occurredAt.getTime(), kind: row.kind as AgentOperatorEventStoredKind },
      actorUserId: row.actorUserId,
      system: row.actorKind === "system",
      machineIds: [details.fromMachineId, details.toMachineId].filter((id): id is string => typeof id === "string"),
    });
  }
  for (const row of configRows) {
    const details: AgentOperatorEventDetails = {};
    if (row.beforeModel !== row.afterModel) Object.assign(details, { beforeModel: row.beforeModel ?? undefined, afterModel: row.afterModel });
    if (row.beforeRuntime !== row.afterRuntime) Object.assign(details, { beforeRuntime: row.beforeRuntime ?? undefined, afterRuntime: row.afterRuntime });
    if ((row.beforeReasoningEffort ?? null) !== (row.afterReasoningEffort ?? null)) {
      Object.assign(details, { beforeReasoningEffort: row.beforeReasoningEffort ?? null, afterReasoningEffort: row.afterReasoningEffort ?? null });
    }
    drafts.push({
      view: { id: row.id, at: row.changedAt.getTime(), kind: "config_changed", details },
      actorUserId: row.actorKind === "user" ? row.actorId : null,
      // An agent's own change, or a code path that did not know who: no person to name.
      system: row.actorKind !== "user",
      machineIds: [],
    });
  }
  drafts.sort((a, b) => b.view.at - a.view.at || (a.view.id < b.view.id ? 1 : -1));
  const page = drafts.slice(0, limit);

  const userIds = [...new Set(page.map((draft) => draft.actorUserId).filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  if (userIds.length > 0) {
    const members = await db.select({ id: users.id, name: users.name, displayName: users.displayName })
      .from(serverMembers)
      .innerJoin(users, eq(users.id, serverMembers.userId))
      .where(and(eq(serverMembers.serverId, agent.serverId), inArray(serverMembers.userId, userIds)));
    for (const member of members) names.set(member.id, member.displayName || member.name);
  }
  const machineIds = [...new Set(page.flatMap((draft) => draft.machineIds))];
  const machineNames = new Map<string, string>();
  if (machineIds.length > 0) {
    const rows = await db.select({ id: machines.id, name: machines.name }).from(machines)
      .where(and(eq(machines.serverId, agent.serverId), inArray(machines.id, machineIds)));
    for (const row of rows) machineNames.set(row.id, row.name);
  }

  const events = page.map((draft): AgentOperatorEventView => {
    const view: AgentOperatorEventView = {
      ...draft.view,
      actor: draft.system ? { kind: "system" } : { kind: "user", name: draft.actorUserId ? names.get(draft.actorUserId) ?? null : null },
    };
    if (draft.view.kind === "migration_started" || draft.view.kind === "migration_cancelled") {
      const row = operatorRows.find((candidate) => candidate.id === draft.view.id);
      const details = (row?.details ?? {}) as Record<string, string>;
      const fromComputer = details.fromMachineId ? machineNames.get(details.fromMachineId) : undefined;
      const toComputer = details.toMachineId ? machineNames.get(details.toMachineId) : undefined;
      if (fromComputer || toComputer) view.details = { ...(fromComputer ? { fromComputer } : {}), ...(toComputer ? { toComputer } : {}) };
    }
    return view;
  });
  return { events, truncated: drafts.length > limit };
}
