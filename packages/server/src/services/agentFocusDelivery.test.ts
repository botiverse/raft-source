/**
 * The Focus delivery tag (agentFocusDelivery.ts stampFocus): what is tagged,
 * what it costs when nothing can be tagged, and that it never breaks a
 * delivery. Real rows (PGlite).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AGENT_FOCUS_FEATURE_FLAG_KEY, asChannelId, type AgentMessage } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentFocusTargets, featureFlagRules } from "../db/schema";
import { dbTest } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { __clearFocusSetCacheForTests, stampFocus, withoutFocusTags } from "./agentFocusDelivery";
import { focus, unfocus } from "./agentFocusService";
import { createAgent } from "./agentService";
import { createChannel } from "./channelService";
import { __setFlagReadCacheTtlForTests } from "./featureFlagReadCache";

type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };

/** Runs `run` and returns its result with the SQL statements it sent; `fail` makes every statement throw instead. */
async function withQueries<T>(run: () => Promise<T>, opts: { fail?: boolean } = {}): Promise<{ result: T; sql: string[] }> {
  const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
  const originalQuery = pg.query.bind(pg);
  const sql: string[] = [];
  pg.query = ((...args: unknown[]) => {
    sql.push(String(args[0]));
    if (opts.fail) return Promise.reject(new Error("database down"));
    return originalQuery(...args);
  }) as PgliteLike["query"];
  try {
    return { result: await run(), sql };
  } finally {
    pg.query = originalQuery;
  }
}
const focusReads = (sql: readonly string[]) => sql.filter((text) => text.includes("agent_focus_targets")).length;

function message(channelId: string, type: AgentMessage["channel_type"], seq = 1): AgentMessage {
  return {
    channel_id: channelId,
    channel_name: "conversation",
    channel_type: type,
    sender_id: randomUUID(),
    sender_name: "sender",
    sender_type: "human",
    content: "hello",
    timestamp: "2026-11-20T09:00:00.000Z",
    seq,
    message_id: randomUUID(),
  };
}

async function fixture(seed: ReturnType<typeof createSeed>, opts: { flag: boolean }) {
  __clearFocusSetCacheForTests();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  if (opts.flag) {
    await getDb().insert(featureFlagRules).values({ flagKey: AGENT_FOCUS_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id] });
  }
  const agent = await createAgent(server.id, `focus-tag-${randomUUID().slice(0, 8)}`, { runtime: "claude" });
  const other = await createAgent(server.id, `focus-tag-${randomUUID().slice(0, 8)}`, { runtime: "claude" });
  const conversation = asChannelId((await createChannel(server.id, `focus-tag-${randomUUID().slice(0, 6)}`)).id);
  const elsewhere = asChannelId((await createChannel(server.id, `focus-tag-${randomUUID().slice(0, 6)}`)).id);
  const stamp = (agentId: string, messages: readonly AgentMessage[], machineCapable: () => boolean | Promise<boolean> = () => true) =>
    stampFocus({ agentId, serverId: server.id, messages, machineCapable });
  return { server, agent, other, conversation, elsewhere, stamp };
}

afterEach(() => {
  __setFlagReadCacheTtlForTests(0);
  __clearFocusSetCacheForTests();
});

dbTest("tags a copy of each message of a focused thread or DM, for the agent that focused it only", async ({ seed }) => {
  const { agent, other, conversation, elsewhere, stamp } = await fixture(seed, { flag: true });
  await focus(agent.id, conversation, "manual");
  const thread = message(conversation, "thread", 1);
  const dm = message(conversation, "dm", 2);
  const unfocused = message(elsewhere, "thread", 3);
  const input = [thread, dm, unfocused];
  const snapshot = structuredClone(input);

  const out = await stamp(agent.id, input);
  assert.deepEqual(out.map((item) => item.focused), [true, true, undefined]);
  assert.deepEqual(out[0], { ...thread, focused: true });
  assert.notEqual(out[0], thread, "a tagged message is a copy");
  assert.equal(out[2], unfocused, "an untagged message is the same object");
  assert.deepEqual(input, snapshot, "the input, shared with other recipients, is not changed");

  const forOther = await stamp(other.id, input);
  assert.equal(forOther, input, "nothing to tag returns the input itself");
});

