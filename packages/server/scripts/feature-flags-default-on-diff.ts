#!/usr/bin/env -S node --import=@oxc-node/core/register
// Task #255: before turning FEATURE_FLAGS_DEFAULT_ON on in an environment,
// list what would turn on there that is not a default-on exception
// (packages/shared/src/featureFlagDefaultPolicy.ts):
// - rows that are enabled, not killed and stored default-off (the fallback flips);
// - keys referenced in code with no row at all (a missing row answers on under
//   default-on). Code keys come from a static scan of the source tree for
//   `*FLAG*` string constants and `*FLAG_KEYS` maps; it is a review aid, not a
//   registry, so read the list and move credential-needing keys into the
//   exceptions before enabling.
// Read-only: one REPEATABLE READ / READ ONLY transaction of SELECTs, then ROLLBACK.
//
//   DATABASE_URL=<url> pnpm --filter @botiverse/raft-server ops:feature-flags-default-on-diff [-- --json]
//   (reads DATABASE_URL from the environment; --database-url <url> is only a fallback: argv is visible in ps)
//   ... --print-sql        prints the queries and exits without connecting.
//   ... --list-code-keys   prints the scanned code keys and exits without connecting.
//
// Rule counts are listed because a rule that does not match falls through to
// the fallback: under default-on, a server allowlist or a percentage rollout
// on these flags reaches everyone else too (deny rules still hold).
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { featureFlagDefaultOnException } from "@botiverse/raft-shared/feature-flag-default-policy";

export const DEFAULT_ON_CANDIDATES_SQL = `
SELECT f.key,
       f.randomization_unit AS "randomizationUnit",
       f.pre_auth_evaluable AS "preAuthEvaluable",
       COALESCE(r.allow_rules, 0)::int AS "allowRules",
       COALESCE(r.deny_rules, 0)::int AS "denyRules",
       COALESCE(r.stages, '') AS "ruleStages"
FROM feature_flags f
LEFT JOIN (
  SELECT flag_key,
         count(*) FILTER (WHERE decision = 'allow') AS allow_rules,
         count(*) FILTER (WHERE decision = 'deny') AS deny_rules,
         string_agg(DISTINCT stage, ',' ORDER BY stage) AS stages
  FROM feature_flag_rules
  GROUP BY flag_key
) r ON r.flag_key = f.key
WHERE f.enabled AND NOT f.kill_switch AND NOT f.default_enabled
ORDER BY f.key`;

export const ALL_FLAG_KEYS_SQL = "SELECT key FROM feature_flags ORDER BY key";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
// Flag keys in code are snake_case with at least one underscore; this keeps
// versions, scopes and other `*FLAG*` strings out of the scan.
const FLAG_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts"]);
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "test", "tests", "__snapshots__", "generated", ".turbo"]);

function isSkippedFile(name: string): boolean {
  return /\.(test|spec|testkit|realPg|typeproof)\./.test(name) || name.endsWith(".d.ts");
}

function sourceFiles(directory: string, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) sourceFiles(path, out);
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name)) && !isSkippedFile(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Flag keys named in one source file: string constants named `*FLAG` / `*FLAG_KEY`, and the values of
 * object/array literals whose name contains `FLAG` and ends in `S` or names a lookup (`*FLAG_BY_*`).
 */
export function scanFlagKeysInSource(source: string): string[] {
  const keys = new Set<string>();
  for (const match of source.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*FLAG(?:_KEY)?)\s*(?::[^=]+)?=\s*"([^"\n]+)"/g)) {
    if (FLAG_KEY.test(match[2]!)) keys.add(match[2]!);
  }
  for (const match of source.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*FLAG(?:_KEYS|S|_BY_[A-Z0-9_]+)[A-Z0-9_]*)\s*(?::[^=]+)?=\s*([{[])([^}\]]*)[}\]]/g)) {
    const body = match[3]!;
    const values = match[2] === "{"
      ? [...body.matchAll(/:\s*"([^"\n]+)"/g)].map((value) => value[1]!)
      : [...body.matchAll(/"([^"\n]+)"/g)].map((value) => value[1]!);
    for (const value of values) if (FLAG_KEY.test(value)) keys.add(value);
  }
  return [...keys];
}

