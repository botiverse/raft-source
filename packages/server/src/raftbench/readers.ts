import { createHash } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { asServerId, type RaftbenchFindingsQuery, type RaftbenchFindingsResponse } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, raftbenchConfigs, raftbenchReaderGrants, serverAgentMembers, serverMembers, serverMemberRoleAuditEvents } from "../db/schema";
import { filterAgentAccessibleChannelIds } from "../services/channelService";
import { requireAdmin } from "./controls";
import { assertLiveSources, RaftbenchError, requirePilot } from "./service";
import { listFindings } from "./findings";

function refuse(code: string, message: string): never { throw new RaftbenchError(403, code, message, "Ask this server's administrator to review your RaftBench access. Do not retry another agent's identity."); };

// The reader's own refusals. An SDK caller sees only the code and the next
// action (the message is replaced by a generic sentence), so each next action
// names what this agent can do: read again, or tell the person who asked.
// Retrying, another identity, or the service run's steps (stop the run, read
// context) never help a reader.
const READER_NOT_ALLOWED_NEXT = "A server owner or administrator has to allow this agent in RaftBench settings. Tell the person who asked; retrying, or using another agent's identity, will not help.";
function readerNotAllowed(message: string): never { throw new RaftbenchError(403, "raftbench_reader_not_authorized", message, READER_NOT_ALLOWED_NEXT); }
function analysisOff(): never {
  throw new RaftbenchError(403, "raftbench_disabled", "RaftBench analysis is turned off on this server.", "Tell the person who asked that RaftBench analysis is turned off on this server; an administrator has to turn it on. Retrying will not help until then.");
}
function findingsChanged(message: string): never { throw new RaftbenchError(409, "raftbench_findings_changed", message, "Read the first page again without a cursor."); }
/** Run an analysis-side check (pilot, configuring administrator, sources) and refuse in the reader's terms. */
async function analysisCheck<T>(check: () => T | Promise<T>): Promise<T> {
  try { return await check(); }
  catch (error) {
    if (!(error instanceof RaftbenchError)) throw error;
    if (error.code === "raftbench_server_not_allowed") throw new RaftbenchError(error.status, error.code, error.message, "RaftBench is not available on this server. Tell the person who asked; retrying will not help.");
    if (error.code === "raftbench_disabled") analysisOff();
    throw new RaftbenchError(409, "raftbench_findings_unavailable", "RaftBench analysis settings changed (its administrator, service agent or source channels) and need an administrator's review.", "Tell the person who asked that an administrator needs to review the RaftBench settings. Retrying will not help until then.");
  }
}
async function currentGrant(serverId: string, agentId: string) {
  const db = getDb();
  const [grant] = await db.select().from(raftbenchReaderGrants).where(and(eq(raftbenchReaderGrants.serverId, serverId), eq(raftbenchReaderGrants.agentId, agentId))).orderBy(desc(raftbenchReaderGrants.seq)).limit(1);
  if (!grant?.enabled) return null;
  const [member] = await db.select().from(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, grant.grantedBy)));
  const [agent] = await db.select({ joinedAt: serverAgentMembers.joinedAt }).from(serverAgentMembers).innerJoin(agents, eq(agents.id, serverAgentMembers.agentId)).where(and(eq(serverAgentMembers.serverId, serverId), eq(agents.id, agentId), isNull(agents.deletedAt)));
  if (!member || !["owner", "admin"].includes(member.role) || !agent || member.joinedAt > grant.createdAt || agent.joinedAt > grant.createdAt) return null;
  const [demotion] = await db.select({ id: serverMemberRoleAuditEvents.id }).from(serverMemberRoleAuditEvents).where(and(eq(serverMemberRoleAuditEvents.serverId, serverId), eq(serverMemberRoleAuditEvents.targetUserId, grant.grantedBy), gt(serverMemberRoleAuditEvents.createdAt, grant.createdAt), inArray(serverMemberRoleAuditEvents.nextRole, ["member", "guest"]))).limit(1);
  return demotion ? null : grant;
}

/** Tool discovery hint only. The findings endpoint always rechecks authority. */
export async function hasRaftbenchReaderGrant(serverId: string, agentId: string): Promise<boolean> {
  try {
    requirePilot(serverId);
    if (!await currentGrant(serverId, agentId)) return false;
    const [config] = await getDb().select().from(raftbenchConfigs).where(eq(raftbenchConfigs.serverId, serverId));
    if (!config?.enabled || !config.agentId || config.agentId === agentId) return false;
    await requireAdmin(serverId, config.configuredByUserId);
    return true;
  } catch (error) {
    if (error instanceof RaftbenchError && error.status === 403) return false;
    console.warn("RaftBench reader discovery unavailable; omitting optional tool hint");
    return false;
  }
}

