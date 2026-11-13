#!/usr/bin/env node
/**
 * ScrollArea debt ratchet (task #proj-raft-ui:#209): every scrolling region is
 * a raft-ui ScrollArea. `.oxlintrc.json` extends raft-ui's recommended config,
 * which turns on `raft-ui/prefer-scroll-area`, so a new native scroller
 * (`overflow-auto`, `overflow-y-scroll`, an inline `overflowY: "auto"`, ...)
 * fails `lint` at once.
 *
 * Two comments keep a native scroller:
 *
 * - `// raft-ui: native-scroll <reason>`: an exception, kept native for good.
 *   Either one raft-design allows (scroll-area.md, "Native scrolling") or one
 *   slock needs (docs/frontend/scroll-areas.md lists them). Not debt; the OK
 *   line prints them so a new one is seen in review.
 * - `// oxlint-disable-next-line raft-ui/prefer-scroll-area -- ...`: a scroller
 *   that predates the rule and still has to move to ScrollArea. These are the
 *   debt, counted per file against scroll-area-debt-baseline.json.
 *
 * The count may only go down. A file over its baseline, or a new file with a
 * suppression, fails. A file under its baseline fails until the baseline is
 * lowered in the same PR (`--write`), so a migrated scroller can't be quietly
 * replaced by a new one later. Also failing, as they could hide the rule
 * without being counted: a suppression with no native scroller under it, a
 * block or same-line disable of the rule, any disable comment that names no
 * rule, the rule not on as "error" once `.oxlintrc.json` and the configs it
 * `extends` (raft-ui's recommended.json) are applied, the rule set to anything
 * but "error" in any of their rules or overrides, a nested Oxlint config under
 * the linted directories, and an allow/warn flag for it in the `lint` script.
 *
 * Required gate: chained into the package `lint` script.
 *
 *   node --import @oxc-node/core/register scripts/check-scroll-area-debt.ts
 *   ... --write   lower the baseline to src, only when nothing grew
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_BASELINE = resolve(SCRIPT_DIR, "scroll-area-debt-baseline.json");
export const RULE = "raft-ui/prefer-scroll-area";
export const PLUGIN = "@botiverse/raft-ui/lint";
/** The directories `lint` runs the app config on. */
export const LINTED_DIRS = ["src", "visual-testing"];
/** Feature tests are linted with scripts/oxlint-tests.json, which doesn't load the rule. */
const FEATURE_TESTS_RE = /^src\/features\/[^/]+\/tests\//;
const SOURCE_FILE_RE = /\.(?:ts|tsx|js|jsx|mts|mjs|cts|cjs)$/;
const NESTED_CONFIG_RE = /^(?:\.oxlintrc(?:\.json)?|oxlint\.config\.\w+)$/;

/**
 * What raft-ui's rule reports, read from one line: a native-scroll class (with
 * any variant, or as an arbitrary property) or an inline overflow style, its
 * key quoted or not and its value a literal or one branch of a condition.
 * The class patterns are copied from NATIVE_SCROLL_CLASS / NATIVE_SCROLL_ARBITRARY
 * in @botiverse/raft-ui/dist/lint/prefer-scroll-area.mjs: the package exports
 * the rule but not its `hasNativeScrollClass`, so it can't be imported here.
 */
export const NATIVE_SCROLL_RE = new RegExp(
  [
    /(?<![\w-])overflow(?:-[xy])?-(?:auto|scroll)(?![\w-])/.source,
    /\[overflow(?:-[xy])?:[^\]]*\b(?:auto|scroll)\b[^\]]*\]/.source,
    /(?<![\w-])["'`]?overflow[XY]?["'`]?\s*:[^,;}\n]*?["'`]\s*(?:auto|scroll)\s*["'`]/.source,
  ].join("|"),
);
/** A lint directive at the start of a comment: `oxlint-disable-next-line a, b -- why`. */
const DIRECTIVE_RE = /^\s*(?:oxlint|eslint)-(disable|enable)(-next-line|-line)?(?=\s|$)([\s\S]*)$/;
const EXCEPTION_RE = /\braft-ui:\s*native-scroll\s+(\S[^\n]*)/;

export type Baseline = Record<string, number>;

export interface Exception {
  /** `path:line` of the comment. */
  where: string;
  reason: string;
}

export interface DebtScan {
  /** Suppressions of the rule above a native scroller, per file. */
  counts: Baseline;
  /** Directives that break the ratchet: `path:line: why`. */
  problems: string[];
  /** The `raft-ui: native-scroll` exceptions. */
  exceptions: Exception[];
}

