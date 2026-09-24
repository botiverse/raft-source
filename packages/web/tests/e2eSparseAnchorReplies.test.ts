import assert from "node:assert/strict";
import test from "node:test";
import { seedSparseAnchorReplies } from "./e2e/fixtures/sparseAnchorReplies.js";

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("sparse-anchor schedule seeds reply 00 first, then bounded 10, and preserves result order", async () => {
  const started: number[] = [];
  const releases = new Map<number, (result: string) => void>();
  const items = Array.from({ length: 12 }, (_, index) => index);

  const running = seedSparseAnchorReplies(items, async (item) => {
    started.push(item);
    return new Promise<string>((resolve) => releases.set(item, resolve));
  });

  await nextTurn();
  assert.deepEqual(started, [0], "reply 00 must establish the thread alone");

  releases.get(0)!("done-0");
  await nextTurn();
  assert.deepEqual(started, items.slice(0, 11), "only the next ten replies start together");

  releases.get(10)!("done-10");
  await nextTurn();
  assert.deepEqual(started, items.slice(0, 11), "the next batch waits for every current reply");

  for (let index = 9; index >= 1; index -= 1) {
    releases.get(index)!(`done-${index}`);
  }
  await nextTurn();
  assert.deepEqual(started, items);

  releases.get(11)!("done-11");
  assert.deepEqual(
    await running,
    items.map((item) => `done-${item}`),
    "completion order must not move the pagination boundary",
  );
});

test("sparse-anchor schedule reaches UI assertions inside a controlled latency window", async () => {
  const replyCount = 100;
  const responseLatencyMs = 300;
  const testTimeoutMs = 30_000;
  let boundedComplete = false;
  let serialComplete = false;
  let pendingResponses: Array<() => void> = [];

  const postReply = () => new Promise<void>((resolve) => {
    pendingResponses.push(resolve);
  });
  const bounded = seedSparseAnchorReplies(
    Array.from({ length: replyCount }, (_, index) => index),
    postReply,
  ).then(() => {
    boundedComplete = true;
  });
  const serial = (async () => {
    for (let index = 0; index < replyCount; index += 1) {
      await postReply();
    }
    serialComplete = true;
  })();

  await nextTurn();
  const assertionWindowRounds = 1 + Math.ceil((replyCount - 1) / 10);
  for (let round = 0; round < assertionWindowRounds; round += 1) {
    const currentResponses = pendingResponses;
    pendingResponses = [];
    currentResponses.forEach((resolve) => resolve());
    await nextTurn();
  }

  const boundedReachedAssertions = boundedComplete;
  const serialReachedAssertions = serialComplete;

  while (!boundedComplete || !serialComplete) {
    const currentResponses = pendingResponses;
    pendingResponses = [];
    currentResponses.forEach((resolve) => resolve());
    await nextTurn();
  }
  await Promise.all([bounded, serial]);

  assert.equal(
    assertionWindowRounds * responseLatencyMs,
    3_300,
    "the production schedule reaches UI assertions after eleven response rounds",
  );
  assert.ok(
    replyCount * responseLatencyMs >= testTimeoutMs,
    "the old serial schedule consumes the entire 30s case budget before UI assertions",
  );
  assert.equal(boundedReachedAssertions, true);
  assert.equal(serialReachedAssertions, false);
});

test("sparse-anchor schedule accepts an empty fixture without posting", async () => {
  let posts = 0;
  const results = await seedSparseAnchorReplies([], async () => {
    posts += 1;
    return "unexpected";
  });

  assert.deepEqual(results, []);
  assert.equal(posts, 0);
});
