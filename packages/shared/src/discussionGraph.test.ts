import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DISCUSSION_RELATION_REGISTRY,
  listChildren,
  messageReactionActorsDiscussion,
  messageRef,
  messageRepliesDiscussion,
  readPage,
  reactionActorsDiscussionKey,
  sendReply,
  setInteraction,
  syncScopeWindow,
} from "./discussionGraph.js";

const parentScopeKey = { serverId: "server-a", scopeKind: "channel", scopeId: "channel-a" };
const message = messageRef("server-a", "message-a");
const actors = messageReactionActorsDiscussion(message, "👍", parentScopeKey);
const replies = messageRepliesDiscussion(message, parentScopeKey);

test("discussion registry closes every registered relation across backing and command columns", () => {
  assert.deepEqual(DISCUSSION_RELATION_REGISTRY.messageReactionActors, {
    rootKind: "message",
    relation: "reaction-actors",
    backing: "read-cache",
    consistency: "read-page",
    provenance: { count: "shared-parent-fold", previewK: "shared-parent-fold" },
    invalidation: "parent-scope-epoch",
    allowedCommands: ["set-interaction"],
  });
  assert.deepEqual(DISCUSSION_RELATION_REGISTRY.messageReplies.allowedCommands, ["reply"]);
});

test("typed discussion factories produce the only valid read/command combinations", () => {
  const actorRead = listChildren(actors, readPage({ principalScope: "user-a" }));
  assert.equal(actorRead.discussion.backing, "read-cache");
  assert.equal(actorRead.window.kind, "read-page");

  const replyRead = listChildren(replies, syncScopeWindow({ epoch: "epoch-a" }));
  assert.equal(replyRead.discussion.backing, "sync-scope");
  assert.equal(replyRead.window.kind, "sync-scope-window");

  assert.equal(sendReply(replies, "hello").kind, "reply");
  assert.equal(setInteraction(message, "reaction", { emoji: "👍", active: true }).kind, "set-interaction");
});

test("ReadCache identity includes the parent scope and cannot alias across rebases", () => {
  const otherScope = messageReactionActorsDiscussion(message, "👍", {
    ...parentScopeKey,
    scopeId: "channel-b",
  });
  assert.notEqual(reactionActorsDiscussionKey(actors), reactionActorsDiscussionKey(otherScope));
});

function compileTimeIllegalStatesStayUnconstructable() {
  // @ts-expect-error ReactionActors is ReadCache-backed and cannot take a SyncScopeWindow.
  listChildren(actors, syncScopeWindow());
  // @ts-expect-error Replies is SyncScope-backed and cannot take a ReadPage.
  listChildren(replies, readPage({ principalScope: "user-a" }));
  // @ts-expect-error ReactionActors has no Reply capability.
  sendReply(actors, "illegal");
}

void compileTimeIllegalStatesStayUnconstructable;
