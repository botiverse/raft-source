import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CANONICAL_MESSAGE_MANIFEST,
  CANONICAL_REQUIRED_MESSAGE_FIELDS,
  OPTIONAL_AGGREGATE_MESSAGE_FIELDS,
} from "@botiverse/raft-shared";
import type {
  CanonicalMessageField,
} from "@botiverse/raft-shared";
import type { Message } from "../src/store/messageStore";

/**
 * G2 (web half) of the canonical message fold contract (draft v3.1 → RFC 043
 * amendment): the web fold-facing `Message` surface must EQUAL the canonical
 * manifest — both directions enforced at compile time, so a drift on either
 * side fails typecheck before any test runs.
 */

// Client-only fields excluded from the canonical contract (must mirror the
// manifest's excludedClientOnly list; the runtime assertion below pins it).
type ExcludedClientOnlyField = "optimisticDisplaySeq";

// Direction 1 — every manifest field exists on web `Message`.
// A manifest field with no web counterpart fails this Record's key type.
const WEB_FIELD_FOR_MANIFEST_FIELD: { [K in CanonicalMessageField]: K & keyof Message } = {
  channelId: "channelId",
  content: "content",
  createdAt: "createdAt",
  id: "id",
  messageType: "messageType",
  randomId: "randomId",
  senderId: "senderId",
  senderType: "senderType",
  seq: "seq",
  threadId: "threadId",
  actionMetadata: "actionMetadata",
  attachments: "attachments",
  commentRef: "commentRef",
  conversationContext: "conversationContext",
  externalAuthor: "externalAuthor",
  mentions: "mentions",
  reactions: "reactions",
  senderDescription: "senderDescription",
  senderMembershipStatus: "senderMembershipStatus",
  senderName: "senderName",
};

// Direction 2 — every non-client-only web `Message` field is classified in the
// manifest. A new unclassified `Message` field fails this Record's key type.
const MANIFEST_FIELD_FOR_WEB_FIELD: {
  [K in Exclude<keyof Message, ExcludedClientOnlyField>]: K & CanonicalMessageField;
} = {
  channelId: "channelId",
  content: "content",
  createdAt: "createdAt",
  id: "id",
  messageType: "messageType",
  randomId: "randomId",
  senderId: "senderId",
  senderType: "senderType",
  seq: "seq",
  threadId: "threadId",
  actionMetadata: "actionMetadata",
  attachments: "attachments",
  commentRef: "commentRef",
  conversationContext: "conversationContext",
  externalAuthor: "externalAuthor",
  mentions: "mentions",
  reactions: "reactions",
  senderDescription: "senderDescription",
  senderMembershipStatus: "senderMembershipStatus",
  senderName: "senderName",
};

test("web Message surface == canonical manifest (20 fields, both directions)", () => {
  const manifestFields = [
    ...CANONICAL_REQUIRED_MESSAGE_FIELDS,
    ...OPTIONAL_AGGREGATE_MESSAGE_FIELDS,
  ].sort();
  assert.deepEqual(Object.keys(WEB_FIELD_FOR_MANIFEST_FIELD).sort(), manifestFields);
  assert.deepEqual(Object.keys(MANIFEST_FIELD_FOR_WEB_FIELD).sort(), manifestFields);
  assert.deepEqual(
    [...CANONICAL_MESSAGE_MANIFEST.excludedClientOnly],
    ["optimisticDisplaySeq"],
    "ExcludedClientOnlyField type above must mirror the manifest's excluded list",
  );
});
