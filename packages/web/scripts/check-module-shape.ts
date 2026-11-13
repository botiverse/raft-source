#!/usr/bin/env node
/**
 * Module-shape ratchet for packages/web/src (Artea, #proj-frontend:22900a50,
 * task #proj-frontend:#15): split monolith files, one component per file,
 * named exports. Three counts may only go down:
 *
 * - lines: files over MAX_LINES lines. A listed file may not grow past its
 *   baseline; a new file may not cross the limit.
 * - mixedExports: a .tsx file that exports a component and also exports
 *   runtime values that are not components (hooks, helpers, constants,
 *   contexts). These files break React Fast Refresh. Type exports don't count.
 * - defaultComponent: a .tsx file whose default export is a component.
 *
 * New findings fail. A listed count that has gone down must be lowered in the
 * baseline in the same PR (stale entries fail), except `lines`, which is a cap
 * and only goes stale once the file is back under MAX_LINES or gone.
 *
 * Required gate: chained into the package `lint` script. Components are
 * recognised by syntax (uppercase name plus JSX, or memo/forwardRef/lazy), as
 * the oxlint only-export-components rule does; it stays off in .oxlintrc.json
 * because `--max-warnings=0` cannot ratchet.
 *
 *   node --import @oxc-node/core/register scripts/check-module-shape.ts
 *   ... --print-current   print the current findings as a baseline and exit 0
 *   ... --write           rewrite the baseline from src, only when nothing grew
 *                         (after a split or a move into features/)
 *
 * The baseline is a directory that mirrors src: one small JSON file per listed
 * module (scripts/module-shape-baseline/src/x/Y.tsx.json). Parallel split PRs
 * then touch different files and merge without conflicts, through the merge
 * queue; a moved module is a renamed baseline file (`git mv`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { isMisplacedTestPath, isStrayFeatureTestFile, isTestPath } from "./testLocations";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_BASELINE = resolve(SCRIPT_DIR, "module-shape-baseline");
const ENTRY_SUFFIX = ".json";
export const MAX_LINES = 800;
/** Generated code and translation catalogs are data, not modules to split. */
const EXCLUDED_DIRS = ["src/generated/", "src/i18n/messages/"];
const SOURCE_FILE_RE = /\.(?:ts|tsx)$/;
const COMPONENT_WRAPPERS = new Set(["memo", "forwardRef", "lazy", "observer"]);

export interface ModuleShape {
  lines: number;
  mixedExports: number;
  defaultComponent: boolean;
}

export interface BaselineEntry {
  lines?: number;
  mixedExports?: number;
  defaultComponent?: boolean;
}

export type Baseline = Record<string, BaselineEntry>;

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) return;
    if (
      ts.isJsxElement(child) ||
      ts.isJsxSelfClosingElement(child) ||
      ts.isJsxFragment(child)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

/** A component-shaped value: a function returning JSX, or memo/forwardRef/lazy(...). */
function isComponentValue(node: ts.Node | undefined): boolean {
  if (!node) return false;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return isComponentValue(node.expression);
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
    return containsJsx(node);
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return containsJsx(node);
  if (ts.isCallExpression(node)) {
    const name = calleeName(node.expression);
    return name !== undefined && COMPONENT_WRAPPERS.has(name);
  }
  return false;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some((m) => m.kind === kind) ?? false;
}

/** Shape of one module's source. `tsx` decides whether export rules apply. */
export function analyzeModuleSource(fileName: string, source: string): ModuleShape {
  const lines = source.length === 0 ? 0 : source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
  if (!fileName.endsWith(".tsx")) return { lines, mixedExports: 0, defaultComponent: false };

  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  /** Top-level runtime bindings: name → is a component. */
  const locals = new Map<string, boolean>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      locals.set(statement.name.text, isComponentName(statement.name.text) && isComponentValue(statement));
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      locals.set(statement.name.text, isComponentName(statement.name.text) && isComponentValue(statement));
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        locals.set(name, isComponentName(name) && isComponentValue(declaration.initializer));
      }
    } else if (ts.isEnumDeclaration(statement)) {
      locals.set(statement.name.text, false);
    }
  }

  let components = 0;
  let nonComponents = 0;
  let defaultComponent = false;
  const count = (isComponent: boolean) => {
    if (isComponent) components += 1;
    else nonComponents += 1;
  };

  for (const statement of sourceFile.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    if (exported && (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))) {
      const name = statement.name?.text;
      const isComponent = name ? locals.get(name) === true : isComponentValue(statement);
      count(isComponent);
      if (isDefault && isComponent) defaultComponent = true;
    } else if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) count(locals.get(declaration.name.text) === true);
        else nonComponents += 1;
      }
    } else if (exported && ts.isEnumDeclaration(statement)) {
      if (!hasModifier(statement, ts.SyntaxKind.ConstKeyword)) nonComponents += 1;
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = statement.expression;
      const isComponent = ts.isIdentifier(expression)
        ? locals.get(expression.text) === true
        : isComponentValue(expression);
      count(isComponent);
      if (isComponent) defaultComponent = true;
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      if (!statement.exportClause) {
        // `export * from "./x"`: the re-exported names are unknown here.
        nonComponents += 1;
        continue;
      }
      if (!ts.isNamedExports(statement.exportClause)) {
        nonComponents += 1;
        continue;
      }
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        const localName = (element.propertyName ?? element.name).text;
        const exportedName = element.name.text;
        const isComponent = statement.moduleSpecifier
          ? isComponentName(localName)
          : locals.get(localName) === true;
        if (!statement.moduleSpecifier && !locals.has(localName)) continue; // a type or import
        count(isComponent);
        if (exportedName === "default" && isComponent) defaultComponent = true;
      }
    }
  }

  return { lines, mixedExports: components > 0 ? nonComponents : 0, defaultComponent };
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_FILE_RE.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
}

