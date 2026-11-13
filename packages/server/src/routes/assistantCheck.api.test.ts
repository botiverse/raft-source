// RFC 077 step 2 (design v3.1): with ASSISTANT_RAFT_CHECK=on, a doorbell runs
// Raft's own check: one deterministic query over the owner's unread inbox,
// a wake only when something needs them, the items by id and the turn's input
// in `payload.check`, told by seq, quiet hours respected.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agents, assistantChecks, channels, assistantContactRules, assistantContactSettings, assistantDoorbells, assistantDoorbellSources, featureFlags, messages, thirdPartyAgentEvents, userChannelReadCursors, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createFeatureFlag, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { addMember } from "../services/serverService";
import { addHuman, createChannel, findOrCreateDM, findOrCreateUserDM, removeHuman } from "../services/channelService";
import { broadcastSystemMessage, createMessage } from "../services/messageService";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { setAssistantReadsDms } from "../services/assistantDmScope";
import { __resetAssistantBriefRowsSyncForTests, ASSISTANT_CHECK_LAG_MAX_WAIT_MS, ASSISTANT_CHECK_LAG_WAIT_MS, drainAssistantDoorbells, importAssistantCheckState, listOwnerInboxRows, runAssistantBriefs } from "../services/assistantService";
import { SYSTEM_ASSISTANT_APP } from "../services/agentAppEventsService";
import { listTold, recordTold } from "../services/assistantContactRulesService";
import { checkToldSeqs, planCheck, recordCheck } from "../services/assistantCheckService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";
import { tokenForHuman } from "../test/integration/credentials";
import { enablePersonalAssistants, withHostedRuntime } from "../test/hostedAssistantFixture";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
const deliverer = { deliverMessage: async () => {} } as unknown as Parameters<typeof drainAssistantDoorbells>[0]["deliverer"];