export async function setReaderGrant(serverId: string, userId: string, agentId: string, enabled: boolean) {
  await requireAdmin(serverId, userId, enabled);
  await getDb().transaction(async tx => {
    // Serialize decisions with configuration changes and fence the human role.
    const [config] = await tx.select().from(raftbenchConfigs).where(eq(raftbenchConfigs.serverId, serverId)).for("update");
    const [human] = await tx.select().from(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId))).for("share");
    const [agent] = await tx.select().from(serverAgentMembers).where(and(eq(serverAgentMembers.serverId, serverId), eq(serverAgentMembers.agentId, agentId))).for("share");
    const [liveAgent] = await tx.select().from(agents).where(and(eq(agents.id, agentId), isNull(agents.deletedAt)));
    if (!config || !human || !["owner", "admin"].includes(human.role) || !agent || !liveAgent) refuse("raftbench_grant_unavailable", "The server, administrator or selected agent is no longer available.");
    if (enabled && (!config.enabled || config.agentId === agentId)) refuse("raftbench_grant_unavailable", "Enable analysis and select a conversational agent, not the background service agent.");
    await tx.insert(raftbenchReaderGrants).values({ serverId, agentId, grantedBy: userId, enabled });
  });
}

export async function listReaderGrants(serverId: string, userId: string) {
  await requireAdmin(serverId, userId, false);
  const [config] = await getDb().select().from(raftbenchConfigs).where(eq(raftbenchConfigs.serverId, serverId));
  const members = await getDb().select({ agentId: agents.id, name: agents.name, displayName: agents.displayName }).from(serverAgentMembers).innerJoin(agents, eq(agents.id, serverAgentMembers.agentId)).where(and(eq(serverAgentMembers.serverId, serverId), isNull(agents.deletedAt)));
  const result = [];
  for (const member of members) {
    if (member.agentId === config?.agentId) continue;
    const grant = await currentGrant(serverId, member.agentId);
    result.push({ ...member, enabled: !!grant, grantedBy: grant?.grantedBy ?? null, changedAt: grant?.createdAt.toISOString() ?? null });
  }
  return result;
}

const cursorSchema = z.object({ version: z.string(), page: z.number().int().min(1).max(1_000_000) }).strict();
export async function readFindings(serverId: string, agentId: string, query: RaftbenchFindingsQuery): Promise<RaftbenchFindingsResponse> {
  await analysisCheck(() => requirePilot(serverId));
  const grant = await currentGrant(serverId, agentId);
  if (!grant) readerNotAllowed("This agent does not have a current RaftBench reader grant.");
  const [config] = await getDb().select().from(raftbenchConfigs).where(eq(raftbenchConfigs.serverId, serverId));
  if (!config?.enabled || !config.agentId) analysisOff();
  const serviceAgentId = config.agentId;
  await analysisCheck(() => requireAdmin(serverId, config.configuredByUserId));
  const sources = await analysisCheck(() => assertLiveSources(config, serviceAgentId));
  const visible = [...await filterAgentAccessibleChannelIds(sources.map(source => source.localId), agentId, asServerId(serverId))];
  const version = createHash("sha256").update(JSON.stringify([serverId, agentId, grant.seq, config.revision, visible.sort(), query.kind, query.channelId, query.period, query.limit])).digest("hex");
  let page = 1;
  if (query.cursor) {
    let parsed;
    try { parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"))); } catch { parsed = null; }
    if (!parsed?.success || parsed.data.version !== version) throw new RaftbenchError(409, "raftbench_cursor_stale", "The cursor no longer matches the grant, source scope or filters.", "Read the first page again without a cursor.");
    page = parsed.data.page;
  }
  const result = await listFindings(serverId, config.revision, sources, page, getDb(), query, false, { channelIds: visible, pageSize: query.limit });
  const [latest] = await getDb().select().from(raftbenchConfigs).where(eq(raftbenchConfigs.serverId, serverId));
  const current = await currentGrant(serverId, agentId);
  if (!current) readerNotAllowed("RaftBench access was withdrawn while reading.");
  if (!latest?.enabled) analysisOff();
  if (current.seq !== grant.seq || latest.revision !== config.revision) findingsChanged("RaftBench access or analysis changed while reading.");
  await analysisCheck(() => requireAdmin(serverId, latest.configuredByUserId));
  // Recheck live channel authority before returning derived text.
  const stillVisible = await filterAgentAccessibleChannelIds(visible, agentId, asServerId(serverId));
  if (visible.some(id => !stillVisible.has(id))) findingsChanged("This agent's channel access changed while reading.");
  return { revision: config.revision, findings: result.records.map(row => ({ id: row.id, evidenceAt: row.evidenceAt, pattern: row.pattern })), total: result.total,
    nextCursor: page < result.pageCount ? Buffer.from(JSON.stringify({ version, page: page + 1 })).toString("base64url") : null,
    coverage: { historyFrom: config.historyFrom?.toISOString() ?? null, scannedThroughAt: config.scannedThroughAt?.toISOString() ?? null, note: "Only findings whose every source is currently accessible are included. Zero findings does not mean zero issues. Historical findings do not establish current status." } };
}
