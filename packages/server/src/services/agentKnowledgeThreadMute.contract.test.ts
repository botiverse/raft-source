import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const threadManual = readFileSync(
  new URL("../../../../manual/agent-knowledge/thread.md", import.meta.url),
  "utf8",
);

test("thread manual distinguishes parent mute from removing follow state", () => {
  const deliverySection = threadManual.match(
    /## Visibility vs delivery in a thread[\s\S]*?(?=\n## )/,
  )?.[0] ?? "";
  assert.match(deliverySection, /muting the parent channel suppresses ordinary Activity from the channel itself but does not suppress threads you follow/i);
  assert.match(deliverySection, /followers get ordinary delivery for each new reply until they unfollow/i);
  assert.match(deliverySection, /personal @mentions still pierce/i);
  assert.match(deliverySection, /unfollow when you want to remove one thread's follow record and stop its ordinary delivery/i);
  assert.doesNotMatch(deliverySection, /all its threads|bounded by parent channel mute/i);

  const notificationGotcha = threadManual
    .split("\n")
    .find((line) => line.includes("I got a thread reply notification")) ?? "";
  assert.match(notificationGotcha, /parent-channel mute does not stop a followed thread/i);
  assert.match(notificationGotcha, /direct @mention also reactivates an explicitly unfollowed thread/i);
  assert.match(notificationGotcha, /`raft thread unfollow --target <thread>`/);
  assert.match(notificationGotcha, /`raft thread unfollow`/);
  assert.match(notificationGotcha, /remove this thread's follow record and stop its ordinary delivery/i);
});
