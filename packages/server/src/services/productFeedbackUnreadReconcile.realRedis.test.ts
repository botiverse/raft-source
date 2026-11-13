// Real-Redis teeth for the product-feedback unread reconcile state
// (productFeedbackUnreadReconcile.ts). The default suite runs the job on the
// in-memory state; only a real Redis runs the claim (SET NX PX, one per app)
// and the Lua scripts: the cursor saved only by the claim's holder (with
// last_success_at), and the stuck counter that restarts on progress. CI runs
// this in the probe-concurrency job with a Redis service; local runs need
// PRODUCT_FEEDBACK_RECONCILE_REAL_REDIS_URL.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import {
  PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY,
  productFeedbackReconcileClaimKey,
  productFeedbackReconcileCursorKey,
  redisProductFeedbackReconcileState,
} from "./productFeedbackUnreadReconcile";

const REAL_REDIS_URL = process.env.PRODUCT_FEEDBACK_RECONCILE_REAL_REDIS_URL;
const REAL_REDIS_REQUIRED = process.env.PRODUCT_FEEDBACK_RECONCILE_REAL_REDIS_REQUIRED === "1";

function skipUnlessRealRedis(): boolean {
  if (REAL_REDIS_URL) return false;
  if (REAL_REDIS_REQUIRED) throw new Error("PRODUCT_FEEDBACK_RECONCILE_REAL_REDIS_REQUIRED=1 but PRODUCT_FEEDBACK_RECONCILE_REAL_REDIS_URL is unset");
  return true;
}

async function withClient(run: (client: Redis) => Promise<void>) {
  const client = new Redis(REAL_REDIS_URL!, { maxRetriesPerRequest: 0, enableOfflineQueue: false, lazyConnect: true });
  await client.connect();
  try {
    await client.del(PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY);
    await run(client);
  } finally {
    await client.del(PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY);
    await client.quit();
  }
}

test.skipIf(skipUnlessRealRedis())("real Redis: one claim per TTL; only its holder saves the cursor, with last_success_at; an expired holder saves nothing", async () => {
  await withClient(async (client) => {
    const state = redisProductFeedbackReconcileState(() => client);
    const appId = randomUUID();
    const [first, second] = [randomUUID(), randomUUID()];
    assert.equal(await state.claim(first, 300, PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY), true);
    assert.equal(await state.claim(second, 300, PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY), false, "a second task skips while the claim holds");
    const ttl = await client.pttl(PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY);
    assert.ok(ttl > 0 && ttl <= 300, `the claim has the TTL, got ${ttl}`);

    assert.equal(await state.saveCursor(second, appId, "not-mine", 1, PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY), false, "a non-holder saves nothing");
    assert.equal(await state.getCursor(appId), null);
    assert.equal(await state.saveCursor(first, appId, "cursor-1", 1_700_000_000_000, PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY), true);
    assert.equal(await state.getCursor(appId), "cursor-1");
    assert.equal(await state.getLastSuccessAt(appId), 1_700_000_000_000);
    assert.equal(await client.pttl(productFeedbackReconcileCursorKey(appId)), -1, "the cursor never expires");

    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(await state.saveCursor(first, appId, "late", 2, PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY), false, "a run that outlived its claim saves nothing");
    assert.equal(await state.getCursor(appId), "cursor-1");
    assert.equal(await state.claim(second, 300, PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY), true, "the claim is free once expired");
    await client.del(productFeedbackReconcileCursorKey(appId));
  });
});

test.skipIf(skipUnlessRealRedis())("real Redis: each app has its own claim; a mobile app's does not lock the web app's or another's, and a cursor is saved only by the holder of its own app's claim", async () => {
  await withClient(async (client) => {
    const state = redisProductFeedbackReconcileState(() => client);
    const [webAppId, androidAppId, iosAppId] = [randomUUID(), randomUUID(), randomUUID()];
    const androidClaim = productFeedbackReconcileClaimKey({ source: "android", appId: androidAppId });
    const iosClaim = productFeedbackReconcileClaimKey({ source: "ios", appId: iosAppId });
    assert.equal(productFeedbackReconcileClaimKey({ source: "web", appId: webAppId }), PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY, "the web app keeps the key older tasks claim");
    assert.notEqual(androidClaim, iosClaim);
    const [web, android, ios, late] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    try {
      assert.equal(await state.claim(android, 300, androidClaim), true);
      assert.equal(await state.claim(late, 300, androidClaim), false, "a second task skips that app while its claim holds");
      assert.equal(await state.claim(web, 300, PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY), true, "the web app's claim is its own");
      assert.equal(await state.claim(ios, 300, iosClaim), true, "another mobile app's too");
      const ttl = await client.pttl(androidClaim);
      assert.ok(ttl > 0 && ttl <= 300, `the app's claim has the TTL, got ${ttl}`);

      assert.equal(await state.saveCursor(web, androidAppId, "not-mine", 1, androidClaim), false, "the web app's holder does not hold Android's claim");
      assert.equal(await state.getCursor(androidAppId), null);
      assert.equal(await state.saveCursor(android, androidAppId, "cursor-1", 1_700_000_000_000, androidClaim), true);
      assert.equal(await state.getCursor(androidAppId), "cursor-1");
      assert.equal(await state.getLastSuccessAt(androidAppId), 1_700_000_000_000);
      assert.equal(await state.saveCursor(android, webAppId, "not-mine", 1, PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY), false, "Android's holder does not hold the web app's claim");
      assert.equal(await state.getCursor(webAppId), null);
    } finally {
      await client.del(androidClaim, iosClaim, productFeedbackReconcileCursorKey(androidAppId));
    }
  });
});

test.skipIf(skipUnlessRealRedis())("real Redis: the stuck counter counts runs that get no further, restarts on progress or a new cursor", async () => {
  await withClient(async (client) => {
    const state = redisProductFeedbackReconcileState(() => client);
    const appId = randomUUID();
    assert.equal(await state.noteStuck(appId, "cursor-a", 2), 1);
    assert.equal(await state.noteStuck(appId, "cursor-a", 2), 2);
    assert.equal(await state.noteStuck(appId, "cursor-a", 1), 3, "no further than before");
    assert.equal(await state.noteStuck(appId, "cursor-a", 5), 1, "further into the page: progress");
    assert.equal(await state.noteStuck(appId, "cursor-b", 0), 1, "another cursor");
    await state.clearStuck(appId);
    assert.equal(await state.noteStuck(appId, "cursor-b", 0), 1);
    await state.clearStuck(appId);
  });
});

test.skipIf(skipUnlessRealRedis())("real Redis: seen replies and the Retry-After not-before round-trip", async () => {
  await withClient(async (client) => {
    const state = redisProductFeedbackReconcileState(() => client);
    const appId = randomUUID();
    const ticketId = randomUUID();
    assert.equal(await state.getSeenComment(appId, ticketId), null);
    await state.setSeenComment(appId, ticketId, "comment-1");
    assert.equal(await state.getSeenComment(appId, ticketId), "comment-1");
    const notBefore = Date.now() + 60_000;
    await state.setNotBefore(appId, notBefore);
    assert.equal(await state.getNotBefore(appId), notBefore);
  });
});
