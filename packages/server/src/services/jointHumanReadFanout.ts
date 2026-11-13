import { sql } from "drizzle-orm";
import { asChannelId, asServerId, type Brand, type ChannelId, type ServerId } from "@botiverse/raft-shared";
import type { DatabaseTransaction } from "../db";
import { safeAddTraceEvent } from "../tracing/semanticTrace";
import {
  filterJointHumanMemberEntries, jointEntryIdentitySql, resolveJointHumanMembershipScopes,
  type JointHumanMembershipId,
} from "./jointHumanMembershipAccess";
import type { ReadMutationAck, ReadMutationBoundary, ReadMutationClaim } from "./readMutationSequencer";

export const JOINT_READ_MAX_ENTRIES = 16;
type ScopeState = ReadMutationAck["scopes"][number];
type Target = {
  originScopeId: ChannelId;
  scopeId: ChannelId;
  serverId: ServerId;
  storageScopeId: ChannelId;
  rootScopeId: ChannelId;
  rootJointId: JointHumanMembershipId;
};
/** Frozen projection candidates, with identity/resource locks taken before J membership. */
export type JointReadFanoutPreparation = Brand<readonly Target[], "JointReadFanoutPreparation">;
export type JointReadFanoutPlan = {
  groups: ReadonlyMap<string, readonly Target[]>;
  effectiveBoundary: ReadMutationBoundary[];
};
export type JointReadFanoutUpdate = ScopeState & { serverId: ServerId };

const ids = (values: readonly string[]) => sql`${sql.param([...new Set(values)])}::uuid[]`;

/**
 * Called BEFORE the executor's server/authority/resource locks. In particular,
 * a first cursor insert takes a channel FK lock: taking another entry's channel
 * after JCM would deadlock with its remove-member writer (channel -> JCM).
 * Discovery grants no access; execution rechecks the frozen candidates later.
 */
