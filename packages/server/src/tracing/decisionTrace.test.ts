import assert from "node:assert/strict";
import { buildDecisionEventAttrs } from "./decisionTrace";

const contract = {
  name: "server.test.decision",
  actions: ["computed", "suppressed"] as const,
  reasons: ["entries_found", "no_entries"] as const,
  attributeKeys: ["entries_n", "baseline_before"] as const,
  stringAttributeValidators: {
    baseline_before: (value: string) => value === "unknown" || /^\d+\.\d+\.\d+$/.test(value),
  },
};

test("decision helper emits only contract-declared closed attrs", () => {
  assert.deepEqual(buildDecisionEventAttrs(contract, {
    action: "computed",
    reason: "entries_found",
    attrs: { entries_n: 2, baseline_before: "0.71.1" },
  }), {
    event_kind: "decision",
    outcome: "decided",
    action: "computed",
    reason: "entries_found",
    entries_n: 2,
    baseline_before: "0.71.1",
  });
});

test("decision helper fails closed on unknown enums and raw-value attributes", () => {
  assert.throws(() => buildDecisionEventAttrs(contract, {
    action: "other",
    reason: "entries_found",
  } as never), /unknown action/);
  assert.throws(() => buildDecisionEventAttrs(contract, {
    action: "computed",
    reason: "entries_found",
    attrs: { message_content: "private" },
  } as never), /undeclared or unsafe attribute/);
  assert.throws(() => buildDecisionEventAttrs(contract, {
    action: "computed",
    reason: "entries_found",
    attrs: { baseline_before: "/Users/alice/private" },
  }), /unsafe string attribute/);
});

test("decision helper allows message and path only as bounded identifiers or counters", () => {
  const ids = {
    name: "server.test.decision_ids",
    actions: ["computed"] as const,
    reasons: ["entries_found"] as const,
    attributeKeys: ["message_count", "message_id_hash", "path_kind", "message", "message_text", "file_path", "message_id_raw"] as const,
    stringAttributeValidators: {
      message_id_hash: (value: string) => /^[0-9a-f]{16}$/.test(value),
      path_kind: (value: string) => value === "thread" || value === "channel",
      message: () => true,
      message_text: () => true,
      file_path: () => true,
      message_id_raw: () => true,
    },
  };
  assert.deepEqual(buildDecisionEventAttrs(ids, {
    action: "computed",
    reason: "entries_found",
    attrs: { message_count: 3, message_id_hash: "0123456789abcdef", path_kind: "thread" },
  }), {
    event_kind: "decision",
    outcome: "decided",
    action: "computed",
    reason: "entries_found",
    message_count: 3,
    message_id_hash: "0123456789abcdef",
    path_kind: "thread",
  });
  for (const key of ["message", "message_text", "file_path", "message_id_raw"] as const) {
    assert.throws(() => buildDecisionEventAttrs(ids, {
      action: "computed",
      reason: "entries_found",
      attrs: { [key]: "x" },
    }), /undeclared or unsafe attribute/);
  }
});
