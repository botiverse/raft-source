/**
 * Auto-focus (agentFocusAuto.ts): which deliveries focus a conversation by
 * themselves, what they may not focus (an unfocused one above all), what they
 * cost, and the note on the delivery that did it (`focus_change`). Real rows
 * (PGlite). The agent's lock held elsewhere needs two connections:
 * agentFocusService.realPg.test.ts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AGENT_FOCUS_FEATURE_FLAG_KEY, asChannelId, type AgentMessage } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agentFocusTargets, agents, featureFlagRules } from "../db/schema";
import { dbTest } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
import {
  AUTO_FOCUS_RETRY_INTERVAL_MS,
  __clearAutoFocusTriesForTests,
  autoFocusOwnTask,
  deliveryFocusTrigger,
  focusOnDelivery,
  setAgentFocusCapabilityReader,
} from "./agentFocusAuto";
import { __clearFocusSetCacheForTests, stampFocus, withoutFocusTags } from "./agentFocusDelivery";
import { focus, unfocus } from "./agentFocusService";
import { createAgent } from "./agentService";
import { acceptJointChannelInvite, addAgent, addHuman, createChannel, createJointChannel, findOrCreateDM, getOrCreateThreadForChannel } from "./channelService";
import { __setFlagReadCacheTtlForTests } from "./featureFlagReadCache";
import { registerMachine } from "./machineService";
import { createMessage } from "./messageService";
import { announceTaskClaim, buildTaskAssignmentNotice, postTaskConversationNotice } from "./taskConversationNotice";
import { getTaskConversation } from "./taskConversationService";
import * as taskService from "./taskService";

type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };

/** Runs `run` and returns its result with the SQL statements it sent. */
async function withQueries<T>(run: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
  const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
  const originalQuery = pg.query.bind(pg);
  const sql: string[] = [];
  pg.query = ((...args: unknown[]) => {
    sql.push(String(args[0]));
    return originalQuery(...args);
  }) as PgliteLike["query"];
  try {
    return { result: await run(), sql };
  } finally {
    pg.query = originalQuery;
  }
}
const writes = (sql: readonly string[]) => sql.filter((text) => /^\s*(insert|update|delete|with)\b/i.test(text));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function message(channelId: string, type: AgentMessage["channel_type"], extra: Partial<AgentMessage> = {}): AgentMessage {
  return {
    channel_id: channelId,
    channel_name: "conversation",
    channel_type: type,
    sender_id: randomUUID(),
    sender_name: "sender",
    sender_type: "human",
    content: "hello",
    timestamp: "2026-11-20T09:00:00.000Z",
    seq: 1,
    message_id: randomUUID(),
    ...extra,
  };
}

async function fixture(seed: ReturnType<typeof createSeed>, opts: { flag: boolean }) {
  __clearFocusSetCacheForTests();
  __clearAutoFocusTriesForTests();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  if (opts.flag) {
    await getDb().insert(featureFlagRules).values({ flagKey: AGENT_FOCUS_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id] });
  }
  const channel = await createChannel(server.id, `auto-${randomUUID().slice(0, 6)}`);
  await addHuman(channel.id, owner.id);
  const created = await createAgent(server.id, `auto-bot-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, created.id);
  const { machine } = await registerMachine(server.id, owner.id, `auto-machine-${randomUUID().slice(0, 6)}`);
  await getDb().update(agents).set({ machineId: machine.id }).where(eq(agents.id, created.id));
  const agent = { ...created, machineId: machine.id };

  const thread = async (inChannel: { id: string; name: string } = channel) => {
    const root = await createMessage(inChannel.id, "user", owner.id, "a root");
    const row = await getOrCreateThreadForChannel(inChannel.id, root.id, owner.id, "user");
    return { id: row.id, rootId: root.id, target: `#${inChannel.name}:${root.id.slice(0, 8)}` };
  };
  const deliver = (item: AgentMessage, machineCapable: () => boolean | Promise<boolean> = () => true) =>
    focusOnDelivery({ agentId: agent.id, serverId: server.id, message: item, machineCapable });
  /** Every row, entries and remembered unfocuses alike. */
  const rows = () => getDb().select().from(agentFocusTargets).where(eq(agentFocusTargets.agentId, agent.id));
  /** The entries: what the agent has in focus. */
  const stored = async () => (await rows()).filter((row) => row.unfocusedAt === null);
  const sources = async () => Object.fromEntries((await stored()).map((row) => [row.channelId, row.source]));
  return { owner, server, channel, agent, thread, deliver, rows, stored, sources };
}