interface Comment {
  text: string;
  /** 1-based lines the comment starts and ends on. */
  startLine: number;
  endLine: number;
}

/** Every comment in a module, as TypeScript reads it (strings and JSX text are not comments). */
export function commentsOf(path: string, source: string): Comment[] {
  const kind = /\.[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const seen = new Set<number>();
  const comments: Comment[] = [];
  const collect = (ranges: ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      const raw = source.slice(range.pos, range.end);
      const text = range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? raw.slice(2) : raw.slice(2, -2);
      comments.push({
        text,
        startLine: file.getLineAndCharacterOfPosition(range.pos).line + 1,
        endLine: file.getLineAndCharacterOfPosition(range.end).line + 1,
      });
    }
  };
  const visit = (node: ts.Node) => {
    // JSX text is text: a `//` in it is not a comment.
    if (node.kind !== ts.SyntaxKind.JsxText) {
      collect(ts.getLeadingCommentRanges(source, node.pos));
      collect(ts.getTrailingCommentRanges(source, node.end));
    }
    for (const child of node.getChildren(file)) visit(child);
  };
  visit(file);
  return comments.sort((a, b) => a.startLine - b.startLine);
}

/** The rules a directive names (before its ` -- reason`). */
function rulesOf(rest: string): string[] {
  const list = rest.split(/\s--(?:\s|$)/)[0] ?? "";
  return list
    .split(/[\s,]+/)
    .map((rule) => rule.trim())
    .filter(Boolean);
}

/** This rule, under any plugin alias: `raft-ui/prefer-scroll-area`, `@botiverse/raft-ui/prefer-scroll-area`, ... */
function isThisRule(rule: string): boolean {
  return rule === "prefer-scroll-area" || rule.endsWith("/prefer-scroll-area");
}

/** The ScrollArea debt suppressions in one file's source, the exceptions, and any directive that breaks the ratchet. */
export function scanSource(path: string, source: string): { count: number; problems: string[]; exceptions: Exception[] } {
  const result = { count: 0, problems: [] as string[], exceptions: [] as Exception[] };
  if (!/(?:oxlint|eslint)-(?:disable|enable)|native-scroll/.test(source)) return result;
  const lines = source.split("\n");
  for (const comment of commentsOf(path, source)) {
    const where = `${path}:${comment.startLine}`;
    const exception = EXCEPTION_RE.exec(comment.text);
    if (exception) result.exceptions.push({ where, reason: (exception[1] ?? "").replace(/\s*\*\/?\s*$/, "").trim() });
    const match = DIRECTIVE_RE.exec(comment.text);
    if (!match) continue;
    const [, kind, scope = "", rest = ""] = match;
    if (kind !== "disable") continue;
    const rules = rulesOf(rest);
    if (rules.length === 0) {
      result.problems.push(`${where}: a disable comment that names no rule hides every rule, ${RULE} too; name the rules it disables`);
      continue;
    }
    if (!rules.some(isThisRule)) continue;
    if (scope !== "-next-line") {
      result.problems.push(`${where}: ${RULE} may only be suppressed one line at a time (oxlint-disable-next-line on its own line)`);
      continue;
    }
    if (!NATIVE_SCROLL_RE.test(lines[comment.endLine] ?? "")) {
      result.problems.push(`${where}: this suppression of ${RULE} no longer sits above a native scroller; remove it`);
      continue;
    }
    result.count += 1;
  }
  return result;
}

function walk(dir: string, out: string[], configs: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out, configs);
    else if (NESTED_CONFIG_RE.test(entry)) configs.push(full);
    else if (SOURCE_FILE_RE.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
}

/** Every linted file's ScrollArea debt, keyed by package-relative path. */
export function scanPackage(root = PACKAGE_ROOT): DebtScan {
  const files: string[] = [];
  const configs: string[] = [];
  for (const dir of LINTED_DIRS) walk(join(root, dir), files, configs);
  const counts: Baseline = {};
  const problems: string[] = [];
  const exceptions: Exception[] = [];
  const rel = (file: string) => relative(root, file).split(sep).join("/");
  for (const config of configs) {
    problems.push(`${rel(config)}: a nested Oxlint config under ${LINTED_DIRS.join("/")} could turn ${RULE} off; keep one config`);
  }
  for (const file of files.sort()) {
    const path = rel(file);
    if (FEATURE_TESTS_RE.test(path)) continue;
    const scan = scanSource(path, readFileSync(file, "utf8"));
    if (scan.count > 0) counts[path] = scan.count;
    problems.push(...scan.problems);
    exceptions.push(...scan.exceptions);
  }
  return { counts, problems, exceptions };
}

