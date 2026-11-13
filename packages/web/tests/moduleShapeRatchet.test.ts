/**
 * Required-Test Admission evidence (docs/sops/ci-check-maintenance.md)
 *
 * - Test/check: packages/web module-shape ratchet (check-module-shape.ts,
 *   chained into `lint`)
 * - Adjudicated decision: Artea, #proj-frontend:22900a50 (split monolith
 *   files, one component per file, named exports; "你们推进吧" 1977b9a1)
 * - RED proof (minimal production mutation): append
 *   `export function formatConfirmLabel(x: string) { return x; }` to
 *   src/components/ConfirmDialog.tsx → "exports a component plus 1
 *   non-component value(s) (baseline 0)"; restored file → OK.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_LINES,
  analyzeModuleSource,
  collectCurrentShapes,
  compareShapesToBaseline,
  findGrowth,
  findAppImportsOfTests,
  findEmptyTests,
  findMisplacedTests,
  findStrayFeatureTestFiles,
  followMoves,
  lowerBaseline,
  readBaseline,
  writeBaseline,
} from "../scripts/check-module-shape";
import type { Baseline } from "../scripts/check-module-shape";

test("a component file that also exports a helper is mixed", () => {
  const shape = analyzeModuleSource(
    "src/A.tsx",
    `export function Card() { return <div />; }
export function formatTitle(x: string) { return x; }
export const LIMIT = 3;
export type CardProps = { a: string };`,
  );
  assert.equal(shape.mixedExports, 2);
  assert.equal(shape.defaultComponent, false);
});

test("memo/forwardRef components and type exports keep a file clean", () => {
  const shape = analyzeModuleSource(
    "src/A.tsx",
    `import { memo, forwardRef } from "react";
export const Row = memo(function Row() { return <li />; });
export const Input = forwardRef<HTMLInputElement>((_p, ref) => <input ref={ref} />);
export interface RowProps { id: string }
export type { Other } from "./other";`,
  );
  assert.equal(shape.mixedExports, 0);
});

test("a hook-only .ts module and a helper-only .tsx module are not mixed", () => {
  assert.equal(analyzeModuleSource("src/useX.ts", "export function useX() { return 1; }").mixedExports, 0);
  assert.equal(analyzeModuleSource("src/x.tsx", "export function format() { return 1; }").mixedExports, 0);
});

test("default-exported components are found in all three forms", () => {
  assert.equal(analyzeModuleSource("src/A.tsx", "export default function A() { return <div />; }").defaultComponent, true);
  assert.equal(analyzeModuleSource("src/A.tsx", "function A() { return <div />; }\nexport default A;").defaultComponent, true);
  assert.equal(analyzeModuleSource("src/A.tsx", "const A = () => <div />;\nexport { A as default };").defaultComponent, true);
  assert.equal(analyzeModuleSource("src/A.tsx", "export default { a: 1 };").defaultComponent, false);
});

test("new findings, growth and stale entries fail; unchanged baseline passes", () => {
  const big = MAX_LINES + 100;
  const baseline: Baseline = {
    "src/Big.tsx": { lines: big, mixedExports: 2, defaultComponent: true },
  };
  assert.deepEqual(compareShapesToBaseline({ "src/Big.tsx": { lines: big - 10, mixedExports: 2, defaultComponent: true } }, baseline), []);

  const grown = compareShapesToBaseline({ "src/Big.tsx": { lines: big + 1, mixedExports: 3, defaultComponent: true } }, baseline);
  assert.equal(grown.length, 2);
  assert.match(grown[0] ?? "", /grew to/);
  assert.match(grown[1] ?? "", /non-component value/);

  const fresh = compareShapesToBaseline(
    { ...{ "src/Big.tsx": baseline["src/Big.tsx"] ?? {} }, "src/New.tsx": { lines: MAX_LINES + 1, defaultComponent: true } },
    baseline,
  );
  assert.equal(fresh.length, 2);

  const stale = compareShapesToBaseline({ "src/Big.tsx": { lines: big, mixedExports: 1 } }, baseline);
  assert.equal(stale.length, 2);
  assert.match(stale[0] ?? "", /lower "mixedExports"/);
  assert.match(stale[1] ?? "", /remove "defaultComponent"/);
});

test("--write lowers counts and drops cleared entries, but never records growth", () => {
  const big = MAX_LINES + 100;
  const baseline: Baseline = {
    "src/Big.tsx": { lines: big, mixedExports: 3, defaultComponent: true },
    "src/Split.tsx": { lines: big, mixedExports: 1 },
  };
  const current: Baseline = { "src/Big.tsx": { lines: big - 20, mixedExports: 1 } };
  assert.deepEqual(findGrowth(current, baseline), []);
  assert.deepEqual(lowerBaseline(current, baseline), { "src/Big.tsx": { lines: big, mixedExports: 1 } });
  assert.equal(findGrowth({ "src/Big.tsx": { lines: big, mixedExports: 4 } }, baseline).length, 1);
});

test("--write follows a file that moved, and only an unambiguous move", () => {
  const big = MAX_LINES + 100;
  const baseline: Baseline = {
    "src/components/search/Page.tsx": { lines: big, mixedExports: 4 },
    "src/components/a/Row.tsx": { mixedExports: 1 },
  };
  const current: Baseline = {
    "src/features/search/Page.tsx": { lines: big - 50, mixedExports: 1 },
    "src/features/x/Row.tsx": { mixedExports: 1 },
    "src/features/y/Row.tsx": { mixedExports: 1 },
  };
  const gone = (path: string) => !path.startsWith("src/components/");
  const { baseline: followed, moves } = followMoves(current, baseline, gone);
  assert.deepEqual(moves, [["src/components/search/Page.tsx", "src/features/search/Page.tsx"]]);
  assert.deepEqual(findGrowth({ "src/features/search/Page.tsx": current["src/features/search/Page.tsx"] ?? {} }, followed), []);
  // Two new Row.tsx files: not a move, so both still count as new.
  assert.equal(findGrowth(current, followed).length, 2);
});

test("the baseline directory round-trips and only touches changed entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "module-shape-"));
  try {
    writeBaseline(dir, { "src/a/One.tsx": { lines: 900 }, "src/b/Two.tsx": { mixedExports: 2 } });
    assert.equal(readFileSync(join(dir, "src/a/One.tsx.json"), "utf8"), '{"lines":900}\n');
    writeBaseline(dir, { "src/b/Two.tsx": { mixedExports: 1 } });
    assert.equal(existsSync(join(dir, "src/a")), false);
    assert.deepEqual(readBaseline(dir), { "src/b/Two.tsx": { mixedExports: 1 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("feature tests (src/features/<feature>/tests/) are never a module finding", () => {
  const root = mkdtempSync(join(tmpdir(), "module-shape-src-"));
  const oversized = "export default function Big() { return <div />; }\n" + "// filler\n".repeat(MAX_LINES + 10);
  try {
    for (const path of ["src/features/x/tests/Big.behavior.test.tsx", "src/features/x/tests/helpers/Big.tsx", "src/features/x/Big.tsx"]) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), oversized);
    }
    assert.deepEqual(collectCurrentShapes(root), {
      "src/features/x/Big.tsx": { lines: MAX_LINES + 11, defaultComponent: true },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a test file in src outside src/features/<feature>/tests/ is reported, since Vitest never runs it", () => {
  const root = mkdtempSync(join(tmpdir(), "module-shape-misplaced-"));
  try {
    for (const path of [
      "src/features/x/tests/ok.test.tsx",
      "src/features/x/tests/helpers/fixture.ts",
      "src/features/x/Big.test.tsx",
      "src/features/x/rack/tests/nested.test.tsx",
      "src/components/tests/helper.ts",
      "src/hooks/useThing.spec.ts",
      "src/utils/__tests__/format.ts",
      "src/features/x/Big.tsx",
    ]) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), "export {};\n");
    }
    assert.deepEqual(findMisplacedTests(root), [
      "src/components/tests/helper.ts",
      "src/features/x/Big.test.tsx",
      "src/features/x/rack/tests/nested.test.tsx",
      "src/hooks/useThing.spec.ts",
      "src/utils/__tests__/format.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("app code that imports from a feature's tests/ folder is reported; tests importing each other are not", () => {
  const root = mkdtempSync(join(tmpdir(), "module-shape-app-imports-"));
  const files: Record<string, string> = {
    "src/features/x/tests/helpers/fixture.ts": "export const fixture = 1;\n",
    "src/features/x/tests/a.test.tsx": 'import { fixture } from "./helpers/fixture";\n',
    "src/features/x/Widget.tsx": 'import { fixture } from "./tests/helpers/fixture";\nexport const w = fixture;\n',
    "src/features/y/lazy.ts": 'export const load = () => import("../x/tests/helpers/fixture");\n',
    "src/features/y/ok.ts": 'import { w } from "../x/Widget";\nimport React from "react";\nexport const ok = w;\n',
    "src/features/x/tests/index.ts": "export const all = 1;\n",
    "src/features/x/Barrel.tsx": 'export { all } from "./tests";\n',
    "src/features/x/Commented.tsx": '// import { fixture } from "./tests/helpers/fixture";\n/* import("./tests/a.test") */\nexport const c = "./tests/helpers/fixture";\n',
  };
  try {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    assert.deepEqual(findAppImportsOfTests(root), [
      "src/features/x/Barrel.tsx -> ./tests",
      "src/features/x/Widget.tsx -> ./tests/helpers/fixture",
      "src/features/y/lazy.ts -> ../x/tests/helpers/fixture",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a feature's tests/ folder holds only tests, helpers and fixtures", () => {
  const root = mkdtempSync(join(tmpdir(), "module-shape-stray-"));
  try {
    for (const path of [
      "src/features/x/tests/ok.test.tsx",
      "src/features/x/tests/unit.test.ts",
      "src/features/x/tests/helpers/render.tsx",
      "src/features/x/tests/fixtures/form.json",
      "src/features/x/tests/runtime/fixtures/a.json",
      "src/features/x/tests/Widget.tsx",
      "src/features/x/tests/index.ts",
      "src/features/x/tests/data/rows.ts",
      "src/features/x/Widget.tsx",
    ]) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), "export {};\n");
    }
    assert.deepEqual(findStrayFeatureTestFiles(root), [
      "src/features/x/tests/Widget.tsx",
      "src/features/x/tests/data/rows.ts",
      "src/features/x/tests/index.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty test file, or one that declares no test, is reported", () => {
  const root = mkdtempSync(join(tmpdir(), "module-shape-empty-"));
  const files: Record<string, string> = {
    "tests/ok.test.ts": 'test("a", () => {});\n',
    "tests/each.test.ts": 'describe.each([1])("n %s", () => {});\n',
    "tests/rule.test.ts": "RuleTester.describe = describe;\nnew RuleTester().run();\n",
    "tests/empty.test.ts": "",
    "tests/onlyImports.test.tsx": 'import { render } from "@testing-library/react";\n',
    "src/features/x/tests/blank.test.tsx": "\n",
    "src/features/x/tests/ok.test.tsx": 'it("b", () => {});\n',
    "src/features/x/Widget.tsx": "export const w = 1;\n",
    "tests/helpers/render.ts": "export {};\n",
  };
  try {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    assert.deepEqual(findEmptyTests(root), [
      "src/features/x/tests/blank.test.tsx",
      "tests/empty.test.ts",
      "tests/onlyImports.test.tsx",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
