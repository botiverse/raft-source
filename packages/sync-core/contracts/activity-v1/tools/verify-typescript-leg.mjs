/**
 * Makes the `typescriptStatic` column of the contract vectors real.
 *
 * The validator verifier genuinely exercises the JSON Schema leg. This file
 * independently compiles every candidate against the generated binding:
 *
 *   positive    -> must compile
 *   structural  -> must NOT compile
 *   valueDomain -> must compile
 *
 * Value-domain vectors compiling is asserted positively. `exempt` therefore
 * means “the TypeScript type system was shown not to express this constraint,”
 * not “the vector was skipped.”
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bindingPath = resolve(root, "generated/bindings/activity-sync.ts");
const vectorsPath = resolve(root, "fixtures/activity-sync.contract-vectors.jsonl");

const vectors = readFileSync(vectorsPath, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const work = mkdtempSync(join(tmpdir(), "activity-ts-leg-"));
writeFileSync(join(work, "binding.ts"), readFileSync(bindingPath, "utf8"));

const INTENT_TYPES = new Set([
  "ensureWindow",
  "refresh",
  "loadMore",
  "markChannelReadAll",
  "markInboxReadAll",
  "markThreadDone",
  "markInboxDone",
]);

function compileCandidate(vector) {
  const file = `case_${vector.vectorId.replace(/[^A-Za-z0-9]/g, "_")}.ts`;
  // A direct object-literal assignment is deliberate. TypeScript only performs
  // excess-property checking on a fresh literal, which is the static tooth for
  // the sealed-object vector.
  const isIntent = INTENT_TYPES.has(vector.candidate.type);
  const typeName = isIntent ? "ActivityIntent" : "ActivityIngress";
  const source = `import type { ${typeName} } from "./binding";\n`
    + `export const candidate: ${typeName} = ${JSON.stringify(vector.candidate, null, 2)};\n`;
  writeFileSync(join(work, file), source);

  const program = ts.createProgram([join(work, file)], {
    strict: true,
    noEmit: true,
    exactOptionalPropertyTypes: true,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    skipLibCheck: true,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName.endsWith(file));
}

const counts = { positive: 0, structural: 0, valueDomain: 0 };
const rows = [];
let failures = 0;

for (const vector of vectors) {
  const diagnostics = compileCandidate(vector);
  const compiles = diagnostics.length === 0;
  const expected = vector.expectation.typescriptStatic;
  counts[vector.constraintClass] += 1;

  let ok;
  let note = "";
  if (expected === "accept") {
    ok = compiles;
    note = compiles
      ? ""
      : ts.flattenDiagnosticMessageText(diagnostics[0].messageText, " ").slice(0, 90);
  } else if (expected === "reject") {
    ok = !compiles;
    note = compiles ? "TYPECHECKED, but the partition claims TS rejects it" : "";
  } else {
    ok = compiles;
    note = compiles
      ? "confirmed TS cannot catch this (validator-only on Web)"
      : "TS rejected an exempt vector; the partition is stale";
  }

  if (!ok) failures += 1;
  rows.push([
    ok ? "ok" : "FAIL",
    vector.vectorId,
    vector.constraintClass,
    expected,
    compiles ? "compiles" : "type-error",
    note,
  ]);
}

for (const [status, id, classification, expected, actual, note] of rows) {
  console.log(
    `${status.padEnd(4)} ${id.padEnd(32)} ${classification.padEnd(12)} `
      + `expect=${expected.padEnd(7)} actual=${actual.padEnd(11)} ${note}`,
  );
}

assert.deepEqual(counts, { positive: 4, structural: 10, valueDomain: 4 });

console.log("");
if (failures > 0) {
  console.log(
    `TypeScript leg: FAIL — ${failures}/${vectors.length} vectors did not behave as specified`,
  );
  process.exit(1);
}
console.log(
  `TypeScript leg: PASS — ${vectors.length}/${vectors.length} vectors behave as specified`,
);
console.log("  positive    4/4 compile");
console.log("  structural  10/10 rejected by the type system");
console.log("  valueDomain 4/4 compile — exemption verified, not assumed");
