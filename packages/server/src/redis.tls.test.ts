import assert from "node:assert/strict";
import { once } from "node:events";
import Redis from "ioredis";
import { test } from "vitest";
import { initRedis, getRedis, getRedisPub, getRedisSub, getRedisReplicaSub, resetRedisReplicaSub } from "./redis.js";

// Only the disposable loopback fixture from test:redis-tls may be used here.
const fixtureUrl = process.env.RAFT_TEST_REDIS_TLS_URL;

test.skipIf(!fixtureUrl)("runtime Redis clients support authenticated TLS and reject insecure connections", async () => {
  const url = new URL(fixtureUrl!);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "rediss:");
  const rejected = async (candidate: URL, reason: RegExp) => {
    const client = new Redis(candidate.toString(), {
      lazyConnect: true, retryStrategy: () => null, connectTimeout: 1000,
      maxRetriesPerRequest: 0,
    });
    const errors: string[] = [];
    client.on("error", (error) => { errors.push(error.message); });
    try {
      await assert.rejects(async () => {
        try { await client.connect(); await client.ping(); }
        catch (error) { errors.push(String(error)); throw error; }
      });
      assert.ok(errors.some((message) => reason.test(message)), `Expected ${reason}, received ${errors.join("; ")}`);
    } finally { client.disconnect(); }
  };
  const noAuth = new URL(url);
  noAuth.password = "";
  noAuth.username = "";
  await rejected(noAuth, /NOAUTH/);
  const wrongAuth = new URL(url);
  wrongAuth.password = "WrongSyntheticToken123456";
  await rejected(wrongAuth, /WRONGPASS/);
  const plaintext = new URL(url);
  plaintext.protocol = "redis:";
  await rejected(plaintext, /ECONNRESET|Connection is closed|Socket closed|ETIMEDOUT/);

  initRedis(url.toString());
  const clients = [getRedis(), getRedisPub(), getRedisSub(), getRedisReplicaSub()];
  try {
    assert.deepEqual(await Promise.all(clients.map((client) => client.ping())), ["PONG", "PONG", "PONG", "PONG"]);
    for (const subscriber of [getRedisSub(), getRedisReplicaSub()]) {
      await subscriber.subscribe("audit:tls-fixture");
      const received = once(subscriber, "message", { signal: AbortSignal.timeout(3000) });
      await getRedisPub().publish("audit:tls-fixture", "fixture-payload");
      assert.deepEqual(await received, ["audit:tls-fixture", "fixture-payload"]);
    }
    const replacement = resetRedisReplicaSub();
    clients.push(replacement);
    assert.equal(await replacement.ping(), "PONG");
  } finally {
    for (const client of clients) client.disconnect();
  }
}, 15000);
