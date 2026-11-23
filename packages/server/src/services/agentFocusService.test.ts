import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asChannelId, type AgentFocusSource, type ChannelId } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agentFocusTargets } from "../db/schema";
import { dbTest } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import {
  AGENT_FOCUS_LIMIT,
  AGENT_UNFOCUS_MEMORY,
  autoFocus,
  drop,
  focus,
  touch,
  list,
  mergeFocusSource,
  orderFocusEntries,
  pickFocusEvictions,
  unfocus,
  type AgentFocusEntry,
} from "./agentFocusService";
import { createAgent } from "./agentService";
import { createChannel } from "./channelService";

const T0 = Date.parse("2026-11-19T09:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

function entry(name: string, source: AgentFocusSource, activeMinute: number): AgentFocusEntry {
  return { id: name, agentId: "agent-1", channelId: asChannelId(name), source, focusedAt: at(0), lastActiveAt: at(activeMinute) };
}
const names = (entries: readonly AgentFocusEntry[]) => entries.map((item) => item.id);

test("the limit is three", () => {
  assert.equal(AGENT_FOCUS_LIMIT, 3);
});

test("eviction: nothing to let go at or under the limit", () => {
  const three = [entry("a", "auto", 1), entry("b", "manual", 2), entry("c", "auto", 3)];
  assert.deepEqual(pickFocusEvictions(three, asChannelId("c")), []);
  assert.deepEqual(pickFocusEvictions(three.slice(0, 1), asChannelId("a")), []);
});

test("eviction: an auto entry goes before any manual one, however recent the auto one is", () => {
  const entries = [entry("old-manual", "manual", 1), entry("older-manual", "manual", 0), entry("recent-auto", "auto", 50), entry("new", "manual", 60)];
  assert.deepEqual(names(pickFocusEvictions(entries, asChannelId("new"))), ["recent-auto"]);
});

test("eviction: least recently active first within auto, and within manual once no auto is left", () => {
  const autos = [entry("auto-2", "auto", 2), entry("auto-1", "auto", 1), entry("manual-0", "manual", 0), entry("new", "manual", 9)];
  assert.deepEqual(names(pickFocusEvictions(autos, asChannelId("new"))), ["auto-1"]);
  const manuals = [entry("manual-3", "manual", 3), entry("manual-1", "manual", 1), entry("manual-2", "manual", 2), entry("new", "manual", 9)];
  assert.deepEqual(names(pickFocusEvictions(manuals, asChannelId("new"))), ["manual-1"]);
});

test("eviction: exactly the excess, autos first then manuals, and never the conversation being focused", () => {
  // Five stored (a state the service never writes) with the new one the least recently active auto.
  const entries = [entry("new", "auto", 0), entry("auto-1", "auto", 1), entry("manual-2", "manual", 2), entry("manual-3", "manual", 3), entry("manual-4", "manual", 4)];
  assert.deepEqual(names(pickFocusEvictions(entries, asChannelId("new"))), ["auto-1", "manual-2"]);
  // A new auto entry is kept even when every other entry is manual.
  const manualOnly = [entry("new", "auto", 0), entry("manual-1", "manual", 1), entry("manual-2", "manual", 2), entry("manual-3", "manual", 3)];
  assert.deepEqual(names(pickFocusEvictions(manualOnly, asChannelId("new"))), ["manual-1"]);
});

test("eviction: a tie on last-active time is broken the same way every time", () => {
  const entries = [entry("b", "auto", 1), entry("a", "auto", 1), entry("c", "auto", 1), entry("new", "manual", 9)];
  assert.deepEqual(names(pickFocusEvictions(entries, asChannelId("new"))), ["a"]);
});

test("source: auto becomes manual, manual never goes back to auto", () => {
  assert.equal(mergeFocusSource("auto", "manual"), "manual");
  assert.equal(mergeFocusSource("manual", "auto"), "manual");
  assert.equal(mergeFocusSource("auto", "auto"), "auto");
  assert.equal(mergeFocusSource("manual", "manual"), "manual");
});

test("the list is most recently active first", () => {
  assert.deepEqual(names(orderFocusEntries([entry("a", "auto", 1), entry("c", "manual", 3), entry("b", "auto", 2)])), ["c", "b", "a"]);
});

async function fixture(seed: ReturnType<typeof createSeed>, conversations: number) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const agent = await createAgent(server.id, `focus-${randomUUID().slice(0, 8)}`, { runtime: "claude" });
  const channelIds: ChannelId[] = [];
  for (let i = 0; i < conversations; i += 1) {
    channelIds.push(asChannelId((await createChannel(server.id, `focus-${i}-${randomUUID().slice(0, 6)}`)).id));
  }
  return { server, agent, channelIds };
}