/** The severity a rule setting means: "error" | 2 | ["error", options]. */
function isError(setting: unknown): boolean {
  const level = Array.isArray(setting) ? setting[0] : setting;
  return level === "error" || level === 2;
}

export interface OxlintConfig {
  extends?: unknown[];
  jsPlugins?: unknown[];
  rules?: Record<string, unknown>;
  overrides?: Array<{ rules?: Record<string, unknown> }>;
}

const MAX_EXTENDS_DEPTH = 8;

/** `.oxlintrc.json` as Oxlint reads it: JSONC, comments and trailing commas allowed. Null when it isn't an object. */
export function parseOxlintConfig(configSource: string): OxlintConfig | null {
  const { config, error } = ts.parseConfigFileTextToJson(".oxlintrc.json", configSource);
  return error || typeof config !== "object" || config === null || Array.isArray(config) ? null : (config as OxlintConfig);
}

/** Reads a config file by absolute path; null when it can't be read. */
export type ReadConfig = (path: string) => string | null;

const readConfigFile: ReadConfig = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** The app's Oxlint config with its `extends` applied, as Oxlint applies them. */
export interface ResolvedOxlintConfig {
  /** Whether any of the configs loads raft-ui's lint plugin. */
  loadsPlugin: boolean;
  /** The top-level rules in effect: each extended config in order, then the config's own rules over them. */
  rules: Record<string, unknown>;
  /** Every rules section of every config (top-level and overrides), labelled for messages. */
  sections: Array<[string, Record<string, unknown>]>;
  /** Configs that couldn't be read or parsed, and `extends` cycles. */
  problems: string[];
}

function loadsRaftUiPlugin(plugins: unknown): boolean {
  return Array.isArray(plugins) && plugins.some((plugin) =>
    plugin === PLUGIN || (typeof plugin === "object" && plugin !== null && (plugin as { specifier?: unknown }).specifier === PLUGIN));
}

/**
 * Resolve `configSource` (the config at `configPath`) and, depth first, the
 * configs it `extends`. Oxlint takes each `extends` entry as a path relative to
 * the config that names it; a later one wins over an earlier one, and the
 * config's own rules win over all of them.
 */
export function resolveOxlintConfig(
  configSource: string,
  configPath = join(PACKAGE_ROOT, ".oxlintrc.json"),
  read: ReadConfig = readConfigFile,
): ResolvedOxlintConfig {
  const resolved: ResolvedOxlintConfig = { loadsPlugin: false, rules: {}, sections: [], problems: [] };
  const visit = (source: string, path: string, label: string, chain: string[]) => {
    const config = parseOxlintConfig(source);
    if (!config) {
      resolved.problems.push(`${label}: can't be read as JSONC`);
      return;
    }
    const extendsList = config.extends ?? [];
    if (!Array.isArray(extendsList)) {
      resolved.problems.push(`${label}: extends must be a list of paths`);
    } else {
      for (const spec of extendsList) {
        if (typeof spec !== "string") {
          resolved.problems.push(`${label}: extends entry ${JSON.stringify(spec)} isn't a path`);
          continue;
        }
        const target = resolve(dirname(path), spec);
        const targetLabel = `${label} extends ${spec}`;
        if (chain.includes(target)) {
          resolved.problems.push(`${targetLabel}: extends itself`);
          continue;
        }
        // A cycle through a symlink isn't the same path twice; stop it by depth.
        if (chain.length > MAX_EXTENDS_DEPTH) {
          resolved.problems.push(`${targetLabel}: extends nest deeper than ${MAX_EXTENDS_DEPTH}`);
          continue;
        }
        const targetSource = read(target);
        if (targetSource === null) {
          resolved.problems.push(`${targetLabel}: can't be read (is the package installed?)`);
          continue;
        }
        visit(targetSource, target, targetLabel, [...chain, target]);
      }
    }
    if (loadsRaftUiPlugin(config.jsPlugins)) resolved.loadsPlugin = true;
    const rules = config.rules ?? {};
    Object.assign(resolved.rules, rules);
    resolved.sections.push([`${label} rules`, rules]);
    // Only top-level jsPlugins count: a plugin an override loads runs on that override's files alone.
    for (const [index, override] of (config.overrides ?? []).entries()) {
      resolved.sections.push([`${label} overrides[${index}].rules`, override.rules ?? {}]);
    }
  };
  visit(configSource, configPath, ".oxlintrc.json", [configPath]);
  return resolved;
}

