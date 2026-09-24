/**
 * Shared prose heuristics for raft-i18n Oxlint AST rules
 * (message-call + return-prose). Keep call/return text judgment on one rail.
 */

export const PROSE_ALLOWLIST = [
  "src/generated/",              // emitted from a source manifest; fix upstream, not here
  "src/analytics/flagRegistry.ts", // experiment names, never rendered to users
];
export function isProseAllowlisted(rel) {
  return PROSE_ALLOWLIST.some((p) => rel.includes(p));
}

// Display prose = starts capitalised, and is either multi-word or one of the
// standalone words that are unambiguously UI labels. Ids, paths, class names,
// enum values and SCREAMING_CASE are excluded.
export const STANDALONE_UI_WORDS = /^(Todo|Done|Closed|Online|Offline|Error|Cancel|Save|Delete|Edit|Close|Open|Back|Next|Retry|Loading|Unknown|None|Default)$/;
/** Capitalized single-word UI label with a display ellipsis (Working…/Thinking…/Saving…). */
const STANDALONE_UI_ELLIPSIS = /^[A-Z][A-Za-z0-9]*\u2026$/;
/** Sentence-start / status word after trim (There / Row / Left) — not SCREAMING or camelCase. */
const STANDALONE_CAPITAL_WORD = /^[A-Z][a-z]+$/;
export function looksLikeDisplayProse(s) {
  // Trim first so template residue / padded returns (` Tasks remaining`) stay visible.
  // No separate path/underscore early-out: the final character-class already
  // rejects `/` and `_`, so it was dead code that mutation could not kill.
  const t = String(s ?? "").trim();
  if (!t) return false;
  if (!/^[A-Z]/.test(t)) return false;
  if (!/ /.test(t)) {
    return (
      STANDALONE_UI_WORDS.test(t) ||
      STANDALONE_UI_ELLIPSIS.test(t) ||
      STANDALONE_CAPITAL_WORD.test(t)
    );
  }
  return /^[A-Za-z0-9][A-Za-z0-9 ,'\u2019.!?\u2014\u2013\u2026-]*$/.test(t);
}

export function looksEnglish(text) {
  const t = text.trim();
  if (!t || t.length < 2) return false;
  if (/[㐀-鿿぀-ヿ가-힯]/.test(t)) return false; // CJK/Kana/Hangul present → already localized or not en
  if (!/[A-Za-z]{2,}/.test(t)) return false; // needs a real word
  // Reject obvious technical/identifier-only values.
  if (/^[a-z][a-zA-Z0-9]*$/.test(t)) return false; // camelCase/lowerword identifier (event names, keys)
  if (/^[a-z0-9-]+$/.test(t)) return false; // kebab / lowercase-hyphen token
  if (/^[A-Z0-9_]+$/.test(t)) return false; // CONST_CASE
  if (/^[\d.,%/\s:+-]+$/.test(t)) return false; // numbers/units
  if (/^(px|rem|em|auto|none|flex|grid|block|inline|hidden|button|status|alert|dialog|listbox|menu|tab|region|true|false|http|https|utf|application|image|video|audio|text|json)$/i.test(t)) return false;
  if (t.startsWith("http") || t.startsWith("/") || t.startsWith("#") || t.includes("://")) return false;
  // Reject TS type-annotation noise caught by the JSX `>...<` regex on generics /
  // unions (e.g. `void | Promise`, `Record<string`, `T => U`).
  if (/[|<>]|=>/.test(t)) return false;
  if (/\b(void|null|undefined|Promise|Record|ReactNode|boolean|string|number|unknown|readonly|Partial|Omit|Pick)\b/.test(t)) return false;
  if (/\?:|:\s*(string|number|boolean|void|null)\b/.test(t)) return false;
  // Require a capital-led word OR a space (real sentence/label), to cut identifier noise.
  return /[A-Z][a-z]/.test(t) || /\s/.test(t);
}

/** Template literal residue with `${…}` holes removed (quasi cooked text only). */
export function templateLiteralResidue(node) {
  if (!node || node.type !== "TemplateLiteral" || !Array.isArray(node.quasis)) {
    return "";
  }
  return node.quasis.map((q) => q.value?.cooked ?? q.value?.raw ?? "").join("");
}