afterEach(() => {
  vi.useRealTimers();
  __setFlagReadCacheTtlForTests(0);
  __clearFocusSetCacheForTests();
  __clearAutoFocusTriesForTests();
  setAgentFocusCapabilityReader(null);
});

/** A socket server that sends nothing, and an orchestrator that records what it is asked to deliver. */
function sinks() {
  // Every method of the socket server answers the same object: rooms chain, emits go nowhere.
  const room: unknown = new Proxy(() => room, { get: () => room, apply: () => room });
  const delivered: Array<{ agentId: string; message: AgentMessage }> = [];
  const deliverMessage = async (agentId: string, item: AgentMessage) => { delivered.push({ agentId, message: item }); return { status: "queued" as const }; };
  const orchestrator = {
    deliverMessage,
    deliverMessagesOnChannel: (_channelId: string, batch: ReadonlyArray<{ agentId: string; message: AgentMessage }>) => batch.map((item) => deliverMessage(item.agentId, item.message)),
    loadDeliveryGates: async () => null,
    recordAgentRaftAction: async () => {},
  };
  return { io: room as never, orchestrator: orchestrator as never, delivered };
}

test("what may trigger: a mention by a person or an agent in a thread, a DM they wrote, a system mention in a thread; nothing else", () => {
  const id = randomUUID();
  assert.equal(deliveryFocusTrigger(message(id, "thread", { mentioned: true })), "mentioned");
  assert.equal(deliveryFocusTrigger(message(id, "thread", { mentioned: true, sender_type: "agent", task_conversation_number: 7 })), "mentioned");
  assert.equal(deliveryFocusTrigger(message(id, "thread")), null);
  assert.equal(deliveryFocusTrigger(message(id, "thread", { mentioned: true, sender_type: "third_party_app" })), null, "an app's mention");
  assert.equal(deliveryFocusTrigger(message(id, "thread", { mentioned: true, sender_type: "system" })), "system_mention", "looked up before it counts");
  assert.equal(deliveryFocusTrigger(message(id, "thread", { sender_type: "system" })), null);
  for (const type of ["channel", "private", "joint"] as const) {
    assert.equal(deliveryFocusTrigger(message(id, type, { mentioned: true })), null, `a mention in a plain ${type}`);
  }
  assert.equal(deliveryFocusTrigger(message(id, "dm")), "dm");
  assert.equal(deliveryFocusTrigger(message(id, "dm", { sender_type: "agent" })), "dm");
  assert.equal(deliveryFocusTrigger(message(id, "dm", { sender_type: "system", mentioned: true })), null, "a system message, as in the reminders DM");
  assert.equal(deliveryFocusTrigger(message(id, "dm", { sender_type: "third_party_app" })), null, "an app's DM");
  assert.equal(deliveryFocusTrigger(message(id, "dm", { third_party_event: {} as never })), null, "an app event");
  assert.equal(deliveryFocusTrigger(message(`third-party-agent-events:${id}`, "dm")), null, "no channel row behind it");
  const carried = { reason: "dm" as const, focused: ["dm:@peer"], unfocused: [] };
  assert.equal(deliveryFocusTrigger(message(id, "dm", { focus_change: carried })), null, "another replica focused it already");
});

dbTest("a mention in a thread focuses it (auto), tags the mention itself and says so on that delivery only", async ({ seed }) => {
  const { channel, thread, deliver, stored } = await fixture(seed, { flag: true });
  const one = await thread();
  const mention = message(one.id, "thread", { mentioned: true });

  const first = await deliver(mention);
  assert.equal(first.focused, true, "the triggering delivery itself is tagged");
  assert.deepEqual(first.focus_change, { reason: "mentioned", focused: [one.target], unfocused: [] });
  assert.equal(mention.focused, undefined, "the caller's payload is not changed");
  assert.equal(mention.focus_change, undefined);
  assert.deepEqual((await stored()).map((row) => [row.channelId, row.source]), [[one.id, "auto"]]);

  // Later messages of the thread are tagged; none says it again.
  for (const later of [message(one.id, "thread", { mentioned: true }), message(one.id, "thread")]) {
    const out = await deliver(later);
    assert.equal(out.focused, true);
    assert.equal(out.focus_change, undefined);
  }

  // A mention in the plain channel, an unmentioned message, and a system mention that is no assignment line focus nothing.
  const other = await thread();
  assert.equal((await deliver(message(channel.id, "channel", { mentioned: true }))).focused, undefined);
  assert.equal((await deliver(message(other.id, "thread"))).focused, undefined);
  const system = await deliver(message(other.id, "thread", { mentioned: true, sender_type: "system" }));
  assert.equal(system.focused, undefined);
  assert.equal(system.focus_change, undefined);
  assert.equal((await stored()).length, 1);
});

