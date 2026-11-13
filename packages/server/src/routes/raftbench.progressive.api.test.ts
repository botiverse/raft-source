import { expect } from "vitest";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { agentRuntimeProvisions, agents, channels, featureFlags, messages, raftbenchConfigs, raftbenchFindings, raftbenchLatestRuns, raftbenchServiceAgents, serverAgentMembers, serverMembers, servers } from "../db/schema";
import { advanceServer, dashboard, configure, saveFindingFeedback } from "../raftbench/controls";
import { mintAgentCredential } from "../services/agentCredentialService";

const test = createApiTest();
const serverId = "90623df1-20ed-4321-88a1-e4e2b411a252";

test("background continuation retains findings and unique progress, and clears withdrawn scope", async ({ app, db, seed, onTestFinished }) => {
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

  await db.insert(messages).values(Array.from({ length: 80 }, (_, i) => ({ channelId: channel.id, senderId: owner.id, senderType: "user" as const, content: `Synthetic ${i} ${"progress ".repeat(500)}`, createdAt: new Date(Date.now() - 60000) })));
  await db.insert(raftbenchConfigs).values({ serverId, configuredByUserId: administrator.id, enabled: true, agentId: agent.id, channelIds: [channel.id], revision: 1 });
  await db.insert(raftbenchServiceAgents).values({ serverId, agentId: agent.id });
  const credential = await mintAgentCredential({ agentId: agent.id, scopes: ["read", "raftbench"], name: "Synthetic analysis", issuedVia: "human", createdByUserId: owner.id });
  await db.insert(agentRuntimeProvisions).values({ agentId: agent.id, serverId, provider: "antiproton", state: "active", provisionedProfile: "raftbench_service", credentialId: credential.credentialId, provisionedName: "Synthetic analysis", provisionedInstructions: "Synthetic test only" });
  const call = (path: string, body?: unknown) => fetch(`${app.baseUrl}/internal/agent-api/raftbench/${path}`, { headers: { Authorization: `Bearer ${credential.apiKey}`, "Content-Type": "application/json" }, method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let firstId = "", previousId = "", batches = 0;
  const seen = new Set<string>();
  for (;;) {
    await advanceServer(serverId);
    const [run] = await db.select().from(raftbenchLatestRuns).where(eq(raftbenchLatestRuns.serverId, serverId));
    expect(run.runId).not.toBe(previousId); previousId = run.runId;
    if (batches) {
      const pending = await dashboard(serverId, owner.id);
      expect(pending.run?.status).toBe("queued"); expect(pending.pagination.total).toBe(1);
      expect(pending.run?.report?.patterns?.[0].explanation).toBe("Synthetic accepted finding");
    }
    const response = await call(`context?runId=${run.runId}`), context = await response.json();
    expect(response.status, JSON.stringify(context)).toBe(200);
    const [readRun] = await db.select().from(raftbenchLatestRuns).where(eq(raftbenchLatestRuns.serverId, serverId));
    for (const ref of readRun.fetched) { expect(seen.has(ref.messageId)).toBe(false); seen.add(ref.messageId); }
    if (!firstId) firstId = readRun.fetched[0].messageId; else expect(context.sourceText).not.toContain(firstId);
    const patterns = batches ? [] : [{ kind: "successful_practice", explanation: "Synthetic accepted finding", evidence: [{ target: "#synthetic-qa", messageId: firstId }], counterevidence: [], evidenceLevel: "conversation_only", intent: "unknown", suggestion: "Keep the synthetic checklist" }];
    const body = { runId: run.runId, revision: 1, status: "incomplete", reason: "One batch of an ongoing scan", patterns, gaps: ["partial_scan"] };
    const accepted = await call("submit", body);
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect((await call("submit", body)).status).toBe(200);
    batches++;
    const state = await dashboard(serverId, owner.id);
    expect(state.progress).toMatchObject({ readMessages: seen.size, completedBatches: batches });
    expect(state.pagination.total).toBe(1);
    if (readRun.exhausted) break;
    expect(batches).toBeLessThan(10);
  }
  expect(batches).toBeGreaterThan(1); expect(seen.size).toBe(80);
  // Index all retained findings, then filter before pagination without restarting analysis.
  const [stored] = await db.select().from(raftbenchFindings);
  await db.insert(raftbenchFindings).values(Array.from({ length: 7 }, (_, i) => ({
    serverId, revision: 1, fingerprint: `synthetic-repeated-${i}`, sourceRefs: stored.sourceRefs,
    pattern: { ...stored.pattern, kind: "repeated_attempt" as const, explanation: `Synthetic loop ${i}` },
  })));
  const indexed = await dashboard(serverId, owner.id);
  expect(indexed.findingIndex.kindCounts).toEqual({ repeated_clarification: 0, repeated_attempt: 7, unsupported_completion: 0, successful_practice: 1 });
  expect(indexed.findingExamples.find(group => group.kind === "repeated_attempt")?.findings).toHaveLength(3);
  expect(indexed.findingExamples.find(group => group.kind === "successful_practice")?.findings).toHaveLength(1);
  expect((await dashboard(serverId, owner.id, 1, { period: "recent" })).pagination.total).toBe(8);
  expect((await dashboard(serverId, owner.id, 1, { period: "history" })).pagination.total).toBe(0);
  const oldEvidence = new Date(Date.now() - 60 * 86_400_000);
  await db.update(messages).set({ createdAt: oldEvidence }).where(eq(messages.id, firstId));
  const historical = await dashboard(serverId, owner.id, 2, { period: "history", kind: "repeated_attempt", channelId: channel.id });
  expect(historical.pagination).toMatchObject({ total: 7, page: 2 });
  expect(historical.findingFeedback[0].evidenceAt).toBe(oldEvidence.toISOString());
  const recentEmpty = await dashboard(serverId, owner.id, 1, { period: "recent" });
  expect(recentEmpty.pagination.total).toBe(0);
  expect(recentEmpty.run?.report?.patterns).toEqual([]);
  expect(recentEmpty.findingExamples.every(group => group.findings.length === 0)).toBe(true);
  expect(recentEmpty.progress).toEqual(indexed.progress);
  await db.update(messages).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(messages.id, firstId));
  const review = indexed.findingFeedback[0];
  expect(await saveFindingFeedback(serverId, owner.id, review.id, { revision: 1, version: review.version, value: "agree" })).toEqual({ saved: true });
  expect(await saveFindingFeedback(serverId, administrator.id, review.id, { revision: 1, version: review.version, value: "inaccurate" })).toEqual({ saved: true });
  expect((await dashboard(serverId, owner.id)).findingFeedback.find(row => row.id === review.id)?.value).toBe("agree");
  expect((await dashboard(serverId, administrator.id)).findingFeedback.find(row => row.id === review.id)?.value).toBe("inaccurate");
  await saveFindingFeedback(serverId, owner.id, review.id, { revision: 1, version: review.version, value: "inaccurate" });
  expect((await dashboard(serverId, owner.id)).findingFeedback.find(row => row.id === review.id)?.value).toBe("inaccurate");
  await saveFindingFeedback(serverId, owner.id, review.id, { revision: 1, version: review.version, value: null });
  expect((await dashboard(serverId, owner.id)).findingFeedback.find(row => row.id === review.id)?.value).toBeNull();
  expect(await saveFindingFeedback(serverId, owner.id, review.id, { revision: 1, version: "0".repeat(32), value: "agree" })).toEqual({ saved: false });
  await expect(saveFindingFeedback(serverId, owner.id, review.id, { revision: 2, version: review.version, value: "agree" })).rejects.toMatchObject({ status: 409 });
  await db.update(serverMembers).set({ role: "member" }).where(eq(serverMembers.userId, administrator.id));
  await expect(saveFindingFeedback(serverId, administrator.id, review.id, { revision: 1, version: review.version, value: "agree" })).rejects.toMatchObject({ status: 403 });
  await db.update(serverMembers).set({ role: "admin" }).where(eq(serverMembers.userId, administrator.id));
  const filtered = await dashboard(serverId, owner.id, 2, { kind: "repeated_attempt", channelId: channel.id });
  expect(filtered.pagination).toMatchObject({ page: 2, total: 7, pageCount: 2 });
  expect(filtered.run?.report?.patterns).toHaveLength(2);
  expect(filtered.run?.report?.patterns?.every(pattern => pattern.kind === "repeated_attempt")).toBe(true);
  const empty = await dashboard(serverId, owner.id, 1, { kind: "repeated_clarification" });
  expect(empty.pagination.total).toBe(0); expect(empty.run?.report?.patterns).toEqual([]);
  const foreignChannel = await dashboard(serverId, owner.id, 1, { channelId: "00000000-0000-4000-8000-000000000001" });
  expect(foreignChannel.pagination.total).toBe(0);
  expect(Object.values(foreignChannel.findingIndex.kindCounts)).toEqual([0, 0, 0, 0]);
  expect(filtered.progress).toEqual(indexed.progress);
  await db.update(messages).set({ content: "Synthetic edited source" }).where(eq(messages.id, firstId));
  expect(await saveFindingFeedback(serverId, owner.id, review.id, { revision: 1, version: review.version, value: "agree" })).toEqual({ saved: false });
  const withdrawn = await dashboard(serverId, owner.id);
  expect(withdrawn.pagination.total).toBe(0);
  expect(Object.values(withdrawn.findingIndex.kindCounts)).toEqual([0, 0, 0, 0]);
  expect(await db.select().from(raftbenchFindings)).toHaveLength(0);
  await db.insert(raftbenchFindings).values({ serverId, revision: 1, fingerprint: "synthetic-disable-feedback", pattern: stored.pattern, sourceRefs: stored.sourceRefs, feedback: { [owner.id]: "agree" } });
  await configure(serverId, owner.id, { enabled: false, channelIds: [channel.id], expectedRevision: 1 });
  expect(await db.select().from(raftbenchFindings)).toHaveLength(0);
  expect((await dashboard(serverId, owner.id)).progress).toMatchObject({ readMessages: 0, completedBatches: 0, scannedThroughAt: null });
});
