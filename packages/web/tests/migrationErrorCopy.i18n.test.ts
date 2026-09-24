import assert from "node:assert/strict";
import test from "node:test";
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";
import type { MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { createIntl } from "react-intl";
import { AGENT_MIGRATION_USER_ERROR_CODES } from "@botiverse/raft-shared";

import { migrationErrorPresentation } from "../src/utils/migrationErrorPresentation";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Task #55 — the fifth instance of "a shared module returns English".
//
// `migrationErrorPresentation` returned finished English sentences, and
// AgentDetailPanel renders `presentation.message` directly. So that page could
// scan clean while every migration failure showed English: the sentence was
// built one module away, and nothing at the call site looked like copy.
//
// The scanner could not see it for two independent reasons (task #54): the file
// is `.ts` and the walk only covers `.tsx`, and no rule matches `return "…"`.
// Do not treat "0 findings" as evidence for this module.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const intl = createIntl({ locale: "en", messages: en });
const zhIntl = createIntl({ locale: "zh-cn", messages: zh });

const ARGUMENT_BOUNDARY = Symbol("icu-argument-boundary");
type RenderedToken = string | typeof ARGUMENT_BOUNDARY;

function appendTokens(left: RenderedToken[], right: RenderedToken[]): RenderedToken[] {
  if (left.length === 0) return [...right];
  if (right.length === 0) return [...left];
  const result = [...left];
  const last = result.at(-1);
  const first = right[0];
  if (typeof last === "string" && typeof first === "string") {
    result[result.length - 1] = last + first;
    result.push(...right.slice(1));
  } else {
    result.push(...right);
  }
  return result;
}

function renderedLiteralSegments(message: string): string[][] {
  const walk = (elements: MessageFormatElement[]): RenderedToken[][] => {
    let alternatives: RenderedToken[][] = [[]];
    for (const element of elements) {
      let next: RenderedToken[][];
      if (element.type === TYPE.literal) {
        next = [[element.value]];
      } else if (element.type === TYPE.select || element.type === TYPE.plural) {
        next = Object.values(element.options).flatMap((option) => walk(option.value));
      } else if (element.type === TYPE.tag) {
        // Rich-text tags do not add rendered text between their children and
        // surrounding literals, so keep them inline.
        next = walk(element.children);
      } else {
        // Arguments, numbers, dates, times, and plural pound signs render
        // runtime values. They break literal adjacency without contributing
        // their identifier to this vocabulary check.
        next = [[ARGUMENT_BOUNDARY]];
      }
      alternatives = alternatives.flatMap((left) => next.map((right) => appendTokens(left, right)));
    }
    return alternatives;
  };

  return walk(parse(message)).map((tokens) => {
    const segments: string[] = [];
    for (const token of tokens) {
      if (token === ARGUMENT_BOUNDARY) continue;
      if (token.length > 0) segments.push(token);
    }
    return segments;
  });
}

function containsUntranslatedComputer(message: string): boolean {
  return renderedLiteralSegments(message).some((segments) => segments.some((segment) =>
    /\bcomputer\b/i.test(segment.replace(/Raft Computer/g, "")),
  ));
}

test("every migration error id exists in both catalogs and is translated", () => {
  const ids = Object.keys(en).filter((id) => /^migration\.(?:error|abort)\./.test(id));
  assert.ok(ids.length >= 20, `expected the namespace, found ${ids.length}`);
  for (const id of new Set(ids)) {
    assert.ok(en[id], `${id} missing from en`);
    assert.ok(zh[id], `${id} missing from zh`);
    assert.notEqual(en[id], zh[id], `${id} was never translated`);
  }
});

test("every shared user-error code resolves to specific presentation copy", () => {
  const generic = migrationErrorPresentation({
    code: "UNRECOGNIZED_MIGRATION_ERROR",
    context: "failed",
  }, intl.formatMessage).message;

  for (const code of AGENT_MIGRATION_USER_ERROR_CODES) {
    const presentation = migrationErrorPresentation({ code, context: "failed" }, intl.formatMessage);
    assert.notEqual(presentation.message, generic, `${code} fell through to the generic copy`);
    assert.equal(presentation.technicalCode, code, `${code} lost its support identifier`);
  }
});

test("rendered English is unchanged for every coded error", () => {
  // The point of the migration is that users see the same words; only the
  // assembly point moved. Each of these was a literal in the module before.
  const cases: Array<[string, string]> = [
    ["AGENT_NOT_FOUND", "This agent is no longer available. Refresh and try again."],
    ["TARGET_COMPUTER_REQUIRED", "Choose a target computer before starting the migration."],
    ["TARGET_COMPUTER_OFFLINE", "The target computer is offline. Start Raft Computer on it and try again."],
    ["MIGRATION_START_FAILED", "The migration could not be started. Check both computers and try again."],
    ["MIGRATION_STATUS_FAILED", "Migration status could not be loaded. Refresh and try again."],
  ];
  for (const [code, expected] of cases) {
    const p = migrationErrorPresentation({ code, context: "start" }, intl.formatMessage);
    assert.equal(p.message, expected, `${code} changed`);
  }
});

test("migration authorization denial is action-specific and creator-aware in both locales", () => {
  const english = migrationErrorPresentation({
    code: "not_supported",
    context: "failed",
  }, intl.formatMessage).message;
  assert.equal(
    english,
    "You need permission to migrate agents, or you must be the agent's human creator.",
  );
  assert.doesNotMatch(english, /owners?|admins?/i);

  const chinese = migrationErrorPresentation({
    code: "not_supported",
    context: "failed",
  }, zhIntl.formatMessage).message;
  assert.equal(chinese, "你需要 Agent 迁移权限，或者必须是该 Agent 的人类创建者。");
  assert.doesNotMatch(chinese, /owner|admin/i);
});

test("the optional clause is an ICU select, not a concatenated fragment", () => {
  // Was `${sizeCopy}${largestCopy} Ask the agent…` — three pieces glued in JS,
  // so a translation could not move the middle clause or repunctuate it.
  for (const id of ["migration.error.bundleTooLarge", "migration.error.manifestTooLarge"]) {
    assert.match(en[id], /select, none \{\} other/, `${id} lost its optional clause`);
    assert.match(zh[id], /select, none \{\} other/, `${id}: zh lost its optional clause`);
  }
  // Both arms must actually render.
  const withItems = migrationErrorPresentation({
    code: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE",
    rawMessage: "x:maxBytes=3221225472:topEntries=.git%2F,2147483648",
    context: "failed",
  }, intl.formatMessage);
  assert.match(withItems.message, /Largest workspace items before compression: \.git\/ \(2 GiB\)\./);
  const withoutItems = migrationErrorPresentation({
    code: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE",
    rawMessage: "x:maxBytes=3221225472",
    context: "failed",
  }, intl.formatMessage);
  assert.doesNotMatch(withoutItems.message, /Largest workspace items/);
  assert.doesNotMatch(withoutItems.message, /none/, "the select sentinel leaked into the output");

  // BOTH id variants must render the clause, not just the one the first fixture
  // happens to hit. Mutation testing caught this: emptying the `other` arm of
  // `bundleTooLarge` stayed GREEN because every assertion above supplies
  // maxBytes, which routes to `bundleTooLargeWithLimit`. Same shape as case C3
  // in the catalogue — the fixture never reached the mutated branch.
  const noLimitWithItems = migrationErrorPresentation({
    code: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE",
    rawMessage: "x:topEntries=.git%2F,2147483648",
    context: "failed",
  }, intl.formatMessage);
  assert.match(noLimitWithItems.message, /exceeds the size limit\./);
  assert.match(noLimitWithItems.message, /Largest workspace items before compression: \.git\/ \(2 GiB\)\./);
  // …and the manifest pair, for the same reason.
  const manifestNoCount = migrationErrorPresentation({
    code: "MIGRATION_OBJECT_STORE_MANIFEST_TOO_LARGE",
    rawMessage: "x:topPaths=.git%2F,34214",
    context: "failed",
  }, intl.formatMessage);
  assert.match(manifestNoCount.message, /Most entries are under: \.git\/ \(34,214 entries\)\./);
});

test("counts group per locale, including the ones nested in the path list", () => {
  // The top-level count went through ICU while the per-path counts did not,
  // which silently dropped thousands separators the original had. Both now do.
  const p = migrationErrorPresentation({
    code: "MIGRATION_OBJECT_STORE_MANIFEST_TOO_LARGE",
    rawMessage: "x:entryCount=97079:topPaths=.git%2F,34214",
    context: "failed",
  }, intl.formatMessage);
  assert.match(p.message, /\(97,079 entries\)/, "top-level count lost grouping");
  assert.match(p.message, /\.git\/ \(34,214 entries\)/, "nested count lost grouping");
});

test("zh renders Chinese, and keeps the technical code untranslated", () => {
  const p = migrationErrorPresentation({
    code: "TARGET_COMPUTER_OFFLINE", context: "start",
  }, zhIntl.formatMessage);
  assert.match(p.message, /目标计算机已离线/);
  assert.ok(!/[A-Za-z]{4,}/.test(p.message.replace("Raft Computer", "")),
    `unexpected English left in zh output: ${p.message}`);
  // technicalCode is a wire identifier shown to support — never translated.
  assert.equal(p.technicalCode, "TARGET_COMPUTER_OFFLINE");
});

test("the aborted fallback REUSES the existing id instead of minting a twin", () => {
  // Minting `migration.error.abortedGeneric` produced identical English with a
  // second, already-drifted Chinese rendering. The ratchet caught it.
  assert.equal(en["migration.error.abortedGeneric"], undefined,
    "the duplicate is back — reuse agent.detail.migrationAbortedFallback");
  const p = migrationErrorPresentation({ context: "aborted", reason: "who-knows" }, intl.formatMessage);
  assert.equal(p.message, en["agent.detail.migrationAbortedFallback"]);
});

test("the vocabulary ratchet checks rendered text, not ICU argument names", () => {
  assert.equal(containsUntranslatedComputer("请检查 {computer}。"), false);
  assert.equal(containsUntranslatedComputer("请检查 computer。"), true);
  assert.equal(containsUntranslatedComputer("启动 Raft Computer。"), false);
  assert.equal(
    containsUntranslatedComputer("{state, select, offline {{computer} 已离线} other {computer 未翻译}}"),
    true,
    "nested select arms must still be inspected",
  );
  assert.equal(
    containsUntranslatedComputer("我的 Raft{x}Computer 很好"),
    true,
    "an argument boundary must not manufacture the Raft Computer brand exception",
  );
  assert.equal(
    containsUntranslatedComputer("启动 Raft <b>Computer</b>。"),
    false,
    "inline rich-text tags must not split the rendered Raft Computer brand",
  );
  assert.equal(
    containsUntranslatedComputer("{n, plural, one {comp} other {uter}}"),
    false,
    "mutually exclusive plural arms must not be concatenated into a word",
  );
  assert.equal(
    containsUntranslatedComputer("启动 <b>Raft <i>Computer</i></b>。"),
    false,
    "nested rich-text tags remain inline in rendered text",
  );
});

test("zh follows the vocabulary rulings", () => {
  const ids = Object.keys(en).filter((k) => k.startsWith("migration.error.") || k.startsWith("migration.abort."));
  for (const id of ids) {
    assert.ok(!zh[id].includes("……"), `${id} uses a double ellipsis`);
    assert.ok(!zh[id].includes("..."), `${id} uses ASCII dots`);
    // @AngLee 2026-08-01: app UI standardises on 计算机 for Computer; only the
    // "Raft Computer" brand stays English.
    assert.ok(!containsUntranslatedComputer(zh[id]),
      `${id} left "computer" untranslated`);
  }
});