dbTest("a DM from a person focuses it; a system or app message in a DM does not, and a label for a channel id sends no query", async ({ seed }) => {
  const { owner, server, agent, deliver, stored } = await fixture(seed, { flag: true });
  const dm = await findOrCreateDM(server.id, owner.id, agent.id);
  assert.ok(dm);

  for (const quiet of [message(dm.id, "dm", { sender_type: "system" }), message(dm.id, "dm", { sender_type: "third_party_app" })]) {
    const out = await deliver(quiet);
    assert.equal(out.focused, undefined);
    assert.equal(out.focus_change, undefined);
  }
  assert.deepEqual(await stored(), []);

  // A third-party event arrives as a `dm` whose channel id is a label, not a uuid.
  const event = message(`third-party-agent-events:${randomUUID()}`, "dm", { focused: true });
  const labelled = await withQueries(() => deliver(event));
  assert.deepEqual(labelled.sql, [], "never sent to a uuid column");
  assert.equal("focused" in labelled.result, false);

  const out = await deliver(message(dm.id, "dm"));
  assert.equal(out.focused, true);
  assert.deepEqual(out.focus_change, { reason: "dm", focused: [`dm:@${owner.name}`], unfocused: [] });
  assert.deepEqual((await stored()).map((row) => [row.channelId, row.source]), [[dm.id, "auto"]]);
});

dbTest("the limit and its order hold: an auto entry is let go first, a manual one never by an auto-focus, and a manual entry stays manual", async ({ seed }) => {
  const { owner, server, agent, thread, deliver, sources } = await fixture(seed, { flag: true });
  const [a, b, c, d] = [await thread(), await thread(), await thread(), await thread()];
  const dm = await findOrCreateDM(server.id, owner.id, agent.id);
  assert.ok(dm);
  await focus(agent.id, asChannelId(a.id), "manual", { now: new Date(Date.now() - 60_000) });
  await focus(agent.id, asChannelId(b.id), "auto", { now: new Date(Date.now() - 50_000) });
  await focus(agent.id, asChannelId(c.id), "manual", { now: new Date(Date.now() - 40_000) });

  // `a` is the least recently active, but manual: the auto entry goes, and the agent is told which.
  const fourth = await deliver(message(d.id, "thread", { mentioned: true }));
  assert.deepEqual(fourth.focus_change, { reason: "mentioned", focused: [d.target], unfocused: [b.target] });
  assert.deepEqual(await sources(), { [a.id]: "manual", [c.id]: "manual", [d.id]: "auto" });

  // The next one takes the place of the only auto entry left, not of a manual one.
  const fifth = await deliver(message(dm.id, "dm"));
  assert.deepEqual(fifth.focus_change, { reason: "dm", focused: [`dm:@${owner.name}`], unfocused: [d.target] });
  assert.deepEqual(await sources(), { [a.id]: "manual", [c.id]: "manual", [dm.id]: "auto" });

  // Every place holds an entry the agent focused by hand: Raft focuses nothing and lets nothing go.
  await focus(agent.id, asChannelId(b.id), "manual");
  __clearAutoFocusTriesForTests();
  const sixth = await deliver(message(d.id, "thread", { mentioned: true }));
  assert.equal(sixth.focused, undefined, "the message leaves untagged");
  assert.equal(sixth.focus_change, undefined);
  assert.deepEqual(await sources(), { [a.id]: "manual", [b.id]: "manual", [c.id]: "manual" });
  // That refusal is a try like any other: more mentions inside the interval ask nothing again.
  let asked = 0;
  for (let i = 0; i < 3; i += 1) await deliver(message(d.id, "thread", { mentioned: true }), () => { asked += 1; return true; });
  assert.equal(asked, 0);
  // The agent's own focus still takes a place, from the least recently active manual entry.
  const byHand = await focus(agent.id, asChannelId(d.id), "manual");
  assert.deepEqual(byHand.evicted.map((entry) => entry.channelId), [a.id]);
  assert.deepEqual(await sources(), { [b.id]: "manual", [c.id]: "manual", [d.id]: "manual" });

  // A mention in a conversation the agent focused itself refreshes it: still manual, nothing to tell.
  const manual = await deliver(message(c.id, "thread", { mentioned: true }));
  assert.equal(manual.focused, true);
  assert.equal(manual.focus_change, undefined);
  assert.equal((await sources())[c.id], "manual");
});

