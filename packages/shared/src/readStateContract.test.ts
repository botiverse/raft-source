import assert from "node:assert/strict";

import { buildOpenApiDocument, openApiContractModules } from "./openApiContract";
import { markConversationUnreadResponseSchema, readStateContract } from "./readStateContract";

const answer = { ok: true, unreadCount: 1, maxReadSeq: 4, readStateVersion: 7, markedUnread: false, outcome: "counted" } as const;

test("Mark as Unread is registered: no request body, a channelId path param, explicit statuses", () => {
  assert.equal(openApiContractModules.readState.operations, readStateContract);
  const { markUnread } = readStateContract;
  assert.equal("requestBody" in markUnread, false);
  assert.deepEqual(Object.keys(markUnread.requestParams.shape), ["channelId"]);
  assert.deepEqual(Object.keys(markUnread.responses).map(Number), [200, 202, 403, 404]);
  const operation = buildOpenApiDocument().paths?.["/api/channels/{channelId}/unread"]?.post;
  assert.equal(operation?.operationId, "markConversationUnread");
  assert.equal(operation?.requestBody, undefined);
});

test("the 200 answer: the existing fields plus an optional outcome, nothing else", () => {
  for (const outcome of ["counted", "marked", "nothing"] as const) {
    assert.deepEqual(markConversationUnreadResponseSchema.parse({ ...answer, outcome }), { ...answer, outcome });
  }
  assert.equal(markConversationUnreadResponseSchema.safeParse({ ...answer, outcome: "unknown" }).success, false);
  const { outcome: _omitted, ...withoutOutcome } = answer;
  assert.equal(markConversationUnreadResponseSchema.safeParse(withoutOutcome).success, true, "an older server's answer has no outcome");
  assert.equal(markConversationUnreadResponseSchema.safeParse({ ...answer, extra: 1 }).success, false);
});
