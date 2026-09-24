import assert from "node:assert/strict";
import { test } from "vitest";
import { buildDecisionEventAttrs } from "./decisionTrace.js";

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