async function enableAssistants() {
  const [existing] = await getDb().select().from(featureFlags).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
  if (existing) {
    await getDb().update(featureFlags).set({ defaultEnabled: true }).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
    return;
  }
  await createFeatureFlag({ key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", enabled: true, defaultEnabled: true });
}

async function seed() {
  await enableAssistants();
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`check-owner-${suffix}@slock.test`, `check-owner-${suffix}`);
  const peer = await seedUser(`check-peer-${suffix}@slock.test`, `check-peer-${suffix}`);
  const server = await createServer("Check Server", `check-${suffix}`, owner.id);
  await addMember(server.id, peer.id);
  const room = await createChannel(server.id, `room-${suffix}`);
  await addHuman(room.id, owner.id);
  await addHuman(room.id, peer.id);
  const lobby = await createChannel(server.id, `lobby-${suffix}`);
  await addHuman(lobby.id, owner.id);
  await addHuman(lobby.id, peer.id);
  const assistant = await createAgent(server.id, `check-helper-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  await getDb().update(agents).set({ assistantOwnerUserId: owner.id }).where(eq(agents.id, assistant.id));
  const { apiKey } = await mintAgentCredential({ agentId: assistant.id, scopes: ["read", "send"], name: "check-test", issuedVia: "computer", createdByUserId: null });
  // No quiet hours unless a test sets them (the default 22:00-08:00 UTC would hold every check run at night).
  await getDb().insert(assistantContactSettings).values({ agentId: assistant.id, quiet: null });
  return { suffix, owner, peer, server, room, lobby, assistant, apiKey };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function ring(f: Fixture) {
  await getDb().insert(assistantDoorbells).values({ agentId: f.assistant.id, serverId: f.server.id, ownerUserId: f.owner.id, firstChangeAt: new Date() })
    .onConflictDoNothing();
}

async function drainOnce(f: Fixture) {
  await getDb().delete(thirdPartyAgentEvents).where(and(eq(thirdPartyAgentEvents.agentId, f.assistant.id), eq(thirdPartyAgentEvents.systemApp, SYSTEM_ASSISTANT_APP)));
  await ring(f);
  await drainAssistantDoorbells({ deliverer });
  const events = await getDb().select().from(thirdPartyAgentEvents)
    .where(and(eq(thirdPartyAgentEvents.agentId, f.assistant.id), eq(thirdPartyAgentEvents.systemApp, SYSTEM_ASSISTANT_APP)));
  return events.map((event) => event.payload as Record<string, any>);
}

/** The owner asked to hear everything in a channel: chat there wakes a doorbell though it names no one. */
async function hearAll(f: Fixture, channelId: string) {
  await getDb().insert(assistantContactRules).values({ agentId: f.assistant.id, serverId: f.server.id, effect: "always", subjectKind: "channel", subjectId: channelId });
}

/** As if the last DM went out longer ago than the spacing between doorbell DMs. */
async function pastSpacing(f: Fixture) {
  await getDb().update(assistantChecks).set({ createdAt: sql`${assistantChecks.createdAt} - interval '31 minutes'` }).where(eq(assistantChecks.agentId, f.assistant.id));
}

/** A brief's check, planned and recorded now (the brief's schedule is tested on its own). */
async function briefCheck(f: Fixture) {
  const now = new Date();
  const plan = await planCheck({ agentId: f.assistant.id, serverId: f.server.id, ownerUserId: f.owner.id, trigger: "brief", now });
  assert.equal(plan.kind, "wake");
  if (plan.kind !== "wake") throw new Error("no brief");
  await recordCheck(getDb(), { agentId: f.assistant.id, check: plan.check, items: plan.items, briefDay: null, now });
  return plan.check;
}

async function withRaftCheck<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env.ASSISTANT_RAFT_CHECK;
  process.env.ASSISTANT_RAFT_CHECK = "on";
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.ASSISTANT_RAFT_CHECK; else process.env.ASSISTANT_RAFT_CHECK = saved;
  }
}

test("on: a doorbell wakes with Raft's check (items by id, the turn's input, tools by placeholder) only when something needs the owner", async ({ app }) => {
  assert.ok(app);
  const f = await seed();
  await withRaftCheck(async () => {
    await createMessage(f.lobby.id, "user", f.peer.id, "lunch anyone?");
    assert.deepEqual(await drainOnce(f), [], "general chat alone: no wake");
    assert.equal((await getDb().select().from(assistantDoorbells).where(eq(assistantDoorbells.agentId, f.assistant.id))).length, 0, "the doorbell is taken");

    await createMessage(f.room.id, "user", f.peer.id, `@${f.owner.name} can you review the launch plan?`);
    const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
    await createMessage(dm!.id, "user", f.peer.id, "quick question for you");
    const drained = await drainOnce(f);
    const [payload] = drained;
    assert.ok(payload?.check, `drained: ${JSON.stringify(drained)}`);
    const check = payload.check;
    assert.equal(check.version, 1);
    assert.equal(check.trigger, "doorbell");
    assert.deepEqual(check.allowed_tools, ["notify", "owner_messages", "note_decision"]);
    const byChannel = Object.fromEntries((check.items as Array<{ channelId: string; why: string }>).map((item) => [item.channelId, item.why]));
    // createMessage records no @mention fact here, so the room's message only names the owner: that waits for the brief.
    assert.deepEqual(byChannel, { [dm!.id]: "dm" });
    assert.match(check.instruction, /\{\{tool:notify\}\}/);
    assert.match(check.instruction, /quick question for you/);
    assert.equal(check.instruction.includes("lunch anyone") || check.instruction.includes("launch plan"), false, "what does not need the owner now is not in the input");
    assert.equal(check.counts.items, 1);
    assert.equal(check.counts.default_out, 1);
    assert.equal(check.counts.digest, 1);
    const [stored] = await getDb().select().from(assistantChecks).where(eq(assistantChecks.id, check.id));
    assert.equal(stored?.trigger, "doorbell");
    assert.equal((stored?.items as unknown[]).length, 1);

    const context = await fetch(`${app.baseUrl}/internal/agent-api/context`, { headers: { Authorization: `Bearer ${f.apiKey}` } });
    assert.equal(((await context.json()) as { agent: { assistantOf: { raftCheck: boolean } } }).agent.assistantOf.raftCheck, true);
  });
});

test("on: the check asks for the lines in the owner's language when Raft knows it, the same one the fixed lines use", async ({ app }) => {
  assert.ok(app);
  const f = await seed();
  await withRaftCheck(async () => {
    await hearAll(f, f.room.id);
    await createMessage(f.room.id, "user", f.peer.id, `@${f.owner.name} can you review the launch plan?`);
    const [unknown] = await drainOnce(f);
    assert.ok(unknown?.check);
    assert.equal(unknown.check.instruction.includes("Write every line in"), false, "no language known: nothing is asked");

    await getDb().update(users).set({ displayLanguage: "en", preferredLanguage: "zh-CN" }).where(eq(users.id, f.owner.id));
    await createMessage(f.room.id, "user", f.peer.id, `@${f.owner.name} and the pricing page?`);
    const [stated] = await drainOnce(f);
    assert.ok(stated?.check);
    assert.match(stated.check.instruction, /Write every line in Chinese \(China\), your owner's language/);
  });
});

test("on: told covers a conversation up to the told message's seq; new activity brings it back", async ({ app }) => {
  assert.ok(app);
  const f = await seed();
  await withRaftCheck(async () => {
    await hearAll(f, f.room.id);
    const asked = await createMessage(f.room.id, "user", f.peer.id, `@${f.owner.name} sign off?`);
    await recordTold({ agentId: f.assistant.id, serverId: f.server.id, ownerUserId: f.owner.id }, { messageIds: [asked.id], via: "notify" });
    assert.deepEqual(await drainOnce(f), [], "already told: nothing to wake for");
    await createMessage(f.room.id, "user", f.peer.id, `@${f.owner.name} ping?`);
    const [payload] = await drainOnce(f);
    assert.deepEqual((payload?.check.items as Array<{ channelId: string }>).map((item) => item.channelId), [f.room.id]);
  });
});

test("on: quiet hours hold everything (no read, no wake); off: the doorbell is as before", async ({ app }) => {
  assert.ok(app);
  const f = await seed();
  await createMessage(f.room.id, "user", f.peer.id, `@${f.owner.name} urgent?`);
  await withRaftCheck(async () => {
    const hour = new Date().getUTCHours();
    const from = `${String(hour).padStart(2, "0")}:00`;
    const to = `${String((hour + 2) % 24).padStart(2, "0")}:00`;
    await getDb().update(assistantContactSettings).set({ quiet: { from, to } }).where(eq(assistantContactSettings.agentId, f.assistant.id));
    assert.deepEqual(await drainOnce(f), []);
  });
  const [payload] = await drainOnce(f);
  assert.equal(payload?.type, "owner_inbox_updated");
  assert.equal("check" in payload!, false, "off: no check");
  // RFC 081: every doorbell is on the owner inbox's one item.
  const [event] = await getDb().select({ objectRef: thirdPartyAgentEvents.objectRef }).from(thirdPartyAgentEvents)
    .where(and(eq(thirdPartyAgentEvents.agentId, f.assistant.id), eq(thirdPartyAgentEvents.systemApp, SYSTEM_ASSISTANT_APP)));
  assert.equal(event?.objectRef, `owner-inbox/${f.owner.id}`);
});

async function notify(baseUrl: string, apiKey: string, body: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api/assistant/notify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

test("notify: Raft composes the owner DM from the model's lines (at most 3, then N more), records it as told, and never sends twice; what the model left out, a DM too, is held", async ({ app }) => {
  const f = await seed();
  const ownDm = await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id);
  assert.ok(ownDm);
  await withRaftCheck(async () => {
    const channels: Array<Awaited<ReturnType<typeof createChannel>>> = [];
    for (let i = 0; i < 4; i++) {
      const channel = await createChannel(f.server.id, `ask-${i}-${f.suffix}`);
      await addHuman(channel.id, f.owner.id);
      await addHuman(channel.id, f.peer.id);
      await hearAll(f, channel.id);
      await createMessage(channel.id, "user", f.peer.id, `${f.owner.name}, item ${i}?`);
      channels.push(channel);
    }
    await createMessage(f.lobby.id, "user", f.peer.id, `${f.owner.name} lol`);
    const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
    await createMessage(dm!.id, "user", f.peer.id, "can you sign?");
    const [payload] = await drainOnce(f);
    const check = payload!.check;
    assert.equal(check.items.length, 5, "the lobby joke only names the owner: it waits for the brief");

    const unknown = await notify(app.baseUrl, f.apiKey, { check_id: randomUUID(), idempotency_key: "k0", items: [] });
    assert.deepEqual([unknown.status, unknown.body.code], [409, "check_unknown"]);

    // The model writes lines for the four asks and judges the DM not worth a line now: the assistant decides.
    const items = channels.map((channel, i) => ({ channelId: channel.id, summary: `@${f.peer.name} asks about item ${i}`, kind: "question" }));
    const sent = await notify(app.baseUrl, f.apiKey, { check_id: check.id, idempotency_key: "turn-1", items: [...items, { channelId: randomUUID(), summary: "x" }] });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepEqual([sent.body.outcome, sent.body.shown, sent.body.more], ["sent", 3, 1]);
    assert.deepEqual(sent.body.dropped.map((d: { reason: string }) => d.reason), ["not_in_check"]);
    assert.deepEqual(sent.body.reasons, { question: 4 }, "every line sent says why");
    const [message] = await getDb().select().from(messages).where(and(eq(messages.channelId, ownDm.id), eq(messages.senderId, f.assistant.id)));
    const lines = message!.content.split("\n");
    assert.equal(lines.length, 4);
    assert.equal(message!.content.includes("dm:@"), false, "the DM the model left out gets no line of Raft's");
    assert.match(lines[3]!, /^1 more \(1 in #ask-\d-\w+\) — reply "more" to see them\.$/);
    assert.ok(lines.slice(0, 3).every((line) => /asks about item \d: #ask-\d-/.test(line)), lines.join("\n"));

    // A check is answered once: a retry with the same key, or another key, gets the first result and sends nothing.
    for (const key of ["turn-1", "turn-2"]) {
      const again = await notify(app.baseUrl, f.apiKey, { check_id: check.id, idempotency_key: key, items });
      assert.deepEqual(again.body, sent.body);
    }
    assert.equal((await getDb().select().from(messages).where(and(eq(messages.channelId, ownDm.id), eq(messages.senderId, f.assistant.id)))).length, 1);

    // Shown ones are told; the held-back one and the left-out DM are held: the next doorbell is not a second batch of the same backlog.
    await pastSpacing(f);
    assert.deepEqual(await drainOnce(f), [], "no doorbell drains the backlog a few at a time, nor offers the left-out DM again");
    // "more" still lists the held ask, the left-out DM (a hold is not a telling) and the lobby joke; the shown three are told.
    const untold = await fetch(`${app.baseUrl}/internal/agent-api/assistant/owner-inbox?filter=untold`, { headers: { Authorization: `Bearer ${f.apiKey}` } });
    const heldIds = ((await untold.json()) as { items: Array<{ channelId: string }> }).items.map((item) => item.channelId);
    assert.equal(heldIds.length, 3, `the held ask, the left-out DM and the lobby: ${JSON.stringify(heldIds)}`);
    assert.equal(heldIds.filter((id) => channels.some((channel) => channel.id === id)).length, 1);
    assert.ok(heldIds.includes(dm!.id));

    // New activity in a held conversation brings back that one only.
    const moved = channels.find((channel) => heldIds.includes(channel.id))!;
    await createMessage(moved.id, "user", f.peer.id, `${f.owner.name}, still need you here`);
    const [next] = await drainOnce(f);
    assert.deepEqual((next!.check.items as Array<{ channelId: string }>).map((item) => item.channelId), [moved.id]);

    // The brief lists what is still waiting, held or not, with the lobby joke for the model to judge.
    const brief = await briefCheck(f);
    const briefIds = new Set((brief.items as Array<{ channelId: string }>).map((item) => item.channelId));
    assert.ok(heldIds.every((id) => briefIds.has(id)), JSON.stringify([...briefIds]));
  });
});

test("doorbell DMs are spaced: what rings within the window waits on the doorbell and goes out together after it", async ({ app }) => {
  const f = await seed();
  assert.ok(await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id));
  await withRaftCheck(async () => {
    const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
    await createMessage(dm!.id, "user", f.peer.id, "first question");
    const [first] = await drainOnce(f);
    assert.equal((await notify(app.baseUrl, f.apiKey, { check_id: first!.check.id, idempotency_key: "a", items: [{ channelId: dm!.id, summary: "a question" }] })).body.outcome, "sent");

    await hearAll(f, f.room.id);
    await createMessage(f.room.id, "user", f.peer.id, "news in the room");
    await createMessage(dm!.id, "user", f.peer.id, "second question");
    assert.deepEqual(await drainOnce(f), [], "within the window: nothing");
    assert.equal((await getDb().select().from(assistantDoorbells).where(eq(assistantDoorbells.agentId, f.assistant.id))).length, 1, "the doorbell waits");

    await pastSpacing(f);
    const [later] = await drainOnce(f);
    assert.deepEqual(new Set((later!.check.items as Array<{ channelId: string }>).map((item) => item.channelId)), new Set([dm!.id, f.room.id]));
  });
});

test("notify: what the owner's always rule let through is shown even when the model wrote no line for it; anything else left out sends nothing", async ({ app }) => {
  const f = await seed();
  const ownDm = await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id);
  assert.ok(ownDm);
  await withRaftCheck(async () => {
    // The owner asked to hear everything in the room: chat there needs them, though it names no one.
    await getDb().insert(assistantContactRules).values({ agentId: f.assistant.id, serverId: f.server.id, effect: "always", subjectKind: "channel", subjectId: f.room.id });
    await createMessage(f.room.id, "user", f.peer.id, "status update on the launch");
    const [payload] = await drainOnce(f);
    const check = payload!.check;
    assert.deepEqual((check.items as Array<{ channelId: string; why: string }>).map((item) => item.why), ["always"]);

    // The model wrote no line for it: the owner's rule still holds, with Raft's fixed line.
    const sent = await notify(app.baseUrl, f.apiKey, { check_id: check.id, idempotency_key: "k", items: [] });
    assert.deepEqual([sent.body.outcome, sent.body.shown, sent.body.more, sent.body.reasons], ["sent", 1, 0, { owner_rule: 1 }]);
    const [message] = await getDb().select().from(messages).where(and(eq(messages.channelId, ownDm.id), eq(messages.senderId, f.assistant.id)));
    assert.match(message!.content, new RegExp(`^@${f.peer.name} in #`));

    // A DM the model leaves out (or writes no words for) sends nothing, and is not offered again until it moves.
    await pastSpacing(f);
    const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
    await createMessage(dm!.id, "user", f.peer.id, "fyi, shipped");
    const [next] = await drainOnce(f);
    const quiet = await notify(app.baseUrl, f.apiKey, { check_id: next!.check.id, idempotency_key: "k2", items: [{ channelId: dm!.id, summary: " " }] });
    assert.deepEqual([quiet.body.outcome, quiet.body.shown, quiet.body.more], ["nothing_to_send", 0, 0]);
    assert.equal((await getDb().select().from(messages).where(and(eq(messages.channelId, ownDm.id), eq(messages.senderId, f.assistant.id)))).length, 1);
    await pastSpacing(f);
    assert.deepEqual(await drainOnce(f), [], "held: not offered again until it moves");
  });
});

