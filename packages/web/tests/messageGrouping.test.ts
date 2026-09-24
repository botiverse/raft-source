// Deterministic local-day keys regardless of the runner's timezone.
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import test from "node:test";

import {
  computeMessageGrouping,
  localDayKey,
  shouldShowGroupedMessageHeader,
} from "../src/components/message/messageGrouping";
import type {
  GroupableMessage,
} from "../src/components/message/messageGrouping";

function msg(overrides: Partial<GroupableMessage> & Pick<GroupableMessage, "id">): GroupableMessage {
  return {
    senderType: "user",
    senderId: "u1",
    messageType: "chat",
    createdAt: "2026-07-01T15:00:00Z",
    ...overrides,
  };
}

test("consecutive same-sender messages group (continuation rows hide avatar + name)", () => {
  const states = computeMessageGrouping([
    msg({ id: "a", createdAt: "2026-07-01T15:00:00Z" }),
    msg({ id: "b", createdAt: "2026-07-01T15:01:00Z" }),
    msg({ id: "c", createdAt: "2026-07-01T15:02:00Z" }),
  ]);

  assert.equal(states.get("a")?.isFirstInGroup, true);
  assert.equal(states.get("a")?.showAvatar, true);
  assert.equal(states.get("a")?.showName, true);

  for (const id of ["b", "c"]) {
    assert.equal(states.get(id)?.isFirstInGroup, false, `${id} continues the group`);
    assert.equal(states.get(id)?.showAvatar, false, `${id} hides avatar`);
    assert.equal(states.get(id)?.showName, false, `${id} hides name`);
    assert.equal(states.get(id)?.showDayDivider, false);
  }
});

test("selected grouped continuation promotes its own avatar/header for share capture", () => {
  const states = computeMessageGrouping([
    msg({ id: "first" }),
    msg({ id: "later", createdAt: "2026-07-01T15:01:00Z" }),
    msg({ id: "latest", createdAt: "2026-07-01T15:02:00Z" }),
  ]);
  const continuation = states.get("later");
  const latest = states.get("latest");

  assert.equal(continuation?.previousMessageId, "first");
  assert.equal(latest?.previousMessageId, "later");
  assert.equal(shouldShowGroupedMessageHeader(continuation, false, false, false), false);
  assert.equal(shouldShowGroupedMessageHeader(continuation, true, false, false), false);
  assert.equal(shouldShowGroupedMessageHeader(continuation, true, true, false), true);
  assert.equal(shouldShowGroupedMessageHeader(latest, true, true, true), false);
  assert.equal(shouldShowGroupedMessageHeader(latest, true, true, false), true);
  assert.equal(shouldShowGroupedMessageHeader(states.get("first"), true, true, false), true);
});

test("a different sender starts a new group", () => {
  const states = computeMessageGrouping([
    msg({ id: "a", senderId: "u1" }),
    msg({ id: "b", senderId: "u2" }),
    msg({ id: "c", senderType: "agent", senderId: "u1" }), // same id string, different type = different sender
  ]);

  assert.equal(states.get("b")?.isFirstInGroup, true);
  assert.equal(states.get("b")?.showAvatar, true);
  assert.equal(states.get("c")?.isFirstInGroup, true, "agent u1 != user u1");
  assert.equal(states.get("c")?.showAvatar, true);
});

test("system messages never act as a chat continuation and break the group", () => {
  const states = computeMessageGrouping([
    msg({ id: "a", senderId: "u1" }),
    msg({ id: "sys", senderId: "u1", messageType: "system" }),
    msg({ id: "b", senderId: "u1" }), // same sender as a, but the system message split them
  ]);

  // system row is its own group and shows no chat chrome
  assert.equal(states.get("sys")?.isFirstInGroup, true);
  assert.equal(states.get("sys")?.showAvatar, false, "system message hides chat avatar");
  assert.equal(states.get("sys")?.showName, false);

  // the message after a system row restarts the group even though the sender matches `a`
  assert.equal(states.get("b")?.isFirstInGroup, true);
  assert.equal(states.get("b")?.showAvatar, true);
});

test("a day boundary starts a new group and marks a date divider (even for the same sender)", () => {
  const states = computeMessageGrouping([
    msg({ id: "a", senderId: "u1", createdAt: "2026-07-01T23:30:00Z" }),
    msg({ id: "b", senderId: "u1", createdAt: "2026-07-02T00:10:00Z" }), // same sender, next day
  ]);

  assert.equal(states.get("a")?.showDayDivider, true, "first message always opens a day");
  assert.equal(states.get("a")?.dayKey, "2026-07-01");

  assert.equal(states.get("b")?.showDayDivider, true, "new calendar day → divider");
  assert.equal(states.get("b")?.dayKey, "2026-07-02");
  assert.equal(states.get("b")?.isFirstInGroup, true, "day boundary breaks the group despite same sender");
  assert.equal(states.get("b")?.showAvatar, true);
});

test("first message always opens a group + a day divider", () => {
  const states = computeMessageGrouping([msg({ id: "only" })]);
  assert.equal(states.get("only")?.isFirstInGroup, true);
  assert.equal(states.get("only")?.showDayDivider, true);
});

test("a standalone message (reply/task) never merges and breaks the run around it", () => {
  const states = computeMessageGrouping(
    [
      msg({ id: "a", senderId: "u1" }),
      msg({ id: "b", senderId: "u1" }), // would normally continue a
      msg({ id: "c", senderId: "u1" }), // would normally continue b
    ],
    undefined,
    new Set(["b"]), // b carries a reply/task → standalone
  );

  assert.equal(states.get("a")?.isFirstInGroup, true);
  assert.equal(states.get("b")?.isFirstInGroup, true, "standalone b keeps its full header");
  assert.equal(states.get("b")?.showAvatar, true);
  assert.equal(states.get("c")?.isFirstInGroup, true, "the message after a standalone restarts the run");
  assert.equal(states.get("c")?.showAvatar, true);
});

test("empty list yields an empty map", () => {
  assert.equal(computeMessageGrouping([]).size, 0);
});

test("localDayKey is a stable YYYY-MM-DD bucket; invalid input yields empty string", () => {
  assert.equal(localDayKey("2026-07-01T15:00:00Z"), "2026-07-01");
  assert.equal(localDayKey("not-a-date"), "");
});
