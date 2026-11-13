// #proj-raft-computer:#68 (readiness PR 1): the server side of agent readiness.
//
// - Stores the latest `machine:runtime_readiness` report per Computer
//   (computer_readiness_reports), dropping a report whose `seq` is not above
//   the stored one.
// - Adds its own facts (Computer offline as the outage machinery counts it:
//   reconnecting inside its 60 s dwell, offline once told, restarting when
//   planned and offline 5 min after its last heartbeat, updating while the
//   upgrade it was sent runs; below the enforced version floor; a runtime
//   detection confirmed missing) and
//   composes with the shared `composeReadiness`, per agent and per runtime.
// - Trims per viewer before anything leaves the server (Tenny #1): the
//   Computer's owner, the agent's owner and server admins see the reason;
//   everyone else the state alone.
// - Tells the owner once when a blocked login fact appears in a report, one
//   DM per fact listing the affected agents, and again only after it was gone.
//   The notice is claimed in the report's own transaction (race-safe).
// - Sums up per Computer what a person must act on (`composeReadinessAttention`)
//   for the machine list, with who can fix each (their display name).
//
// The server never enforces a daemon-reported fact (it does not stop waking
// for one): the daemon that saw it holds the agents, and a lost "recovered"
// report must not block them here forever.

import {
  agentReadinessChain,
  composeReadiness,
  composeReadinessAttention,
  trimReadinessAttentionForViewer,
  type ReadinessAttention,
  readinessLoginKey,
  runtimeAuthRuntimeFor,
  runtimeReadinessChain,
  sameReadinessResource,
  sharedCredentialsAuthRuntime,
  trimReadinessForViewer,
  type ComputerReadiness,
  type Readiness,
  type ReadinessFact,
  type RuntimeConfigHydrationInput,
  type RuntimeReadinessReport,
} from "@botiverse/raft-shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents, computerOutageOccurrences, computerReadinessReports, computers, computerUpgradeRequests, machines, serverMembers, users } from "../db/schema";
import { mapWithConcurrency } from "../lib/mapWithConcurrency";

// ── Server facts ──

export interface ComputerServerFactInput {
  online: boolean;
  /** Epoch ms of the last heartbeat. */
  lastSeenAtMs: number | null;
  /**
   * While offline, the Computer outage machinery's open occurrence
   * (computerOutageNotificationService): `pending` inside its 60 s dwell,
   * `notified` once the owner was told `computer.offline`; null when there is
   * none (a planned stop / restart / upgrade or a shutdown, which it does not
   * count as an outage). `managed: false` (a legacy daemon, or a revoked
   * Computer) has no outage machinery: offline is offline.
   */
  outage: { state: "pending" | "notified"; sinceMs: number } | null;
  /**
   * The upgrade the server sent it and that is still open
   * (computer_upgrade_requests, outcome null): while it is offline before
   * the request's deadline it is updating. Null when none.
   */
  upgrade: { requestedAtMs: number; deadlineAtMs: number } | null;
  managed: boolean;
  /** Below the version floor while it is enforced (isMachineAgentWorkHeld / versionGate.enforced). */
  versionHeld: boolean;
  /** Raft Desktop's bundled Computer (installKind `electron`): its copy says to update Raft Desktop. */
  managedByDesktop: boolean;
  /**
   * The runtimes the Computer has, when its detection confirmed them
   * (`runtimeDetection.status === "complete"`); null otherwise. A Computer
   * that never reports detection is unknown, never missing (Archer #5).
   */
  confirmedRuntimes: readonly string[] | null;
}

/** A planned restart that has not come back this long after the last heartbeat is offline. */
export const COMPUTER_RESTART_GRACE_MS = 5 * 60_000;