/**
 * Every module in src/ with at least one finding, keyed by package-relative path.
 * Feature tests (src/features/<feature>/tests/) are not modules to split and
 * never enter the baseline; a test file anywhere else in src is reported by
 * findMisplacedTests instead.
 */
export function collectCurrentShapes(root = PACKAGE_ROOT): Baseline {
  const files: string[] = [];
  walk(join(root, "src"), files);
  const current: Baseline = {};
  for (const file of files.sort()) {
    const path = relative(root, file).split(sep).join("/");
    if (EXCLUDED_DIRS.some((dir) => path.startsWith(dir)) || isTestPath(path)) continue;
    const shape = analyzeModuleSource(path, readFileSync(file, "utf8"));
    const entry: BaselineEntry = {};
    if (shape.lines > MAX_LINES) entry.lines = shape.lines;
    if (shape.mixedExports > 0) entry.mixedExports = shape.mixedExports;
    if (shape.defaultComponent) entry.defaultComponent = true;
    if (Object.keys(entry).length > 0) current[path] = entry;
  }
  return current;
}

/**
 * Test files in src outside src/features/<feature>/tests/ (Vitest would never
 * collect them), as package-relative paths.
 */
export function findMisplacedTests(root = PACKAGE_ROOT): string[] {
  const files: string[] = [];
  walk(join(root, "src"), files);
  return files
    .map((file) => relative(root, file).split(sep).join("/"))
    .filter(isMisplacedTestPath)
    .sort();
}

/**
 * Files in a feature's tests/ folder that are neither tests nor helpers or
 * fixtures (see isStrayFeatureTestFile), as package-relative paths.
 */
export function findStrayFeatureTestFiles(root = PACKAGE_ROOT): string[] {
  const files: string[] = [];
  walk(join(root, "src"), files);
  return files
    .map((file) => relative(root, file).split(sep).join("/"))
    .filter(isStrayFeatureTestFile)
    .sort();
}

/** A call that declares tests, or RuleTester (oxlint rule tests declare theirs through it). */
const DECLARES_TESTS_RE = /\b(?:test|it|describe|bench)(?:\.\w+)*\s*\(|\bRuleTester\b/;

/**
 * Test files (under tests/ or src/features/<feature>/tests/) that are empty or
 * declare no test: a move or rewrite that lost the file's content would
 * otherwise pass lint and typecheck, and Vitest is not reliable about it.
 */
export function findEmptyTests(root = PACKAGE_ROOT): string[] {
  const files: string[] = [];
  for (const dir of ["tests", "src"]) {
    if (existsSync(join(root, dir))) walk(join(root, dir), files);
  }
  return files
    .map((file) => ({ file, path: relative(root, file).split(sep).join("/") }))
    .filter(({ path }) => isTestPath(path) && /\.test\.tsx?$/.test(path))
    .filter(({ file }) => !DECLARES_TESTS_RE.test(readFileSync(file, "utf8")))
    .map(({ path }) => path)
    .sort();
}

/** Import and export-from specifiers, and dynamic imports, as TypeScript reads them (comments and strings do not count). */
function importSpecifiers(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((file) => file.fileName);
}

/**
 * App modules in src that import from a feature's tests/ folder, as
 * "importer -> specifier". Test code is left out of the app's lint and
 * typecheck, so app code must never depend on it.
 */
export function findAppImportsOfTests(root = PACKAGE_ROOT): string[] {
  const files: string[] = [];
  walk(join(root, "src"), files);
  const found: string[] = [];
  for (const file of files) {
    const path = relative(root, file).split(sep).join("/");
    if (isTestPath(path) || isMisplacedTestPath(path)) continue;
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) continue;
      const target = relative(root, resolve(dirname(file), specifier)).split(sep).join("/");
      // "./tests" resolves to the folder itself (its index file): test it as a folder too.
      if (isTestPath(target) || isTestPath(`${target}/`)) found.push(`${path} -> ${specifier}`);
    }
  }
  return found.sort();
}