async function storedCount(agentId: string): Promise<number> {
  return (await getDb().select({ id: agentFocusTargets.id }).from(agentFocusTargets).where(eq(agentFocusTargets.agentId, agentId))).length;
}

dbTest("focus stores an entry, lists most recently active first, and a fourth lets go of the least recently active auto", async ({ seed }) => {
  const { agent, channelIds: [a, b, c, d] } = await fixture(seed, 4);
  const first = await focus(agent.id, a!, "manual", { now: at(1) });
  assert.equal(first.alreadyFocused, false);
  assert.deepEqual(first.evicted, []);
  assert.equal(first.focused.source, "manual");
  assert.equal(first.focused.focusedAt.getTime(), at(1).getTime());
  await focus(agent.id, b!, "auto", { now: at(2) });
  await focus(agent.id, c!, "auto", { now: at(3) });
  assert.deepEqual((await list(agent.id)).map((item) => item.channelId), [c, b, a]);

  // `a` is the least recently active, but it is manual: the older auto (`b`) goes.
  const fourth = await focus(agent.id, d!, "manual", { now: at(4) });
  assert.deepEqual(fourth.evicted.map((item) => item.channelId), [b]);
  assert.deepEqual(fourth.entries.map((item) => item.channelId), [d, c, a]);
  assert.deepEqual((await list(agent.id)).map((item) => item.channelId), [d, c, a]);
  assert.equal(await storedCount(agent.id), AGENT_FOCUS_LIMIT);
});

dbTest("with no auto entry left, the least recently active manual one goes; the new one never does", async ({ seed }) => {
  const { agent, channelIds: [a, b, c, d, e] } = await fixture(seed, 5);
  await focus(agent.id, a!, "manual", { now: at(1) });
  await focus(agent.id, b!, "manual", { now: at(2) });
  await focus(agent.id, c!, "manual", { now: at(3) });
  const manual = await focus(agent.id, d!, "manual", { now: at(4) });
  assert.deepEqual(manual.evicted.map((item) => item.channelId), [a]);
  // A new auto entry among manual ones stays; the oldest manual goes.
  const auto = await focus(agent.id, e!, "auto", { now: at(5) });
  assert.deepEqual(auto.evicted.map((item) => item.channelId), [b]);
  assert.deepEqual(auto.entries.map((item) => item.channelId), [e, d, c]);
  assert.equal(await storedCount(agent.id), AGENT_FOCUS_LIMIT);
});

dbTest("focusing a focused conversation refreshes it, upgrades auto to manual, never downgrades, and evicts nothing", async ({ seed }) => {
  const { agent, channelIds: [a, b, c] } = await fixture(seed, 3);
  await focus(agent.id, a!, "auto", { now: at(1) });
  await focus(agent.id, b!, "manual", { now: at(2) });
  await focus(agent.id, c!, "auto", { now: at(3) });

  const upgraded = await focus(agent.id, a!, "manual", { now: at(10) });
  assert.equal(upgraded.alreadyFocused, true);
  assert.equal(upgraded.focused.source, "manual");
  assert.equal(upgraded.focused.focusedAt.getTime(), at(1).getTime(), "when it was first focused is kept");
  assert.equal(upgraded.focused.lastActiveAt.getTime(), at(10).getTime());
  assert.deepEqual(upgraded.evicted, []);
  assert.deepEqual(upgraded.entries.map((item) => item.channelId), [a, c, b]);

  const kept = await focus(agent.id, b!, "auto", { now: at(11) });
  assert.equal(kept.alreadyFocused, true);
  assert.equal(kept.focused.source, "manual", "manual is never downgraded");
  assert.equal(await storedCount(agent.id), 3);
});