dbTest("a tag the input already carries is never trusted: it is removed, on a copy, whenever it does not hold now", async ({ seed }) => {
  const { agent, conversation, stamp } = await fixture(seed, { flag: true });
  const tagged = (type: AgentMessage["channel_type"] = "thread") => ({ ...message(conversation, type), focused: true as const });
  const stripped = async (out: Promise<readonly AgentMessage[]>, input: readonly AgentMessage[], why: string) => {
    const [result] = await out;
    assert.equal("focused" in result!, false, why);
    assert.notEqual(result, input[0], `${why}: a copy`);
    assert.equal(input[0]!.focused, true, `${why}: the input is not changed`);
  };

  // Not focused (never, or unfocused since the tag was written).
  let input = [tagged()];
  await stripped(stamp(agent.id, input), input, "not focused");
  await focus(agent.id, conversation, "manual");
  input = [tagged()];
  assert.equal(await stamp(agent.id, input), input, "still focused: kept as it is");
  await unfocus(agent.id, conversation);
  await stripped(stamp(agent.id, input), input, "unfocused since");

  // Focused, but the Computer is not capable, its capability is unreadable, or the server is unknown.
  await focus(agent.id, conversation, "manual");
  assert.equal(await stamp(agent.id, [message(conversation, "thread")], () => false).then((out) => out[0]!.focused), undefined);
  await stripped(stamp(agent.id, input, () => false), input, "not capable");
  await stripped(stamp(agent.id, input, () => Promise.reject(new Error("store down"))), input, "capability unreadable");
  await stripped(stampFocus({ agentId: agent.id, serverId: null, messages: input, machineCapable: () => true }), input, "no server");
  await stripped(withQueries(() => stamp(agent.id, input), { fail: true }).then((run) => run.result), input, "reads failing");

  // A plain channel message cannot be focused: its tag goes without any query.
  const plain = [tagged("channel")];
  const { result, sql } = await withQueries(() => stamp(agent.id, plain));
  assert.equal("focused" in result[0]!, false);
  assert.deepEqual(sql, []);
  assert.equal(withoutFocusTags(input)[0]!.focused, undefined);
});

dbTest("with the flag off a stored tag is removed", async ({ seed }) => {
  const { agent, conversation, stamp } = await fixture(seed, { flag: false });
  await focus(agent.id, conversation, "manual");
  const input = [{ ...message(conversation, "dm"), focused: true as const }];
  const [result] = await stamp(agent.id, input);
  assert.equal("focused" in result!, false);
  assert.equal(input[0]!.focused, true);
});

dbTest("a plain channel message costs no query; with the flag off a thread costs the flag read only, and none once it is cached", async ({ seed }) => {
  const on = await fixture(seed, { flag: true });
  await focus(on.agent.id, on.conversation, "manual");
  for (const type of ["channel", "private", "joint"] as const) {
    const input = [message(on.conversation, type)];
    const { result, sql } = await withQueries(() => on.stamp(on.agent.id, input));
    assert.equal(result, input, type);
    assert.deepEqual(sql, [], type);
  }

  const off = await fixture(seed, { flag: false });
  await focus(off.agent.id, off.conversation, "manual");
  __clearFocusSetCacheForTests();
  __setFlagReadCacheTtlForTests(30_000);
  const input = [message(off.conversation, "thread")];
  const first = await withQueries(() => off.stamp(off.agent.id, input));
  assert.equal(first.result, input);
  assert.ok(first.sql.length > 0, "the first read evaluates the flag");
  assert.equal(focusReads(first.sql), 0, "flag off: the focus set is never read");
  const second = await withQueries(() => off.stamp(off.agent.id, input));
  assert.equal(second.result, input);
  assert.deepEqual(second.sql, [], "flag off and cached: no query at all");
});