/** The facts the server itself sees about one Computer, for the runtimes its agents need. */
export function serverFactsForComputer(input: ComputerServerFactInput, neededRuntimes: Iterable<string>, nowMs: number): ReadinessFact[] {
  if (!input.online) {
    // An offline Computer: nothing else about it is current. Read from the
    // outage machinery, so readiness and its `computer.offline` notice agree.
    const computer = { kind: "computer" } as const;
    const lastSeen = input.lastSeenAtMs ?? nowMs;
    const offline = (since: number): ReadinessFact[] => [{ resource: computer, code: "computer_offline", behaviour: "blocked", since }];
    if (!input.managed) return offline(lastSeen);
    // The owner was told it is offline: that wins over a planned stop.
    if (input.outage?.state === "notified") return offline(input.outage.sinceMs);
    // The upgrade the server sent it is running, until the request's
    // deadline; past it (not settled yet), offline.
    if (input.upgrade) {
      if (nowMs >= input.upgrade.deadlineAtMs) return offline(lastSeen);
      return [{ resource: computer, code: "computer_updating", behaviour: "waiting", since: input.upgrade.requestedAtMs, until: input.upgrade.deadlineAtMs }];
    }
    if (input.outage?.state === "pending") return [{ resource: computer, code: "computer_reconnecting", behaviour: "advisory", since: input.outage.sinceMs }];
    // A planned stop / restart: restarting for 5 min after the last heartbeat, then offline since then.
    if (nowMs - lastSeen >= COMPUTER_RESTART_GRACE_MS) return offline(lastSeen);
    return [{ resource: computer, code: "computer_restarting", behaviour: "waiting", since: lastSeen }];
  }
  const facts: ReadinessFact[] = [];
  if (input.versionHeld) {
    facts.push({ resource: { kind: "computer" }, code: "computer_too_old", behaviour: "blocked", since: nowMs, params: { managedByDesktop: input.managedByDesktop } });
  }
  if (input.confirmedRuntimes) {
    const present = new Set(input.confirmedRuntimes);
    for (const runtime of new Set(neededRuntimes)) {
      if (!present.has(runtime)) facts.push({ resource: { kind: "runtime", runtime }, code: "runtime_missing", behaviour: "blocked", since: nowMs });
    }
  }
  return facts;
}

// ── Composition ──

export type ReadinessAgentInput = RuntimeConfigHydrationInput & { id: string; runtime: string };

/** The login an agent depends on: its Computer's machine login for its runtime, else its own (the daemon's rule). */
export function agentLoginKey(agent: ReadinessAgentInput): string {
  return readinessLoginKey(agent.id, sharedCredentialsAuthRuntime(agent));
}

export function composeAgentReadiness(agent: ReadinessAgentInput, facts: readonly ReadinessFact[], nowMs: number): Readiness {
  return composeReadiness(facts, agentReadinessChain({ agentId: agent.id, runtime: agent.runtime, loginKey: agentLoginKey(agent), model: agent.model }), nowMs);
}

/** A Computer's own readiness and each listed runtime's (Computer → runtime → its machine login). */
export function composeComputerReadiness(runtimes: readonly string[], facts: readonly ReadinessFact[], nowMs: number): ComputerReadiness {
  const own = composeReadiness(facts, [{ kind: "server" }, { kind: "computer" }], nowMs);
  const perRuntime: Record<string, Readiness> = {};
  for (const runtime of runtimes) {
    const authRuntime = runtimeAuthRuntimeFor(runtime);
    perRuntime[runtime] = composeReadiness(facts, runtimeReadinessChain(runtime, authRuntime ? `shared:${authRuntime}` : null), nowMs);
  }
  return { ...own, runtimes: perRuntime };
}

/**
 * Tenny #1: who sees the reason. The Computer's owner (its recorded owner, or
 * whoever connected it), the agent's owner, and the server's admins.
 */
export function canSeeReadinessReason(input: {
  viewerUserId: string;
  viewerIsServerAdmin: boolean;
  computerOwnerUserIds: ReadonlyArray<string | null | undefined>;
  agentOwnerUserId?: string | null;
}): boolean {
  if (input.viewerIsServerAdmin) return true;
  if (input.agentOwnerUserId && input.agentOwnerUserId === input.viewerUserId) return true;
  return input.computerOwnerUserIds.some((id) => id === input.viewerUserId);
}