dbTest("unfocus is idempotent and leaves the other entries", async ({ seed }) => {
  const { agent, channelIds: [a, b] } = await fixture(seed, 2);
  await focus(agent.id, a!, "manual", { now: at(1) });
  await focus(agent.id, b!, "manual", { now: at(2) });
  assert.deepEqual(await unfocus(agent.id, a!), { wasFocused: true });
  assert.deepEqual(await unfocus(agent.id, a!), { wasFocused: false });
  assert.deepEqual((await list(agent.id)).map((item) => item.channelId), [b]);
});

dbTest("each agent has its own list, and concurrent focus calls never leave more than the limit", async ({ seed }) => {
  const { server, agent, channelIds } = await fixture(seed, 6);
  const other = await createAgent(server.id, `focus-other-${randomUUID().slice(0, 8)}`, { runtime: "claude" });
  await focus(other.id, channelIds[0]!, "manual", { now: at(0) });

  const results = await Promise.all(channelIds.map((channelId, index) => focus(agent.id, channelId, index % 2 === 0 ? "manual" : "auto", { now: at(index + 1) })));
  assert.equal(await storedCount(agent.id), AGENT_FOCUS_LIMIT);
  for (const result of results) {
    assert.ok(result.entries.length <= AGENT_FOCUS_LIMIT);
    assert.ok(result.entries.some((item) => item.channelId === result.focused.channelId), "the conversation just focused is in the list it returns");
    assert.ok(!result.evicted.some((item) => item.channelId === result.focused.channelId));
  }
  assert.deepEqual((await list(other.id)).map((item) => item.channelId), [channelIds[0]]);
});

dbTest("an entry the agent can no longer read is dropped before the limit is counted: it pushes nothing out and is not reported as let go", async ({ seed }) => {
  const { agent, channelIds: [a, b, c, d] } = await fixture(seed, 4);
  await focus(agent.id, a!, "manual", { now: at(1) });
  await focus(agent.id, b!, "manual", { now: at(2) });
  await focus(agent.id, c!, "manual", { now: at(3) });

  // The agent lost `c`. Without the drop, the fourth would let go of `a` and leave only two.
  const asked: ChannelId[][] = [];
  const fourth = await focus(agent.id, d!, "manual", {
    now: at(4),
    stillReadable: async (ids) => {
      asked.push([...ids]);
      return ids.map((id) => id !== c);
    },
  });
  assert.deepEqual(fourth.evicted, []);
  assert.deepEqual(fourth.entries.map((item) => item.channelId), [d, b, a]);
  assert.deepEqual((await list(agent.id)).map((item) => item.channelId), [d, b, a]);
  // Only the entries already stored are asked about, never the one being focused.
  assert.equal(asked.length, 1);
  assert.deepEqual([...asked[0]!].sort(), [a, b, c].sort());

  // With every entry readable the limit still holds as before.
  const fifth = await focus(agent.id, c!, "manual", { now: at(5), stillReadable: async (ids) => ids.map(() => true) });
  assert.deepEqual(fifth.evicted.map((item) => item.channelId), [a]);
  assert.equal(await storedCount(agent.id), AGENT_FOCUS_LIMIT);
});

/** The rows left of an unfocus: remembered, but no entries. */
async function unfocusedRows(agentId: string) {
  return (await getDb().select().from(agentFocusTargets).where(eq(agentFocusTargets.agentId, agentId))).filter((row) => row.unfocusedAt !== null);
}