/** Problems with the rule in the app's Oxlint config, its `extends` applied. */
export function checkConfig(
  configSource: string,
  configPath = join(PACKAGE_ROOT, ".oxlintrc.json"),
  read: ReadConfig = readConfigFile,
): string[] {
  const config = resolveOxlintConfig(configSource, configPath, read);
  const problems = [...config.problems];
  if (!config.loadsPlugin) problems.push(`.oxlintrc.json: neither it nor a config it extends loads ${PLUGIN} in jsPlugins`);
  if (!isError(config.rules[RULE])) {
    problems.push(`.oxlintrc.json: ${RULE} must be "error" once its extends are applied (found ${JSON.stringify(config.rules[RULE])})`);
  }
  for (const [where, section] of config.sections) {
    for (const [rule, setting] of Object.entries(section)) {
      if (isThisRule(rule) && !isError(setting)) {
        problems.push(`${where}: ${rule} must stay "error" (found ${JSON.stringify(setting)})`);
      }
    }
  }
  return problems;
}

/** Problems with the `lint` script: a flag that turns the rule (or every rule) down. */
export function checkLintScript(script: string): string[] {
  const problems: string[] = [];
  const flag = /(?:^|\s)(-A|--allow|-W|--warn)(?:=|\s+)(\S+)/g;
  for (const [, name, value = ""] of script.matchAll(flag)) {
    const target = value.replace(/^["']|["']$/g, "");
    if (isThisRule(target) || target === "all" || target === "raft-ui") {
      problems.push(`package.json lint: \`${name} ${target}\` turns ${RULE} down`);
    }
  }
  return problems;
}

/** Files whose debt grew past the baseline, or that have debt and aren't listed. */
export function findGrowth(current: Baseline, baseline: Baseline): string[] {
  return Object.entries(current)
    .filter(([path, count]) => count > (baseline[path] ?? 0))
    .map(([path, count]) =>
      `${path}: ${count} suppressed native scroller(s), baseline ${baseline[path] ?? 0}. ` +
        "Use ScrollArea (or a documented `// raft-ui: native-scroll <reason>` exception), not a new suppression.",
    );
}

/** Baseline entries above what src has now: lower them with `--write`. */
export function findStale(current: Baseline, baseline: Baseline): string[] {
  return Object.entries(baseline)
    .filter(([path, count]) => (current[path] ?? 0) < count)
    .map(([path, count]) => `${path}: down to ${current[path] ?? 0} from ${count}; lower the baseline (--write).`);
}

export function total(counts: Baseline): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

export function readBaseline(path = DEFAULT_BASELINE): Baseline {
  return JSON.parse(readFileSync(path, "utf8")) as Baseline;
}

export function serializeBaseline(counts: Baseline): string {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** Everything that fails the check, besides growth and staleness. */
export function packageProblems(root = PACKAGE_ROOT): DebtScan {
  const scan = scanPackage(root);
  const configPath = join(root, ".oxlintrc.json");
  scan.problems.push(...checkConfig(readFileSync(configPath, "utf8"), configPath));
  const lint = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts?.lint ?? "";
  scan.problems.push(...checkLintScript(lint));
  return scan;
}

function main(argv: string[]): void {
  const { counts, problems, exceptions } = packageProblems();
  const baseline = readBaseline();
  const growth = findGrowth(counts, baseline);
  if (argv.includes("--write")) {
    if (growth.length > 0 || problems.length > 0) {
      console.error("ScrollArea debt ratchet: not writing, the baseline only goes down:");
      for (const problem of [...problems, ...growth]) console.error(`  - ${problem}`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(DEFAULT_BASELINE, serializeBaseline(counts));
    console.log(`ScrollArea debt ratchet: wrote ${total(counts)} (was ${total(baseline)})`);
    return;
  }
  const all = [...problems, ...growth, ...findStale(counts, baseline)];
  if (all.length > 0) {
    console.error(`ScrollArea debt ratchet (scripts/scroll-area-debt-baseline.json, ${total(baseline)} listed):`);
    for (const problem of all) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ScrollArea debt ratchet: OK (${total(counts)} native scrollers left in ${Object.keys(counts).length} files; ${exceptions.length} kept native as exceptions:)`);
  for (const exception of exceptions) console.log(`  ${exception.where}: ${exception.reason}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
