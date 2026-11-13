// Real-Redis teeth for agentHistoryBlocks' store (task #proj-commercial:#24,
// C+ step 2). The default suite swaps in a memory store; only a real Redis
// runs MULTI SADD + EXPIRE, the SCARD pipeline, and the first command on a
// client that is still connecting. Local runs need
// AGENT_HISTORY_BLOCKS_REAL_REDIS_URL.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { agentHistoryBlockKey, redisAgentHistoryBlockStore } from "./agentHistoryBlocks";

const REAL_REDIS_URL = process.env.AGENT_HISTORY_BLOCKS_REAL_REDIS_URL;
const REAL_REDIS_REQUIRED = process.env.AGENT_HISTORY_BLOCKS_REAL_REDIS_REQUIRED === "1";

function skipUnlessRealRedis(): boolean {
  if (REAL_REDIS_URL) return false;
  if (REAL_REDIS_REQUIRED) throw new Error("AGENT_HISTORY_BLOCKS_REAL_REDIS_REQUIRED=1 but AGENT_HISTORY_BLOCKS_REAL_REDIS_URL is unset");
  return true;
}

test.skipIf(skipUnlessRealRedis())("real Redis: the first write on a client still connecting lands; sets dedupe, expire in 8 days, and sum", async () => {
  // As the shared bounded client: no offline queue, so a command before the
  // connect would fail without the store's first-connect wait.
  const client = new Redis(REAL_REDIS_URL!, { maxRetriesPerRequest: 0, enableOfflineQueue: false });
  const serverId = randomUUID();
  const keys = [agentHistoryBlockKey(serverId, "2026-11-12"), agentHistoryBlockKey(serverId, "2026-11-11")];
  try {
    assert.notEqual(client.status, "ready", "the client is still connecting");
    const store = redisAgentHistoryBlockStore(() => client);
    await store.add(keys[0]!, "agent-1:c1", 8 * 24 * 60 * 60);
    await store.add(keys[0]!, "agent-1:c1", 8 * 24 * 60 * 60);
    await store.add(keys[0]!, "agent-1:search", 8 * 24 * 60 * 60);
    await store.add(keys[1]!, "agent-2:c1", 8 * 24 * 60 * 60);
    assert.deepEqual(await store.sizes(keys), [2, 1]);
    const ttl = await client.ttl(keys[0]!);
    assert.ok(ttl > 7 * 24 * 60 * 60 && ttl <= 8 * 24 * 60 * 60, `about 8 days, got ${ttl}`);

    await client.quit();
    await assert.rejects(store.sizes(keys), "a closed client fails at once");
  } finally {
    const cleanup = new Redis(REAL_REDIS_URL!);
    await cleanup.del(...keys);
    await cleanup.quit();
  }
});