dbTest("a conversation the agent cannot read is never focused", async ({ seed }) => {
  const { owner, server, thread, deliver, rows } = await fixture(seed, { flag: true });
  const closed = await createChannel(server.id, `auto-private-${randomUUID().slice(0, 6)}`, undefined, "private");
  await addHuman(closed.id, owner.id);
  const hidden = await thread(closed);

  const out = await deliver(message(hidden.id, "thread", { mentioned: true }));
  assert.equal(out.focused, undefined);
  assert.equal(out.focus_change, undefined);
  assert.deepEqual(await rows(), []);
});

dbTest("flag off, or a Computer without the capability: nothing is written, and no query beyond the tag's own", async ({ seed }) => {
  const off = await fixture(seed, { flag: false });
  const offThread = await off.thread();
  __setFlagReadCacheTtlForTests(30_000);
  const mention = message(offThread.id, "thread", { mentioned: true });
  await off.deliver(mention);
  const cached = await withQueries(() => off.deliver(mention));
  assert.equal(cached.result, mention, "flag off: the message leaves as it came");
  assert.deepEqual(cached.sql, [], "flag off and cached: no query at all");
  assert.deepEqual(await off.rows(), []);

  const on = await fixture(seed, { flag: true });
  const onThread = await on.thread();
  const input = message(onThread.id, "thread", { mentioned: true });
  await on.deliver(message(onThread.id, "thread"));
  __clearFocusSetCacheForTests();
  const tagOnly = await withQueries(() => stampFocus({ agentId: on.agent.id, serverId: on.server.id, messages: [input], machineCapable: () => false }));
  __clearFocusSetCacheForTests();
  const incapable = await withQueries(() => on.deliver(input, () => false));
  assert.equal(incapable.result, input);
  assert.deepEqual(incapable.sql, tagOnly.sql, "not capable: exactly the tag's reads");
  assert.deepEqual(await on.rows(), []);

  // A capability that cannot be read counts as missing, and breaks nothing.
  __clearAutoFocusTriesForTests();
  const unreadable = await on.deliver(input, () => Promise.reject(new Error("store down")));
  assert.equal(unreadable.focused, undefined);
  assert.deepEqual(await on.rows(), []);

  // Nothing is focused while a transaction is open: the writes would join it.
  __clearAutoFocusTriesForTests();
  await getDb().transaction(async () => {
    assert.equal((await on.deliver(input)).focus_change, undefined);
  });
  assert.deepEqual(await on.rows(), []);
});

dbTest("a delivery that triggers nothing costs no query once the flag and the focus set are cached", async ({ seed }) => {
  const { thread, deliver } = await fixture(seed, { flag: true });
  const one = await thread();
  __setFlagReadCacheTtlForTests(30_000);
  const quiet = message(one.id, "thread");
  await deliver(quiet);
  const again = await withQueries(() => deliver(quiet));
  assert.equal(again.result, quiet);
  assert.deepEqual(again.sql, []);
});

dbTest("a busy focused DM: no query inside the interval, then one statement that moves its last-active time", async ({ seed }) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T09:00:00.000Z"));
  const { owner, server, agent, deliver, stored } = await fixture(seed, { flag: true });
  __setFlagReadCacheTtlForTests(30_000);
  const dm = await findOrCreateDM(server.id, owner.id, agent.id);
  assert.ok(dm);
  await deliver(message(dm.id, "dm"));
  const [focused] = await stored();
  assert.ok(focused);

  vi.setSystemTime(Date.now() + 1_000);
  for (let i = 0; i < 5; i += 1) {
    const busy: { result: AgentMessage; sql: string[] } = await withQueries(() => deliver(message(dm.id, "dm")));
    assert.equal(busy.result.focused, true);
    assert.deepEqual(busy.sql, [], `message ${i}`);
  }
  assert.equal((await stored())[0]!.lastActiveAt.getTime(), focused.lastActiveAt.getTime());

  // Past the interval (the flag and the focus set are read again by then, as for any tagged message):
  // the refresh adds a single UPDATE. No access check, no lock, no address.
  vi.setSystemTime(Date.now() + AUTO_FOCUS_RETRY_INTERVAL_MS);
  const refresh: { result: AgentMessage; sql: string[] } = await withQueries(() => deliver(message(dm.id, "dm")));
  const own = refresh.sql.filter((text) => !/from "feature_flag/.test(text) && !/^select "agent_id" from "agent_focus_targets"/.test(text));
  assert.equal(own.length, 1, refresh.sql.join("\n"));
  assert.match(own[0]!, /^\s*update agent_focus_targets set last_active_at/i);
  assert.equal(refresh.result.focused, true);
  assert.equal(refresh.result.focus_change, undefined, "a refresh is nothing to tell");
  const refreshed = (await stored())[0]!;
  assert.ok(refreshed.lastActiveAt.getTime() > focused.lastActiveAt.getTime());
  assert.equal(refreshed.source, "auto");
  vi.setSystemTime(Date.now() + 1_000);
  assert.deepEqual((await withQueries(() => deliver(message(dm.id, "dm")))).sql, []);
});

