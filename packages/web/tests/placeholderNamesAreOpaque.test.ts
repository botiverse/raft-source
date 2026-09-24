import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "@formatjs/icu-messageformat-parser";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Glossary batch A translated `runtime`/`provider` in zh values. My first
// converter also translated them INSIDE ICU placeholders and produced
// `{提供方} 登录` — a placeholder name is an identifier, not display text, so
// that message breaks. @沈括 asked for this to be an auditable contract rather
// than something I remembered to avoid.
//
// Two halves:
//   1. no placeholder name anywhere may contain CJK (general, permanent)
//   2. the 6 values whose ONLY occurrence is a placeholder name are named, so
//      the 45-candidate / 39-changed gap is a contract, not a silent omission

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const CJK = /[一-鿿]/;

// Parse, do not pattern-match. A regex over braces cannot tell an ARGUMENT NAME
// from a plural/select ARM BODY: `{count, plural, other {# 个任务}}` contains
// `{# 个任务}`, which is translated text and entirely correct. My first version
// of this guard flagged 8 such arms as violations — the check was wrong, not the
// catalog. The AST distinguishes them; a brace heuristic cannot.
function argumentNames(message: string): string[] {
  const names: string[] = [];
  const walk = (nodes: ReturnType<typeof parse>): void => {
    for (const node of nodes) {
      if ("value" in node && typeof node.value === "string" && "type" in node && node.type !== 0) {
        names.push(node.value);
      }
      const options = (node as { options?: Record<string, { value: ReturnType<typeof parse> }> }).options;
      if (options) for (const arm of Object.values(options)) walk(arm.value);
      const children = (node as { children?: ReturnType<typeof parse> }).children;
      if (children) walk(children);
    }
  };
  walk(parse(message));
  return names;
}

test("no ICU placeholder name contains CJK, in either catalog", () => {
  const offenders: string[] = [];
  for (const [name, catalog] of [["en", en], ["zh", zh]] as const) {
    for (const [id, value] of Object.entries(catalog)) {
      let names: string[];
      try { names = argumentNames(value); } catch { continue; } // unparseable is another test's job
      for (const argName of names) {
        if (CJK.test(argName)) offenders.push(`${name}:${id} → {${argName}}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "placeholder names are identifiers, not display text:\n" + offenders.join("\n"),
  );
});

test("batch A's 6 expected no-ops still hold their placeholder untranslated", () => {
  // Named per @沈括 so 45 candidates → 39 changes is auditable. Each of these
  // contains runtime/provider ONLY as a placeholder name.
  const EXPECTED_NO_OP = [
    "agent.runtimeConfig.apiKeyForProvider",
    "agent.runtimeConfig.apiKeyRequiredForProvider",
    "agent.runtimeConfig.builtInRequiredHint",
    "onboarding.computerRuntime.runtimeInstallHint",
    "pages.socialCallback.noCode",
    "pages.socialCallback.noSession",
  ];
  for (const id of EXPECTED_NO_OP) {
    assert.ok(zh[id], `${id} missing from zh`);
    const names = argumentNames(zh[id]);
    assert.ok(
      names.some((n) => /runtime|provider/i.test(n)),
      `${id} was listed as a placeholder-only no-op but no longer has a runtime/provider placeholder`,
    );
    assert.ok(!CJK.test(names.join("")), `${id}: a placeholder name was translated`);
  }
});