test("a doorbell waiting out its spacing holds no place in the batch: a newer one that may go out is taken", async ({ app }) => {
  assert.ok(app);
  const waiting = await seed();
  const fresh = await seed();
  assert.ok(await findOrCreateDM(waiting.server.id, waiting.owner.id, waiting.assistant.id));
  await withRaftCheck(async () => {
    const dm = await findOrCreateUserDM(waiting.server.id, waiting.owner.id, waiting.peer.id);
    await createMessage(dm!.id, "user", waiting.peer.id, "first question");
    const [first] = await drainOnce(waiting);
    assert.equal((await notify(app.baseUrl, waiting.apiKey, { check_id: first!.check.id, idempotency_key: "a", items: [{ channelId: dm!.id, summary: "a question" }] })).body.outcome, "sent");
    // The waiting one rang first (the oldest doorbell); the fresh one rang after.
    await createMessage(dm!.id, "user", waiting.peer.id, "second question");
    await ring(waiting);
    const freshDm = await findOrCreateUserDM(fresh.server.id, fresh.owner.id, fresh.peer.id);
    await createMessage(freshDm!.id, "user", fresh.peer.id, "a question for you");
    await getDb().insert(assistantDoorbells).values({ agentId: fresh.assistant.id, serverId: fresh.server.id, ownerUserId: fresh.owner.id, firstChangeAt: new Date(Date.now() + 1_000) });

    // Only this drain's wakes count (and no recent wake shields the waiting one: only its spacing does).
    await getDb().delete(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.systemApp, SYSTEM_ASSISTANT_APP));
    await drainAssistantDoorbells({ deliverer, batch: 1 });
    const woke = async (f: Fixture) => (await getDb().select().from(thirdPartyAgentEvents)
      .where(and(eq(thirdPartyAgentEvents.agentId, f.assistant.id), eq(thirdPartyAgentEvents.systemApp, SYSTEM_ASSISTANT_APP)))).length;
    assert.equal(await woke(fresh), 1, "the fresh doorbell is taken although the batch holds one");
    assert.equal(await woke(waiting), 0, "the waiting one still waits");
    assert.equal((await getDb().select().from(assistantDoorbells).where(eq(assistantDoorbells.agentId, waiting.assistant.id))).length, 1);
  });
});