export async function prepareJointReadFanout(
  tx: DatabaseTransaction,
  claim: ReadMutationClaim,
): Promise<JointReadFanoutPreparation> {
  const empty = () => [] as unknown as JointReadFanoutPreparation;
  if (claim.principalKind !== "human") return empty();
  const source = await tx.execute<{
    originScopeId: string; storageScopeId: string; jointId: string; rootJointId: string;
  }>(sql`
    SELECT p.local_channel_id AS "originScopeId", j.canonical_channel_id AS "storageScopeId",
           j.id AS "jointId", root.id AS "rootJointId"
    FROM joint_channel_servers p
    JOIN channels c ON c.id=p.local_channel_id AND c.server_id=p.server_id AND c.deleted_at IS NULL
    JOIN joint_channels j ON j.id=p.joint_channel_id AND j.status='active'
    JOIN channels storage ON storage.id=j.canonical_channel_id AND storage.deleted_at IS NULL
    JOIN joint_channels root ON root.canonical_channel_id = CASE
      WHEN c.type IN ('thread','task') THEN storage.parent_channel_id ELSE storage.id END
      AND root.status='active'
    JOIN joint_channel_servers root_entry ON root_entry.joint_channel_id=root.id
      AND root_entry.server_id=p.server_id AND root_entry.status='active'
    WHERE p.server_id=${claim.serverId}::uuid AND p.status='active'
      AND EXISTS (SELECT 1 FROM joint_channel_members m
        WHERE m.joint_channel_id=root.id AND m.user_id=${claim.principalId}::uuid)
      AND CASE
        WHEN ${claim.kind === "global_read_all"} THEN c.type='joint' OR (
          c.type IN ('thread','task') AND EXISTS (SELECT 1 FROM thread_follows f
            WHERE f.thread_channel_id=c.id AND f.follower_type='user' AND f.follower_id=${claim.principalId}::uuid
              AND f.done_at IS NULL AND f.unfollowed_at IS NULL))
        WHEN ${claim.kind === "conversation_read_all"} THEN root_entry.local_channel_id=${claim.scopeId}::uuid
          AND (c.type='joint' OR (c.type='thread' AND EXISTS (SELECT 1 FROM thread_follows f
            WHERE f.thread_channel_id=c.id AND f.follower_type='user' AND f.follower_id=${claim.principalId}::uuid
              AND f.done_at IS NULL AND f.unfollowed_at IS NULL)))
        ELSE c.id=${claim.scopeId}::uuid END
    ORDER BY p.local_channel_id
  `);
  const sources = source.rows;
  if (!sources.length) return empty();

  const roots = await tx.execute<{ rootJointId: string; scopeId: string; serverId: string }>(sql`
    SELECT p.joint_channel_id AS "rootJointId", p.local_channel_id AS "scopeId", p.server_id AS "serverId"
    FROM joint_channel_servers p
    JOIN channels c ON c.id=p.local_channel_id AND c.server_id=p.server_id AND c.type='joint' AND c.deleted_at IS NULL
    JOIN servers s ON s.id=p.server_id AND s.deleted_at IS NULL
    JOIN server_members sm ON sm.server_id=s.id AND sm.user_id=${claim.principalId}::uuid
      AND ${jointEntryIdentitySql("sm", "p", "ungated")}
    WHERE p.status='active' AND p.joint_channel_id=ANY(${ids(sources.map((row) => row.rootJointId))})
    ORDER BY p.joint_channel_id,p.server_id
  `);
  const byRoot = new Map<string, typeof roots.rows>();
  for (const row of roots.rows) byRoot.set(row.rootJointId, [...(byRoot.get(row.rootJointId) ?? []), row]);
  for (const [jointId, entries] of byRoot) {
    if (entries.length > JOINT_READ_MAX_ENTRIES) {
      byRoot.delete(jointId);
      safeAddTraceEvent("read_mutation.joint_fanout.skipped", () => ({
        joint_id: jointId, server_id: claim.serverId, reason: "entry_limit", entry_count: entries.length,
      }));
    }
  }
  const candidates = sources.filter((row) => byRoot.has(row.rootJointId));
  if (!candidates.length) return empty();
  const projections = await tx.execute<{ jointId: string; scopeId: string; serverId: string }>(sql`
    SELECT p.joint_channel_id AS "jointId",p.local_channel_id AS "scopeId",p.server_id AS "serverId"
    FROM joint_channel_servers p JOIN channels c ON c.id=p.local_channel_id
      AND c.server_id=p.server_id AND c.deleted_at IS NULL
    WHERE p.status='active' AND p.joint_channel_id=ANY(${ids(candidates.map((row) => row.jointId))})
    ORDER BY p.local_channel_id
  `);
  const targets: Target[] = candidates.flatMap((origin) => projections.rows.flatMap((p) => {
    const root = byRoot.get(origin.rootJointId)?.find((entry) => entry.serverId === p.serverId);
    if (p.jointId !== origin.jointId || !root) return [];
    return [{ originScopeId: asChannelId(origin.originScopeId), scopeId: asChannelId(p.scopeId),
      serverId: asServerId(p.serverId), storageScopeId: asChannelId(origin.storageScopeId),
      rootScopeId: asChannelId(root.scopeId), rootJointId: origin.rootJointId as JointHumanMembershipId }];
  }));
  if (!targets.length) return empty();

  const serverIds = [...new Set([claim.serverId, ...targets.map((row) => row.serverId)])].sort();
  await tx.execute(sql`SELECT id FROM servers WHERE id=ANY(${ids(serverIds)}) ORDER BY id FOR SHARE`);
  // Before ANY shared content lock: a waiting peer must not retain a KEY
  // SHARE lock that Done needs to upgrade to FOR UPDATE on canonical content.
  for (const storageId of [...new Set(targets.map((row) => row.storageScopeId))].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`joint-human-read:${claim.principalId}:${storageId}`},0))`);
  }
  // Global order channel -> server -> member -> J (removeHuman): the local
  // channel rows before the principal's member rows. A joint archive holds
  // every projection FOR UPDATE and then takes its bound Guests' member rows
  // (lockBoundJointGuestMemberships); a Guest's read taking its member row
  // first and then waiting on the channel would close a cycle (P3).
  const localIds = [...new Set(targets.flatMap((row) => [row.scopeId, row.rootScopeId]))];
  await tx.execute(sql`SELECT id FROM channels WHERE id=ANY(${ids(localIds)}) ORDER BY id FOR KEY SHARE`);
  await tx.execute(sql`SELECT server_id FROM server_members
    WHERE user_id=${claim.principalId}::uuid AND server_id=ANY(${ids(serverIds)}) ORDER BY server_id FOR SHARE`);

  // Conversion rollback takes child projections, their storage and parent
  // messages before parent joints. Match that order before ordinary resolution.
  const targetIds = targets.map((row) => row.scopeId);
  await tx.execute(sql`SELECT p.local_channel_id FROM joint_channel_servers p
    JOIN joint_channels j ON j.id=p.joint_channel_id
    JOIN channels storage ON storage.id=j.canonical_channel_id AND storage.type='thread'
    JOIN messages parent ON parent.id=storage.parent_message_id
    WHERE p.local_channel_id=ANY(${ids(targetIds)}) ORDER BY p.local_channel_id
    FOR KEY SHARE OF p,j,parent
    ${sql.raw(claim.kind === "done" ? "FOR UPDATE" : "FOR KEY SHARE")} OF storage`);
  await tx.execute(sql`SELECT p.local_channel_id FROM joint_channel_servers p
    JOIN joint_channels j ON j.id=p.joint_channel_id
    JOIN channels storage ON storage.id=j.canonical_channel_id AND storage.type='task'
    JOIN tasks task ON task.id=storage.task_id
    WHERE p.local_channel_id=ANY(${ids(targetIds)}) ORDER BY p.local_channel_id
    FOR KEY SHARE OF p,j,task
    ${sql.raw(claim.kind === "done" ? "FOR UPDATE" : "FOR KEY SHARE")} OF storage`);
  const rootIds = targets.map((row) => row.rootJointId);
  await tx.execute(sql`SELECT id FROM joint_channels WHERE id=ANY(${ids(rootIds)}) ORDER BY id FOR KEY SHARE`);
  await tx.execute(sql`SELECT local_channel_id FROM joint_channel_servers
    WHERE local_channel_id=ANY(${ids(targets.map((row) => row.rootScopeId))}) ORDER BY server_id FOR KEY SHARE`);
  // Child Done owns only its own content frontier. Upgrading the root or
  // parent metadata would also block unrelated readers and message FKs.
  const doneOnRoot = claim.kind === "done" && candidates.some((row) => row.jointId === row.rootJointId);
  await tx.execute(sql`SELECT storage.id FROM channels storage JOIN joint_channels j ON j.canonical_channel_id=storage.id
    WHERE j.id=ANY(${ids(rootIds)}) ORDER BY storage.id
    ${sql.raw(doneOnRoot ? "FOR UPDATE" : "FOR KEY SHARE")} OF storage`);
  return targets as unknown as JointReadFanoutPreparation;
}

/** Resolve eligibility again under identity/resource fences, then serialize
 * the shared conversation before locking or changing any cursor. */
export async function planJointReadFanout(
  tx: DatabaseTransaction,
  claim: ReadMutationClaim,
  preparation: JointReadFanoutPreparation,
  boundary: readonly ReadMutationBoundary[],
  residueScopeIds: ReadonlySet<string>,
): Promise<JointReadFanoutPlan> {
  const boundaryIds = new Set(boundary.filter((row) => !residueScopeIds.has(row.scopeId)).map((row) => row.scopeId));
  const candidates = preparation.filter((row) => boundaryIds.has(row.originScopeId));
  const groups = new Map<string, Target[]>();
  if (candidates.length) {
    const scopes = await resolveJointHumanMembershipScopes({ localChannelIds: candidates.map((row) => row.rootScopeId) }, tx);
    const allowed = await filterJointHumanMemberEntries([...scopes.values()], claim.principalId, tx);
    const live = await tx.execute<{ scopeId: string; storageScopeId: string }>(sql`SELECT p.local_channel_id AS "scopeId",j.canonical_channel_id AS "storageScopeId"
      FROM joint_channel_servers p JOIN joint_channels j ON j.id=p.joint_channel_id AND j.status='active'
      JOIN channels c ON c.id=p.local_channel_id AND c.server_id=p.server_id AND c.deleted_at IS NULL
      JOIN channels storage ON storage.id=j.canonical_channel_id AND storage.deleted_at IS NULL
        AND (storage.type=c.type OR (c.type='joint' AND storage.type='channel'))
      WHERE p.status='active' AND p.local_channel_id=ANY(${ids(candidates.map((row) => row.scopeId))})`);
    const liveIds = new Map(live.rows.map((row) => [row.scopeId, row.storageScopeId]));
    for (const row of candidates) {
      if (allowed.has(row.rootScopeId) && liveIds.get(row.scopeId) === row.storageScopeId) groups.set(row.originScopeId, [...(groups.get(row.originScopeId) ?? []), row]);
    }
    // An origin that lost live authority never acts for its other entries.
    for (const [origin, entries] of groups) if (!entries.some((row) => row.scopeId === origin)) groups.delete(origin);
  }
  const cursors = groups.size ? await tx.execute<{ scopeId: string; seq: number }>(sql`
    SELECT channel_id AS "scopeId",last_read_seq AS seq FROM user_channel_read_cursors
    WHERE user_id=${claim.principalId}::uuid AND channel_id=ANY(${ids([...groups.values()].flat().map((row) => row.scopeId))})
    ORDER BY channel_id FOR UPDATE`) : { rows: [] };
  const positions = new Map(cursors.rows.map((row) => [row.scopeId, row.seq]));
  return { groups, effectiveBoundary: boundary.map((row) => {
    const entries = groups.get(row.scopeId);
    if (!entries?.length) return row;
    const positionsAtEntries = entries.map((entry) => positions.get(entry.scopeId) ?? 0);
    return { scopeId: row.scopeId, throughSeq: claim.kind === "row_unread"
      ? Math.min(Number(row.throughSeq), ...positionsAtEntries)
      : Math.max(Number(row.throughSeq), ...positionsAtEntries) };
  }) };
}

/** Recipient entries retain THEIR authority sequence; another server's durable
 * operation sequence is incomparable. Only per-cursor versions are shared. */
export async function applyJointReadFanout(
  tx: DatabaseTransaction,
  claim: ReadMutationClaim,
  plan: JointReadFanoutPlan,
  scopes: readonly ScopeState[],
): Promise<JointReadFanoutUpdate[]> {
  const desired = new Map<string, { state: ScopeState; target: Target }>();
  for (const state of scopes) {
    if (state.unreadOutcome === "nothing") continue;
    for (const target of plan.groups.get(state.scopeId) ?? []) {
      if (target.scopeId === state.scopeId) continue;
      if (desired.has(target.scopeId)) throw new Error("joint read fanout resolved a duplicate recipient scope");
      desired.set(target.scopeId, { state, target });
    }
  }
  if (!desired.size) return [];
  const entries = [...desired.values()].sort((a, b) => a.target.scopeId.localeCompare(b.target.scopeId));
  const result = await tx.execute<{
    scopeId: string; maxReadSeq: number; readStateVersion: number; lastAppliedAuthoritySeq: string;
  }>(sql`
    INSERT INTO user_channel_read_cursors(user_id,channel_id,last_read_seq,read_state_version,marked_unread,updated_at)
    SELECT ${claim.principalId}::uuid,s.scope_id,CASE WHEN s.marked THEN 0 ELSE s.seq END,1,s.marked,now()
    FROM unnest(${sql.param(entries.map((row) => row.target.scopeId))}::uuid[],
      ${sql.param(entries.map((row) => row.state.maxReadSeq))}::int[],
      ${sql.param(entries.map((row) => row.state.markedUnread === true))}::boolean[]) s(scope_id,seq,marked)
    WHERE s.seq>0 OR s.marked OR EXISTS (SELECT 1 FROM user_channel_read_cursors current
      WHERE current.user_id=${claim.principalId}::uuid AND current.channel_id=s.scope_id)
    ORDER BY s.scope_id
    ON CONFLICT(user_id,channel_id) DO UPDATE SET
      last_read_seq=CASE WHEN EXCLUDED.marked_unread THEN user_channel_read_cursors.last_read_seq
        WHEN ${claim.kind === "row_unread"} THEN LEAST(user_channel_read_cursors.last_read_seq,EXCLUDED.last_read_seq)
        ELSE GREATEST(user_channel_read_cursors.last_read_seq,EXCLUDED.last_read_seq) END,
      marked_unread=EXCLUDED.marked_unread,
      read_state_version=user_channel_read_cursors.read_state_version+1,updated_at=now()
    WHERE user_channel_read_cursors.marked_unread<>EXCLUDED.marked_unread OR (
      NOT EXCLUDED.marked_unread AND CASE WHEN ${claim.kind === "row_unread"}
        THEN user_channel_read_cursors.last_read_seq>EXCLUDED.last_read_seq
        ELSE user_channel_read_cursors.last_read_seq<EXCLUDED.last_read_seq END)
    RETURNING channel_id AS "scopeId",last_read_seq AS "maxReadSeq",read_state_version AS "readStateVersion",
      last_applied_authority_seq::text AS "lastAppliedAuthoritySeq"
  `);
  return result.rows.map((row) => {
    const source = desired.get(row.scopeId)!;
    const authoritySeq = Number(row.lastAppliedAuthoritySeq);
    if (!Number.isSafeInteger(authoritySeq)) throw new Error("unsafe joint read authority sequence");
    return { ...source.state, scopeId: row.scopeId, serverId: source.target.serverId,
      maxReadSeq: row.maxReadSeq, readStateVersion: row.readStateVersion,
      lastAppliedAuthoritySeq: authoritySeq, changed: true };
  });
}