export function trimComputerReadinessForViewer(readiness: ComputerReadiness, canSeeReason: boolean): ComputerReadiness {
  if (canSeeReason) return readiness;
  const runtimes: Record<string, Readiness> = {};
  for (const [runtime, each] of Object.entries(readiness.runtimes)) runtimes[runtime] = trimReadinessForViewer(each, false);
  return { ...trimReadinessForViewer(readiness, false), runtimes };
}

// ── Storage ──

/**
 * Store `report` as the Computer's latest unless one with the same or a
 * higher `seq` is already stored, and claim the notices it brings, in one
 * transaction on the Computer's row: the blocked login facts that just
 * appeared and were not told within READINESS_RENOTIFY_AFTER_MS
 * (readinessFactsToNotify) are marked told at `receivedAt` before the row is
 * released, so two reports racing never both tell the owner. A claim nobody
 * could be told about is given back (releaseReadinessNotices). Returns the
 * facts it replaced and the facts to tell now, or null when the report was dropped.
 */
export async function storeRuntimeReadinessReport(
  machineId: string,
  report: RuntimeReadinessReport,
  receivedAt: Date,
  executor: DatabaseExecutor = getDb(),
): Promise<{ previous: ReadinessFact[]; toNotify: ReadinessFact[] } | null> {
  return executor.transaction(async (tx) => {
    // The row exists before it is locked, so a first report and a racing
    // second one serialize on it too (seq 0: any real report is above it).
    await tx.insert(computerReadinessReports)
      .values({ machineId, seq: 0, facts: [], receivedAt })
      .onConflictDoNothing({ target: computerReadinessReports.machineId });
    const [current] = await tx.select({ seq: computerReadinessReports.seq, facts: computerReadinessReports.facts, notified: computerReadinessReports.notified })
      .from(computerReadinessReports)
      .where(eq(computerReadinessReports.machineId, machineId))
      .for("update");
    if (!current || report.seq <= current.seq) return null;
    const previous = Array.isArray(current.facts) ? current.facts : [];
    const toNotify = readinessFactsToNotify(previous, report.facts, current.notified ?? {}, receivedAt.getTime());
    const claimed = Object.fromEntries(toNotify.map((fact) => [readinessNoticeKey(fact)!, receivedAt.getTime()]));
    await tx.update(computerReadinessReports)
      .set({ seq: report.seq, facts: report.facts, receivedAt, notified: pruneReadinessNotified({ ...(current.notified ?? {}), ...claimed }, receivedAt.getTime()) })
      .where(eq(computerReadinessReports.machineId, machineId));
    return { previous, toNotify };
  });
}

/** The stored daemon facts of each Computer (none: no report yet). */
export async function loadRuntimeReadinessFacts(machineIds: readonly string[], executor: DatabaseExecutor = getDb()): Promise<Map<string, ReadinessFact[]>> {
  const byMachine = new Map<string, ReadinessFact[]>();
  if (machineIds.length === 0) return byMachine;
  const rows = await executor.select({ machineId: computerReadinessReports.machineId, facts: computerReadinessReports.facts })
    .from(computerReadinessReports)
    .where(inArray(computerReadinessReports.machineId, [...new Set(machineIds)]));
  for (const row of rows) byMachine.set(row.machineId, Array.isArray(row.facts) ? row.facts : []);
  return byMachine;
}

// ── Notice: appear → tell the owner once → close on recovery ──

/**
 * The blocked facts of `next` that `previous` did not have (same resource and
 * code). A fact that stays is not news; one that went away and comes back is.
 */
export function newlyBlockedFacts(previous: readonly ReadinessFact[], next: readonly ReadinessFact[]): ReadinessFact[] {
  return next.filter((fact) => fact.behaviour === "blocked"
    && !previous.some((before) => before.code === fact.code && sameReadinessResource(before.resource, fact.resource)));
}

/** How long a (login key, code) told to its owner is not told again. */
export const READINESS_RENOTIFY_AFTER_MS = 24 * 60 * 60_000;

