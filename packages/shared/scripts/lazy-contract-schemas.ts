#!/usr/bin/env node
// Mechanical rewrite: wrap every top-level zod schema constant in the shared
// package's source with `lazySchema("<name>", () => <initializer>)`, so the
// schema is built on first use instead of at import (see src/lazySchema.ts).
// Every non-test module under src/ that imports zod is covered: the CLI loads
// most of them through the package barrel, so one eager module costs every
// `raft` call.
//
// A top-level `const` is a schema when its initializer (after `as` /
// `satisfies` / parentheses) is a call chain rooted at `z`, at
// `passthroughObject`, or at another identifier ending in `Schema`. Nothing
// else is touched: shapes, helper functions, route tables and plain constants
// stay as written. The rewrite is idempotent.
//
//   node --import @oxc-node/core/register scripts/lazy-contract-schemas.ts          rewrite in place
//   node --import @oxc-node/core/register scripts/lazy-contract-schemas.ts --check  exit 1 if any file would change
//   node --import @oxc-node/core/register scripts/lazy-contract-schemas.ts --list   JSON list of modules that use lazySchema
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Source files (relative to src/, `/`-separated) the rewrite applies to. */
export function lazySchemaCandidateFiles(root = SRC) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== "generated" && entry !== "testVectors") walk(path);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".d.ts") || /\.test\.ts$|testkit/.test(entry)) continue;
      const rel = relative(root, path).split(sep).join("/");
      if (rel === "lazySchema.ts") continue;
      if (readFileSync(path, "utf8").includes('from "zod"')) files.push(rel);
    }
  };
  walk(root);
  return files.sort();
}

function importLineFor(fileName) {
  const depth = fileName.split("/").length - 1;
  return `import { lazySchema } from "${depth === 0 ? "./" : "../".repeat(depth)}lazySchema";\n`;
}

function rootIdentifier(expression) {
  let current = expression;
  for (;;) {
    if (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else break;
  }
  return ts.isIdentifier(current) ? current.text : null;
}

function unwrapTypeAssertions(expression) {
  let current = expression;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function isSchemaInitializer(initializer) {
  const core = unwrapTypeAssertions(initializer);
  if (!ts.isCallExpression(core)) return false;
  const root = rootIdentifier(core);
  return root === "z" || root === "passthroughObject" || (root !== null && root !== "lazySchema" && root.endsWith("Schema"));
}

export function rewriteContractSource(fileName, source) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const edits = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (!isSchemaInitializer(declaration.initializer)) continue;
      const name = declaration.name.text;
      edits.push({ at: declaration.initializer.getStart(sourceFile), text: `lazySchema(${JSON.stringify(name)}, () => ` });
      edits.push({ at: declaration.initializer.getEnd(), text: ")" });
    }
  }
  if (edits.length === 0) return { output: source, wrapped: 0 };
  let output = source;
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    output = output.slice(0, edit.at) + edit.text + output.slice(edit.at);
  }
  const importLine = importLineFor(fileName);
  if (!output.includes(importLine)) {
    const zodImport = output.match(/^import \{[^}]*\} from "zod";\n/m);
    const at = zodImport ? zodImport.index + zodImport[0].length : 0;
    output = output.slice(0, at) + importLine + output.slice(at);
  }
  return { output, wrapped: edits.length / 2 };
}

function main() {
  const files = lazySchemaCandidateFiles();
  if (process.argv.includes("--list")) {
    const lazy = files.filter((file) => readFileSync(join(SRC, file), "utf8").includes("lazySchema("));
    console.log(JSON.stringify(lazy.map((file) => file.replace(/\.ts$/, ""))));
    return;
  }
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const file of files) {
    const path = join(SRC, file);
    const source = readFileSync(path, "utf8");
    const { output, wrapped } = rewriteContractSource(file, source);
    if (output === source) continue;
    if (check) {
      stale += 1;
      console.error(`${file}: ${wrapped} top-level schema(s) are not wrapped in lazySchema; run node --import @oxc-node/core/register packages/shared/scripts/lazy-contract-schemas.ts`);
    } else {
      writeFileSync(path, output);
      console.log(`${file}: wrapped ${wrapped} schema(s)`);
    }
  }
  if (stale > 0) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
