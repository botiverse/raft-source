import assert from "node:assert/strict";
import { test } from "vitest";
import { productFeedbackServerTiming, sanitizeHandsServerTiming } from "./productFeedbackTiming.js";

test("feedback timing forwards only fixed Hands duration metrics", () => {
  assert.deepEqual(sanitizeHandsServerTiming([
    "hands_auth;dur=12.34",
    "hands_preflight;dur=56.7",
    "ticket_id;dur=1",
    "hands_commit;desc=secret;dur=8",
    "hands_commit;dur=-1",
    "hands_list;dur=999999",
    "hands_auth;dur=99.9",
    "hands_postcommit;dur=0",
    "hands_session_mint;dur=8.25",
    "hands_session_verify;dur=0.45",
  ].join(", ")), [
    "hands_auth;dur=12.3",
    "hands_preflight;dur=56.7",
    "hands_postcommit;dur=0.0",
    "hands_session_mint;dur=8.3",
    "hands_session_verify;dur=0.5",
  ]);
});

test("feedback timing includes a bounded Raft-to-Hands duration", () => {
  assert.equal(
    productFeedbackServerTiming(123.456, "hands_auth;dur=20.0, hands_list;dur=80.0"),
    "raft_feedback_hands;dur=123.5, hands_auth;dur=20.0, hands_list;dur=80.0",
  );
  assert.equal(productFeedbackServerTiming(Number.POSITIVE_INFINITY, null), "raft_feedback_hands;dur=0.0");
  assert.equal(
    productFeedbackServerTiming(10, "hands_auth;dur=5"),
    "raft_feedback_hands;dur=10.0, hands_auth;dur=5.0",
    "deploy-token mode must not invent session timing names",
  );
});