/**
 * The codes the owner is told about: those the notice has copy for
 * (agentReadinessBlockedNoticeText). Any other code, known or not, is shown
 * but never sent as a DM, so a report full of made-up codes tells nobody.
 */
export const READINESS_NOTICE_CODES: ReadonlySet<string> = new Set(["verification_required"]);

/** At most this many (login key, code) are remembered per Computer; older first out. */
export const READINESS_NOTIFIED_MAX_KEYS = 100;

/**
 * The remembered notices worth keeping: those told within
 * READINESS_RENOTIFY_AFTER_MS (an older one no longer holds a notice back),
 * at most READINESS_NOTIFIED_MAX_KEYS of them, newest first.
 */
export function pruneReadinessNotified(notified: Readonly<Record<string, number>>, nowMs: number): Record<string, number> {
  return Object.fromEntries(Object.entries(notified)
    .filter(([, at]) => typeof at === "number" && nowMs - at < READINESS_RENOTIFY_AFTER_MS)
    .sort(([, a], [, b]) => b - a)
    .slice(0, READINESS_NOTIFIED_MAX_KEYS));
}

/** The notice identity of a fact: its login key and code. */
export function readinessNoticeKey(fact: ReadinessFact): string | null {
  return fact.resource.kind === "login" ? `${fact.resource.key}|${fact.code}` : null;
}

/**
 * What to tell now: the blocked login facts that just appeared and were not
 * told within READINESS_RENOTIFY_AFTER_MS. A person's Retry ends a hold and,
 * while the account is still not verified, the next call brings it back:
 * that must not tell the owner again. The rule is the window alone (the
 * server is not told why a fact went away); a fact that comes back a day
 * later is told again.
 */
export function readinessFactsToNotify(
  previous: readonly ReadinessFact[],
  next: readonly ReadinessFact[],
  notified: Readonly<Record<string, number>>,
  nowMs: number,
): ReadinessFact[] {
  return newlyBlockedFacts(previous, next).filter((fact) => {
    if (!READINESS_NOTICE_CODES.has(fact.code)) return false;
    const key = readinessNoticeKey(fact);
    if (!key) return false;
    const last = notified[key];
    return typeof last !== "number" || nowMs - last >= READINESS_RENOTIFY_AFTER_MS;
  });
}

/**
 * Give back notices claimed at `claimedAtMs` that nobody was told (no one to
 * tell, or the post failed): only while the claim is still that one, so a
 * later report's claim stays.
 */
export async function releaseReadinessNotices(machineId: string, keys: readonly string[], claimedAtMs: number, executor: DatabaseExecutor = getDb()): Promise<void> {
  for (const key of keys) {
    await executor.update(computerReadinessReports)
      .set({ notified: sql`${computerReadinessReports.notified} - ${key}::text` })
      .where(and(eq(computerReadinessReports.machineId, machineId), sql`${computerReadinessReports.notified} ->> ${key}::text = ${String(claimedAtMs)}::text`));
  }
}

/**
 * Who is told about a login fact, and about which agents: the agents on the
 * Computer whose chain has that login; a machine login's to the Computer's
 * owner, an agent's own login's to that agent's owner. Null when nobody can
 * be: a key no agent bound to this Computer uses (an `agent:<id>` of an agent
 * elsewhere, a made-up `shared:` runtime) tells nobody.
 */
export function readinessNoticePlan(
  fact: ReadinessFact,
  agents: ReadonlyArray<ReadinessAgentInput & { name: string; ownerUserId: string | null }>,
  computerOwnerUserId: string | null,
): { recipientUserId: string; agents: Array<{ id: string; name: string }> } | null {
  if (fact.resource.kind !== "login") return null;
  const key = fact.resource.key;
  const affected = agents.filter((agent) => agentLoginKey(agent) === key);
  if (affected.length === 0) return null;
  const recipientUserId = key.startsWith("shared:") ? computerOwnerUserId : affected[0]!.ownerUserId;
  if (!recipientUserId) return null;
  return { recipientUserId, agents: affected.map(({ id, name }) => ({ id, name })) };
}

