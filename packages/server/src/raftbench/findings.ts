import { createHash } from "node:crypto";
import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
import { currentDate, emptyRaftbenchKindCounts, RAFTBENCH_PATTERN_KINDS, type RaftbenchFindingFilter, type RaftbenchPatternKind, type RaftbenchReport } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import { messages, raftbenchConfigs, raftbenchFindings, raftbenchLatestRuns } from "../db/schema";

import type { AnalysisSource } from "./sources";
type Sources = AnalysisSource[];
/** Model inputs remain independent: merge accepted, scrubbed results only on the server. */
export async function accumulateReport(tx: DatabaseTransaction, config: typeof raftbenchConfigs.$inferSelect,
  run: typeof raftbenchLatestRuns.$inferSelect, sources: Sources, report: RaftbenchReport) {
  for (const pattern of report.patterns) {
    const normalize = (ref: { target: string; messageId: string }) => {
      const source = run.fetched.find(value => value.target === ref.target && value.messageId.startsWith(ref.messageId));
      if (!source?.sourceVersion) throw new Error("Validated citation has no source version");
      const storage = sources.find(value => value.localId === source.channelId);
      if (!storage) throw new Error("Validated citation has no source scope");
      return { reference: { target: ref.target, messageId: source.messageId },
        source: { messageId: source.messageId, channelId: source.channelId, storageChannelId: storage.storageId, sourceVersion: source.sourceVersion } };
    };
    const evidence = pattern.evidence.map(normalize), counter = pattern.counterevidence.map(normalize);
    const sourceRefs = [...evidence, ...counter].map(value => value.source);
    const normalized = { ...pattern, evidence: evidence.map(value => value.reference), counterevidence: counter.map(value => value.reference) };
    const fingerprint = createHash("sha256").update(JSON.stringify([pattern.kind, sourceRefs.map(value => `${value.channelId}:${value.messageId}`).sort()])).digest("hex");
    await tx.insert(raftbenchFindings).values({ serverId: config.serverId, revision: config.revision, fingerprint, pattern: normalized, sourceRefs })
      .onConflictDoUpdate({ target: [raftbenchFindings.serverId, raftbenchFindings.revision, raftbenchFindings.fingerprint], set: { pattern: normalized, sourceRefs, feedback: sql`CASE WHEN ${raftbenchFindings.pattern} = ${JSON.stringify(normalized)}::jsonb AND ${raftbenchFindings.sourceRefs} = ${JSON.stringify(sourceRefs)}::jsonb THEN ${raftbenchFindings.feedback} ELSE '{}'::jsonb END`, updatedAt: currentDate() } });
  }
  const rows = run.fetched.length ? await tx.select({ seq: messages.seq }).from(messages).where(inArray(messages.id, run.fetched.map(ref => ref.messageId))) : [];
  const thread = run.sourceKind === "thread";
  const cursor = thread ? config.threadReadThroughSeq : config.readThroughSeq;
  const newReads = rows.filter(row => row.seq > cursor).length;
  await tx.update(raftbenchConfigs).set({ completedBatches: config.completedBatches + 1,
    ...(thread ? {
      threadReadMessages: config.threadReadMessages + newReads,
      threadReadThroughSeq: Math.max(cursor, run.nextSeq),
      ...(run.exhausted ? { threadScannedThroughAt: run.to } : {}),
    } : {
      readMessages: config.readMessages + newReads, readThroughSeq: Math.max(cursor, run.nextSeq),
      ...(run.exhausted ? { scannedThroughAt: run.to } : {}),
    }),
  }).where(eq(raftbenchConfigs.serverId, config.serverId));
}

