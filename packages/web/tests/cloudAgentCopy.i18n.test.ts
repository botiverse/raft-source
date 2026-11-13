/**
 * Product copy calls the provider-run agent a "cloud agent" / "runs in the cloud"
 * (云端 Agent). The provider's name never reaches a person, and the old
 * "Hosted by Raft" / "no computer needed" wording does not come back next to it.
 *
 * Identifiers keep the provider name (`antiproton_hosted_runtime`, provider kind
 * `"antiproton"`, API paths); this guard reads only what people can see: catalog
 * values, JSX text, and string literals that read as prose.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

const webRoot = resolve(import.meta.dirname, "..");
const srcRoot = resolve(webRoot, "src");
const catalogRoot = resolve(srcRoot, "i18n/messages");

const PROVIDER_NAME = /antiproton/i;
const RETIRED_WORDING = /hosted by raft|raft[- ]hosted|no computer needed/i;
/** A literal made only of identifier/path characters is a machine value (flag key, kind, route), not copy. */
const MACHINE_VALUE = /^[a-z0-9_./:-]*$/;

function catalogViolations(locale: string, messages: Record<string, string>): string[] {
  return Object.entries(messages)
    .filter(([, value]) => PROVIDER_NAME.test(value) || RETIRED_WORDING.test(value))
    .map(([id, value]) => `${locale} ${id}: ${value}`);
}

test("no en or zh-cn message names the provider or uses the retired hosted wording", () => {
  assert.deepEqual(catalogViolations("en", enMessages as Record<string, string>), []);
  assert.deepEqual(catalogViolations("zh-cn", zhMessages as Record<string, string>), []);
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return path === catalogRoot ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function visibleTextViolations(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const check = (node: ts.Node, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const named = PROVIDER_NAME.test(trimmed) && !MACHINE_VALUE.test(trimmed);
    if (!named && !RETIRED_WORDING.test(trimmed)) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push(`${relative(webRoot, file)}:${line + 1}: ${trimmed}`);
  };
  // Comments are trivia, so the scanner never yields them as literals.
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) check(node, node.text);
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) check(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test("no component renders the provider name or the retired hosted wording as a literal", () => {
  const files = sourceFiles(srcRoot);
  assert.ok(files.length > 100, `expected the web source tree, found ${files.length} files`);
  assert.deepEqual(files.flatMap(visibleTextViolations), []);
});