// ── Read side: one Computer's inputs, then per agent and viewer ──

export interface ComputerReadinessInputs {
  server: ComputerServerFactInput;
  /** The Computer's recorded owner and whoever connected it: both see its reasons. */
  ownerUserIds: Array<string | null>;
  /** Who fixes the Computer's problems (its recorded owner, else whoever connected it): their server member display name. */
  ownerName: string | null;
  /** The stored daemon facts (its logins). */
  daemonFacts: ReadinessFact[];
}

/**
 * Everything composition needs about each Computer, read once per list.
 * `versionHeld`: the caller's already-checked set (agent list), else asked.
 */
export async function loadComputerReadinessInputs(
  machineIds: readonly string[],
  orchestrator: { getMachineStatus(machineId: string): Promise<"online" | "offline">; getMachineRuntimeDetection(machineId: string): Promise<{ status: string } | null>; isMachineAgentWorkHeld(machineId: string): Promise<boolean> },
  versionHeld?: ReadonlySet<string>,
  executor: DatabaseExecutor = getDb(),
): Promise<Map<string, ComputerReadinessInputs>> {
  const ids = [...new Set(machineIds)];
  const result = new Map<string, ComputerReadinessInputs>();
  if (ids.length === 0) return result;
  const [rows, daemonFacts, managedRows, outageRows, upgradeRows] = await Promise.all([
    executor.select({
      id: machines.id,
      serverId: machines.serverId,
      userId: machines.userId,
      ownerUserId: machines.ownerUserId,
      lastHeartbeat: machines.lastHeartbeat,
      runtimes: machines.runtimes,
      installKind: machines.installKind,
    }).from(machines).where(inArray(machines.id, ids)),
    loadRuntimeReadinessFacts(ids, executor),
    executor.select({ machineId: computers.machineId }).from(computers)
      .where(and(inArray(computers.machineId, ids), isNull(computers.revokedAt))),
    executor.select({ machineId: computerOutageOccurrences.machineId, state: computerOutageOccurrences.state, firstOfflineAt: computerOutageOccurrences.firstOfflineAt })
      .from(computerOutageOccurrences)
      .where(and(inArray(computerOutageOccurrences.machineId, ids), inArray(computerOutageOccurrences.state, ["pending", "notified"]))),
    executor.select({ machineId: computerUpgradeRequests.machineId, requestedAt: computerUpgradeRequests.requestedAt, deadlineAt: computerUpgradeRequests.deadlineAt })
      .from(computerUpgradeRequests)
      .where(and(inArray(computerUpgradeRequests.machineId, ids), isNull(computerUpgradeRequests.outcome))),
  ]);
  const upgrades = new Map<string, { requestedAtMs: number; deadlineAtMs: number }>();
  for (const row of upgradeRows) {
    const current = upgrades.get(row.machineId);
    if (!current || row.requestedAt.getTime() > current.requestedAtMs) upgrades.set(row.machineId, { requestedAtMs: row.requestedAt.getTime(), deadlineAtMs: row.deadlineAt.getTime() });
  }
  const names = new Map<string, string>();
  for (const [serverId, owners] of groupBy(rows, (row) => row.serverId, (row) => row.ownerUserId ?? row.userId)) {
    for (const [id, name] of await loadMemberDisplayNames(serverId, owners, executor)) names.set(id, name);
  }
  const managed = new Set(managedRows.map((row) => row.machineId));
  const outages = new Map(outageRows.map((row) => [row.machineId, { state: row.state as "pending" | "notified", sinceMs: row.firstOfflineAt.getTime() }]));
  await mapWithConcurrency(rows, 16, async (row) => {
    const [status, detection, held] = await Promise.all([
      orchestrator.getMachineStatus(row.id),
      orchestrator.getMachineRuntimeDetection(row.id).catch(() => null),
      versionHeld ? Promise.resolve(versionHeld.has(row.id)) : orchestrator.isMachineAgentWorkHeld(row.id).catch(() => false),
    ]);
    result.set(row.id, {
      server: {
        online: status === "online",
        lastSeenAtMs: row.lastHeartbeat?.getTime() ?? null,
        outage: outages.get(row.id) ?? null,
        upgrade: upgrades.get(row.id) ?? null,
        managed: managed.has(row.id),
        versionHeld: held,
        managedByDesktop: row.installKind === "electron",
        confirmedRuntimes: detection?.status === "complete" ? row.runtimes ?? [] : null,
      },
      ownerUserIds: [row.ownerUserId, row.userId],
      ownerName: names.get(row.ownerUserId ?? row.userId) ?? null,
      daemonFacts: daemonFacts.get(row.id) ?? [],
    });
  });
  return result;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string, value: (item: T) => string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), value(item)]);
  return out;
}