/** Count and page only findings whose cited source versions and source scope still exist. */
export async function listFindings(serverId: string, revision: number, sources: Sources, requestedPage: number, executor: DatabaseExecutor = getDb(), filter: RaftbenchFindingFilter = {}, includeExamples = false, reader?: { channelIds: string[]; pageSize: number }) {
  if (!sources.length) return { patterns: [], records: [], examples: [], total: 0, allTotal: 0, kindCounts: emptyRaftbenchKindCounts(), page: 1, pageCount: 1 };
  const scope = and(eq(raftbenchFindings.serverId, serverId), eq(raftbenchFindings.revision, revision));
  const liveSources = sql`(jsonb_array_length(${raftbenchFindings.sourceRefs}) > 0 AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(${raftbenchFindings.sourceRefs}) AS ref
      LEFT JOIN ${messages} AS cited ON cited.id = (ref->>'messageId')::uuid
      WHERE cited.id IS NULL OR cited.deleted_at IS NOT NULL
        OR cited.channel_id <> (ref->>'storageChannelId')::uuid
        OR NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(sources.map(source => ({ local: source.localId, storage: source.storageId })))}::jsonb) AS allowed(local text, storage text)
          WHERE ref->>'channelId' = allowed.local AND ref->>'storageChannelId' = allowed.storage)
        OR encode(sha256(convert_to(cited.content, 'UTF8')), 'hex') <> ref->>'sourceVersion'
    ))`;
  // Withdraw the stored derived copy as well as hiding it from results.
  await executor.delete(raftbenchFindings).where(and(scope, not(liveSources)));
  const visible = reader ? sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${raftbenchFindings.sourceRefs}) AS ref WHERE NOT COALESCE(${reader.channelIds.length ? inArray(sql`ref->>'channelId'`, reader.channelIds) : sql`false`}, false))` : undefined;
  const valid = and(scope, liveSources, visible);
  const pageSize = reader?.pageSize ?? 5;
  const [all] = await executor.select({ total: sql<number>`count(*)`.mapWith(Number) }).from(raftbenchFindings).where(valid);
  // Source timestamps, never analysis/review timestamps. Include counterevidence too.
  const evidenceAt = sql<string>`(SELECT max(cited.created_at)::text FROM jsonb_array_elements(${raftbenchFindings.sourceRefs}) AS ref JOIN ${messages} AS cited ON cited.id = (ref->>'messageId')::uuid)`;
  const cutoff = new Date(currentDate().getTime() - 30 * 24 * 60 * 60_000).toISOString();
  const periodScope = filter.period ? (filter.period === "recent" ? sql`(${evidenceAt})::timestamptz >= ${cutoff}::timestamptz` : sql`(${evidenceAt})::timestamptz < ${cutoff}::timestamptz`) : undefined;
  const filteredSources = filter.channelId ? sources.filter(source => source.localId === filter.channelId || source.parentId === filter.channelId).map(source => source.localId) : [];
  const channelScope = and(valid, periodScope, filter.channelId ? (filteredSources.length ? sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${raftbenchFindings.sourceRefs}) AS ref WHERE ${inArray(sql`ref->>'channelId'`, filteredSources)})` : sql`false`) : undefined);
  const groups = await executor.select({ kind: sql<RaftbenchPatternKind>`${raftbenchFindings.pattern}->>'kind'`, count: sql<number>`count(*)`.mapWith(Number) })
    .from(raftbenchFindings).where(channelScope).groupBy(sql`${raftbenchFindings.pattern}->>'kind'`);
  const kindCounts = emptyRaftbenchKindCounts();
  for (const group of groups) kindCounts[group.kind] = group.count;
  const filtered = and(channelScope, filter.kind ? sql`${raftbenchFindings.pattern}->>'kind' = ${filter.kind}` : undefined);
  const total = filter.kind ? kindCounts[filter.kind] : Object.values(kindCounts).reduce((sum, value) => sum + value, 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize)), page = Math.min(requestedPage, pageCount);
  const rows = await executor.select({ id: raftbenchFindings.id, evidenceAt, version: sql<string>`md5(${raftbenchFindings.pattern}::text || ${raftbenchFindings.sourceRefs}::text)`, feedback: raftbenchFindings.feedback, pattern: raftbenchFindings.pattern }).from(raftbenchFindings).where(filtered)
    .orderBy(desc(evidenceAt), raftbenchFindings.id).limit(pageSize).offset((page - 1) * pageSize);
  const examples: Array<{ kind: RaftbenchPatternKind; findings: typeof rows }> = [];
  if (includeExamples) for (const kind of RAFTBENCH_PATTERN_KINDS) {
    const findings = await executor.select({ id: raftbenchFindings.id, evidenceAt, version: sql<string>`md5(${raftbenchFindings.pattern}::text || ${raftbenchFindings.sourceRefs}::text)`, feedback: raftbenchFindings.feedback, pattern: raftbenchFindings.pattern })
      .from(raftbenchFindings).where(and(channelScope, sql`${raftbenchFindings.pattern}->>'kind' = ${kind}`))
      .orderBy(desc(evidenceAt), raftbenchFindings.id).limit(3);
    examples.push({ kind, findings });
  }
  return { examples, records: rows, patterns: rows.map(row => row.pattern), total, allTotal: all?.total ?? 0, kindCounts, page, pageCount };
}