test("brief: the first pass holds today's brief until the runtime's import; then the same query in brief mode, once a day", async ({ app }) => {
  assert.ok(app);
  const f = await seed();
  await withRaftCheck(async () => {
    const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
    await createMessage(dm!.id, "user", f.peer.id, "can you look at this today?");
    const briefs = async () => (await getDb().select().from(thirdPartyAgentEvents)
      .where(and(eq(thirdPartyAgentEvents.agentId, f.assistant.id), eq(thirdPartyAgentEvents.systemApp, SYSTEM_ASSISTANT_APP))))
      .map((event) => event.payload as Record<string, any>).filter((payload) => payload.type === "owner_brief");
    // 09:00 owner-local (no zone known: UTC). The first pass only schedules and holds today.
    __resetAssistantBriefRowsSyncForTests();
    const nine = new Date("2030-01-02T09:00:00Z");
    assert.equal(await runAssistantBriefs({ deliverer, now: nine }), 0);
    assert.equal(await runAssistantBriefs({ deliverer, now: new Date("2030-01-02T09:05:00Z") }), 0, "held: no import yet");
    assert.deepEqual(await briefs(), []);

    // The runtime says it did not brief today: due now.
    const owner = { agentId: f.assistant.id, serverId: f.server.id, ownerUserId: f.owner.id };
    assert.deepEqual(await importAssistantCheckState(owner, { briefSent: "2030-01-01" }, new Date("2030-01-02T09:06:00Z")), { briefToday: "due" });
    assert.equal(await runAssistantBriefs({ deliverer, now: new Date("2030-01-02T09:07:00Z") }), 1);
    const [brief] = await briefs();
    assert.equal(brief?.check.trigger, "brief");
    // RFC 081: each day's brief is its own item.
    const [briefEvent] = await getDb().select({ objectRef: thirdPartyAgentEvents.objectRef }).from(thirdPartyAgentEvents)
      .where(and(eq(thirdPartyAgentEvents.agentId, f.assistant.id), sql`${thirdPartyAgentEvents.payload} ->> 'type' = 'owner_brief'`));
    assert.equal(briefEvent?.objectRef, "brief/2030-01-02");
    assert.deepEqual((brief?.check.items as Array<{ channelId: string; why: string }>).map((item) => item.why), ["dm"]);
    const [stored] = await getDb().select().from(assistantChecks).where(eq(assistantChecks.id, brief!.check.id));
    assert.equal(stored?.briefDay, "2030-01-02");
    // Once a day: a second import or sweep does not brief again.
    assert.deepEqual(await importAssistantCheckState(owner, { briefSent: null }, new Date("2030-01-02T09:30:00Z")), { briefToday: "sent" });
    assert.equal(await runAssistantBriefs({ deliverer, now: new Date("2030-01-02T10:00:00Z") }), 0);
    // The next morning, without anything from the runtime.
    assert.equal(await runAssistantBriefs({ deliverer, now: new Date("2030-01-03T08:01:00Z") }), 1);
  });
});

test("brief: an assistant made while Raft runs the checks is briefed on its first day, with no import to wait for", async ({ app }) => {
  await withHostedRuntime(async () => {
    const suffix = randomUUID().slice(0, 8);
    const owner = await seedUser(`brief-new-owner-${suffix}@slock.test`, `brief-new-owner-${suffix}`);
    const peer = await seedUser(`brief-new-peer-${suffix}@slock.test`, `brief-new-peer-${suffix}`);
    const server = await createServer("Brief New", `brief-new-${suffix}`, owner.id);
    await addMember(server.id, peer.id);
    await enablePersonalAssistants(server.id);
    await withRaftCheck(async () => {
      const created = await fetch(`${app.baseUrl}/api/servers/${server.id}/assistant`, {
        method: "POST",
        headers: headers(await tokenForHuman(owner.email), server.id),
        body: JSON.stringify({ name: "Ada" }),
      });
      assert.equal(created.status, 201);
      const agentId = (await created.json() as { assistant: { agentId: string } }).assistant.agentId;
      await getDb().insert(assistantContactSettings).values({ agentId, quiet: null }).onConflictDoNothing();
      const dm = await findOrCreateUserDM(server.id, owner.id, peer.id);
      await createMessage(dm!.id, "user", peer.id, "welcome! can you check this?");
      __resetAssistantBriefRowsSyncForTests();
      assert.equal(await runAssistantBriefs({ deliverer, now: new Date("2030-01-02T09:00:00Z") }), 1, "no hold: briefed on day one");
    });
  });
});

test("brief: a runtime that already briefed today keeps Raft from briefing until tomorrow", async ({ app }) => {
  assert.ok(app);
  const f = await seed();
  await withRaftCheck(async () => {
    const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
    await createMessage(dm!.id, "user", f.peer.id, "ping");
    const owner = { agentId: f.assistant.id, serverId: f.server.id, ownerUserId: f.owner.id };
    assert.deepEqual(await importAssistantCheckState(owner, { briefSent: "2030-01-02" }, new Date("2030-01-02T09:00:00Z")), { briefToday: "sent" });
    assert.equal(await runAssistantBriefs({ deliverer, now: new Date("2030-01-02T09:01:00Z") }), 0);
    assert.equal(await runAssistantBriefs({ deliverer, now: new Date("2030-01-03T08:00:30Z") }), 1);
  });
});

