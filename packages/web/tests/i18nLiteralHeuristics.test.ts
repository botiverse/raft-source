/**
 * Permanent unit pins for shared i18n prose heuristics used by raft-i18n AST rules.
 * Migrated from the retired regex scanner contract (scanHardcodedEn) after Regex→AST
 * parity went GREEN — see formatjsLiteralGate.test.ts migration receipt.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  PROSE_ALLOWLIST,
  isProseAllowlisted,
  looksEnglish,
  looksLikeDisplayProse,
  templateLiteralResidue,
} from "../scripts/i18n-literal-heuristics.mjs";

test("looksEnglish skips CJK-mixed strings (half-migrated copy)", () => {
  // Pure CJK often fails later word checks too; mixed zh+en is the input where
  // the CJK guard alone decides the outcome.
  assert.equal(looksEnglish("条消息 from Bob"), false);
  assert.equal(looksEnglish("Hello 世界"), false);
  assert.equal(looksEnglish("Close panel"), true);
});

test("looksEnglish rejects ids, paths, and technical tokens", () => {
  assert.equal(looksEnglish("/settings/profile"), false);
  assert.equal(looksEnglish("task_status_todo"), false);
  assert.equal(looksEnglish("AGENT_NOT_FOUND"), false);
  assert.equal(looksEnglish("bg-brutal-lime"), false);
  assert.equal(looksEnglish("sign-in"), false);
  assert.equal(looksEnglish("online"), false);
  assert.equal(looksEnglish("void | Promise"), false);
});

test("looksLikeDisplayProse accepts UI labels and rejects ids/paths/enums", () => {
  assert.equal(looksLikeDisplayProse("Todo"), true);
  assert.equal(looksLikeDisplayProse("Online"), true);
  assert.equal(looksLikeDisplayProse("In Progress"), true);
  assert.equal(looksLikeDisplayProse("/settings/profile"), false);
  assert.equal(looksLikeDisplayProse("task_status_todo"), false);
  assert.equal(looksLikeDisplayProse("warning"), false);
  assert.equal(looksLikeDisplayProse("AGENT_NOT_FOUND"), false);
  assert.equal(looksLikeDisplayProse("Settings/Profile"), false);
  assert.equal(looksLikeDisplayProse("Task_Status"), false);
  assert.equal(looksLikeDisplayProse("some internal note"), false);
});

test("looksLikeDisplayProse trims edges and accepts U+2026 display ellipsis labels", () => {
  // Leading/trailing space must not false-green template residue / padded returns.
  assert.equal(looksLikeDisplayProse(" Tasks remaining"), true);
  assert.equal(looksLikeDisplayProse("  In Progress  "), true);
  assert.equal(looksLikeDisplayProse("Thinking\u2026"), true);
  assert.equal(looksLikeDisplayProse("Working\u2026"), true);
  assert.equal(looksLikeDisplayProse("Saving\u2026"), true);
  assert.equal(looksLikeDisplayProse(" Thinking\u2026 "), true);
  // Trim must not drop sentence-start / status words that only had pad spaces.
  assert.equal(looksLikeDisplayProse("There"), true);
  assert.equal(looksLikeDisplayProse("Row "), true);
  // Still reject ids / paths / technical after trim.
  assert.equal(looksLikeDisplayProse("  /settings/profile  "), false);
  assert.equal(looksLikeDisplayProse("  task_status_todo  "), false);
  assert.equal(looksLikeDisplayProse("  AGENT_NOT_FOUND  "), false);
  assert.equal(looksLikeDisplayProse("bg-brutal-lime"), false);
  assert.equal(looksLikeDisplayProse("sign-in"), false);
  assert.equal(looksLikeDisplayProse("AgentStatus"), false);
});

test("PROSE_ALLOWLIST stays narrow (generated + analytics only)", () => {
  assert.deepEqual(PROSE_ALLOWLIST, [
    "src/generated/",
    "src/analytics/flagRegistry.ts",
  ]);
  for (const entry of PROSE_ALLOWLIST) {
    assert.ok(entry !== "src/" && entry !== "src", `allowlist entry ${entry} is too broad`);
  }
  assert.equal(isProseAllowlisted("src/generated/reactionSpriteManifest.ts"), true);
  assert.equal(isProseAllowlisted("src/analytics/flagRegistry.ts"), true);
  assert.equal(isProseAllowlisted("src/utils/activity.ts"), false);
});

test("templateLiteralResidue joins cooked quasis and drops holes", () => {
  const node = {
    type: "TemplateLiteral",
    quasis: [
      { value: { cooked: "", raw: "" } },
      { value: { cooked: " · Drag to move", raw: " · Drag to move" } },
    ],
  };
  assert.equal(templateLiteralResidue(node), " · Drag to move");

  const nestedShape = {
    type: "TemplateLiteral",
    quasis: [
      { value: { cooked: "", raw: "" } },
      { value: { cooked: " · ", raw: " · " } },
      { value: { cooked: "Drag to move", raw: "Drag to move" } },
    ],
  };
  assert.equal(templateLiteralResidue(nestedShape), " · Drag to move");

  assert.equal(templateLiteralResidue(null), "");
  assert.equal(templateLiteralResidue({ type: "Literal" }), "");
});
