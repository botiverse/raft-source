import assert from "node:assert/strict";
import { agentMigrationSourceBuildProgressReportSchema } from "./agentMigration";
import {
  agentMigrationUserIgnoreAdditionsReceiptSchema,
  readAgentMigrationUserIgnoreAdditions,
} from "./agentMigrationUserIgnore";

const VALID = { paths: ["data/raw", "**/fixtures"], addedBy: "Alice", addedAt: "2026-11-04T08:30:00Z" };

test("a source lease's userIgnoreAdditions is read when well formed", () => {
  assert.deepEqual(readAgentMigrationUserIgnoreAdditions({ role: "source", userIgnoreAdditions: VALID }), {
    kind: "present",
    additions: VALID,
  });
  assert.deepEqual(readAgentMigrationUserIgnoreAdditions({ role: "source" }), { kind: "absent" });
  // Content is the daemon's to judge (it writes free text sanitized); the reader checks shape and bounds.
  assert.equal(readAgentMigrationUserIgnoreAdditions({
    role: "source",
    userIgnoreAdditions: { paths: [], addedBy: "", addedAt: "not a date" },
  }).kind, "present");
});

test("at most 200 paths of at most 1024 UTF-8 bytes each", () => {
  const read = (paths: unknown) => readAgentMigrationUserIgnoreAdditions({ role: "source", userIgnoreAdditions: { ...VALID, paths } }).kind;
  assert.equal(read(Array.from({ length: 200 }, (_, i) => `p${i}`)), "present");
  assert.equal(read(Array.from({ length: 201 }, (_, i) => `p${i}`)), "invalid");
  assert.equal(read(["a".repeat(1024)]), "present");
  assert.equal(read(["a".repeat(1025)]), "invalid");
  // 342 three-byte characters: 1026 bytes though only 342 characters.
  assert.equal(read(["中".repeat(341)]), "present");
  assert.equal(read(["中".repeat(342)]), "invalid");
});

test("wrong types make a source lease's field invalid", () => {
  for (const userIgnoreAdditions of [
    null,
    "data",
    ["data"],
    { ...VALID, paths: "data" },
    { ...VALID, paths: ["data", 7] },
    { ...VALID, addedBy: 7 },
    { ...VALID, addedAt: null },
    { paths: ["data"], addedBy: "Alice" },
  ]) {
    assert.deepEqual(
      readAgentMigrationUserIgnoreAdditions({ role: "source", userIgnoreAdditions }),
      { kind: "invalid" },
      JSON.stringify(userIgnoreAdditions),
    );
  }
});

test("a target lease ignores the field, valid or not", () => {
  assert.deepEqual(readAgentMigrationUserIgnoreAdditions({ role: "target", userIgnoreAdditions: VALID }), { kind: "absent" });
  assert.deepEqual(readAgentMigrationUserIgnoreAdditions({ role: "target", userIgnoreAdditions: "junk" }), { kind: "absent" });
});

test("a source-progress report takes the receipt as an optional, strict field", () => {
  const report = { migrationGeneration: "g", phase: "scanning", files: 0, bytes: 0 };
  const receipt = { written: 2, alreadyPresent: 1, rejected: [{ path: "MEMORY.md", reason: "forced_keep" }] };
  assert.deepEqual(agentMigrationSourceBuildProgressReportSchema.parse(report), report);
  assert.deepEqual(
    agentMigrationSourceBuildProgressReportSchema.parse({ ...report, userIgnoreAdditions: receipt }),
    { ...report, userIgnoreAdditions: receipt },
  );
  assert.equal(agentMigrationUserIgnoreAdditionsReceiptSchema.safeParse({ ...receipt, extra: 1 }).success, false);
  assert.equal(agentMigrationUserIgnoreAdditionsReceiptSchema.safeParse({
    ...receipt,
    rejected: [{ path: "x", reason: "too_spicy" }],
  }).success, false);
  assert.equal(agentMigrationUserIgnoreAdditionsReceiptSchema.safeParse({
    ...receipt,
    rejected: Array.from({ length: 21 }, () => ({ path: "x", reason: "invalid_line" })),
  }).success, false);
});
