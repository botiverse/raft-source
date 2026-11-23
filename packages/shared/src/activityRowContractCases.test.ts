// The Activity row contract cases (contract-cases/activity-row/, README there):
// every case file is valid against case.schema.json, and every agreed case
// holds for the shared rule (reduceActivityRow, activityLiveUnread,
// applySyncInboxRowChange for sync_inbox_row deletes). Web runs
// the same cases (packages/web/tests/contractCases.activityRow.test.ts), the
// app its vendored copy, and the server the predicate cases against the
// RisingWave SQL (packages/server/src/services/activityUnreadPredicate.contractCases.test.ts).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import { runActivityRowCase, type ActivityRowCase } from "./activityRowContractCaseRunner";

const dir = fileURLToPath(new URL("../contract-cases/activity-row/", import.meta.url));
const schema: unknown = JSON.parse(readFileSync(join(dir, "case.schema.json"), "utf8"));
const files = readdirSync(join(dir, "cases")).filter((name) => name.endsWith(".json")).sort();
const cases = files.map((name) => ({ name, value: JSON.parse(readFileSync(join(dir, "cases", name), "utf8")) as ActivityRowCase }));

/** The named cases the redesign's acceptance rests on (design doc, "Fact 1"). */
const REQUIRED = [
  "in_order_live_before_answer",
  "reverse_commit_live_after_answer",
  "reverse_commit_live_before_answer",
  "duplicate_delivery",
  "mention_only_then_message",
  "mention_only_reverse_commit",
  "null_position_rereads",
  "mention_only_counting_mention",
  "seq_above_2_53",
];

test("the case schema compiles in strict mode", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  assert.doesNotThrow(() => ajv.compile(schema as object));
});

test("every case is valid against the schema, its id is its file name, and checkpoints point at steps", () => {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema as object);
  for (const { name, value } of cases) {
    assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`);
    assert.equal(`${value.id}.json`, name);
    for (const { afterStep } of value.checkpoints ?? []) {
      assert.ok(afterStep <= value.steps.length, `${name}: checkpoint after step ${afterStep} of ${value.steps.length}`);
    }
  }
});

test("the named cases are there and agreed", () => {
  for (const id of REQUIRED) {
    assert.equal(cases.find(({ value }) => value.id === id)?.value.status, "agreed", id);
  }
});

test("the schema rejects what it should", () => {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema as object);
  const position = cases.find(({ value }) => value.rule === "position")!.value;
  const predicate = cases.find(({ value }) => value.rule === "predicate" && value.status === "agreed")!.value;
  assert.equal(validate({ ...position, formatVersion: 2 }), false, "an unknown formatVersion");
  assert.equal(validate({ ...position, steps: [{ act: "teleport" }] }), false, "an unknown act");
  assert.equal(validate({ ...position, steps: [{ act: "read", seq: 101 }] }), false, "a seq as a JSON number");
  assert.equal(validate({ ...position, steps: [{ act: "read", seq: "0101" }] }), false, "a non-canonical seq");
  assert.equal(validate({ ...position, expect: { row: { unreadCount: 1 } } }), false, "a position case without reread");
  assert.equal(validate({ ...position, expect: { reread: false, verdict: { counts: true, mention: false } } }), false, "a verdict on a position case");
  assert.equal(validate({ ...position, steps: [{ act: "syncDelete", position: null, reason: "left" }] }), false, "a syncDelete on a position case");
  assert.equal(validate({ ...position, expect: { removed: true, reread: false } }), false, "removed on a position case");
  assert.equal(validate({ ...position, rule: "sync_inbox_row", steps: [{ act: "syncDelete", position: "1", reason: "gone" }] }), false, "an unknown delete reason");
  assert.equal(validate({ ...position, rule: "sync_inbox_row", steps: [{ act: "syncDelete", position: null, reason: "left" }], expect: { removed: true, reread: false } }), true, "control: a sync_inbox_row delete case");
  assert.equal(validate({ ...predicate, steps: [{ act: "read", seq: 1 }] }), false, "steps on a predicate case");
  assert.equal(validate({ ...predicate, expect: { reread: true } }), false, "a predicate case without a verdict");
  assert.equal(validate({ ...predicate, status: "pending-product-decision" }), false, "pending without a decision (and with expect)");
});

for (const { value } of cases) {
  if (value.status !== "agreed") {
    test.skip(`${value.id} (skipped: pending product decision: ${value.decision?.question})`, () => {});
    continue;
  }
  test(`${value.id} holds for the shared rule`, () => runActivityRowCase(value));
}