dbTest("a try that focused nothing is not repeated on every message", async ({ seed }) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T09:00:00.000Z"));
  const { thread, deliver, stored } = await fixture(seed, { flag: true });
  __setFlagReadCacheTtlForTests(30_000);
  const one = await thread();
  let asked = 0;
  const incapable = () => { asked += 1; return false; };
  for (let i = 0; i < 4; i += 1) await deliver(message(one.id, "thread", { mentioned: true }), incapable);
  assert.equal(asked, 1, "the capability is read once per interval");

  // The Computer reconnects with the capability: focused at the next try.
  vi.setSystemTime(Date.now() + AUTO_FOCUS_RETRY_INTERVAL_MS);
  const out = await deliver(message(one.id, "thread", { mentioned: true }));
  assert.equal(out.focus_change?.reason, "mentioned");
  assert.equal((await stored()).length, 1);
});

dbTest("four busy conversations do not take each other's place inside the interval", async ({ seed }) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T09:00:00.000Z"));
  const { thread, deliver, stored } = await fixture(seed, { flag: true });
  const [a, b, c, d] = [await thread(), await thread(), await thread(), await thread()];
  const mention = (one: { id: string }) => deliver(message(one.id, "thread", { mentioned: true }));
  for (const one of [a, b, c]) {
    await mention(one);
    vi.setSystemTime(Date.now() + 1_000);
  }
  // Long after those tries: `d` takes the place of `a`, the least recently active.
  vi.setSystemTime(Date.now() + 2 * AUTO_FOCUS_RETRY_INTERVAL_MS);
  assert.deepEqual((await mention(d)).focus_change, { reason: "mentioned", focused: [d.target], unfocused: [a.target] });
  const ids = async () => (await stored()).map((row) => row.channelId).sort();
  const settled = [b.id, c.id, d.id].sort();

  // `a` is mentioned again at once, and again: it was just let go, so it waits out the interval.
  vi.setSystemTime(Date.now() + 1_000);
  for (let i = 0; i < 3; i += 1) {
    const out = await mention(a);
    assert.equal(out.focused, undefined);
    assert.equal(out.focus_change, undefined);
  }
  assert.deepEqual(await ids(), settled);

  // After the interval its next mention focuses it again.
  vi.setSystemTime(Date.now() + AUTO_FOCUS_RETRY_INTERVAL_MS);
  assert.deepEqual((await mention(a)).focus_change?.focused, [a.target]);
});

dbTest("two deliveries at once to one conversation: one focus, both tagged, one says so", async ({ seed }) => {
  const { thread, deliver, stored } = await fixture(seed, { flag: true });
  const one = await thread();
  let decided = 0;
  const capable = () => { decided += 1; return true; };
  const out = await Promise.all([1, 2, 3].map((seq) => deliver(message(one.id, "thread", { mentioned: true, seq }), capable)));
  assert.deepEqual(out.map((item) => item.focused), [true, true, true], "none left untagged ahead of the focus");
  assert.equal(out.filter((item) => item.focus_change).length, 1);
  // The first decides (it alone asks for the capability before focusing); the others wait for it. Each tag then asks once.
  assert.equal(decided, 1 + 3);
  assert.equal((await stored()).length, 1);
});

