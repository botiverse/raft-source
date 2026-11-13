/**
 * RED-verifies the TypeScript-leg gate by degrading an in-memory copy of the
 * generated binding. Every plausible emitter regression must flip exactly the
 * named structural vectors from type-error to compiles.
 */
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binding = readFileSync(
  resolve(root, "generated/bindings/activity-sync.ts"),
  "utf8",
);
const vectors = readFileSync(
  resolve(root, "fixtures/activity-sync.contract-vectors.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

function compilesUnder(bindingSource, vector, work) {
  writeFileSync(join(work, "binding.ts"), bindingSource);
  const isIntent = INTENT_TYPES.has(vector.candidate.type);
  const typeName = isIntent ? "ActivityIntent" : "ActivityIngress";
  const file = `case_${vector.vectorId.replace(/[^A-Za-z0-9]/g, "_")}.ts`;
  writeFileSync(
    join(work, file),
    `import type { ${typeName} } from "./binding";\n`
      + `export const candidate: ${typeName} = ${JSON.stringify(vector.candidate, null, 2)};\n`,
  );
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
    .filter((diagnostic) => diagnostic.file?.fileName.endsWith(file)).length === 0;
}

const structural = vectors.filter(
  (vector) => vector.expectation.typescriptStatic === "reject",
);

const INTENT_TYPES = new Set([
  "ensureWindow",
  "refresh",
  "loadMore",
  "markChannelReadAll",
  "markInboxReadAll",
  "markThreadDone",
  "markInboxDone",
]);

function rejectedSet(bindingSource, work) {
  const rejected = new Set();
  for (const vector of structural) {
    if (!compilesUnder(bindingSource, vector, work)) rejected.add(vector.vectorId);
  }
  return rejected;
}

const mutations = [
  {
    name: "B1 emitter widens UInt64String to string | number",
    why: "the decimal-string decision silently reverts to allowing numbers",
    expect: ["N4-decimal-as-number", "N5-unsafe-decimal-as-number", "I2-thread-done-number-throughActivitySeq"],
    apply: (source) =>
      source.replace(
        "export type UInt64String = string;",
        "export type UInt64String = string | number;",
      ),
  },
  {
    name: "B2 emitter emits an index signature",
    why: "unknown wire fields start typechecking",
    expect: ["N3-extra-property"],
    apply: (source) =>
      source.replace(
        /export interface SnapshotIngress \{/,
        "export interface SnapshotIngress {\n  readonly [k: string]: unknown;",
      ),
  },
  {
    name: "B3 emitter marks every SnapshotIngress member optional",
    why: "required/optional collapse on the snapshot branch",
    expect: ["N1-missing-required-field"],
    apply: (source) =>
      source.replace(
        /export interface SnapshotIngress \{[\s\S]*?\n\}/,
        (block) =>
          block.replace(
            /^(\s+readonly\s+[A-Za-z0-9_]+)(\??):/gm,
            "$1?:",
          ),
      ),
  },
  {
    name: "B6 emitter makes required-nullable nextFromSeq optional",
    why: "collapses required T|null into optional T|null",
    expect: ["N9-required-nullable-missing"],
    apply: (source) =>
      source.replace(
        "readonly nextFromSeq: UInt64String | null;",
        "readonly nextFromSeq?: UInt64String | null;",
      ),
  },
  {
    name: "B4 emitter widens the discriminator literal to string",
    why: "the closed union degrades to a rough object shape",
    expect: ["N2-unknown-discriminator"],
    apply: (source) =>
      source.replace(/readonly type: "snapshot";/, "readonly type: string;"),
  },
  {
    name: "B5 emitter drops the ActivityFilter enum",
    why: "a nested scalar constraint silently disappears",
    expect: ["N10-nested-enum-invalid"],
    apply: (source) =>
      source.replace(
        /export type ActivityFilter = .*;/,
        "export type ActivityFilter = string;",
      ),
  },
  {
    name: "B7 emitter makes Done-intent throughActivitySeq optional",
    why: "the Done content-frontier seq silently becomes optional, letting a Done omit its frontier",
    expect: ["I1-thread-done-missing-throughActivitySeq", "I4-inbox-done-missing-throughActivitySeq"],
    apply: (source) =>
      source.replace(
        /readonly throughActivitySeq: UInt64String;/g,
        "readonly throughActivitySeq?: UInt64String;",
      ),
  },
];

const work = mkdtempSync(join(tmpdir(), "activity-ts-mut-"));
const baseline = rejectedSet(binding, work);
console.log(
  `baseline: ${baseline.size}/${structural.length} structural vectors rejected by the type system`,
);
const missing = structural
  .filter((vector) => !baseline.has(vector.vectorId))
  .map((vector) => vector.vectorId);
if (missing.length) {
  console.log(`FAIL — baseline does not reject: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("");

let failures = 0;
for (const mutation of mutations) {
  const mutated = mutation.apply(binding);
  if (mutated === binding) {
    console.log(
      `FAIL  ${mutation.name} — mutation did not alter the binding (anchor drifted)`,
    );
    failures += 1;
    continue;
  }
  const after = rejectedSet(mutated, work);
  const flipped = [...baseline].filter((id) => !after.has(id)).sort();
  const expected = [...mutation.expect].sort();
  const ok = JSON.stringify(flipped) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${(ok ? "RED" : "FAIL").padEnd(5)} ${mutation.name}`);
  console.log(`      ${mutation.why}`);
  console.log(
    `      flipped to compiles: [${flipped.join(", ") || "none"}]  `
      + `expected: [${expected.join(", ")}]`,
  );
}

console.log("");
if (failures) {
  console.log(
    `RESULT: FAIL — ${failures}/${mutations.length} mutations did not flip exactly the named vectors`,
  );
  process.exit(1);
}
console.log(
  `RESULT: PASS — all ${mutations.length} binding degradations flip named structural vectors.`,
);
console.log("The typescriptStatic column is enforced, not declared.");