dbTest("an unfocused conversation is remembered but is no entry: not listed, not counted, never let go in place of an entry", async ({ seed }) => {
  const { agent, channelIds: [a, b, c, d, e] } = await fixture(seed, 5);
  await focus(agent.id, a!, "auto", { now: at(1) });
  await focus(agent.id, b!, "manual", { now: at(2) });
  assert.deepEqual(await unfocus(agent.id, a!, { now: at(3) }), { wasFocused: true });
  assert.deepEqual((await list(agent.id)).map((item) => item.channelId), [b]);
  assert.deepEqual((await unfocusedRows(agent.id)).map((row) => row.channelId), [a]);

  // Unfocusing what is not focused writes nothing: not a second time, and not a conversation never focused.
  assert.deepEqual(await unfocus(agent.id, a!, { now: at(4) }), { wasFocused: false });
  assert.deepEqual(await unfocus(agent.id, e!), { wasFocused: false });
  assert.deepEqual((await unfocusedRows(agent.id)).map((row) => [row.channelId, row.unfocusedAt?.getTime()]), [[a, at(3).getTime()]]);

  // Two more fit beside `b`: the remembered row takes none of the three places.
  const third = await focus(agent.id, d!, "auto", { now: at(6) });
  await focus(agent.id, c!, "auto", { now: at(5) });
  assert.deepEqual(third.evicted, []);
  assert.equal((await list(agent.id)).length, AGENT_FOCUS_LIMIT);
  // A fourth lets go of an entry, deleted outright; the remembered row is not what goes, and is not reported.
  const fourth = await focus(agent.id, e!, "manual", { now: at(7) });
  assert.deepEqual(fourth.evicted.map((item) => item.channelId), [c]);
  assert.deepEqual(fourth.entries.map((item) => item.channelId), [e, d, b]);
  assert.deepEqual((await unfocusedRows(agent.id)).map((row) => row.channelId), [a], "being let go by the limit is not remembered");
  assert.equal(await touch(agent.id, a!), false, "nothing to refresh on a remembered row");
  assert.equal(await touch(agent.id, b!, at(9)), true);
  assert.equal((await list(agent.id))[0]!.channelId, b);
});

dbTest("the agent focusing an unfocused conversation brings it back; Raft does not, unless told the unfocus no longer holds", async ({ seed }) => {
  const { agent, channelIds: [a, b] } = await fixture(seed, 2);
  await focus(agent.id, a!, "auto", { now: at(1) });
  await unfocus(agent.id, a!, { now: at(2) });

  assert.equal(await autoFocus(agent.id, a!, { now: at(3) }), "unfocused");
  const asked: Date[] = [];
  assert.equal(await autoFocus(agent.id, a!, { now: at(3), unfocusLifted: async (unfocusedAt) => { asked.push(unfocusedAt); return false; } }), "unfocused");
  assert.deepEqual(asked.map((when) => when.getTime()), [at(2).getTime()]);
  assert.deepEqual(await list(agent.id), []);

  const lifted = await autoFocus(agent.id, a!, { now: at(4), unfocusLifted: async () => true });
  assert.ok(typeof lifted === "object");
  assert.equal(lifted.alreadyFocused, false);
  assert.equal(lifted.focused.source, "auto");
  assert.equal(lifted.focused.focusedAt.getTime(), at(4).getTime(), "focused anew");
  assert.deepEqual(await unfocusedRows(agent.id), []);

  await unfocus(agent.id, a!, { now: at(5) });
  const manual = await focus(agent.id, a!, "manual", { now: at(6) });
  assert.equal(manual.alreadyFocused, false);
  assert.equal(manual.focused.source, "manual");
  assert.deepEqual((await list(agent.id)).map((item) => item.channelId), [a]);
  assert.deepEqual(await unfocusedRows(agent.id), []);

  // An entry that is dropped because the agent can no longer read it is not remembered as an unfocus.
  await focus(agent.id, b!, "auto", { now: at(7) });
  await drop(agent.id, b!);
  assert.deepEqual(await unfocusedRows(agent.id), []);
  assert.ok(typeof await autoFocus(agent.id, b!, { now: at(8) }) === "object");
});

dbTest("at most AGENT_UNFOCUS_MEMORY unfocuses are remembered per agent, the newest", async ({ seed }) => {
  const { agent, channelIds } = await fixture(seed, AGENT_UNFOCUS_MEMORY + 3);
  for (const [index, channelId] of channelIds.entries()) {
    await focus(agent.id, channelId, "manual", { now: at(index) });
    await unfocus(agent.id, channelId, { now: at(index) });
  }
  const remembered = await unfocusedRows(agent.id);
  assert.equal(remembered.length, AGENT_UNFOCUS_MEMORY);
  assert.deepEqual(new Set(remembered.map((row) => row.channelId)), new Set(channelIds.slice(3)));
  assert.deepEqual(await list(agent.id), []);
});
