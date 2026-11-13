import assert from "node:assert/strict";
import { __setAgentHistoryBlockStoreForTests, countAgentHistoryBlocks7d, noteAgentHistoryBlock } from "./agentHistoryBlocks";

// C+ step 2 (task #proj-commercial:#24): one per agent, conversation (or
// search) and UTC day; the count sums the last 7 UTC days.

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-12T10:00:00.000Z");

function memoryStore() {
  const sets = new Map<string, Set<string>>();
  return {
    sets,
    store: {
      async add(key: string, member: string) {
        const set = sets.get(key) ?? new Set<string>();
        set.add(member);
        sets.set(key, set);
      },
      async sizes(keys: readonly string[]) {
        return keys.map((key) => sets.get(key)?.size ?? 0);
      },
    },
  };
}

afterEach(() => __setAgentHistoryBlockStoreForTests(null));

test("one per agent, conversation and day; the count covers the last 7 UTC days", async () => {
  const { store, sets } = memoryStore();
  __setAgentHistoryBlockStoreForTests(store);
  noteAgentHistoryBlock({ serverId: "s1", agentId: "a1", reach: { conversationId: "c1" }, now: NOW });
  noteAgentHistoryBlock({ serverId: "s1", agentId: "a1", reach: { conversationId: "c1" }, now: NOW + 60_000 });
  noteAgentHistoryBlock({ serverId: "s1", agentId: "a1", reach: { search: true }, now: NOW });
  noteAgentHistoryBlock({ serverId: "s1", agentId: "a2", reach: { conversationId: "c1" }, now: NOW });
  noteAgentHistoryBlock({ serverId: "s1", agentId: "a1", reach: { conversationId: "c1" }, now: NOW - 6 * DAY_MS });
  noteAgentHistoryBlock({ serverId: "s1", agentId: "a1", reach: { conversationId: "c1" }, now: NOW - 7 * DAY_MS });
  noteAgentHistoryBlock({ serverId: "s2", agentId: "a1", reach: { conversationId: "c9" }, now: NOW });
  assert.deepEqual([...(sets.get("agent-history-blocked:s1:2026-11-12") ?? [])].sort(), ["a1:c1", "a1:search", "a2:c1"]);
  assert.equal(await countAgentHistoryBlocks7d("s1", NOW), 4, "today's 3, and 6 days ago; 7 days ago is outside");
  assert.equal(await countAgentHistoryBlocks7d("s2", NOW), 1);
  assert.equal(await countAgentHistoryBlocks7d("s3", NOW), 0);
});

test("an unreadable store gives no count, and a failed write is swallowed", async () => {
  __setAgentHistoryBlockStoreForTests({
    add: async () => { throw new Error("down"); },
    sizes: async () => { throw new Error("down"); },
  });
  noteAgentHistoryBlock({ serverId: "s1", agentId: "a1", reach: { conversationId: "c1" }, now: NOW });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await countAgentHistoryBlocks7d("s1", NOW), null);
});
