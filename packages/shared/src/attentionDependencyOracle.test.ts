import assert from "node:assert/strict";
import test from "node:test";

import {
  ATTENTION_HINT_COPY_VERSION,
  ATTENTION_HINT_DEFAULT_K,
  ATTENTION_HINT_SCHEMA,
  evaluateAttentionDependencyOracle,
} from "./attentionDependencyOracle.js";

test("D(t) oracle shows M2 only when dependencies are provably empty and participation is passive", () => {
  const verdict = evaluateAttentionDependencyOracle({
    trigger: "M2",
    scope: "#proj-runtime",
    targetKind: "channel",
    deliveryCount: ATTENTION_HINT_DEFAULT_K,
    dependencies: {
      directedOpenAsk: false,
      taskAnchor: false,
      awaitedReview: false,
    },
    participation: "pure_receive",
    nowMs: 123,
  });

  assert.equal(verdict.kind, "show");
  assert.equal(verdict.kind === "show" && verdict.hint.schema, ATTENTION_HINT_SCHEMA);
  assert.equal(verdict.kind === "show" && verdict.hint.trigger, "M2");
  assert.equal(verdict.kind === "show" && verdict.hint.copy_version, ATTENTION_HINT_COPY_VERSION);
  const copy = verdict.kind === "show" ? verdict.hint.copy : "";
  assert.match(copy, /followed threads keep delivering until you unfollow them/i);
  assert.doesNotMatch(copy, /ordinary thread updates are muted too|all its threads/i);
});

test("gate_blind_nudger stays silent on unknown dependency state", () => {
  const verdict = evaluateAttentionDependencyOracle({
    trigger: "M2",
    scope: "#proj-runtime",
    targetKind: "channel",
    deliveryCount: ATTENTION_HINT_DEFAULT_K,
    dependencies: {
      directedOpenAsk: "unknown",
      taskAnchor: false,
      awaitedReview: false,
    },
    participation: "pure_receive",
  });

  assert.deepEqual(verdict, { kind: "silence", reason: "dependency_unknown" });
});

test("D(t) oracle stays silent on substantive participation", () => {
  const verdict = evaluateAttentionDependencyOracle({
    trigger: "M2",
    scope: "#proj-runtime",
    targetKind: "channel",
    deliveryCount: ATTENTION_HINT_DEFAULT_K,
    dependencies: {
      directedOpenAsk: false,
      taskAnchor: false,
      awaitedReview: false,
    },
    participation: "substantive",
  });

  assert.deepEqual(verdict, { kind: "silence", reason: "participation_substantive" });
});