/**
 * Display names of these users as members of `serverId` (display name, else
 * name): who can fix a problem, shown to viewers who may not see the reason.
 * Never an email or any other account field; a non-member has none.
 */
export async function loadMemberDisplayNames(serverId: string, userIds: ReadonlyArray<string | null | undefined>, executor: DatabaseExecutor = getDb()): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const rows = await executor.select({ id: users.id, name: users.name, displayName: users.displayName })
    .from(serverMembers)
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .where(and(eq(serverMembers.serverId, serverId), inArray(serverMembers.userId, ids)));
  for (const row of rows) names.set(row.id, row.displayName || row.name);
  return names;
}

export type ReadinessOwnedAgent = ReadinessAgentInput & { creatorType?: string | null; creatorId?: string | null; assistantOwnerUserId?: string | null };

/** An agent's owner: a personal assistant's person, else the person who created it. */
export function readinessAgentOwnerUserId(agent: ReadinessOwnedAgent): string | null {
  return agent.assistantOwnerUserId ?? (agent.creatorType === "user" ? agent.creatorId ?? null : null);
}

/**
 * Who reads readiness. `isGuest`: a server guest (role `guest`) gets who
 * fixes it (`actor`) and how (`action`), never their name (Tenny, #14587
 * follow-up): a guest is outside the server and should not learn who owns
 * which Computer.
 */
export interface ReadinessViewer {
  userId: string;
  isServerAdmin: boolean;
  isGuest?: boolean;
}

/** The readiness viewer for a server role (`getActorServerRoleInServer`). */
export function readinessViewerForRole(userId: string, role: string | null | undefined): ReadinessViewer {
  return { userId, isServerAdmin: role === "owner" || role === "admin", isGuest: role === "guest" };
}

/** Who fixes a composed readiness, by name: the Computer's owner, or the agent's owner. None for a guest. */
function withActorName<T extends { actor: Readiness["actor"] }>(value: T, viewer: ReadinessViewer, computerOwnerName: string | null, agentOwnerName: string | null | undefined): T & { actorName?: string } {
  if (viewer.isGuest) return value;
  const name = value.actor === "computer_owner" ? computerOwnerName : value.actor === "agent_owner" ? agentOwnerName ?? null : null;
  return name ? { ...value, actorName: name } : value;
}

/** One agent's readiness as `viewer` may see it. `agentOwnerName`: its owner's member display name, when known. */
export function agentReadinessForViewer(
  agent: ReadinessOwnedAgent,
  computer: ComputerReadinessInputs,
  viewer: ReadinessViewer,
  nowMs: number,
  agentOwnerName?: string | null,
): Readiness {
  const facts = [...serverFactsForComputer(computer.server, [agent.runtime], nowMs), ...computer.daemonFacts];
  const composed = composeAgentReadiness(agent, facts, nowMs);
  const readiness = composed.state === "blocked" || composed.state === "waiting" ? withActorName(composed, viewer, computer.ownerName, agentOwnerName) : composed;
  const agentOwnerUserId = readinessAgentOwnerUserId(agent);
  return trimReadinessForViewer(readiness, canSeeReadinessReason({
    viewerUserId: viewer.userId,
    viewerIsServerAdmin: viewer.isServerAdmin,
    computerOwnerUserIds: computer.ownerUserIds,
    agentOwnerUserId,
  }));
}

