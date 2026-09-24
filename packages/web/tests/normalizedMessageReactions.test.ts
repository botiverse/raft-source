import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalReactionFactsJson } from "@botiverse/raft-shared";

import type { Message } from "../src/store/messageStore.js";
import {
  applyMessageReactionsForV2Ingress,
  isMessageV2IngressSoleApplyEligible,
  isMessageV2SoleApplyEligible,
  normalizeMessageReactionsForV2,
  normalizeMessagesReactionsForV2,
} from "../src/store/normalizedMessageReactions.js";
import { reactionReadModelStore } from "../src/store/reactionReadModels.js";

const rawMessage: Message = {
  id: "message-a",
  channelId: "channel-all",
  senderType: "user",
  senderId: "actor-a",
  content: "hello",
  createdAt: "2026-07-13T12:00:00.000Z",
  reactions: [{
    emoji: "👍",
    count: 2,
    reactorIds: ["hidden-human", "actor-b"],
    reactorNames: ["Hidden Human", "Bee"],
  }],
};

test("legacy channel compatibility is room-common across principals and keeps names out of shared bytes", () => {
  reactionReadModelStore.getState().reset();
  reactionReadModelStore.getState().activatePrincipal("principal-a");
  const first = normalizeMessageReactionsForV2(rawMessage, {
    serverId: "server-a",
    principalId: "principal-a",
    source: "channel-room",
    viewerUserId: "principal-a",
  });
  reactionReadModelStore.getState().activatePrincipal("principal-b");
  const second = normalizeMessageReactionsForV2(rawMessage, {
    serverId: "server-a",
    principalId: "principal-b",
    source: "channel-room",
    viewerUserId: "principal-b",
  });

  const firstBytes = canonicalReactionFactsJson(first.reactions ?? []);
  const secondBytes = canonicalReactionFactsJson(second.reactions ?? []);
  assert.equal(firstBytes, secondBytes);
  assert.equal(firstBytes.includes("Hidden Human"), false);
  assert.deepEqual(first.reactions, [{ emoji: "👍", count: 2, previewK: [] }]);
  assert.deepEqual(
    reactionReadModelStore.getState().readViewerOverlay("principal-b", "server-a", rawMessage.id, "👍"),
    { status: "unknown" },
  );
  assert.equal(isMessageV2SoleApplyEligible(first), true);
});

test("receiver-private ingress splits overlay and detail cache from the shared fact", () => {
  reactionReadModelStore.getState().reset();
  reactionReadModelStore.getState().activatePrincipal("actor-b");
  const normalized = normalizeMessageReactionsForV2(rawMessage, {
    serverId: "server-a",
    principalId: "actor-b",
    source: "receiver-private",
    viewerUserId: "actor-b",
  });

  assert.deepEqual(normalized.reactions, [{ emoji: "👍", count: 2, previewK: [] }]);
  assert.deepEqual(
    reactionReadModelStore.getState().readViewerOverlay("actor-b", "server-a", rawMessage.id, "👍"),
    { status: "loaded", reactedByMe: true },
  );
  assert.equal(reactionReadModelStore.getState().actorCache.size, 1);
  assert.equal(JSON.stringify(normalized).includes("reactorIds"), false);
  assert.equal(JSON.stringify(normalized).includes("reactorNames"), false);
});

test("the normalized sole-apply tripwire rejects raw, wider, and untrimmed reaction shapes", () => {
  assert.equal(isMessageV2SoleApplyEligible(rawMessage), false);
  assert.equal(isMessageV2SoleApplyEligible({
    ...rawMessage,
    reactions: [{ emoji: "👍", count: 1, previewK: [], reactorIds: ["actor-a"] } as never],
  }), false);
  assert.equal(isMessageV2SoleApplyEligible({
    ...rawMessage,
    reactions: [{ emoji: " 👍 ", count: 1, previewK: [] }],
  }), false);
});

test("an absent reaction field remains absent instead of becoming an authoritative empty snapshot", () => {
  reactionReadModelStore.getState().reset();
  const withoutReactions = { ...rawMessage, reactions: undefined };
  const normalized = normalizeMessageReactionsForV2(withoutReactions, {
    serverId: "server-a",
    principalId: "actor-b",
    source: "receiver-private",
    viewerUserId: "actor-b",
  });
  assert.equal(normalized, withoutReactions);
  assert.deepEqual(
    reactionReadModelStore.getState().readViewerOverlay("actor-b", "server-a", rawMessage.id, "👍"),
    { status: "unknown" },
  );
});

test("an explicit canonical empty roster is eligible for sole apply", () => {
  reactionReadModelStore.getState().reset();
  reactionReadModelStore.getState().activatePrincipal("actor-b");
  const emptySnapshot = { ...rawMessage, reactions: [] };
  const projected = applyMessageReactionsForV2Ingress(emptySnapshot, {
    serverId: "server-a",
    principalId: "actor-b",
    source: "receiver-private",
    viewerUserId: "actor-b",
  });
  assert.equal(projected, emptySnapshot);
  assert.equal(isMessageV2IngressSoleApplyEligible(projected), true);
});

test("receiver-private canonical-looking malformed rows fail before any batch cache commit", () => {
  reactionReadModelStore.getState().reset();
  const malformed = {
    ...rawMessage,
    id: "message-b",
    reactions: [{ emoji: " 👍 ", count: 1, previewK: [] }],
  };
  assert.throws(() => normalizeMessagesReactionsForV2([rawMessage, malformed], {
    serverId: "server-a",
    principalId: "actor-b",
    source: "receiver-private",
    viewerUserId: "actor-b",
  }), /not eligible for normalized V2 apply/);
  assert.equal(reactionReadModelStore.getState().actorCache.size, 0);
  assert.deepEqual(
    reactionReadModelStore.getState().readViewerOverlay(
      "actor-b",
      "server-a",
      rawMessage.id,
      "👍",
    ),
    { status: "unknown" },
  );
});