test("notify: the owner's kind rules hold for every line, a DM's too; a telling recorded since the check does not drop it; what the owner can no longer see is not sent", async ({ app }) => {
  const f = await seed();
  const ownDm = await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id);
  assert.ok(ownDm);
  await withRaftCheck(async () => {
    const owner = { agentId: f.assistant.id, serverId: f.server.id, ownerUserId: f.owner.id };
    // The owner said reviews can go: a kind mute.
    await getDb().insert(assistantContactRules).values({ agentId: f.assistant.id, serverId: f.server.id, effect: "mute", subjectKind: "kind", subjectId: "review" });
    const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
    const asked = await createMessage(dm!.id, "user", f.peer.id, "can you sign the contract?");
    const club = await createChannel(f.server.id, `club-${f.suffix}`, undefined, "private");
    await addHuman(club.id, f.owner.id);
    await addHuman(club.id, f.peer.id);
    await hearAll(f, club.id);
    await createMessage(club.id, "user", f.peer.id, `${f.owner.name}, quick one?`);
    const [payload] = await drainOnce(f);
    const check = payload!.check;
    assert.equal(check.items.length, 2);

    // The model marks the DM as told through the chat route.
    await recordTold(owner, { messageIds: [asked.id], via: "chat" });
    // The owner leaves the private channel before the notify.
    await removeHuman(club.id, f.owner.id, { self: true });
    const result = await notify(app.baseUrl, f.apiKey, {
      check_id: check.id,
      idempotency_key: "turn-x",
      items: [{ channelId: dm!.id, summary: "sign the contract", kind: "question" }, { channelId: club.id, summary: "secret plans", kind: "question" }],
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual([result.body.outcome, result.body.shown], ["sent", 1]);
    assert.deepEqual(result.body.dropped, [{ channelId: club.id, reason: "not_visible" }]);
    assert.deepEqual(result.body.reasons, { question: 1 });
    const [message] = await getDb().select().from(messages).where(and(eq(messages.channelId, ownDm.id), eq(messages.senderId, f.assistant.id)));
    assert.match(message!.content, /sign the contract/);
    assert.equal(message!.content.includes("secret plans") || message!.content.includes(club.name), false);

    // A skip is never listed as a telling.
    const listed = await listTold(f.assistant.id, { since: new Date(0), limit: 50 });
    assert.ok(listed.items.every((item) => item.via !== "skipped"));
  });
});

test("notify: an owner's kind rule mutes a DM's line; a brief the assistant finds nothing in is not sent, and what it passed over is still listed", async ({ app }) => {
  const f = await seed();
  const ownDm = await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id);
  assert.ok(ownDm);
  await withRaftCheck(async () => {
    // "Review requests can wait for me to look": a kind mute, applied to a DM too.
    await getDb().insert(assistantContactRules).values({ agentId: f.assistant.id, serverId: f.server.id, effect: "mute", subjectKind: "kind", subjectId: "review" });
    const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
    await createMessage(dm!.id, "user", f.peer.id, "could you review my PR?");
    const [payload] = await drainOnce(f);
    const muted = await notify(app.baseUrl, f.apiKey, { check_id: payload!.check.id, idempotency_key: "m", items: [{ channelId: dm!.id, summary: "review a PR", kind: "review" }] });
    assert.deepEqual([muted.body.outcome, muted.body.dropped], ["nothing_to_send", [{ channelId: dm!.id, reason: "rule_mute" }]]);

    // The brief: the assistant keeps nothing, so nothing is sent (no "Morning." on its own).
    await createMessage(dm!.id, "user", f.peer.id, "also, fyi: the build is green");
    const brief = await briefCheck(f);
    assert.ok((brief.items as Array<{ channelId: string }>).some((item) => item.channelId === dm!.id));
    const none = await notify(app.baseUrl, f.apiKey, { check_id: brief.id, idempotency_key: "b", items: [] });
    assert.deepEqual([none.body.outcome, none.body.shown], ["nothing_to_send", 0]);
    assert.equal((await getDb().select().from(messages).where(and(eq(messages.channelId, ownDm.id), eq(messages.senderId, f.assistant.id)))).length, 0, "no brief DM");
    // Passed over is not told: "more" still lists it.
    const untold = await fetch(`${app.baseUrl}/internal/agent-api/assistant/owner-inbox?filter=untold`, { headers: { Authorization: `Bearer ${f.apiKey}` } });
    assert.ok(((await untold.json()) as { items: Array<{ channelId: string }> }).items.some((item) => item.channelId === dm!.id));
  });
});

test("on: a doorbell whose inbox read trails it waits for the next poll, then goes ahead after a minute; told only at what was read", async ({ app }) => {
  assert.ok(app);
  const f = await seed();
  await withRaftCheck(async () => {
    const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
    const asked = await createMessage(dm!.id, "user", f.peer.id, "are you there?");
    await getDb().delete(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.agentId, f.assistant.id));
    // The doorbell says the DM rang at a seq the inbox read does not show yet (the read trails the insert).
    const now = new Date();
    await getDb().insert(assistantDoorbells).values({ agentId: f.assistant.id, serverId: f.server.id, ownerUserId: f.owner.id, firstChangeAt: now }).onConflictDoNothing();
    await getDb().insert(assistantDoorbellSources).values({ agentId: f.assistant.id, sourceChannelId: dm!.id, maxSeq: Number(asked.seq) + 5 })
      .onConflictDoUpdate({ target: [assistantDoorbellSources.agentId, assistantDoorbellSources.sourceChannelId], set: { maxSeq: Number(asked.seq) + 5 } });
    const events = async () => (await getDb().select().from(thirdPartyAgentEvents)
      .where(and(eq(thirdPartyAgentEvents.agentId, f.assistant.id), eq(thirdPartyAgentEvents.systemApp, SYSTEM_ASSISTANT_APP)))).length;

    assert.equal(await drainAssistantDoorbells({ deliverer, now }), 0);
    assert.equal(await events(), 0, "behind: no wake yet");
    assert.equal((await getDb().select().from(assistantDoorbells).where(eq(assistantDoorbells.agentId, f.assistant.id))).length, 1, "the doorbell stays for the next poll");
    assert.equal(await drainAssistantDoorbells({ deliverer, now: new Date(now.getTime() + 5_000) }), 0, "still behind, still waiting");

    // After a minute it goes ahead on what was read; the check's item carries the seq that was read.
    assert.equal(await drainAssistantDoorbells({ deliverer, now: new Date(now.getTime() + ASSISTANT_CHECK_LAG_WAIT_MS + 1_000) }), 1);
    const [check] = await getDb().select().from(assistantChecks).where(eq(assistantChecks.agentId, f.assistant.id));
    const item = (check!.items as Array<{ channelId: string; latestSeq: number }>).find((i) => i.channelId === dm!.id);
    assert.equal(item?.latestSeq, Number(asked.seq), "told will cover what was read, never past it");
  });
});