dbTest("an unfocus sticks: no trigger focuses the conversation again until the agent writes in it or focuses it", async ({ seed }) => {
  const { owner, server, agent, thread, deliver, rows, stored } = await fixture(seed, { flag: true });
  const dm = await findOrCreateDM(server.id, owner.id, agent.id);
  assert.ok(dm);
  const one = await thread();
  const cases = [
    { id: dm.id, trigger: () => message(dm.id, "dm"), reason: "dm" },
    { id: one.id, trigger: () => message(one.id, "thread", { mentioned: true }), reason: "mentioned" },
  ];
  for (const { id, trigger, reason } of cases) {
    assert.equal((await deliver(trigger())).focus_change?.reason, reason);
    assert.deepEqual(await unfocus(agent.id, asChannelId(id)), { wasFocused: true });

    // At once, and long after (another replica, or a later minute, has no record of a try): still unfocused.
    for (let i = 0; i < 2; i += 1) {
      const out = await deliver(trigger());
      assert.equal(out.focused, undefined, `${reason}: not tagged`);
      assert.equal(out.focus_change, undefined);
      __clearAutoFocusTriesForTests();
    }
    assert.equal((await stored()).some((row) => row.channelId === id), false);
    assert.ok((await rows()).find((row) => row.channelId === id)?.unfocusedAt, "the unfocus is remembered");
  }

  // The agent writes in the DM: its next message from the peer focuses it again, and says so.
  await pause(15);
  await createMessage(dm.id, "agent", agent.id, "back to this");
  const lifted = await deliver(message(dm.id, "dm"));
  assert.equal(lifted.focused, true);
  assert.deepEqual(lifted.focus_change, { reason: "dm", focused: [`dm:@${owner.name}`], unfocused: [] });
  assert.equal((await rows()).find((row) => row.channelId === dm.id)?.unfocusedAt, null);

  // Somebody else's message in the thread lifts nothing; the agent focusing it does.
  await pause(15);
  await createMessage(one.id, "user", owner.id, "still here?");
  __clearAutoFocusTriesForTests();
  assert.equal((await deliver(message(one.id, "thread", { mentioned: true }))).focused, undefined);
  const manual = await focus(agent.id, asChannelId(one.id), "manual");
  assert.equal(manual.alreadyFocused, false);
  assert.equal((await deliver(message(one.id, "thread"))).focused, true);
  assert.deepEqual(Object.fromEntries((await stored()).map((row) => [row.channelId, row.source])), { [dm.id]: "auto", [one.id]: "manual" });
});

dbTest("a carried focus_change is kept only with the tag, focuses nothing again, and is never stored", async ({ seed }) => {
  const { agent, server, thread, deliver, rows } = await fixture(seed, { flag: true });
  const one = await thread();
  const told = await deliver(message(one.id, "thread", { mentioned: true }));
  assert.ok(told.focus_change);

  // Handed over by the replica that focused it: no second auto-focus here, the tag is decided again, the note stays.
  __clearAutoFocusTriesForTests();
  const before = await rows();
  const handed = await withQueries(() => deliver(told));
  assert.deepEqual(handed.result.focus_change, told.focus_change);
  assert.equal(handed.result.focused, true);
  assert.deepEqual(writes(handed.sql), [], "the receiving replica writes nothing");
  assert.deepEqual(await rows(), before);
  // Even for a conversation this replica has not seen focused: the carried note is not acted on.
  const other = await thread();
  const foreign = await deliver(message(other.id, "thread", { mentioned: true, focus_change: { reason: "mentioned", focused: [other.target], unfocused: [] } }));
  assert.equal(foreign.focused, undefined);
  assert.equal("focus_change" in foreign, false, "without the tag it goes");
  assert.equal((await rows()).length, 1);

  // Not capable any more, or unfocused since: it goes with the tag.
  const [incapable] = await stampFocus({ agentId: agent.id, serverId: server.id, messages: [told], machineCapable: () => false });
  assert.equal("focus_change" in incapable!, false);
  await unfocus(agent.id, asChannelId(one.id));
  const [unfocused] = await stampFocus({ agentId: agent.id, serverId: server.id, messages: [told], machineCapable: () => true });
  assert.equal("focused" in unfocused!, false);
  assert.equal("focus_change" in unfocused!, false);
  // What is stored (the mention payload) carries neither.
  const [storedCopy] = withoutFocusTags([told]);
  assert.equal("focused" in storedCopy!, false);
  assert.equal("focus_change" in storedCopy!, false);
  assert.ok(told.focus_change, "the delivered copy is not changed");
});