/** A Computer's readiness (itself and each of its runtimes) as `viewer` may see it. */
export function computerReadinessForViewer(
  runtimes: readonly string[],
  computer: ComputerReadinessInputs,
  viewer: ReadinessViewer,
  nowMs: number,
): ComputerReadiness {
  const facts = [...serverFactsForComputer(computer.server, [], nowMs), ...computer.daemonFacts];
  const composed = composeComputerReadiness(runtimes, facts, nowMs);
  const name = (each: Readiness) => (each.state === "blocked" || each.state === "waiting" ? withActorName(each, viewer, computer.ownerName, null) : each);
  const named: ComputerReadiness = { ...name(composed), runtimes: Object.fromEntries(Object.entries(composed.runtimes).map(([runtime, each]) => [runtime, name(each)])) };
  return trimComputerReadinessForViewer(named, canSeeReadinessReason({
    viewerUserId: viewer.userId,
    viewerIsServerAdmin: viewer.isServerAdmin,
    computerOwnerUserIds: computer.ownerUserIds,
  }));
}

// ── Needs attention (the machine list) ──

/** The agents on these Computers (not deleted), for the needs-attention summary. */
export async function loadReadinessAgentsByMachine(machineIds: readonly string[], executor: DatabaseExecutor = getDb()): Promise<Map<string, ReadinessOwnedAgent[]>> {
  const byMachine = new Map<string, ReadinessOwnedAgent[]>();
  if (machineIds.length === 0) return byMachine;
  const rows = await executor.select({
    id: agents.id,
    machineId: agents.machineId,
    runtime: agents.runtime,
    model: agents.model,
    runtimeConfig: agents.runtimeConfig,
    reasoningEffort: agents.reasoningEffort,
    envVars: agents.envVars,
    creatorType: agents.creatorType,
    creatorId: agents.creatorId,
    assistantOwnerUserId: agents.assistantOwnerUserId,
  }).from(agents).where(and(inArray(agents.machineId, [...new Set(machineIds)]), isNull(agents.deletedAt)));
  for (const { machineId, ...agent } of rows) {
    if (!machineId) continue;
    byMachine.set(machineId, [...(byMachine.get(machineId) ?? []), agent]);
  }
  return byMachine;
}

/**
 * A Computer's "needs attention" as `viewer` may see it: what a person must
 * act on (composeReadinessAttention), each with who fixes it by name. A
 * viewer who may not see the Computer's reasons keeps the count and the names.
 */
export function computerAttentionForViewer(
  computer: ComputerReadinessInputs,
  computerAgents: readonly ReadinessOwnedAgent[],
  update: "available" | "required" | null,
  viewer: ReadinessViewer,
  nowMs: number,
  agentOwnerNames: ReadonlyMap<string, string> = new Map(),
): ReadinessAttention {
  const facts = [...serverFactsForComputer(computer.server, computerAgents.map((agent) => agent.runtime), nowMs), ...computer.daemonFacts];
  const attention = composeReadinessAttention({
    facts,
    agents: computerAgents.map((agent) => ({ id: agent.id, chain: agentReadinessChain({ agentId: agent.id, runtime: agent.runtime, loginKey: agentLoginKey(agent), model: agent.model }) })),
    update,
    nowMs,
  });
  const byId = new Map(computerAgents.map((agent) => [agent.id, agent]));
  const named = {
    ...attention,
    items: attention.items.map((item) => {
      const owner = item.actor === "agent_owner" ? byId.get(item.agentIds?.[0] ?? "") : undefined;
      return withActorName(item, viewer, computer.ownerName, owner ? agentOwnerNames.get(readinessAgentOwnerUserId(owner) ?? "") : null);
    }),
  };
  return trimReadinessAttentionForViewer(named, canSeeReadinessReason({
    viewerUserId: viewer.userId,
    viewerIsServerAdmin: viewer.isServerAdmin,
    computerOwnerUserIds: computer.ownerUserIds,
  }));
}