test("on: the read-lag wait is timed on the doorbell: an earlier doorbell's wait never cuts a new one short, and a new message restarts it", async ({ app }) => {
  assert.ok(app);
  const f = await seed();
  await withRaftCheck(async () => {
    const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
    const asked = await createMessage(dm!.id, "user", f.peer.id, "still there?");
    const ring = async (maxSeq: number, firstChangeAt: Date) => {
      await getDb().insert(assistantDoorbells).values({ agentId: f.assistant.id, serverId: f.server.id, ownerUserId: f.owner.id, firstChangeAt }).onConflictDoNothing();
      await getDb().insert(assistantDoorbellSources).values({ agentId: f.assistant.id, sourceChannelId: dm!.id, maxSeq })
        .onConflictDoUpdate({ target: [assistantDoorbellSources.agentId, assistantDoorbellSources.sourceChannelId], set: { maxSeq } });
    };
    const pending = async () => (await getDb().select().from(assistantDoorbells).where(eq(assistantDoorbells.agentId, f.assistant.id)))[0] ?? null;
    await getDb().delete(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.agentId, f.assistant.id));
    const t0 = new Date();
    const at = (ms: number) => new Date(t0.getTime() + ms);

    // A first doorbell starts waiting, then another replica takes it (it is gone).
    await ring(Number(asked.seq) + 5, t0);
    assert.equal(await drainAssistantDoorbells({ deliverer, now: t0 }), 0);
    assert.ok((await pending())?.behindSince, "the wait starts on the doorbell row");
    await getDb().delete(assistantDoorbells).where(eq(assistantDoorbells.agentId, f.assistant.id));
    await getDb().delete(assistantDoorbellSources).where(eq(assistantDoorbellSources.agentId, f.assistant.id));

    // Ten minutes later a new doorbell trails the read too: it gets its own full wait (10:57, InNOut).
    await ring(Number(asked.seq) + 6, at(10 * 60_000));
    assert.equal(await drainAssistantDoorbells({ deliverer, now: at(10 * 60_000) }), 0, "waits, not an instant give-up");
    assert.equal(await drainAssistantDoorbells({ deliverer, now: at(10 * 60_000 + 50_000) }), 0);

    // A new message rings while it waits: the wait starts again for it.
    await ring(Number(asked.seq) + 7, at(10 * 60_000));
    assert.equal(await drainAssistantDoorbells({ deliverer, now: at(10 * 60_000 + 65_000) }), 0, "the new message gets a full wait");
    assert.equal(await drainAssistantDoorbells({ deliverer, now: at(10 * 60_000 + 65_000 + ASSISTANT_CHECK_LAG_WAIT_MS - 1_000) }), 0);
    assert.equal(await drainAssistantDoorbells({ deliverer, now: at(10 * 60_000 + 65_000 + ASSISTANT_CHECK_LAG_WAIT_MS + 1_000) }), 1, "then goes ahead on what was read");
  });
});

test("on: a read that stays behind while new messages keep ringing still goes out within the total cap", async ({ app }) => {
  assert.ok(app);
  const f = await seed();
  await withRaftCheck(async () => {
    const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
    const asked = await createMessage(dm!.id, "user", f.peer.id, "busy day");
    await getDb().delete(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.agentId, f.assistant.id));
    const t0 = new Date();
    await getDb().insert(assistantDoorbells).values({ agentId: f.assistant.id, serverId: f.server.id, ownerUserId: f.owner.id, firstChangeAt: t0 }).onConflictDoNothing();
    // Every 30 s for 5 minutes a new message rings at a seq the read never shows.
    let sentAt: number | null = null;
    for (let ms = 0; ms <= 5 * 60_000 && sentAt === null; ms += 30_000) {
      const maxSeq = Number(asked.seq) + 10 + ms / 30_000;
      await getDb().insert(assistantDoorbellSources).values({ agentId: f.assistant.id, sourceChannelId: dm!.id, maxSeq })
        .onConflictDoUpdate({ target: [assistantDoorbellSources.agentId, assistantDoorbellSources.sourceChannelId], set: { maxSeq } });
      if (await drainAssistantDoorbells({ deliverer, now: new Date(t0.getTime() + ms) }) === 1) sentAt = ms;
    }
    assert.ok(sentAt !== null, "it went out");
    assert.ok(sentAt! >= ASSISTANT_CHECK_LAG_MAX_WAIT_MS && sentAt! < ASSISTANT_CHECK_LAG_MAX_WAIT_MS + 30_000, `sent at ${sentAt} ms: at the total cap`);
  });
});

test("on: a conversation missing from the read counts as behind unless the owner has read up to it", async ({ app }) => {
  assert.ok(app);
  const f = await seed();
  await withRaftCheck(async () => {
    const ring = async (channelId: string, maxSeq: number, now: Date) => {
      await getDb().delete(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.agentId, f.assistant.id));
      await getDb().delete(assistantDoorbellSources).where(eq(assistantDoorbellSources.agentId, f.assistant.id));
      await getDb().insert(assistantDoorbells).values({ agentId: f.assistant.id, serverId: f.server.id, ownerUserId: f.owner.id, firstChangeAt: now }).onConflictDoNothing();
      await getDb().insert(assistantDoorbellSources).values({ agentId: f.assistant.id, sourceChannelId: channelId, maxSeq });
    };
    const kept = async () => (await getDb().select().from(assistantDoorbells).where(eq(assistantDoorbells.agentId, f.assistant.id))).length;
    // A new DM whose only message the read does not show yet.
    const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
    const first = await createMessage(dm!.id, "user", f.peer.id, "hi");
    await getDb().update(userChannelReadCursors).set({ lastReadSeq: Number(first.seq) }).where(and(eq(userChannelReadCursors.userId, f.owner.id), eq(userChannelReadCursors.channelId, dm!.id)));
    await getDb().insert(userChannelReadCursors).values({ userId: f.owner.id, channelId: dm!.id, lastReadSeq: Number(first.seq) }).onConflictDoNothing();
    const now = new Date();
    await ring(dm!.id, Number(first.seq) + 3, now);
    assert.equal(await drainAssistantDoorbells({ deliverer, now }), 0);
    assert.equal(await kept(), 1, "not in the read, owner has not read it: behind, the doorbell stays");

    // The owner has read up to it themself: nothing to wait for.
    await getDb().update(userChannelReadCursors).set({ lastReadSeq: Number(first.seq) + 3 }).where(and(eq(userChannelReadCursors.userId, f.owner.id), eq(userChannelReadCursors.channelId, dm!.id)));
    await drainAssistantDoorbells({ deliverer, now: new Date(now.getTime() + 5_000) });
    assert.equal(await kept(), 0, "read by the owner: decided at once");
  });
});