dbTest("the assignment line that hands an agent a task focuses the task's conversation and its source thread, in one focus_change", async ({ seed }) => {
  const { owner, server, channel, agent, thread, deliver, stored } = await fixture(seed, { flag: true });
  await enableTaskV2ConversationsForServer(server.id);
  const { io, orchestrator, delivered } = sinks();
  const localChannel = { id: channel.id, serverId: server.id, deletedAt: null };
  const source = await thread();
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "from a message", sourceMessageId: source.rootId }]);
  assert.ok(task);
  const actor = { type: "user" as const, id: owner.id };

  // A person hands the agent the task; the line is posted as the routes post it.
  await taskService.assignTask(task.id, { type: "agent", id: agent.id }, "user", owner.id, { serverId: server.id });
  const notice = await buildTaskAssignmentNotice({ actor, assignee: { type: "agent", id: agent.id }, taskNumber: task.taskNumber, title: task.title });
  await postTaskConversationNotice(io, orchestrator, {
    taskId: task.id, localChannel, actor, content: notice.content, attention: notice.attention, follower: notice.follower, actionMetadata: notice.actionMetadata,
  });
  const conversationId = (await getTaskConversation(task.id))?.canonicalChannelId;
  assert.ok(conversationId);
  assert.deepEqual(await stored(), [], "nothing is focused before the line is delivered");
  const line = delivered.find((item) => item.agentId === agent.id && item.message.channel_id === conversationId)?.message;
  assert.ok(line, "the assignment line is delivered to the assignee");
  assert.equal(line.sender_type, "system");
  assert.equal(line.mentioned, true);

  const out = await deliver(line);
  assert.equal(out.focused, true);
  assert.deepEqual(out.focus_change, {
    reason: "task_assigned",
    focused: [`#${channel.name}:#${task.taskNumber}`, source.target],
    unfocused: [],
  });
  assert.deepEqual(Object.fromEntries((await stored()).map((row) => [row.channelId, row.source])), { [conversationId]: "auto", [source.id]: "auto" });

  // Another system line that mentions the agent in the same conversation is no trigger, and the same line again says nothing.
  __clearAutoFocusTriesForTests();
  __clearFocusSetCacheForTests();
  await getDb().delete(agentFocusTargets).where(eq(agentFocusTargets.channelId, source.id));
  const statusLine = await deliver({ ...line, message_id: randomUUID() });
  assert.equal(statusLine.focus_change, undefined);
  assert.equal((await stored()).length, 1, "the source thread was not focused by a line that is no assignment");
  // The line for somebody else's assignment is no trigger for this agent either.
  const peer = await createAgent(server.id, `auto-peer-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, peer.id);
  const forPeer = await focusOnDelivery({ agentId: peer.id, serverId: server.id, message: line, machineCapable: () => true });
  assert.equal(forPeer.focused, undefined);
});

dbTest("an agent that takes a task itself gets it focused silently, after the write, and only with the flag and the capability", async ({ seed }) => {
  const { owner, server, channel, agent, thread, deliver, stored } = await fixture(seed, { flag: true });
  await enableTaskV2ConversationsForServer(server.id);
  const { io, orchestrator, delivered } = sinks();
  const localChannel = { id: channel.id, serverId: server.id, deletedAt: null };
  const source = await thread();
  const { tasks: [task, later] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "to claim", sourceMessageId: source.rootId }, { title: "later" }]);
  const claim = async (item: NonNullable<typeof task>) => {
    await taskService.claimTask(item.id, "agent", agent.id);
    await announceTaskClaim(io, orchestrator, {
      taskId: item.id, taskNumber: item.taskNumber, title: item.title, localChannel,
      actor: { type: "agent", id: agent.id }, before: { status: item.status, claimedByType: null, claimedById: null }, afterStatus: "in_progress", legacyContent: null,
    });
    return (await getTaskConversation(item.id))!.canonicalChannelId;
  };

  // No capability reader registered (no orchestrator on this process): nothing, and no query from the hook.
  const idle = await withQueries(() => autoFocusOwnTask({ taskId: task!.id, agentId: agent.id, conversationChannelId: null }));
  assert.deepEqual(idle.sql, []);

  // A Computer without the capability: nothing.
  setAgentFocusCapabilityReader(async () => false);
  const conversationId = await claim(task!);
  await pause(50);
  assert.deepEqual(await stored(), []);

  // Capable: the conversation and the source thread, source auto. The hook is not awaited by the announcement.
  setAgentFocusCapabilityReader(async () => true);
  await autoFocusOwnTask({ taskId: task!.id, agentId: agent.id, conversationChannelId: conversationId });
  assert.deepEqual(Object.fromEntries((await stored()).map((row) => [row.channelId, row.source])), { [conversationId]: "auto", [source.id]: "auto" });
  const laterConversation = await claim(later!);
  await vi.waitFor(async () => assert.ok((await stored()).some((row) => row.channelId === laterConversation)), { timeout: 5_000 });

  // Silent: the claim's own lines carry no focus_change, and neither does the next message there.
  assert.deepEqual(delivered.filter((item) => item.message.focus_change), []);
  const next = await deliver(message(conversationId, "thread", { task_conversation_number: task!.taskNumber }));
  assert.equal(next.focused, true);
  assert.equal(next.focus_change, undefined);
});

dbTest("with the flag off a claim costs the hook one read of the agent and writes nothing", async ({ seed }) => {
  const { owner, channel, agent, rows } = await fixture(seed, { flag: false });
  setAgentFocusCapabilityReader(async () => true);
  __setFlagReadCacheTtlForTests(30_000);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "flag off" }]);
  await autoFocusOwnTask({ taskId: task!.id, agentId: agent.id, conversationChannelId: null });
  const run = await withQueries(() => autoFocusOwnTask({ taskId: task!.id, agentId: agent.id, conversationChannelId: null }));
  assert.equal(run.sql.length, 1, run.sql.join("\n"));
  assert.match(run.sql[0]!, /from "agents"/);
  assert.deepEqual(await rows(), []);
});

dbTest("in a joint channel the assignee's own server's copy of the task conversation is what is focused", async ({ seed }) => {
  __clearFocusSetCacheForTests();
  __clearAutoFocusTriesForTests();
  const [hostOwner, peerOwner] = [await seed.human(), await seed.human()];
  const host = await seed.server({ owner: hostOwner });
  const peer = await seed.server({ owner: peerOwner });
  for (const server of [host, peer]) {
    await getDb().insert(featureFlagRules).values({ flagKey: AGENT_FOCUS_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id] });
    await enableTaskV2ConversationsForServer(server.id);
  }
  const made = await createJointChannel({
    hostServerId: host.id, createdByUserId: hostOwner.id, name: `auto-joint-${randomUUID().slice(0, 6)}`, targetServerSlug: peer.slug, invitedPeople: [`@${peerOwner.name}`], userIds: [],
  });
  const peerChannel = await acceptJointChannelInvite({ inviteId: made.invites[0]!.id, targetServerId: peer.id, acceptedByUserId: peerOwner.id });
  const peerAgent = await createAgent(peer.id, `auto-peer-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(peerChannel.id, peerAgent.id);

  // The host's owner makes a task in the joint channel and hands it to the other server's agent.
  const { io, orchestrator, delivered } = sinks();
  const actor = { type: "user" as const, id: hostOwner.id };
  const { tasks: [task] } = await taskService.createTasks(made.jointChannel.canonicalChannelId, "user", hostOwner.id, [{ title: "across servers" }], { initiatingServerId: host.id });
  assert.ok(task);
  const assigned = await taskService.assignTask(task.id, { type: "agent", id: peerAgent.id }, "user", hostOwner.id, { serverId: host.id });
  assert.equal(typeof assigned, "object", String(assigned));
  const notice = await buildTaskAssignmentNotice({ actor, assignee: { type: "agent", id: peerAgent.id }, taskNumber: task.taskNumber, title: task.title });
  await postTaskConversationNotice(io, orchestrator, {
    taskId: task.id, localChannel: { id: made.channel.id, serverId: host.id, deletedAt: null }, actor,
    content: notice.content, attention: notice.attention, follower: notice.follower, actionMetadata: notice.actionMetadata,
  });
  const conversation = await getTaskConversation(task.id);
  const peerLocal = conversation?.localByServer.get(peer.id)?.localChannelId;
  assert.ok(peerLocal && peerLocal !== conversation?.canonicalChannelId, "the peer has its own copy of the conversation");
  const line = delivered.find((item) => item.agentId === peerAgent.id)?.message;
  assert.ok(line, "the assignment line reaches the assignee on the other server");
  assert.equal(line.channel_id, peerLocal);

  const out = await focusOnDelivery({ agentId: peerAgent.id, serverId: peer.id, message: line, machineCapable: () => true });
  assert.equal(out.focused, true);
  assert.equal(out.focus_change?.reason, "task_assigned");
  assert.equal(out.focus_change?.focused.length, 1);
  assert.match(out.focus_change!.focused[0]!, new RegExp(`:#${task.taskNumber}$`));
  const rows = await getDb().select().from(agentFocusTargets).where(eq(agentFocusTargets.agentId, peerAgent.id));
  assert.deepEqual(rows.map((row) => [row.channelId, row.source]), [[peerLocal, "auto"]]);
});