/** Problems that fail the check: new or grown findings, and stale baseline entries. */
export function compareShapesToBaseline(current: Baseline, baseline: Baseline): string[] {
  return [...findGrowth(current, baseline), ...findStale(current, baseline)];
}

/** New or grown findings: `--write` refuses to record these. */
export function findGrowth(current: Baseline, baseline: Baseline): string[] {
  const problems: string[] = [];
  for (const [path, now] of Object.entries(current)) {
    const base = baseline[path] ?? {};
    if (now.lines !== undefined) {
      if (base.lines === undefined) {
        problems.push(`${path}: ${now.lines} lines, over the ${MAX_LINES}-line limit. Split it.`);
      } else if (now.lines > base.lines) {
        problems.push(`${path}: grew to ${now.lines} lines (baseline ${base.lines}). Split it instead of growing it.`);
      }
    }
    if (now.mixedExports !== undefined) {
      if (now.mixedExports > (base.mixedExports ?? 0)) {
        problems.push(
          `${path}: exports a component plus ${now.mixedExports} non-component value(s) (baseline ${base.mixedExports ?? 0}). ` +
            "Move hooks, helpers and constants to their own module.",
        );
      }
    }
    if (now.defaultComponent && !base.defaultComponent) {
      problems.push(`${path}: default-exports a component. Use a named export.`);
    }
  }
  return problems;
}

/** Baseline entries that are higher than src now: `--write` lowers these. */
export function findStale(current: Baseline, baseline: Baseline): string[] {
  const problems: string[] = [];
  for (const [path, base] of Object.entries(baseline)) {
    const now = current[path] ?? {};
    if (base.lines !== undefined && now.lines === undefined) {
      problems.push(`${path}: now under ${MAX_LINES} lines (or gone); remove "lines" from the baseline.`);
    }
    if (base.mixedExports !== undefined && (now.mixedExports ?? 0) < base.mixedExports) {
      problems.push(
        `${path}: mixed exports went down to ${now.mixedExports ?? 0}; lower "mixedExports" in the baseline (or drop it at 0).`,
      );
    }
    if (base.defaultComponent && !now.defaultComponent) {
      problems.push(`${path}: no longer default-exports a component; remove "defaultComponent" from the baseline.`);
    }
  }
  return problems;
}

/**
 * Baseline entries carried over to where their file moved. A listed file that
 * no longer exists, and one new path with the same file name, is a move (the
 * split PRs move whole directories into features/). Returns the baseline with
 * those keys renamed, and the moves found.
 */
export function followMoves(
  current: Baseline,
  baseline: Baseline,
  fileExists: (path: string) => boolean,
): { baseline: Baseline; moves: Array<[string, string]> } {
  const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const newPaths = Object.keys(current).filter((path) => !(path in baseline));
  const moved: Baseline = { ...baseline };
  const moves: Array<[string, string]> = [];
  for (const [path, entry] of Object.entries(baseline)) {
    if (fileExists(path)) continue;
    const targets = newPaths.filter((candidate) => fileName(candidate) === fileName(path));
    if (targets.length !== 1) continue;
    const target = targets[0] as string;
    if (target in moved) continue;
    delete moved[path];
    moved[target] = entry;
    moves.push([path, target]);
  }
  return { baseline: moved, moves };
}

/**
 * The baseline lowered to src: counts that went down are lowered and entries
 * that cleared are dropped. `lines` keeps its cap while the file is still over
 * MAX_LINES, so a later edit to a big file isn't blocked by a recent trim.
 */
export function lowerBaseline(current: Baseline, baseline: Baseline): Baseline {
  const lowered: Baseline = {};
  for (const [path, now] of Object.entries(current)) {
    const base = baseline[path] ?? {};
    const entry: BaselineEntry = {};
    if (now.lines !== undefined) entry.lines = Math.max(now.lines, base.lines ?? 0);
    if (now.mixedExports !== undefined) entry.mixedExports = now.mixedExports;
    if (now.defaultComponent) entry.defaultComponent = true;
    lowered[path] = entry;
  }
  return lowered;
}

