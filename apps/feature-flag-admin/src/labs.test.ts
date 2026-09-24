import assert from "node:assert/strict";
import test from "node:test";
import {
  auditReasonValid,
  createLabMutationBody,
  fallbackLabel,
  LAB_OPERATOR_ENDPOINTS,
  labKeyValid,
  labTransitionLabel,
  nextLabStates,
  orderedRules,
  selectableLabs,
  type FeatureFlagRuleLike,
  type LabDefinition,
} from "./labs";

const NOW = "2026-07-22T00:00:00.000Z";

function lab(labKey: string, state: LabDefinition["state"]): LabDefinition {
  return { labKey, name: labKey, description: `${labKey} description`, state, createdAt: NOW, updatedAt: NOW };
}

function rule(
  id: string,
  stage: FeatureFlagRuleLike["stage"],
  priority: number,
  decision: FeatureFlagRuleLike["decision"] = "allow",
): FeatureFlagRuleLike {
  return { id, stage, priority, decision, values: [id], percentageBasisPoints: null };
}

test("lab picker offers only open catalog entries", () => {
  assert.deepEqual(
    selectableLabs([
      lab("draft", "draft"),
      lab("open", "open"),
      lab("paused", "paused"),
      lab("retired", "retired"),
    ]).map((item) => item.labKey),
    ["open"],
  );
});

test("retired is terminal while paused resumes to open", () => {
  assert.deepEqual(nextLabStates("draft"), ["open"]);
  assert.deepEqual(nextLabStates("open"), ["paused", "retired"]);
  assert.deepEqual(nextLabStates("paused"), ["open", "retired"]);
  assert.deepEqual(nextLabStates("retired"), []);
  assert.equal(labTransitionLabel("draft", "open"), "Publish");
  assert.equal(labTransitionLabel("paused", "open"), "Resume");
});

test("precedence follows evaluator stages then ascending priority", () => {
  const rules = [
    rule("plan", "plan", 0),
    rule("lab-late", "lab", 20, "deny"),
    rule("server", "server", 100),
    rule("lab-early", "lab", 10),
    rule("user", "user", 999),
  ];

  assert.deepEqual(orderedRules(rules).map((item) => item.id), [
    "user",
    "server",
    "lab-early",
    "lab-late",
    "plan",
  ]);
});

test("fallback is explicit operator language", () => {
  assert.equal(fallbackLabel(true), "On");
  assert.equal(fallbackLabel(false), "Off");
});

test("operator endpoint builders encode stable keys and ids", () => {
  assert.equal(LAB_OPERATOR_ENDPOINTS.catalog, "/api/operator/labs");
  assert.equal(LAB_OPERATOR_ENDPOINTS.definition("lab/a"), "/api/operator/labs/lab%2Fa");
  assert.equal(LAB_OPERATOR_ENDPOINTS.lifecycle("lab_a"), "/api/operator/labs/lab_a/state");
  assert.equal(LAB_OPERATOR_ENDPOINTS.rules("flag/a"), "/api/operator/feature-flags/flag%2Fa/lab-rules");
  assert.equal(LAB_OPERATOR_ENDPOINTS.rule("flag_a", "rule/a"), "/api/operator/feature-flags/flag_a/lab-rules/rule%2Fa");
});

test("UI uses the same bounded key and audit-reason admission as the operator API", () => {
  assert.equal(labKeyValid("labs.catalog-v0"), true);
  assert.equal(labKeyValid("Labs Catalog"), false);
  assert.equal(labKeyValid("a".repeat(129)), false);
  assert.equal(auditReasonValid("ok"), false);
  assert.equal(auditReasonValid("publish lab"), true);
  assert.equal(auditReasonValid("x".repeat(501)), false);
});

test("Lab create mutation uses the canonical external labKey contract", () => {
  const body = createLabMutationBody({
    labKey: "labs.catalog_v0",
    name: "Labs catalog",
    description: "Expose the Labs catalog.",
  }, "  publish operator catalog  ", 42);

  assert.deepEqual(body, {
    labKey: "labs.catalog_v0",
    name: "Labs catalog",
    description: "Expose the Labs catalog.",
    reason: "publish operator catalog",
    expectedConfigVersion: 42,
  });
  assert.equal("key" in body, false);
});
