import { expect, vi } from "vitest";
import * as tracing from "../tracing/semanticTrace";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { agentRuntimeProvisions, agents, channels, featureFlags, messages, raftbenchConfigs, raftbenchFindings, raftbenchLatestRuns, raftbenchServiceAgents, serverAgentMembers, serverMembers, servers } from "../db/schema";
import { advanceServer, dashboard, configure, saveFindingFeedback } from "../raftbench/controls";
import { mintAgentCredential } from "../services/agentCredentialService";

const test = createApiTest();
const serverId = "90623df1-20ed-4321-88a1-e4e2b411a252";

test("thread backfill preserves channel progress and withdraws reply evidence", async ({ app, db, seed, onTestFinished }) => {
  const trace = vi.spyOn(tracing, "recordTraceEvent");
  onTestFinished(() => trace.mockRestore());
  const oldEnv = process.env.DEPLOYMENT_ENV;
  process.env.DEPLOYMENT_ENV = "staging";
  onTestFinished(() => { if (oldEnv === undefined) delete process.env.DEPLOYMENT_ENV; else process.env.DEPLOYMENT_ENV = oldEnv; });
  const owner = await seed.human();
  const administrator = await seed.human();
  await db.insert(featureFlags).values({ key: "raftbench_overview_v0", randomizationUnit: "server", salt: "synthetic", defaultEnabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true, killSwitch: false, defaultEnabled: true } });
  await db.insert(servers).values({ id: serverId, ownerId: owner.id, name: "Synthetic QA", slug: "synthetic-qa" });
  await db.insert(serverMembers).values({ serverId, userId: owner.id, role: "owner", setupStatus: "complete" });
  await db.insert(serverMembers).values({ serverId, userId: administrator.id, role: "admin", setupStatus: "complete" });
  const [agent] = await db.insert(agents).values({ serverId, name: "AnalysisService", runtime: "external" }).returning();
  await db.insert(serverAgentMembers).values({ serverId, agentId: agent.id, role: "member" });
  const [channel] = await db.insert(channels).values({ serverId, name: "synthetic-qa", type: "channel" }).returning();

  await db.insert(messages).values(Array.from({ length: 2 }, (_, i) => ({ channelId: channel.id, senderId: owner.id, senderType: "user" as const, content: `Synthetic ${i} ${"progress ".repeat(500)}`, createdAt: new Date(Date.now() - 60000) })));
  await db.insert(raftbenchConfigs).values({ serverId, configuredByUserId: administrator.id, enabled: true, agentId: agent.id, channelIds: [channel.id], revision: 1 });
  await db.insert(raftbenchServiceAgents).values({ serverId, agentId: agent.id });
  const credential = await mintAgentCredential({ agentId: agent.id, scopes: ["read", "raftbench"], name: "Synthetic analysis", issuedVia: "human", createdByUserId: owner.id });
  await db.insert(agentRuntimeProvisions).values({ agentId: agent.id, serverId, provider: "antiproton", state: "active", provisionedProfile: "raftbench_service", credentialId: credential.credentialId, provisionedName: "Synthetic analysis", provisionedInstructions: "Synthetic test only" });
  const call = (path: string, body?: unknown) => fetch(`${app.baseUrl}/internal/agent-api/raftbench/${path}`, { headers: { Authorization: `Bearer ${credential.apiKey}`, "Content-Type": "application/json" }, method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const [parent] = await db.insert(messages).values({ channelId: channel.id, senderId: owner.id, senderType: "user", content: "Old parent", createdAt: new Date(Date.now() - 30 * 86400000) }).returning();
  const [thread] = await db.insert(channels).values({ serverId, name: "synthetic-thread", type: "thread", parentChannelId: channel.id, parentMessageId: parent.id }).returning();
  const replies = await db.insert(messages).values(Array.from({ length: 40 }, (_, i) => ({ channelId: thread.id, senderId: owner.id, senderType: "user" as const, content: `Reply ${i} ${"synthetic ".repeat(500)}`, createdAt: new Date(Date.now() - 60000) }))).returning();
  const consume = async (kind: "channel" | "thread", finding = false) => {
    const [run] = await db.select().from(raftbenchLatestRuns).where(eq(raftbenchLatestRuns.serverId, serverId));
    expect(run.sourceKind).toBe(kind);
    const response = await call(`context?runId=${run.runId}`), context = await response.json();
    expect(response.status, JSON.stringify(context)).toBe(200);
    const [read] = await db.select().from(raftbenchLatestRuns).where(eq(raftbenchLatestRuns.serverId, serverId));
    const readEvent = trace.mock.calls.filter(([name]) => name === "raftbench.read_progress").at(-1)?.[1];
    // Exact metadata allowlist also guards against logging source bodies or refs.
    expect(readEvent).toEqual({ run_id: run.runId, revision: run.revision, source_kind: kind,
      from: run.from.toISOString(), to: run.to.toISOString(), start_after_seq: run.startAfterSeq,
      page_after_seq: run.startAfterSeq, page_next_seq: read.nextSeq, next_seq: read.nextSeq,
      page_count: context.sources.length, fetched_count: read.fetched.length,
      exhausted: read.exhausted, stop_reason: read.stopReason });
    expect(context).not.toHaveProperty("progress");
    const beforeInvalid = trace.mock.calls.filter(([name]) => name === "raftbench.read_progress").length;
    expect((await call(`context?runId=${run.runId}&cursor=invalid`)).status).toBe(409);
    expect(trace.mock.calls.filter(([name]) => name === "raftbench.read_progress")).toHaveLength(beforeInvalid);
    if (kind === "thread") {
      expect(read.fetched.every(ref => ref.channelId === thread.id && ref.target === `#synthetic-qa:${parent.id.slice(0, 8)}`)).toBe(true);
      expect(context.sourceText).not.toContain("Old parent");
    }
    const patterns = finding ? [{ kind: "successful_practice", explanation: "Synthetic reply finding", evidence: [context.sources[0]], counterevidence: [], evidenceLevel: "conversation_only", intent: "unknown", suggestion: "Keep the checklist" }] : [];
    const body = { runId: run.runId, revision: 1, status: "incomplete", reason: "Synthetic batch", patterns, gaps: ["partial_scan"] };
    const accepted = await call("submit", body); expect(accepted.status, await accepted.clone().text()).toBe(200);
    const receipt = await accepted.json();
    expect((await call("submit", body)).status).toBe(200);
    const submissions = trace.mock.calls.filter(([name, attrs]) => name === "raftbench.report_accepted" && attrs?.run_id === run.runId);
    expect(submissions).toHaveLength(2);
    for (const [, attrs] of submissions) expect(attrs).toEqual({ run_id: run.runId, revision: 1,
      receipt_id: receipt.receiptId, report_status: "incomplete", failure: false });
    return read;
  };
  await advanceServer(serverId);
  expect((await consume("channel")).fetched).toHaveLength(2);
  const [before] = await db.select().from(raftbenchConfigs).where(eq(raftbenchConfigs.serverId, serverId));
  // A transport failure before context was read must never skip the whole
  // historical window, even after the normal three model-attempt threshold.
  await advanceServer(serverId);
  const [unread] = await db.select().from(raftbenchLatestRuns).where(eq(raftbenchLatestRuns.serverId, serverId));
  let unreadAttempt = unread;
  let channelTurns = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const failed = await call("submit", { runId: unreadAttempt.runId, revision: 1, status: "incomplete", failure: true, reason: "Synthetic transport failure before context", patterns: [], gaps: [] });
    expect(failed.status, await failed.text()).toBe(200);
    expect((await dashboard(serverId, owner.id)).run?.unreadRetries.thread?.failures).toBe(attempt + 1);
    const clock = new Date(Date.now() + (attempt + 1) * 16 * 60000);
    await advanceServer(serverId, clock, true);
    [unreadAttempt] = await db.select().from(raftbenchLatestRuns).where(eq(raftbenchLatestRuns.serverId, serverId));
    expect(unreadAttempt.unreadRetries.thread?.failures).toBe(attempt + 1);
    expect((await dashboard(serverId, owner.id)).run?.unreadRetries.thread?.failures).toBe(attempt + 1);
    if (attempt >= 1) {
      expect(unreadAttempt.sourceKind).toBe("channel");
      await consume("channel"); channelTurns++;
      const [progressed] = await db.select().from(raftbenchConfigs).where(eq(raftbenchConfigs.serverId, serverId));
      expect(progressed.scannedThroughAt?.getTime()).toBe(clock.getTime());
      expect(progressed.threadReadMessages).toBe(0);
      await advanceServer(serverId, clock, true);
      [unreadAttempt] = await db.select().from(raftbenchLatestRuns).where(eq(raftbenchLatestRuns.serverId, serverId));
    }
    expect(unreadAttempt.from).toEqual(unread.from); expect(unreadAttempt.to).toEqual(unread.to);
    expect(unreadAttempt.startAfterSeq).toBe(unread.startAfterSeq);
    expect(unreadAttempt.failureCount).toBe(0); // Separate from material-processing attempts.
    expect(unreadAttempt.sourceKind).toBe("thread"); expect(unreadAttempt.skippedRanges).toEqual([]);
  }
  expect(channelTurns).toBe(3);
  const seen = new Set<string>(); let batches = 0;
  for (;;) {
    await advanceServer(serverId);
    const run = await consume("thread", batches === 0);
    for (const ref of run.fetched) { expect(seen.has(ref.messageId)).toBe(false); seen.add(ref.messageId); }
    batches++;
    if (run.exhausted) break;
    expect(batches).toBeLessThan(10);
  }
  const [recovered] = await db.select().from(raftbenchLatestRuns).where(eq(raftbenchLatestRuns.serverId, serverId));
  expect(recovered.unreadRetries.thread).toBeUndefined();
  expect(seen.size).toBe(40); expect(batches).toBeGreaterThan(1);
  const [after] = await db.select().from(raftbenchConfigs).where(eq(raftbenchConfigs.serverId, serverId));
  expect(after.readMessages).toBe(2); expect(after.readThroughSeq).toBe(before.readThroughSeq);
  expect(after.threadReadMessages).toBe(40); expect(after.sourceScanVersion).toBe(2);
  const state = await dashboard(serverId, owner.id, 1, { channelId: channel.id });
  expect(state.progress.readMessages).toBe(42);
  expect(state.progress.streams.channel.readMessages).toBe(2);
  expect(state.progress.streams.thread.readMessages).toBe(40);
  expect(state.run?.sourceKind).toBe("thread"); expect(state.coverage?.windowMessages).toBe(42);
  expect(state.pagination.total).toBe(1);
  expect(state.run?.report?.patterns?.[0].evidence[0].target).toBe(`#synthetic-qa:${parent.id.slice(0, 8)}`);
  // A new reply in the old thread is discovered independently of parent age.
  const later = new Date(Date.now() + 60_000);
  const [newReply] = await db.insert(messages).values({ channelId: thread.id, senderId: owner.id, senderType: "user", content: "New reply in old thread", createdAt: later }).returning();
  await advanceServer(serverId, new Date(later.getTime() + 20 * 60000), true); await consume("channel");
  await advanceServer(serverId, new Date(later.getTime() + 40 * 60000), true);
  const [firstAttempt] = await db.select().from(raftbenchLatestRuns).where(eq(raftbenchLatestRuns.serverId, serverId));
  await call(`context?runId=${firstAttempt.runId}`);
  const [failedRead] = await db.select().from(raftbenchLatestRuns).where(eq(raftbenchLatestRuns.serverId, serverId));
  await db.update(raftbenchLatestRuns).set({ status: "failed" }).where(eq(raftbenchLatestRuns.serverId, serverId));
  await advanceServer(serverId, new Date(later.getTime() + 41 * 60000), true);
  const retry = await consume("thread");
  expect(retry.runId).not.toBe(firstAttempt.runId);
  expect(retry.fetched.map(ref => ref.messageId)).toEqual(failedRead.fetched.map(ref => ref.messageId));
  let increment = retry;
  while (!increment.exhausted) {
    await advanceServer(serverId, new Date(later.getTime() + 42 * 60000), true);
    increment = await consume("thread");
  }
  expect(increment.fetched.some(ref => ref.messageId === newReply.id)).toBe(true);
  const [incremented] = await db.select().from(raftbenchConfigs).where(eq(raftbenchConfigs.serverId, serverId));
  expect(incremented.threadReadMessages).toBe(41);
  await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, replies[0].id));
  expect((await dashboard(serverId, owner.id)).pagination.total).toBe(0);
  expect(await db.select().from(raftbenchFindings)).toHaveLength(0);
  await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, parent.id));
  await advanceServer(serverId, new Date(Date.now() + 20 * 60000), true); expect((await consume("thread")).fetched).toHaveLength(0);
  await advanceServer(serverId, new Date(Date.now() + 40 * 60000), true);
  await consume("channel");
  await configure(serverId, owner.id, { enabled: false, channelIds: [], expectedRevision: 1 });
  const [cleared] = await db.select().from(raftbenchConfigs).where(eq(raftbenchConfigs.serverId, serverId));
  expect(cleared.threadReadMessages).toBe(0); expect(cleared.threadReadThroughSeq).toBe(0); expect(cleared.threadScannedThroughAt).toBeNull();
});