function walkEntries(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkEntries(full, out);
    else if (entry.endsWith(ENTRY_SUFFIX)) out.push(full);
  }
}

/** The baseline directory as one map: `src/x/Y.tsx.json` holds the entry for `src/x/Y.tsx`. */
export function readBaseline(dir: string): Baseline {
  const files: string[] = [];
  walkEntries(dir, files);
  const baseline: Baseline = {};
  for (const file of files.sort()) {
    const path = relative(dir, file).split(sep).join("/").slice(0, -ENTRY_SUFFIX.length);
    baseline[path] = JSON.parse(readFileSync(file, "utf8")) as BaselineEntry;
  }
  return baseline;
}

function serializeEntry(entry: BaselineEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

/** Make the directory match `baseline`, touching only the files that changed. */
export function writeBaseline(dir: string, baseline: Baseline): void {
  const before = existsSync(dir) ? readBaseline(dir) : {};
  for (const path of Object.keys(before)) {
    if (!(path in baseline)) rmSync(join(dir, `${path}${ENTRY_SUFFIX}`));
  }
  for (const [path, entry] of Object.entries(baseline)) {
    const file = join(dir, `${path}${ENTRY_SUFFIX}`);
    const text = serializeEntry(entry);
    if (existsSync(file) && readFileSync(file, "utf8") === text) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  removeEmptyDirs(dir);
}

function removeEmptyDirs(dir: string): boolean {
  let empty = true;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory() && removeEmptyDirs(full)) rmSync(full, { recursive: true });
    else empty = false;
  }
  return empty;
}

function main(argv: string[]): void {
  if (argv.includes("--help")) {
    console.log("Usage: check-module-shape.ts [--baseline <dir>] [--print-current | --write]");
    return;
  }
  const baselineIndex = argv.indexOf("--baseline");
  const baselinePath = baselineIndex >= 0 ? resolve(argv[baselineIndex + 1] ?? "") : DEFAULT_BASELINE;
  const current = collectCurrentShapes();
  if (argv.includes("--print-current")) {
    process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
    return;
  }
  if (!existsSync(baselinePath)) {
    console.error(`baseline directory not found: ${baselinePath}`);
    process.exitCode = 2;
    return;
  }
  let baseline = readBaseline(baselinePath);
  if (argv.includes("--write")) {
    const { baseline: followed, moves } = followMoves(current, baseline, (path) => existsSync(join(PACKAGE_ROOT, path)));
    for (const [from, to] of moves) console.log(`  moved: ${from} -> ${to}`);
    baseline = followed;
    const growth = findGrowth(current, baseline);
    if (growth.length > 0) {
      console.error("module shape ratchet: not writing, these grew (the baseline only goes down):");
      for (const problem of growth) console.error(`  - ${problem}`);
      process.exitCode = 1;
      return;
    }
    writeBaseline(baselinePath, lowerBaseline(current, baseline));
    console.log(`module shape ratchet: wrote ${relative(PACKAGE_ROOT, baselinePath)}`);
    return;
  }
  const appImportsOfTests = findAppImportsOfTests();
  if (appImportsOfTests.length > 0) {
    console.error("app code in src must not import from a feature's tests/ folder (test code is not linted or typechecked as app code):");
    for (const entry of appImportsOfTests) console.error(`  - ${entry}`);
    process.exitCode = 1;
    return;
  }
  const empty = findEmptyTests();
  if (empty.length > 0) {
    console.error("test files must declare tests (empty, or no test/it/describe call):");
    for (const path of empty) console.error(`  - ${path}`);
    process.exitCode = 1;
    return;
  }
  const stray = findStrayFeatureTestFiles();
  if (stray.length > 0) {
    console.error("a feature's tests/ folder holds only *.test.ts(x) files and their tests/helpers/ and tests/fixtures/:");
    for (const path of stray) console.error(`  - ${path}`);
    process.exitCode = 1;
    return;
  }
  const misplaced = findMisplacedTests();
  if (misplaced.length > 0) {
    console.error("test files in src must live in src/features/<feature>/tests/ (Vitest does not collect them anywhere else):");
    for (const path of misplaced) console.error(`  - ${path}`);
    process.exitCode = 1;
    return;
  }
  const problems = compareShapesToBaseline(current, baseline);
  if (problems.length > 0) {
    console.error(`module shape ratchet (${relative(PACKAGE_ROOT, baselinePath)}):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("After splitting or moving files, `--write` lowers the baseline and follows the moves.");
    process.exitCode = 1;
    return;
  }
  console.log(`module shape ratchet: OK (${Object.keys(baseline).length} baseline files)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
