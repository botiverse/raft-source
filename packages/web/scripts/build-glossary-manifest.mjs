// Print an on-demand zh glossary report to stdout; redirect it when a saved
// audit is useful. Classification rules stay executable and covered by tests.
//
// Batch ownership is deterministic: a value belongs to the FIRST batch whose
// term it contains. That is @沈括's requirement — one value in exactly one PR,
// never edited twice, never missed.
import { parse } from "@formatjs/icu-messageformat-parser";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// @AngLee 2026-08-03: `Raft <ProperNoun>` is a brand form and stays English;
// a bare `server` / `computer` translates. Dropping this over-counts batch B by
// 13 and turns `Raft Server` into `Raft 服务器`.
export const BRAND = /Raft (?:Server|Computer|Desktop|Cloud)/g;

// CLI command references are code-like and stay English (`slock server info`).
// Without this, `agent.scopes.row.serverRead` — whose ONLY "server" sits inside
// the command — can never leave batch B, so the manifest can never reach zero:
// the same failure shape as the missing brand tooth (criterion only in the
// discussion, nothing in the artifact). A real `server` next to a command is
// still caught: the exclusion strips only the command phrase.
export const CODE_LIKE = /slock [a-z][a-z-]*/g;
export const stripCodeLike = (value) => displayText(value).replace(CODE_LIKE, "");

// Kept-English forms of "Server" (@AngLee 2026-08-03, discriminator: Raft-
// prefix or functional proper nouns stay; pure technical nouns and labels
// translate; out-of-glossary technical words stay English within their
// compound):
//   Server Labs         — feature proper noun (enrollmentMasterDisabled)
//   Server attestation  — attestation not in the glossary, compound stays
//                         (stepAttestationFailed)
// Without these the values can never leave batch B and the manifest can never
// reach zero — same failure shape as the brand tooth.
export const KEPT_SERVER_FORMS = /Server (?:Labs|attestation)/g;
export const stripKeptServerForms = (value) => displayText(value).replace(KEPT_SERVER_FORMS, "");

// Term matching runs over the message's DISPLAY TEXT: literal text plus
// plural/select arm bodies, with argument NAMES excluded.
//
// The distinction needs the AST, not a brace regex. `{provider} 登录` must not
// match (an argument name is an identifier, never translated), but
// `{count, plural, other {# 个 agent}}` MUST match — that arm body is rendered
// to the user. A regex over `\{[^{}]*\}` strips both, which is the bug @Wug
// caught in the first version of this fix: it silently hid real candidates
// living inside plural/select arms.
//
// This is the same AST rule already used by tests/placeholderNamesAreOpaque.
// It is stated in both places because both need it; what it must never be again
// is a rule I remember rather than one the code applies.
export function displayText(message) {
  let out = "";
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.type === 0) out += node.value;                 // literal
      else if (node.options) {                                // plural / select
        for (const arm of Object.values(node.options)) walk(arm.value);
      } else if (node.children) walk(node.children);          // rich-text tag
      // argument nodes contribute nothing: their `value` is the identifier
    }
  };
  try { walk(parse(message)); } catch { return message; }     // unparseable: fall back
  return out;
}

export const stripBrand = (value) => displayText(value).replace(BRAND, "");

export const BATCHES = [
  ["A-runtime-provider", /(?<![A-Za-z])(?:[Rr]untime|[Pp]rovider)(?![A-Za-z])/, "runtime→运行时 / provider→提供方"],
  ["B-server", /(?<![A-Za-z])[Ss]erver(?![A-Za-z])/, "server→服务器"],
  ["C-daemon", /(?<![A-Za-z])[Dd]aemon(?![A-Za-z])/, "daemon→守护进程"],
  ["D-agent-case", /(?<![A-Za-z])agent(?![A-Za-z])/, "agent→Agent (kept English, Title Case)"],
];

export function parseCatalog(source) {
  return Object.fromEntries(
    [...source.matchAll(/^  "([^"]+)":\s*"((?:[^"\\]|\\.)*)"/gm)].map((m) => [m[1], m[2]]),
  );
}

/** @returns {{owner: Record<string,string>, terms: Record<string,string[]>, hits: number}} */
export function assign(catalog) {
  const owner = {}, terms = {};
  let hits = 0;
  for (const [id, value] of Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b))) {
    const stripped = stripKeptServerForms(stripCodeLike(stripBrand(value)));
    const matched = BATCHES.filter(([, re]) => re.test(stripped)).map(([name]) => name);
    hits += matched.length;
    if (matched.length > 0) { owner[id] = matched[0]; terms[id] = matched; }
  }
  return { owner, terms, hits };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const catalog = parseCatalog(readFileSync(join(HERE, "../src/i18n/messages/zh-cn.ts"), "utf8"));
  const { owner, terms, hits } = assign(catalog);
  const overlaps = Object.entries(terms).filter(([, t]) => t.length > 1);
  const ruleOf = Object.fromEntries(BATCHES.map(([n, , r]) => [n, r]));
  const out = [
    "# i18n glossary pass — canonical id list", "",
    "Generated by `packages/web/scripts/build-glossary-manifest.mjs`. Regenerate; do not hand-edit.",
    "Numbers quoted in chat — including mine — are not authoritative. This file is.", "",
    `term hits: ${hits} · deduped values: ${Object.keys(owner).length} · overlapping: ${overlaps.length}`, "",
    "| batch | ruling | values |", "|---|---|---|",
    ...BATCHES.map(([n, , r]) => `| ${n} | ${r} | ${Object.values(owner).filter((o) => o === n).length} |`),
    "", "## Overlapping values", "",
    "Owned by the FIRST batch. The owning batch must convert EVERY term the value",
    "contains to final state in that PR — later batches skip it, so a half-converted",
    "value keeps its English forever.", "",
    ...overlaps.flatMap(([id, t]) => [
      `### \`${id}\``, `- owned by: **${t[0]}**`,
      `- must satisfy in that batch: ${t.map((n) => ruleOf[n]).join("; ")}`,
      `- current zh: \`${catalog[id]}\``, "",
    ]),
    "## Full assignment", "",
    ...BATCHES.flatMap(([n]) => [
      `### ${n} (${Object.values(owner).filter((o) => o === n).length})`,
      ...Object.keys(owner).filter((id) => owner[id] === n).sort().map((id) => `- \`${id}\``),
      "",
    ]),
  ].join("\n");
  process.stdout.write(out);
  console.error(`glossary manifest: ${hits} hits -> ${Object.keys(owner).length} values, ${overlaps.length} overlapping`);
}
