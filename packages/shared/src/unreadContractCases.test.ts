// The unread contract cases (contract-cases/unread/, README there): every
// case file is valid against case.schema.json, and the server answers it
// replays are ones the current read-state contract allows.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import { markConversationUnreadResponseSchema, readMutationPendingResponseSchema } from "./readStateContract";

const dir = fileURLToPath(new URL("../contract-cases/unread/", import.meta.url));
const schema: unknown = JSON.parse(readFileSync(join(dir, "case.schema.json"), "utf8"));
const files = readdirSync(join(dir, "cases")).filter((name) => name.endsWith(".json")).sort();

type Step = { act: string; status?: number; body?: unknown; from?: string };
type Checkpoint = { afterStep: number };
type Case = {
  id: string;
  status: string;
  steps: Step[];
  checkpoints?: Checkpoint[];
  decision?: { candidates: { id: string; checkpoints?: Checkpoint[] }[] };
};

const cases = files.map((name) => ({ name, value: JSON.parse(readFileSync(join(dir, "cases", name), "utf8")) as Case }));

test("the case schema compiles in strict mode", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  assert.doesNotThrow(() => ajv.compile(schema as object));
});

test("there are cases, and every one is valid against the schema", () => {
  assert.ok(cases.length > 0, "contract-cases/unread/cases/ has no case files");
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema as object);
  for (const { name, value } of cases) {
    assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`);
  }
});

test("the schema rejects what it should", () => {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema as object);
  const agreed = cases.find(({ value }) => value.status === "agreed")?.value;
  assert.ok(agreed);
  assert.equal(validate({ ...agreed, formatVersion: 2 }), false, "an unknown formatVersion");
  assert.equal(validate({ ...agreed, steps: [{ act: "teleport" }] }), false, "an unknown act");
  assert.equal(validate({ ...agreed, expect: { state: { badgeCount: 1 } } }), false, "an unknown state key");
  assert.equal(validate({ ...agreed, status: "pending-product-decision" }), false, "pending without a decision (and with expect)");
});

test("each case's id is its file name, ids are unique, and checkpoints point at steps", () => {
  for (const { name, value } of cases) {
    assert.equal(`${value.id}.json`, name);
    const checkpoints = [
      ...(value.checkpoints ?? []),
      ...(value.decision?.candidates.flatMap((candidate) => candidate.checkpoints ?? []) ?? []),
    ];
    for (const { afterStep } of checkpoints) {
      assert.ok(afterStep <= value.steps.length, `${name}: checkpoint after step ${afterStep} of ${value.steps.length}`);
    }
    const candidateIds = value.decision?.candidates.map((candidate) => candidate.id) ?? [];
    assert.equal(new Set(candidateIds).size, candidateIds.length, `${name}: duplicate candidate ids`);
  }
});

test("the answers the cases replay are ones the current server sends", () => {
  for (const { name, value } of cases) {
    for (const step of value.steps) {
      if (step.act !== "serverResponds" || step.from === "olderServer") continue;
      if (step.status === 200) {
        assert.equal(markConversationUnreadResponseSchema.safeParse(step.body).success, true, `${name}: 200 body`);
      } else if (step.status === 202) {
        assert.equal(readMutationPendingResponseSchema.safeParse(step.body).success, true, `${name}: 202 body`);
      }
    }
  }
});