/** Every flag key the scan finds under packages/ and apps/, with the files that name it. */
export function scanFlagKeysInCode(repoRoot = REPO_ROOT): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const top of ["packages", "apps"]) {
    for (const file of sourceFiles(join(repoRoot, top))) {
      for (const key of scanFlagKeysInSource(readFileSync(file, "utf8"))) {
        const files = found.get(key) ?? [];
        files.push(relative(repoRoot, file));
        found.set(key, files);
      }
    }
  }
  return new Map([...found.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export type DefaultOnCandidateRow = {
  key: string;
  randomizationUnit: string;
  preAuthEvaluable: boolean;
  allowRules: number;
  denyRules: number;
  ruleStages: string;
};

export type DefaultOnDiff = {
  /** Fallback flips off -> on under default-on. */
  wouldChange: DefaultOnCandidateRow[];
  /** Same SQL shape, but an exception keeps the stored default. */
  heldByException: Array<DefaultOnCandidateRow & { reason: string }>;
  /** Keys named in code with no row: off -> on under default-on. */
  noRowWouldTurnOn: Array<{ key: string; files: string[] }>;
  /** Keys named in code with no row that an exception keeps off. */
  noRowHeldByException: Array<{ key: string; files: string[]; reason: string }>;
};

export function classifyDefaultOnCandidates(
  rows: readonly DefaultOnCandidateRow[],
  allRowKeys: ReadonlySet<string> = new Set(rows.map((row) => row.key)),
  codeKeys: ReadonlyMap<string, string[]> = new Map(),
): DefaultOnDiff {
  const diff: DefaultOnDiff = { wouldChange: [], heldByException: [], noRowWouldTurnOn: [], noRowHeldByException: [] };
  for (const row of rows) {
    const reason = featureFlagDefaultOnException(row.key);
    if (reason === null) diff.wouldChange.push(row);
    else diff.heldByException.push({ ...row, reason });
  }
  for (const [key, files] of codeKeys) {
    if (allRowKeys.has(key)) continue;
    const reason = featureFlagDefaultOnException(key);
    if (reason === null) diff.noRowWouldTurnOn.push({ key, files });
    else diff.noRowHeldByException.push({ key, files, reason });
  }
  return diff;
}

export async function readDefaultOnDiff(databaseUrl: string): Promise<DefaultOnDiff> {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: "feature-flags-default-on-diff" });
  client.on("error", () => undefined);
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const result = await client.query<DefaultOnCandidateRow>(DEFAULT_ON_CANDIDATES_SQL);
    const allKeys = await client.query<{ key: string }>(ALL_FLAG_KEYS_SQL);
    await client.query("ROLLBACK");
    return classifyDefaultOnCandidates(result.rows, new Set(allKeys.rows.map((row) => row.key)), scanFlagKeysInCode());
  } finally {
    await client.end().catch(() => undefined);
  }
}

function formatRow(row: DefaultOnCandidateRow): string {
  const rules = row.allowRules + row.denyRules === 0
    ? "no rules"
    : `${row.allowRules} allow / ${row.denyRules} deny (${row.ruleStages})`;
  return `${row.key}\tunit=${row.randomizationUnit}${row.preAuthEvaluable ? " pre-auth" : ""}\t${rules}`;
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "database-url": { type: "string" },
      json: { type: "boolean", default: false },
      "print-sql": { type: "boolean", default: false },
      "list-code-keys": { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values["print-sql"]) {
    process.stdout.write(`${DEFAULT_ON_CANDIDATES_SQL.trim()};\n${ALL_FLAG_KEYS_SQL};\n`);
    return;
  }
  if (values["list-code-keys"]) {
    for (const [key, files] of scanFlagKeysInCode()) {
      const reason = featureFlagDefaultOnException(key);
      process.stdout.write(`${key}\t${reason === null ? "-" : `exception: ${reason}`}\t${files.join(",")}\n`);
    }
    return;
  }
  // DATABASE_URL from the environment (a URL in argv shows in the process list and shell history); the flag is
  // a fallback only.
  const databaseUrl = process.env.DATABASE_URL?.trim() || values["database-url"];
  if (!databaseUrl) throw new Error("usage: DATABASE_URL=<url> feature-flags-default-on-diff.ts [--json] | --print-sql | --list-code-keys (--database-url <url> as a fallback)");
  const diff = await readDefaultOnDiff(databaseUrl);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Fallback would change off -> on (${diff.wouldChange.length}):\n`);
  for (const row of diff.wouldChange) process.stdout.write(`  ${formatRow(row)}\n`);
  process.stdout.write(`\nHeld off by a default-on exception (${diff.heldByException.length}):\n`);
  for (const row of diff.heldByException) process.stdout.write(`  ${formatRow(row)}\t${row.reason}\n`);
  process.stdout.write(`\nNo row; would turn on (${diff.noRowWouldTurnOn.length}):\n`);
  for (const item of diff.noRowWouldTurnOn) process.stdout.write(`  ${item.key}\t${item.files.join(",")}\n`);
  process.stdout.write(`\nNo row; held off by a default-on exception (${diff.noRowHeldByException.length}):\n`);
  for (const item of diff.noRowHeldByException) process.stdout.write(`  ${item.key}\t${item.reason}\n`);
  process.stdout.write("\nNo-row keys come from a static source scan; keys built at runtime or named outside *FLAG* constants are not listed.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
