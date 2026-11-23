/**
 * Shared prose heuristics for raft-i18n Oxlint AST rules, re-exported from
 * `@botiverse/lint/i18n`.
 */

import {
  DEFAULT_EXCLUDE_PATH_PATTERNS,
  looksEnglish,
  looksLikeDisplayProse,
  matchesPathPattern,
  STANDALONE_UI_WORDS,
  templateLiteralResidue,
} from "@botiverse/lint/i18n";

export const PROSE_ALLOWLIST = DEFAULT_EXCLUDE_PATH_PATTERNS;

export function isProseAllowlisted(rel: string): boolean {
  return PROSE_ALLOWLIST.some((p) => matchesPathPattern(rel, p));
}

export { looksEnglish, looksLikeDisplayProse, STANDALONE_UI_WORDS, templateLiteralResidue };
