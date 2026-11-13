import assert from "node:assert/strict";

import { cardEvaluatedAttrs } from "./agentCardTrace";

const originalJwtSecret = process.env.JWT_SECRET;
beforeEach(() => { process.env.JWT_SECRET = "trace-identity-test-secret"; });
afterEach(() => {
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
});

const channelId = "22222222-2222-4222-8222-222222222222";
const parentId = "55555555-5555-4555-8555-555555555555";
const contextId = "44444444-4444-4444-8444-444444444444";

test("a card check carries the key it is held once for: the card's conversation hashed, context, and whether the send named a version", () => {
  const attrs = cardEvaluatedAttrs({ outcome: "held", targetType: "dm", channelId, cardChannelId: channelId, headers: { "x-agent-context-id": contextId }, seenCardPresent: false });
  assert.equal(attrs.outcome, "held");
  assert.equal(attrs.target_type, "dm");
  assert.equal(attrs.seen_card_present, false);
  assert.equal(attrs.context_id, contextId);
  assert.equal(attrs.context_id_present, true);
  assert.match(String(attrs.conversation_id_hash), /^[0-9a-f]{16}$/);
  assert.equal(attrs.card_conversation_id_hash, attrs.conversation_id_hash, "a top-level send's card is its own conversation's");
  assert.doesNotMatch(JSON.stringify(attrs), /22222222-2222/, "no raw conversation id");
});

test("two threads of one channel are two conversations but one card", () => {
  const threadA = cardEvaluatedAttrs({ outcome: "held", targetType: "thread", channelId: "66666666-6666-4666-8666-666666666666", cardChannelId: parentId, headers: { "x-agent-context-id": contextId }, seenCardPresent: false });
  const threadB = cardEvaluatedAttrs({ outcome: "held", targetType: "thread", channelId: "77777777-7777-4777-8777-777777777777", cardChannelId: parentId, headers: { "x-agent-context-id": contextId }, seenCardPresent: false });
  assert.notEqual(threadA.conversation_id_hash, threadB.conversation_id_hash);
  assert.equal(threadA.card_conversation_id_hash, threadB.card_conversation_id_hash);
});

test("a send without a well-formed context header is marked, not given one", () => {
  const attrs = cardEvaluatedAttrs({ outcome: "seen", targetType: "dm", channelId, cardChannelId: null, headers: { "x-agent-context-id": "not a context" }, seenCardPresent: true });
  assert.equal(attrs.context_id_present, false);
  assert.equal("context_id" in attrs, false);
  assert.equal(attrs.seen_card_present, true);
  assert.equal("card_conversation_id_hash" in attrs, false, "a peer card the send named a version of is not looked up");
});