test("owner inbox: every row says whether the owner was told; untold lists only what was not, with the total, whatever the page", async ({ app }) => {
  const f = await seed();
  const owner = { agentId: f.assistant.id, serverId: f.server.id, ownerUserId: f.owner.id };
  const inbox = async (query: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/assistant/owner-inbox?${query}`, { headers: { Authorization: `Bearer ${f.apiKey}` } });
    assert.equal(res.status, 200, await res.clone().text());
    return await res.json() as { filter: string; items: Array<{ channelId: string; told?: boolean }>; hasMore: boolean; nextOffset: number | null; total?: number; totalCapped?: boolean };
  };
  const told = await createMessage(f.room.id, "user", f.peer.id, "told about this one");
  const skipped = await createMessage(f.lobby.id, "user", f.peer.id, "skipped this one");
  const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
  await createMessage(dm!.id, "user", f.peer.id, "nobody said anything about this");
  await recordTold(owner, { messageIds: [told.id], via: "notify" });
  await recordTold(owner, { messageIds: [skipped.id], via: "skipped" });

  const unread = await inbox("filter=unread");
  assert.equal(unread.total, undefined, "total only with untold");
  assert.deepEqual(Object.fromEntries(unread.items.map((item) => [item.channelId, item.told])), { [f.room.id]: true, [f.lobby.id]: false, [dm!.id]: false });

  const untold = await inbox("filter=untold");
  assert.equal(untold.filter, "untold");
  assert.deepEqual(new Set(untold.items.map((item) => item.channelId)), new Set([f.lobby.id, dm!.id]), "a skip is not a telling");
  assert.ok(untold.items.every((item) => item.told === false));
  assert.deepEqual([untold.total, untold.totalCapped, untold.hasMore], [2, false, false]);

  // Paging over the untold list; the total stays the same.
  const first = await inbox("filter=untold&limit=1");
  assert.deepEqual([first.items.length, first.total, first.hasMore, first.nextOffset], [1, 2, true, 1]);
  const second = await inbox("filter=untold&limit=1&offset=1");
  assert.deepEqual([second.items.length, second.total, second.hasMore, second.nextOffset], [1, 2, false, null]);
  assert.notEqual(first.items[0]!.channelId, second.items[0]!.channelId);

  // New activity in the told conversation makes it untold again.
  await createMessage(f.room.id, "user", f.peer.id, "and something new");
  assert.equal((await inbox("filter=untold")).total, 3);
});

test("owner inbox: a conversation notified, then skipped at a newer message, is untold again (the skip does not move the telling up)", async ({ app }) => {
  const f = await seed();
  assert.ok(await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id));
  await withRaftCheck(async () => {
    const inbox = async () => {
      const res = await fetch(`${app.baseUrl}/internal/agent-api/assistant/owner-inbox?filter=untold`, { headers: { Authorization: `Bearer ${f.apiKey}` } });
      return await res.json() as { items: Array<{ channelId: string }>; total?: number };
    };
    await createMessage(f.room.id, "user", f.peer.id, `${f.owner.name}, can you review?`);
    const first = await briefCheck(f);
    const told = await notify(app.baseUrl, f.apiKey, { check_id: first.id, idempotency_key: "t1", items: [{ channelId: f.room.id, summary: "review asked" }] });
    assert.equal(told.body.outcome, "sent", JSON.stringify(told.body));
    assert.equal((await inbox()).items.some((item) => item.channelId === f.room.id), false, "told");

    // Still unread; a newer message names the owner; the model leaves it out (a skip).
    await createMessage(f.room.id, "user", f.peer.id, `${f.owner.name} also this`);
    const second = await briefCheck(f);
    assert.ok((second.items as Array<{ channelId: string }>).some((item) => item.channelId === f.room.id));
    await notify(app.baseUrl, f.apiKey, { check_id: second.id, idempotency_key: "t2", items: [] });
    const after = await inbox();
    assert.equal(after.items.some((item) => item.channelId === f.room.id), true, "the skip is not a telling");
    assert.equal(after.total, 1);
  });
});

test("owner inbox: what the assistant tells its owner in their DM is told, from the references it writes; elsewhere nothing is recorded", async ({ app }) => {
  const f = await seed();
  assert.ok(await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id));
  const untold = async () => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/assistant/owner-inbox?filter=untold`, { headers: { Authorization: `Bearer ${f.apiKey}` } });
    return await res.json() as { items: Array<{ channelId: string }>; total?: number };
  };
  const send = async (target: string, content: string, status = 200) => {
    // The assistant's send route (v1 send is not on its allowlist).
    const res = await fetch(`${app.baseUrl}/internal/agent-api/v2/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ target, content }),
    });
    assert.equal(res.status, status, await res.clone().text());
  };
  const roomAsk = await createMessage(f.room.id, "user", f.peer.id, "can you review the plan?");
  const lobbyAsk = await createMessage(f.lobby.id, "user", f.peer.id, "lunch?");
  const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
  const dmAsk = await createMessage(dm!.id, "user", f.peer.id, "sign this?");
  assert.equal((await untold()).total, 3);

  // A reference posted outside the owner DM (refused to an assistant anyway) records nothing.
  await send(`#${f.room.name}`, `see #${f.room.name}:${roomAsk.id.slice(0, 8)}`, 403);
  assert.equal((await untold()).total, 3);

  // In the owner DM: the channel and DM references are told; an unknown one is ignored.
  // Recorded off the send's response path: poll briefly.
  await send(`dm:@${f.owner.name}`, `Review asked: #${f.room.name}:${roomAsk.id.slice(0, 8)}\nSign this: dm:@${f.peer.name}:${dmAsk.id.slice(0, 8)}\nAnd #nowhere:deadbeef`);
  let after = await untold();
  for (let i = 0; i < 50 && after.total !== 1; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    after = await untold();
  }
  assert.deepEqual(after.items.map((item) => item.channelId), [f.lobby.id]);
  assert.equal(after.total, 1);
  assert.ok(lobbyAsk);
});

test("owner inbox: a DM reference is resolved by its message id, whatever name the model wrote (storage name, peer handle)", async ({ app }) => {
  const f = await seed();
  assert.ok(await findOrCreateDM(f.server.id, f.owner.id, f.assistant.id));
  const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
  const [dmRow] = await getDb().select({ name: channels.name }).from(channels).where(eq(channels.id, dm!.id));
  const untoldTotal = async () => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/assistant/owner-inbox?filter=untold`, { headers: { Authorization: `Bearer ${f.apiKey}` } });
    return (await res.json() as { total?: number }).total;
  };
  const tellWith = async (ref: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/v2/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ target: `dm:@${f.owner.name}`, content: `Sign this: ${ref}` }),
    });
    assert.equal(res.status, 200);
  };
  for (const name of [dmRow!.name, f.peer.name]) {
    const ask = await createMessage(dm!.id, "user", f.peer.id, `sign this? (${name})`);
    assert.equal(await untoldTotal(), 1);
    await tellWith(`#${name}:${ask.id.slice(0, 8)}`);
    let total = await untoldTotal();
    for (let i = 0; i < 50 && total !== 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      total = await untoldTotal();
    }
    assert.equal(total, 0, `told via #${name}:…`);
  }
});

