// Shared ships to the web, so the continuation runtime must not need Node:
// no Node module imported and no Node global used, here or in anything it
// imports relatively (a helper elsewhere in shared that needs Node is caught
// too).

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));

function specifiersOf(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((file) => file.fileName);
}

function resolveRelative(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  const file = [`${base}.ts`, join(base, "index.ts")].find((candidate) => existsSync(candidate));
  if (!file) throw new Error(`cannot resolve ${specifier} from ${from}`);
  return file;
}

/** `entries` and every file they import relatively, transitively. */
function importGraph(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) queue.push(resolveRelative(file, specifier));
    }
  }
  return [...seen];
}

/** Node built-ins the files import: "file: specifier". */
function nodeImports(files: string[]): string[] {
  return files.flatMap((file) => specifiersOf(readFileSync(file, "utf8"))
    .filter((specifier) => isBuiltin(specifier))
    .map((specifier) => `${relative(here, file)}: ${specifier}`));
}

const NODE_GLOBALS = new Set(["process", "Buffer", "global", "__dirname", "__filename", "require"]);

const isGlobalThis = (node: ts.Node): boolean => ts.isIdentifier(node) && node.text === "globalThis";

/**
 * Node globals a source refers to (`process.env`, `Buffer.from`, `require(…)`,
 * `globalThis.process`, `globalThis["process"]`), and "globalThis" for a use
 * of it that hides which global it reaches (`const g = globalThis`,
 * `globalThis[name]`).
 */
function nodeGlobalsOf(source: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && NODE_GLOBALS.has(node.text) && refersToGlobal(node)) found.push(node.text);
    else if (isGlobalThis(node) && !isPlainGlobalThisAccess(node as ts.Identifier)) found.push("globalThis");
    if (ts.isElementAccessExpression(node) && isGlobalThis(node.expression) && ts.isStringLiteralLike(node.argumentExpression)
      && NODE_GLOBALS.has(node.argumentExpression.text)) {
      found.push(node.argumentExpression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true));
  return found;
}

/** A property name (`record.process`, `{ process: … }`), not a reference to a variable. */
function isPropertyName(node: ts.Identifier): boolean {
  const { parent } = node;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  const named = ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent);
  return named && parent.name === node;
}

/** `globalThis.process` refers to the global; `record.process` and `{ process: … }` do not. */
function refersToGlobal(node: ts.Identifier): boolean {
  const { parent } = node;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return isGlobalThis(parent.expression);
  return !isPropertyName(node);
}

/** `globalThis.name` or `globalThis["name"]`: which global it reaches is in the source, so the checks above see it. */
function isPlainGlobalThisAccess(node: ts.Identifier): boolean {
  if (isPropertyName(node)) return true;
  const { parent } = node;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return true;
  return ts.isElementAccessExpression(parent) && parent.expression === node && ts.isStringLiteralLike(parent.argumentExpression);
}

// Tests run under Node and may use it; everything else here ships, with what it imports.
const shipped = readdirSync(here, { recursive: true, encoding: "utf8" })
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => join(here, name));
const shippedGraph = importGraph(shipped);

test("the scan covers the runtime and the shared modules it imports", () => {
  assert.ok(shipped.some((file) => file.endsWith("runtime.ts")), "expected to scan the runtime");
  for (const outside of ["clock.ts", "jsonValue.ts", "maybePromise.ts"]) {
    assert.ok(shippedGraph.includes(resolve(here, "..", outside)), `expected the walk to reach ../${outside}`);
  }
});

test("the continuation runtime, and everything it imports, runs without Node", () => {
  assert.deepEqual(nodeImports(shippedGraph), []);
});

test("the continuation runtime, and everything it imports, uses no Node global", () => {
  const found = shippedGraph.flatMap((file) => nodeGlobalsOf(readFileSync(file, "utf8")).map((name) => `${relative(here, file)}: ${name}`));
  assert.deepEqual(found, []);
});

test("the global check finds Node globals in code, not in comments, strings or property names", () => {
  for (const source of [
    "const home = process.env.HOME;",
    'const bytes = Buffer.from("x");',
    "const here = __dirname;",
    'const fs = require("fs");',
    "globalThis.process.exit(1);",
    "const { env } = process;",
    'const env = globalThis["process"].env;',
    "const g = globalThis; g.process.exit(1);",
    'const name = "process"; globalThis[name].exit(1);',
    "const look = (scope: typeof globalThis) => scope; look(globalThis).process;",
    "globalThis.global.process.exit(1);",
  ]) {
    assert.notDeepEqual(nodeGlobalsOf(source), [], source);
  }
  for (const source of [
    "// its process died; a Buffer of text; require(nothing)",
    'const word = "process Buffer require";',
    "const value = record.process;",
    "const shape = { require: 1, process: 2 };",
    "type Shape = { process: string; Buffer: number };",
    "globalThis.crypto.getRandomValues(bytes);",
    'const subtle = globalThis["crypto"].subtle;',
    "const shape = { globalThis: 1 }; shape.globalThis;",
  ]) {
    assert.deepEqual(nodeGlobalsOf(source), [], source);
  }
});

test("the check finds a Node import however it is written", () => {
  for (const source of [
    'import { randomBytes } from "node:crypto";',
    'import fs from "fs";',
    'export { join } from "node:path";',
    'const os = await import("node:os");',
    'import type { Stats } from "node:fs";',
  ]) {
    assert.ok(specifiersOf(source).some((specifier) => isBuiltin(specifier)), source);
  }
});
