import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { currentDate, asServerId, redactDiagnosticText, formatUtcTimestamp, type RaftbenchReport } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import { agentCredentials, messages, raftbenchConfigs, raftbenchLatestRuns, raftbenchServiceAgents } from "../db/schema";
import { readSourcePage } from "./sourcePage";
import { accumulateReport } from "./findings";
import { withTraceChildSpan, recordTraceEvent } from "../tracing/semanticTrace";
import { includeThreadSources, type AnalysisSource } from "./sources";
import * as channelService from "../services/channelService";
import { agentHasScope } from "../services/agentScopesService";
import { evaluateFeatureFlag } from "../services/featureFlagService";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import { isPilotServer, READ_GRANTS, validateFetchedEvidence, type ValidationProblem } from "./contract";
import { hasExactRaftbenchServiceScopes } from "./credentialScopes";

export class RaftbenchError extends Error {
  constructor(public status: number, public code: string, message: string, public suggestedNextAction: string, public issues?: ValidationProblem[]) { super(message); }
}
const PAGE_SIZE = 100;
const RUN_MESSAGE_LIMIT = 2000;
const MAX_MESSAGE_CHARS = 4000;
export function scrubText(value: string): string {
  return redactDiagnosticText(value).replace(/\*\*\*REDACTED\*\*\*|\[REDACTED_[A-Z_]+\]|%5BREDACTED_[A-Z_]+%5D/gi, "[redacted]").replace(/[0-9a-fA-F:.]+/g, token => {
    const candidate = token.replace(/\.+$/, "");
    return isIP(candidate) ? "[redacted]" : token;
  });
}
const RUN_CHARACTER_LIMIT = 64_000;
type Run = typeof raftbenchLatestRuns.$inferSelect;
type Config = typeof raftbenchConfigs.$inferSelect;
function fail(status: number, code: string, message: string, next: string): never { throw new RaftbenchError(status, code, message, next); }
export function requirePilot(serverId: string): void {
  if (!isPilotServer(serverId, process.env.DEPLOYMENT_ENV)) fail(403, "raftbench_server_not_allowed", "RaftBench is unavailable on this server or deployment.", "Use an enrolled staging server. Production is not enrolled.");
}
export function runCoverage(run: Run) {
  const skipped = run.skippedRanges.filter(range => new Date(range.from) < run.to && new Date(range.to) > run.from);
  return { from: run.from.toISOString(), to: run.to.toISOString(), fetchedMessages: run.fetched.length, exhausted: run.exhausted && run.startAfterSeq === 0 && skipped.length === 0, skippedChunks: skipped.length, stopReason: run.stopReason, notRead: [
    run.sourceKind === "thread" ? "This batch reads accessible message-thread replies in selected channels. Top-level messages are analyzed in separate batches." : "This batch reads top-level messages in selected channels. Thread replies are analyzed in separate batches.",
    "Tool execution outcomes and task-conversation channels are not included.",
    "Messages outside the selected channels and time window are not included.",
    `Source bodies are bounded to ${MAX_MESSAGE_CHARS} characters per message, ${RUN_CHARACTER_LIMIT} characters including headers per run.`,
    ...skipped.map(range => `Messages from ${formatUtcTimestamp(range.from)} to ${formatUtcTimestamp(range.to)} (${range.messages ?? "an unknown number of"} messages) were skipped after 3 failed analysis attempts and were not analyzed; treat them as unknown.`),
    ...(run.startAfterSeq > 0 ? ["Messages earlier in this window are not included here. They may have been analyzed or skipped in previous runs."] : []),
  ] };
}
/** Content identity excludes task/done/action metadata changes and stores no body copy. */
export function sourceContentVersion(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
export async function sourceVersionsLive(db: DatabaseExecutor, run: Run, sources: AnalysisSource[], lock = false): Promise<boolean> {
  if (!run.fetched.length) return true;
  const query = db.select({ id: messages.id, channelId: messages.channelId, sourceVersion: sql<string>`encode(sha256(convert_to(${messages.content}, 'UTF8')), 'hex')` }).from(messages)
    .where(and(inArray(messages.id, run.fetched.map(ref => ref.messageId)), isNull(messages.deletedAt)));
  const rows = lock ? await query.for("share") : await query;
  const byId = new Map(rows.map(row => [row.id, row]));
  return run.fetched.every(ref => {
    const row = byId.get(ref.messageId), source = sources.find(item => item.localId === ref.channelId);
    return !!row && !!source && row.channelId === source.storageId && ref.target === source.target && ref.sourceVersion === row.sourceVersion;
  });
}

/** Configuring human and service agent must retain their roles and channel access. */
export async function assertLiveSources(config: Config, agentId: string): Promise<AnalysisSource[]> {
  const role = await getActorServerRoleInServer(config.serverId, "user", config.configuredByUserId);
  if (!config.enabled) fail(409, "raftbench_disabled", "RaftBench was disabled for this server.", "Stop this run and wait for an administrator to enable it again.");
  if (config.agentId !== agentId || (role !== "owner" && role !== "admin")) {
    fail(403, "raftbench_access_revoked", "The run's administrator permissions changed.", "Stop this run and wait for an administrator to review its permissions.");
  }
  for (const grant of READ_GRANTS) {
    if (!await agentHasScope(agentId, grant)) fail(403, "raftbench_read_permission_revoked", "The service agent's read permissions changed.", "Stop this run. An administrator has to restore its read grants; retrying will not help.");
  }
  const sources: AnalysisSource[] = [];
  for (const id of config.channelIds) {
    const channel = await channelService.getChannel(id);
    if (!channel || channel.deletedAt || channel.archivedAt || !["channel", "private", "joint"].includes(channel.type) ||
        !await channelService.canUserAccessChannel(id, config.configuredByUserId, asServerId(config.serverId)) ||
        !await channelService.canAgentAccessChannel(id, agentId)) {
      fail(409, "raftbench_source_unavailable", "A selected source is no longer accessible.", "Stop this run. Ask the administrator to update its source scope, then read context again.");
    }
    const access = await channelService.resolveChannelAccess({ serverId: config.serverId, channelId: id });
    if (!access) fail(409, "raftbench_source_unavailable", "A selected source is no longer available.", "Read context again after its source scope is updated.");
    sources.push({ localId: id, storageId: access.kind === "joint" ? access.canonicalChannelId : id, target: `#${channel.name}` });
  }
  return withTraceChildSpan("server.raftbench.thread_sources", { surface: "server", kind: "internal", attrs: { root_count: sources.length } },
    () => includeThreadSources(sources, config.serverId, config.configuredByUserId, agentId));
}
async function ownedRun(tx: DatabaseTransaction, serverId: string, agentId: string, runId?: string) {
  requirePilot(serverId);
  const [config] = await tx.select().from(raftbenchConfigs).where(eq(raftbenchConfigs.serverId, serverId)).for("update");
  const [run] = await tx.select().from(raftbenchLatestRuns).where(eq(raftbenchLatestRuns.serverId, serverId)).for("update");
  if (!config || !run || run.agentId !== agentId || config.agentId !== agentId || (runId && run.runId !== runId)) {
    fail(404, "raftbench_run_not_owned", "No assigned run is available for this credential.", "Wait for a raftbench_run_assigned event for this service agent. Do not retry another agent's run ID.");
  }
  const [dedicated] = await tx.select({ agentId: raftbenchServiceAgents.agentId }).from(raftbenchServiceAgents)
    .where(and(eq(raftbenchServiceAgents.agentId, agentId), eq(raftbenchServiceAgents.serverId, serverId)));
  const credentials = await tx.select({ scopes: agentCredentials.scopes }).from(agentCredentials)
    .where(and(eq(agentCredentials.agentId, agentId), isNull(agentCredentials.revokedAt)));
  if (!dedicated || !credentials.some(credential => hasExactRaftbenchServiceScopes(credential.scopes)))
    fail(403, "raftbench_service_credential_required", "This run requires its assigned RaftBench service agent and read-only credential.", "Ask an administrator to create and assign a RaftBench service agent with read and raftbench access. Retrying or using another credential will not help.");
  const flag = await evaluateFeatureFlag({ key: "raftbench_overview_v0", serverId, userId: config.configuredByUserId }, tx);
  if (!flag.enabled) fail(409, "raftbench_disabled", "RaftBench was disabled for this server.", "Stop this run. Ask the administrator to review enrollment before reading context again.");
  if (config.revision !== run.revision) fail(409, "raftbench_revision_conflict", "The configuration revision changed.", "Read context again and use its current run ID and revision.");
  const sources = await withTraceChildSpan("server.raftbench.authorize_sources", { surface: "server", kind: "internal" }, () => assertLiveSources(config, agentId));
  if (!await sourceVersionsLive(tx, run, sources, true)) fail(409, "raftbench_source_unavailable", "A message used by this run changed or was deleted. The old result cannot be accepted.", "Stop this run and wait for a new assignment with refreshed source material.");
  return { config, run, sources };
}

/** Read-only semantics: replaying the same cursor never counts source references twice. */
export async function readContext(serverId: string, agentId: string, query: { runId?: string; cursor?: string }) {
  const { context, progress } = await getDb().transaction(async tx => {
    const { run, sources } = await withTraceChildSpan("server.raftbench.owned_run", { surface: "server", kind: "internal" }, () => ownedRun(tx, serverId, agentId, query.runId));
    if (run.status === "failed") fail(409, "raftbench_run_finished", "This run ended before a result was accepted.", "Stop this run and wait for a new assignment.");
    if (run.submissionHash) fail(409, "raftbench_run_finished", "A result has already been accepted for this run.", "Do not restart its read loop. Retry only the identical submit request to recover its receipt, or wait for a new assigned run.");
    let after = run.startAfterSeq;
    if (query.cursor) {
      const parts = query.cursor.split(":");
      if (parts.length !== 3 || parts[0] !== run.runId || Number(parts[1]) !== run.revision || !/^\d+$/.test(parts[2])) {
        fail(409, "raftbench_cursor_stale", "The source cursor belongs to another run or revision.", "Discard the cursor and read context again with the assigned run ID.");
      }
      after = Number(parts[2]);
      if (!Number.isSafeInteger(after) || after < run.startAfterSeq || after > run.nextSeq) fail(400, "raftbench_cursor_invalid", "This cursor was not issued for the run.", "Use nextCursor from the preceding context response.");
    }
    const scanSources = sources.filter(source => run.sourceKind === "thread" ? !!source.parentId : !source.parentId);
    const rows = await withTraceChildSpan("server.raftbench.read_messages", { surface: "server", kind: "internal", attrs: { source_kind: run.sourceKind, source_count: scanSources.length } }, () => readSourcePage(tx, scanSources.map(s => s.storageId), after, run.from, run.to, PAGE_SIZE + 1), { onSuccess: rows => ({ row_count: rows.length }) });
    const renderStarted = performance.now();
    const existing = new Set(run.fetched.map(ref => ref.messageId));
    const page: typeof rows = [];
    const refs: Run["fetched"] = [];
    const lines: string[] = [];
    let sourceCharacters = run.sourceCharacters;
    let newMessages = 0;
    let budgetStop: "message_limit" | "char_limit" | null = null;
    for (const row of rows.slice(0, PAGE_SIZE)) {
      const source = sources.find(s => s.storageId === row.message.channelId)!;
      const sender = row.message.senderType === "agent" ? row.agentName : row.userName;
      const body = scrubText(row.message.content);
      const preview = body.length > MAX_MESSAGE_CHARS ? `${body.slice(0, MAX_MESSAGE_CHARS)}…⟨${body.length - MAX_MESSAGE_CHARS} more chars⟩` : body;
      const line = `[target=${source.target} msg=${row.message.id} time=${formatUtcTimestamp(row.message.createdAt)} type=${row.message.senderType === "user" ? "human" : row.message.senderType}] @${sender ?? "unknown"}: ${preview}`;
      if (!existing.has(row.message.id)) {
        if (run.fetched.length + newMessages >= RUN_MESSAGE_LIMIT) { budgetStop = "message_limit"; break; }
        if (sourceCharacters + line.length > RUN_CHARACTER_LIMIT) { budgetStop = "char_limit"; break; }
        newMessages += 1;
        sourceCharacters += line.length;
      }
      page.push(row);
      refs.push({ target: source.target, messageId: row.message.id, channelId: source.localId, sourceVersion: sourceContentVersion(row.message.content) });
      lines.push(line);
    }
    const fetched = [...run.fetched, ...refs.filter(ref => !existing.has(ref.messageId))];
    const exhausted = run.exhausted || (rows.length <= PAGE_SIZE && page.length === rows.length);
    const last = page.at(-1)?.message.seq ?? after;
    const next = !budgetStop && fetched.length < RUN_MESSAGE_LIMIT && sourceCharacters < RUN_CHARACTER_LIMIT && !exhausted ? `${run.runId}:${run.revision}:${last}` : null;
    const stopReason = exhausted ? "window_end" as const : budgetStop ?? (fetched.length >= RUN_MESSAGE_LIMIT ? "message_limit" as const : sourceCharacters >= RUN_CHARACTER_LIMIT ? "char_limit" as const : "more_pages" as const);
    const nextRun = { ...run, fetched, exhausted, sourceCharacters, stopReason, nextSeq: Math.max(run.nextSeq, last) };
    recordTraceEvent("raftbench.render_context", { duration_ms: performance.now() - renderStarted, row_count: page.length, source_kind: run.sourceKind });
    await withTraceChildSpan("server.raftbench.save_read_progress", { surface: "server", kind: "internal" }, async () => {
      await tx.update(raftbenchLatestRuns).set({ fetched, exhausted, sourceCharacters, stopReason, nextSeq: nextRun.nextSeq, status: "running", updatedAt: currentDate() }).where(eq(raftbenchLatestRuns.serverId, serverId));
    });
    return {
      context: { runId: run.runId, revision: run.revision, sourceText: lines.join("\n\n"), sources: refs.map(({ target, messageId }) => ({ target, messageId })), coverage: runCoverage(nextRun), nextCursor: next },
      progress: { run_id: run.runId, revision: run.revision, source_kind: run.sourceKind,
        from: run.from.toISOString(), to: run.to.toISOString(), start_after_seq: run.startAfterSeq,
        page_after_seq: after, page_next_seq: last, next_seq: nextRun.nextSeq,
        page_count: refs.length, fetched_count: fetched.length, exhausted, stop_reason: stopReason },
    };
  });
  // Emit only after the progress transaction commits; never include source text or refs.
  recordTraceEvent("raftbench.read_progress", progress);
  return context;
}

export async function submitReport(serverId: string, agentId: string, report: RaftbenchReport) {
  const result = await getDb().transaction(async tx => {
    const { run, config, sources } = await ownedRun(tx, serverId, agentId, report.runId);
    if (run.revision !== report.revision) fail(409, "raftbench_revision_conflict", "This result uses an old revision.", "Read context again; regenerate the result using its current run ID and revision.");
    const hash = createHash("sha256").update(JSON.stringify(report)).digest("hex");
    if (run.submissionHash) {
      if (run.submissionHash !== hash) fail(409, "raftbench_submission_conflict", "A different result was already accepted for this run and revision.", "Do not overwrite it. Ask the administrator to start a new run.");
      return { runId: run.runId, revision: run.revision, status: run.report!.status, receiptId: run.receiptId!, coverage: runCoverage(run) };
    }
    if (run.status === "failed") fail(409, "raftbench_run_finished", "This run ended before a result was accepted.", "Stop this run and wait for a new assignment.");
    const liveRows = run.fetched.length ? await tx.select({ id: messages.id }).from(messages).where(inArray(messages.id, run.fetched.map(ref => ref.messageId))) : [];
    const liveIds = new Set(liveRows.map(row => row.id));
    const issues = validateFetchedEvidence(report, run.fetched.filter(ref => liveIds.has(ref.messageId)));
    if (report.status === "complete" && run.fetched.length === 0) issues.push({ path: "status", message: "No messages were read in this window; nothing was analyzed.", suggestedFix: "Change status to incomplete, set reason to: No messages were read in this window; nothing was analyzed. Leave patterns empty." });
    if (report.status === "complete" && !runCoverage(run).exhausted) issues.push({ path: "status", message: "The selected source window has not been fully read.", suggestedFix: "Change status to incomplete and set reason to: The supplied material does not cover the entire window. Nothing has been saved." });
    if (issues.length) throw new RaftbenchError(422, "raftbench_validation_failed", "Result validation failed; nothing has been saved.", "Correct all listed fields once; if still invalid, submit incomplete with the validation failure as its reason.", issues);
    const receiptId = randomUUID();
    const safeReport = { ...report, ...(report.reason ? { reason: scrubText(report.reason) } : {}), patterns: report.patterns.map(pattern => ({ ...pattern, explanation: scrubText(pattern.explanation), suggestion: scrubText(pattern.suggestion) })) };
    if (!report.failure) await accumulateReport(tx, config, run, sources, safeReport);
    await tx.update(raftbenchLatestRuns).set({ report: safeReport, submissionHash: hash, receiptId, status: report.failure ? "failed" : report.status === "complete" ? "ready" : "partial", failureReason: report.failure ? safeReport.reason : null, updatedAt: currentDate() }).where(eq(raftbenchLatestRuns.serverId, serverId));
    return { runId: run.runId, revision: run.revision, status: report.status, receiptId, coverage: runCoverage(run) };
  });
  recordTraceEvent("raftbench.report_accepted", { run_id: result.runId, revision: result.revision,
    receipt_id: result.receiptId, report_status: result.status, failure: report.failure === true });
  return result;
}