test("on: a doorbell rung by the producer (first_change_at with microseconds) still waits on a trailing read and then goes out", async ({ app }) => {
  assert.ok(app);
  const f = await seed();
  await withRaftCheck(async () => {
    const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
    const asked = await createMessage(dm!.id, "user", f.peer.id, "around?");
    await getDb().delete(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.agentId, f.assistant.id));
    // As the producer writes it: now() in the database, microseconds included.
    await getDb().execute(sql`INSERT INTO assistant_doorbells (agent_id, server_id, owner_user_id, first_change_at)
      VALUES (${f.assistant.id}, ${f.server.id}, ${f.owner.id}, now() - interval '123 microseconds') ON CONFLICT DO NOTHING`);
    await getDb().insert(assistantDoorbellSources).values({ agentId: f.assistant.id, sourceChannelId: dm!.id, maxSeq: Number(asked.seq) + 5 })
      .onConflictDoUpdate({ target: [assistantDoorbellSources.agentId, assistantDoorbellSources.sourceChannelId], set: { maxSeq: Number(asked.seq) + 5 } });
    const [row] = await getDb().select().from(assistantDoorbells).where(eq(assistantDoorbells.agentId, f.assistant.id));
    const t0 = row!.firstChangeAt;
    assert.equal(await drainAssistantDoorbells({ deliverer, now: t0 }), 0);
    const [waiting] = await getDb().select().from(assistantDoorbells).where(eq(assistantDoorbells.agentId, f.assistant.id));
    assert.ok(waiting?.behindSince, "the wait is marked on the producer's row");
    assert.equal(await drainAssistantDoorbells({ deliverer, now: new Date(t0.getTime() + ASSISTANT_CHECK_LAG_WAIT_MS + 1_000) }), 1, "and then it goes out");
  });
});

test("brief: a schedule written by SQL (next_brief_at with microseconds) is still claimed", async ({ app }) => {
  assert.ok(app);
  const f = await seed();
  await withRaftCheck(async () => {
    const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
    await createMessage(dm!.id, "user", f.peer.id, "morning?");
    // Due, with today's brief not sent, written the way a SQL default or an operator would.
    await getDb().execute(sql`INSERT INTO assistant_check_state (agent_id, next_brief_at)
      VALUES (${f.assistant.id}, now() - interval '1 hour 123 microseconds')
      ON CONFLICT (agent_id) DO UPDATE SET next_brief_at = excluded.next_brief_at, brief_sent_day = NULL`);
    const local = new Date();
    local.setUTCHours(9, 0, 0, 0);
    assert.equal(await runAssistantBriefs({ deliverer, now: local.getTime() > Date.now() ? local : new Date(local.getTime() + 24 * 3_600_000) }), 1);
  });
});

test("check: a doorbell passes over what an earlier DM held back; the brief lists it again", () => {
  const seqs = { told: new Map([["a", 5], ["b", 9]]), held: new Map([["a", 7], ["b", 3], ["c", 4]]) };
  assert.deepEqual(checkToldSeqs(seqs, "day"), new Map([["a", 7], ["b", 9], ["c", 4]]));
  assert.deepEqual(checkToldSeqs(seqs, "night"), new Map([["a", 7], ["b", 9], ["c", 4]]));
  assert.equal(checkToldSeqs(seqs, "brief"), seqs.told);
});

test("a system message in the owner's self-DM (a server-admin notice delivered before #wg-rbac:#42 retired them) is the system's, not the owner's: the check shows `from: system`, an owner person-rule never holds it, the owner inbox says `system`; the owner's own note there stays theirs", async ({ app }) => {
  const f = await seed();
  await setAssistantReadsDms(f.assistant.id, true);
  const selfDm = await findOrCreateUserDM(f.server.id, f.owner.id, f.owner.id);
  await createMessage(selfDm!.id, "user", f.owner.id, "note to self: renew the domain");
  const inbox = async () => (await listOwnerInboxRows({ agentId: f.assistant.id, serverId: f.server.id, ownerUserId: f.owner.id, filter: "all", limit: 50, offset: 0 }))
    .items.find((row) => row.channelId === selfDm!.id);
  const note = await inbox();
  assert.deepEqual([note?.latestSenderType, note?.latestSenderId], ["human", f.owner.id], "the owner's own note reads as theirs");

  // The owner muted themselves as a person: a rule about what the owner says.
  await getDb().insert(assistantContactRules).values({ agentId: f.assistant.id, serverId: f.server.id, effect: "mute", subjectKind: "person", subjectId: f.owner.id });
  // As the retired serverAdminNoticeService wrote it: the SYSTEM identity, unread for the owner.
  await broadcastSystemMessage(app.app.get("io"), app.app.get("agentOrchestrator") as AgentOrchestrator, selfDm!.id,
    "Hostco disconnected Check Server from #launch. People who reached it only through Check Server have left it.", {
      inboxFactPolicy: { mode: "record", producer: "server.admin_notice", reason: "a notice to the server's owners and admins" },
      targetAgentIds: [],
    });

  const row = await inbox();
  assert.deepEqual([row?.latestSenderType, row?.latestSenderId], ["system", "system"], "owner inbox: system, not human");

  const plan = await planCheck({ agentId: f.assistant.id, serverId: f.server.id, ownerUserId: f.owner.id, trigger: "brief", now: new Date() });
  assert.equal(plan.kind, "wake", "the owner person-rule does not hold the system notice");
  if (plan.kind !== "wake") return;
  const item = plan.items.find((candidate) => candidate.channelId === selfDm!.id);
  assert.ok(item, JSON.stringify(plan.items));
  assert.equal(item.senderId, null, "not attributed to the DM's peer (the owner)");
  const line = plan.check.instruction.split("\n").find((entry) => entry.includes(selfDm!.id));
  assert.ok(line, plan.check.instruction);
  assert.equal((JSON.parse(line) as { from: unknown }).from, "system");
});