dbTest("one focus-set read per conversation, shared by its recipients, and dropped by focus and unfocus", async ({ seed }) => {
  const { agent, other, conversation, stamp } = await fixture(seed, { flag: true });
  __setFlagReadCacheTtlForTests(30_000);
  const input = [message(conversation, "thread")];

  // A fan-out: two recipients at once share one read, and later ones reuse it.
  const fanOut = await withQueries(() => Promise.all([stamp(agent.id, input), stamp(other.id, input)]));
  assert.deepEqual(fanOut.result.map((out) => out[0]!.focused), [undefined, undefined]);
  assert.equal(focusReads(fanOut.sql), 1);
  const again = await withQueries(() => stamp(agent.id, input));
  assert.deepEqual(again.sql, [], "flag and focus set both cached");

  // A row written behind the service's back is not seen until the entry expires: the cache is real.
  await getDb().insert(agentFocusTargets).values({ agentId: other.id, channelId: conversation, source: "manual" });
  assert.equal((await stamp(other.id, input))[0]!.focused, undefined);

  // focus and unfocus on this replica drop the entry.
  await focus(agent.id, conversation, "manual");
  assert.equal((await stamp(agent.id, input))[0]!.focused, true);
  assert.equal((await stamp(other.id, input))[0]!.focused, true, "re-read after the change");
  await unfocus(agent.id, conversation);
  assert.equal((await stamp(agent.id, input))[0]!.focused, undefined);
});

dbTest("any failure delivers untagged and is not kept: the flag read, the focus-set read, the capability read", async ({ seed }) => {
  const { agent, conversation, stamp } = await fixture(seed, { flag: true });
  await focus(agent.id, conversation, "manual");
  const input = [message(conversation, "thread")];

  // The flag evaluation fails: read as off.
  const flagDown = await withQueries(() => stamp(agent.id, input), { fail: true });
  assert.equal(flagDown.result, input);
  assert.equal(focusReads(flagDown.sql), 0);

  // The flag is cached on, the focus-set read fails.
  __setFlagReadCacheTtlForTests(30_000);
  assert.equal((await stamp(agent.id, input))[0]!.focused, true);
  __clearFocusSetCacheForTests();
  const setDown = await withQueries(() => stamp(agent.id, input), { fail: true });
  assert.equal(setDown.result, input);
  assert.equal(focusReads(setDown.sql), 1);
  assert.equal((await stamp(agent.id, input))[0]!.focused, true, "the failed read was not cached");

  // The capability read fails.
  assert.equal(await stamp(agent.id, input, () => Promise.reject(new Error("store down"))), input);

  // Failures in a row log at most one warning (a failing flag read would otherwise log on every delivery).
  const warn = console.warn;
  let warnings = 0;
  console.warn = () => { warnings += 1; };
  try {
    for (let i = 0; i < 3; i += 1) await stamp(agent.id, input, () => Promise.reject(new Error("store down")));
  } finally {
    console.warn = warn;
  }
  assert.ok(warnings <= 1, `saw ${warnings} warnings`);
});

dbTest("an unfocused conversation is not tagged, and a channel id that is no channel row is never looked up", async ({ seed }) => {
  const { agent, conversation, stamp } = await fixture(seed, { flag: true });
  await focus(agent.id, conversation, "manual");
  assert.equal((await stamp(agent.id, [message(conversation, "thread")]))[0]!.focused, true);
  await unfocus(agent.id, conversation);
  // The row is still there (it remembers the unfocus); it is no entry.
  assert.equal((await getDb().select().from(agentFocusTargets)).filter((row) => row.agentId === agent.id).length, 1);
  assert.equal((await stamp(agent.id, [message(conversation, "thread")]))[0]!.focused, undefined);
  __clearFocusSetCacheForTests();
  assert.equal((await stamp(agent.id, [message(conversation, "thread")]))[0]!.focused, undefined);

  // A third-party event arrives as a `dm` under a label: no query, and a tag it carried goes.
  const labelled = [{ ...message(`third-party-agent-events:${randomUUID()}`, "dm"), focused: true as const }];
  const { result, sql } = await withQueries(() => stamp(agent.id, labelled));
  assert.deepEqual(sql, []);
  assert.equal("focused" in result[0]!, false);
});
