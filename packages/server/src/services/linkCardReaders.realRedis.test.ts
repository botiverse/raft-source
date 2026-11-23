// Real-Redis teeth for the link card reader store (linkCardReaders.ts). The
// default suite runs the memory store; only a real Redis runs the MULTI that
// records a reader (ZADD, trims by age and by count, PEXPIRE), the readers
// pipeline, the two Lua scripts of the coalescing window, and the first
// command on a client that is still connecting. CI runs it in the probe job
// with a Redis service; local runs need LINK_CARD_READERS_REAL_REDIS_URL.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { asLinkCardObjectRef } from "@botiverse/raft-shared/src/appLinkPreview";
import { LINK_CARD_READERS_PER_OBJECT, LINK_CARD_READERS_WINDOW_MS, linkCardObjectKeySha256, redisLinkCardReaderStore } from "./linkCardReaders";

const REAL_REDIS_URL = process.env.LINK_CARD_READERS_REAL_REDIS_URL;
const REAL_REDIS_REQUIRED = process.env.LINK_CARD_READERS_REAL_REDIS_REQUIRED === "1";

function skipUnlessRealRedis(): boolean {
  if (REAL_REDIS_URL) return false;
  if (REAL_REDIS_REQUIRED) throw new Error("LINK_CARD_READERS_REAL_REDIS_REQUIRED=1 but LINK_CARD_READERS_REAL_REDIS_URL is unset");
  return true;
}

const objectKey = () => linkCardObjectKeySha256(randomUUID(), asLinkCardObjectRef(`pr:o/r#${randomUUID()}`)!);

test.skipIf(skipUnlessRealRedis())("real Redis: a reader recorded on a client still connecting lands; reads past 24 hours and past 1,000 go, oldest first; the key expires in 24 hours", async () => {
  // As the shared bounded client: no offline queue.
  const client = new Redis(REAL_REDIS_URL!, { maxRetriesPerRequest: 0, enableOfflineQueue: false });
  const object = objectKey();
  const key = `slock:link-card:readers:${object}`;
  try {
    assert.notEqual(client.status, "ready", "the client is still connecting");
    const store = redisLinkCardReaderStore(() => client);
    const now = Date.now();
    await store.record([object], "old", now - LINK_CARD_READERS_WINDOW_MS - 1);
    await store.record([object], "recent", now - 1000);
    assert.deepEqual(await store.readers([object], now - LINK_CARD_READERS_WINDOW_MS), [["recent"]]);
    const ttl = await client.pttl(key);
    assert.ok(ttl > LINK_CARD_READERS_WINDOW_MS - 60_000 && ttl <= LINK_CARD_READERS_WINDOW_MS, `expires in 24 hours, got ${ttl}`);
    for (let i = 0; i < LINK_CARD_READERS_PER_OBJECT; i++) await store.record([object], `reader-${i}`, now + i);
    const readers = (await store.readers([object], now - LINK_CARD_READERS_WINDOW_MS))[0]!;
    assert.equal(readers.length, LINK_CARD_READERS_PER_OBJECT);
    assert.ok(!readers.includes("recent"), "the oldest read went first");
    assert.deepEqual(await store.readers([objectKey()], 0), [[]], "an object no one read");
  } finally {
    await client.del(key).catch(() => {});
    client.disconnect();
  }
});

test.skipIf(skipUnlessRealRedis())("real Redis: one window per object; only its opener closes it, learning whether it was marked meanwhile", async () => {
  const client = new Redis(REAL_REDIS_URL!, { maxRetriesPerRequest: 0, enableOfflineQueue: false });
  const object = objectKey();
  try {
    const store = redisLinkCardReaderStore(() => client);
    assert.equal(await store.openOrMark(object, "a", 7000), true, "the first change opens it");
    assert.equal(await store.close(object, "a"), false, "unmarked: no trailing nudge");
    assert.equal(await store.openOrMark(object, "a", 7000), true, "closed, so the next change opens again");
    assert.equal(await store.openOrMark(object, "b", 7000), false, "another replica's change only marks it");
    assert.equal(await store.close(object, "b"), false, "not its window: left alone");
    assert.equal(await store.close(object, "a"), true, "the opener sends once more");
    assert.equal(await store.close(object, "a"), false, "once");
    assert.equal(await client.exists(`slock:link-card:changed_window:${object}`, `slock:link-card:changed_dirty:${object}`), 0);
    assert.equal(await store.openOrMark(object, "c", 50), true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(await store.openOrMark(object, "d", 7000), true, "a window whose opener never closed it expires on its own");
    await store.close(object, "d");
  } finally {
    client.disconnect();
  }
});
