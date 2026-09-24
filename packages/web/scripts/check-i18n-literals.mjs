#!/usr/bin/env node
/**
 * FormatJS + raft-i18n AST literal ratchet: compare oxlint diagnostics from
 * formatjs JSX/object rules and raft-i18n call/return rules against a reviewed
 * baseline. New findings and stale baseline entries both fail.
 *
 * Required gate: invoked by `pnpm run lint:i18n-literals`, which the package
 * `lint` script chains at the end (and CI already runs web lint).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  filterCatalogMessageIdFindings,
  isCatalogMessageIdObjectLiteralFinding,
  loadCatalogMessageIdsFromPath,
  loadCatalogMessageIdsFromSource,
  loadDefaultCatalogMessageIds,
} from "./i18n-catalog-message-ids.mjs";

export {
  filterCatalogMessageIdFindings,
  isCatalogMessageIdObjectLiteralFinding,
  loadCatalogMessageIdsFromPath,
  loadCatalogMessageIdsFromSource,
  loadDefaultCatalogMessageIds,
};

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_CONFIG = resolve(SCRIPT_DIR, "oxlint-i18n.json");
const DEFAULT_BASELINE = resolve(SCRIPT_DIR, "i18n-literal-baseline.json");
const INTENTIONAL_CLASSIFICATIONS = new Set([
  "brand",
  "protocol",
  "code_example",
  "user_data_example",
  "internal_dev",
  "legacy",
  "technical",
  "owner_managed",
]);
const ALL_CLASSIFICATIONS = new Set([
  "debt",
  "brand",
  "protocol",
  "code_example",
  "user_data_example",
  "internal_dev",
  "legacy",
  "technical",
  "owner_managed",
]);
const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?)$/;

/** Oxlint emits `plugin(rule)`; only these i18n literal rules are accepted. */
const EXPECTED_OXLIN_CODES = new Set([
  "formatjs(no-literal-string-in-jsx)",
  "formatjs(no-literal-string-in-object)",
  "raft-i18n(no-literal-in-message-call)",
  "raft-i18n(no-literal-return-prose)",
]);

const DISABLE_DIRECTIVE_RE =
  /^(eslint|oxlint)-disable(?:-next-line|-line)?\b(.*)$/s;

export function normalizeRuleId(code) {
  const match = /^([^(]+)\((.+)\)$/.exec(String(code ?? ""));
  if (!match) return String(code ?? "");
  return `${match[1]}/${match[2]}`;
}

export function extractSourceSnippet(fileContentOrBytes, span) {
  const offset = Number(span?.offset);
  const length = Number(span?.length);
  if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length < 0) {
    throw new Error(`invalid diagnostic span: ${JSON.stringify(span)}`);
  }
  // Oxlint JSON spans are UTF-8 byte offsets, not JS string indices.
  const bytes = Buffer.isBuffer(fileContentOrBytes)
    ? fileContentOrBytes
    : Buffer.from(fileContentOrBytes, "utf8");
  if (offset + length > bytes.length) {
    throw new Error(
      `diagnostic span out of bounds: offset=${offset} length=${length} bytes=${bytes.length}`,
    );
  }
  return bytes.subarray(offset, offset + length).toString("utf8");
}

/**
 * Identity key for a diagnostic span: trim edges, collapse cross-line/indent
 * whitespace to a single space. Preserves semantic quoted spaces like `" "`.
 */
export function normalizeSourceIdentity(source) {
  return String(source).trim().replace(/\s+/g, " ");
}

/**
 * Batch-1 structural noise: pure whitespace, a narrow punctuation allowlist,
 * direct numbers/percentages/count ratios (`/500`, `0/0`), explicit count
 * templates (`${n}/${total}`, `${progress}%`), and the exact quoted escape
 * `"\\n"`. Intentionally does NOT use a wide "no letters ⇒ ignore" rule
 * (would hide `@`/`#` protocol markers) and does not decode letterful escapes.
 *
 * Template policy: only clear count residues `/` or `%` between/after holes.
 * `/${slug}`, empty residue, spaces, middot glue, and formatMessage glue stay.
 */
const STRUCTURAL_PUNCT_CHARS = new Set([
  ".",
  ":",
  "/",
  "·",
  "—",
  "–",
  "+",
  "-",
  "*",
  "%",
  "…",
  "→",
  "=",
  "(",
  ")",
  ",",
  "›",
]);

/**
 * Unwrap oxlint finding source into attr / quoted / template / bare text.
 * Attr form only when `name=` is followed by a full quoted/template literal.
 */
export function parseFindingLiteralSource(source) {
  const s = String(source);
  const attrMatch = /^([A-Za-z_:$][\w:$.-]*)=('.*'|".*"|`.*`)$/.exec(s);
  if (attrMatch) {
    const attrName = attrMatch[1];
    const literal = attrMatch[2];
    const inner = parseFindingLiteralSource(literal);
    return {
      form: inner.form === "template" ? "template" : "attr",
      attrName,
      text: inner.text,
    };
  }
  if (s.length >= 2) {
    const q = s[0];
    if ((q === '"' || q === "'") && s.endsWith(q)) {
      return { form: "quoted", attrName: null, text: s.slice(1, -1) };
    }
    if (q === "`" && s.endsWith("`")) {
      return { form: "template", attrName: null, text: s.slice(1, -1) };
    }
  }
  return { form: "bare", attrName: null, text: s };
}

/**
 * Split template cooked text into static quasis + hole sources.
 * Hole scanning is quote/template-aware so `}` inside `"..."` / `'...'` / `` `...` ``
 * does not terminate the hole early.
 */
export function splitTemplateLiteralParts(text) {
  const quasis = [];
  const holes = [];
  let i = 0;
  let buf = "";
  let balanced = true;
  const s = String(text);

  const skipQuoted = (quote) => {
    i += 1;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (quote === "`" && ch === "$" && s[i + 1] === "{") {
        // Nested template hole: skip balanced `${...}` then continue.
        i += 2;
        let depth = 1;
        while (i < s.length && depth > 0) {
          const nested = s[i];
          if (nested === '"' || nested === "'" || nested === "`") {
            const q = nested;
            i += 1;
            while (i < s.length) {
              if (s[i] === "\\") {
                i += 2;
                continue;
              }
              if (s[i] === q) {
                i += 1;
                break;
              }
              i += 1;
            }
            continue;
          }
          if (nested === "{") depth += 1;
          else if (nested === "}") depth -= 1;
          i += 1;
        }
        continue;
      }
      if (ch === quote) {
        i += 1;
        return;
      }
      i += 1;
    }
  };

  while (i < s.length) {
    if (s[i] === "$" && s[i + 1] === "{") {
      quasis.push(buf);
      buf = "";
      i += 2;
      const start = i;
      let depth = 1;
      while (i < s.length && depth > 0) {
        const ch = s[i];
        if (ch === '"' || ch === "'" || ch === "`") {
          skipQuoted(ch);
          continue;
        }
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        i += 1;
      }
      // Unbalanced / truncated hole → fail closed via empty marker hole.
      if (depth !== 0) {
        balanced = false;
        holes.push(s.slice(start));
        break;
      }
      holes.push(s.slice(start, i - 1));
    } else {
      buf += s[i];
      i += 1;
    }
  }
  quasis.push(buf);
  return { quasis, holes, balanced };
}

/** Split template cooked text into static quasis by removing `${...}` holes. */
export function templateStaticQuasis(text) {
  return splitTemplateLiteralParts(text).quasis;
}

/**
 * True when a template hole's source embeds any static string / template
 * literal. Prefer TS parse; on parse failure fall back to a quote scan and
 * fail closed (treat as stringful → do not ignore).
 */
export function templateHoleHasStaticLiteral(holeSource) {
  const hole = String(holeSource ?? "");
  if (hole.length === 0) return false;
  try {
    const sf = ts.createSourceFile(
      "_i18n_hole.ts",
      `(${hole})`,
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ false,
      ts.ScriptKind.TS,
    );
    // SourceFile parse errors still produce a tree; fail closed (stringful)
    // so malformed count holes cannot be ignored as clean `${n}/${total}` shapes.
    if (sf.parseDiagnostics?.length) {
      return true;
    }
    let found = false;
    const visit = (node) => {
      if (found) return;
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node) ||
        ts.isTaggedTemplateExpression(node)
      ) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  } catch {
    return true;
  }
}

function isFormatMessageCatalogIdLiteral(node, catalogMessageIds) {
  if (!ts.isStringLiteral(node) || !catalogMessageIds.has(node.text)) return false;
  const property = node.parent;
  if (
    !property ||
    !ts.isPropertyAssignment(property) ||
    property.initializer !== node ||
    !(
      (ts.isIdentifier(property.name) && property.name.text === "id") ||
      (ts.isStringLiteral(property.name) && property.name.text === "id")
    )
  ) {
    return false;
  }
  const descriptor = property.parent;
  const call = descriptor?.parent;
  if (
    !descriptor ||
    !ts.isObjectLiteralExpression(descriptor) ||
    !call ||
    !ts.isCallExpression(call) ||
    call.arguments[0] !== descriptor
  ) {
    return false;
  }
  return (
    (ts.isIdentifier(call.expression) && call.expression.text === "formatMessage") ||
    (ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "formatMessage")
  );
}

/**
 * True when a template hole contains a string that could become visible prose.
 * Empty-string fallbacks are structural. Exact catalog ids are safe only in the
 * descriptor passed to formatMessage; a raw catalog id in a conditional stays.
 */
function templateHoleHasUnsafeLiteral(holeSource, catalogMessageIds) {
  const hole = String(holeSource ?? "");
  if (hole.length === 0) return true;
  try {
    const sf = ts.createSourceFile(
      "_i18n_glue_hole.ts",
      `(${hole})`,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TS,
    );
    if (sf.parseDiagnostics?.length) return true;

    let unsafe = false;
    const visit = (node) => {
      if (unsafe) return;
      if (
        node.parent &&
        (ts.isPropertyAssignment(node.parent) ||
          ts.isShorthandPropertyAssignment(node.parent)) &&
        node.parent.name === node
      ) {
        return;
      }
      if (ts.isStringLiteral(node)) {
        if (
          node.text !== "" &&
          !isFormatMessageCatalogIdLiteral(node, catalogMessageIds)
        ) {
          unsafe = true;
        }
        return;
      }
      if (ts.isNoSubstitutionTemplateLiteral(node)) {
        if (node.text !== "" && !isAllowedPunctuationOrSpace(node.text)) {
          unsafe = true;
        }
        return;
      }
      if (ts.isTemplateExpression(node)) {
        const quasis = [
          node.head.text,
          ...node.templateSpans.map((span) => span.literal.text),
        ];
        if (
          quasis.some(
            (quasi) =>
              quasi !== "" && !isAllowedPunctuationOrSpace(quasi),
          )
        ) {
          unsafe = true;
          return;
        }
      }
      if (ts.isTaggedTemplateExpression(node)) {
        unsafe = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return unsafe;
  } catch {
    return true;
  }
}

function isPureWhitespace(text) {
  return text.length > 0 && /^\s+$/.test(text);
}

function isAllowedPunctuationOrSpace(text) {
  if (text.length === 0) return false;
  if (isPureWhitespace(text)) return true;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (STRUCTURAL_PUNCT_CHARS.has(ch)) continue;
    return false;
  }
  return true;
}

function isDirectNumberPercentOrCount(text) {
  return (
    /^\d+(\.\d+)?%?$/.test(text) ||
    /^\d+\s*\/\s*\d+$/.test(text) ||
    // Count/limit ceiling fragment like `/500` (not `/${slug}` templates).
    /^\/\d+$/.test(text)
  );
}

/**
 * Exact quoted JS escape for newline (`"\\n"` → text `\n`). Do not decode
 * other escapes (`\t`, `\uXXXX`, etc.) even when letter-bearing.
 */
function isExactQuotedEscapedNewline(parsed) {
  return (
    (parsed.form === "quoted" || parsed.form === "attr") &&
    parsed.text === "\\n"
  );
}

/**
 * True only for clear count templates:
 * - `${progress}%`
 * - `${n}/${total}` (optional spaces around `/`)
 * AND every hole is free of static string / template literals.
 * Does not match `/${slug}`, glue middots, stringful conditionals, or
 * formatMessage holes (those stay for later batches).
 */
function isIgnorableCountTemplate(text) {
  const { quasis, holes, balanced } = splitTemplateLiteralParts(text);
  if (!balanced) return false;
  const quasiOkPercent =
    quasis.length === 2 && quasis[0] === "" && /^\s*%\s*$/.test(quasis[1]);
  const quasiOkRatio =
    quasis.length === 3 &&
    quasis[0] === "" &&
    /^\s*\/\s*$/.test(quasis[1]) &&
    quasis[2] === "";
  if (!quasiOkPercent && !quasiOkRatio) return false;
  // Fail closed: hole/quasi arity mismatch or any stringful hole → keep.
  if (holes.length !== quasis.length - 1) return false;
  if (holes.some((hole) => templateHoleHasStaticLiteral(hole))) return false;
  return true;
}

function isIgnorableTemplateGlue(text, catalogMessageIds) {
  if (!(catalogMessageIds instanceof Set)) return false;
  const { quasis, holes, balanced } = splitTemplateLiteralParts(text);
  if (!balanced) return false;
  if (holes.length === 0 || holes.length !== quasis.length - 1) return false;
  if (
    quasis.some(
      (quasi) => quasi !== "" && !isAllowedPunctuationOrSpace(quasi),
    )
  ) {
    return false;
  }
  return !holes.some((hole) =>
    templateHoleHasUnsafeLiteral(hole, catalogMessageIds),
  );
}

export function isIgnorableStructuralLiteral(source, catalogMessageIds) {
  const parsed = parseFindingLiteralSource(source);
  if (parsed.form === "template") {
    return (
      isIgnorableCountTemplate(parsed.text) ||
      isIgnorableTemplateGlue(parsed.text, catalogMessageIds)
    );
  }
  return (
    isExactQuotedEscapedNewline(parsed) ||
    isAllowedPunctuationOrSpace(parsed.text) ||
    isDirectNumberPercentOrCount(parsed.text)
  );
}

export function filterIgnorableStructuralFindings(rawFindings, catalogMessageIds) {
  return rawFindings.filter(
    (finding) =>
      !isIgnorableStructuralLiteral(finding.source, catalogMessageIds),
  );
}

/** Per-file text + UTF-8 Buffer cache so many findings in one file share one read. */
export function createFileSourceCache(readFile) {
  const textByPath = new Map();
  const bytesByPath = new Map();
  const readText = (absPath) => {
    let text = textByPath.get(absPath);
    if (text === undefined) {
      text = readFile(absPath);
      textByPath.set(absPath, text);
    }
    return text;
  };
  const readUtf8Bytes = (absPath) => {
    let bytes = bytesByPath.get(absPath);
    if (bytes === undefined) {
      bytes = Buffer.from(readText(absPath), "utf8");
      bytesByPath.set(absPath, bytes);
    }
    return bytes;
  };
  return { readText, readUtf8Bytes };
}

/**
 * Resolve whether argv points at this script. Failures are explicit `error`
 * so the CLI entry can fail closed; the soft predicate maps them to false.
 */
export function resolveDirectCliInvocation(argvPath, scriptPath = SCRIPT_PATH) {
  if (!argvPath) return { kind: "not-cli" };
  try {
    const matched =
      realpathSync(resolve(argvPath)) === realpathSync(scriptPath);
    return { kind: matched ? "direct" : "not-cli" };
  } catch (error) {
    return { kind: "error", message: String(error.message ?? error) };
  }
}

/**
 * Soft predicate: true when argv[1] (possibly a symlink/wrapper) is this script.
 * realpath failures return false — use resolveDirectCliInvocation at CLI entry.
 */
export function isDirectCliInvocation(argvPath, scriptPath = SCRIPT_PATH) {
  return resolveDirectCliInvocation(argvPath, scriptPath).kind === "direct";
}

function toPosix(path) {
  return path.split(sep).join("/");
}

export function findingKey({ path, rule, source }) {
  return `${path}\0${rule}\0${source}`;
}

export function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return 0;
  });
}

export function aggregateFindings(rawFindings) {
  const counts = new Map();
  for (const finding of rawFindings) {
    const key = findingKey(finding);
    const prev = counts.get(key);
    if (prev) {
      prev.count += 1;
    } else {
      counts.set(key, {
        path: finding.path,
        rule: finding.rule,
        source: finding.source,
        count: 1,
      });
    }
  }
  return sortFindings([...counts.values()]);
}

export function assertTargetInsideRoot(root, target) {
  const absRoot = resolve(root);
  const absTarget = isAbsolute(target) ? resolve(target) : resolve(absRoot, target);
  const rel = relative(absRoot, absTarget);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`target must be inside root: target=${absTarget} root=${absRoot}`);
  }
  return absTarget;
}

function commentBodyFromTrivia(tokenText) {
  if (tokenText.startsWith("//")) return tokenText.slice(2).trim();
  if (tokenText.startsWith("/*") && tokenText.endsWith("*/")) {
    return tokenText.slice(2, -2).trim();
  }
  return tokenText.trim();
}

function isI18nGateRuleName(rule) {
  return (
    rule === "formatjs" ||
    rule.startsWith("formatjs/") ||
    rule === "raft-i18n" ||
    rule.startsWith("raft-i18n/")
  );
}

/**
 * Syntax-aware comment extraction via the TypeScript scanner (skipTrivia=false).
 * String/template contents are not comments and must not be reported.
 */
export function extractSourceComments(sourceText, fileName = "file.tsx") {
  const isJsx = /\.[jt]sx$/.test(fileName);
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    isJsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    sourceText,
  );
  const comments = [];
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      comments.push({
        text: scanner.getTokenText(),
        pos: scanner.getTokenPos(),
      });
    }
    token = scanner.scan();
  }
  return comments;
}

/**
 * Classify one comment trivia token. Returns a hit when the directive would
 * suppress FormatJS / raft-i18n (named rules) or disable all rules (bare disable).
 */
export function classifyDisableDirectiveComment(commentTokenText) {
  const body = commentBodyFromTrivia(commentTokenText);
  const match = DISABLE_DIRECTIVE_RE.exec(body);
  if (!match) return null;
  const tool = match[1];
  let rest = String(match[2] ?? "").trim();
  // Reasons use `-- …`. Bare disable-all may be written as
  // `// oxlint-disable -- reason` (no rule list before `--`).
  if (rest.startsWith("--")) {
    rest = "";
  } else {
    const reasonIdx = rest.search(/\s--/);
    if (reasonIdx >= 0) rest = rest.slice(0, reasonIdx).trim();
  }
  if (rest.length === 0) {
    return {
      kind: "disable-all",
      tool,
      message: `forbidden-directive: bare ${tool}-disable (disables all rules including formatjs/raft-i18n)`,
    };
  }
  const rules = rest
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const i18nRules = rules.filter(isI18nGateRuleName);
  if (i18nRules.length === 0) return null;
  return {
    kind: "i18n-gate",
    tool,
    rules: i18nRules,
    message: `forbidden-directive: ${tool}-disable names ${i18nRules.join(", ")}`,
  };
}

export function findForbiddenDisableDirectivesInSource(sourceText, fileName = "file.tsx") {
  const hits = [];
  for (const comment of extractSourceComments(sourceText, fileName)) {
    const classified = classifyDisableDirectiveComment(comment.text);
    if (!classified) continue;
    hits.push({
      pos: comment.pos,
      text: comment.text,
      ...classified,
    });
  }
  return hits;
}

function listTargetSourceFiles(absTarget) {
  const st = statSync(absTarget);
  if (st.isFile()) {
    return SOURCE_FILE_RE.test(absTarget) ? [absTarget] : [];
  }
  if (!st.isDirectory()) return [];
  const out = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === "dist") continue;
        walk(full);
      } else if (ent.isFile() && SOURCE_FILE_RE.test(ent.name)) {
        out.push(full);
      }
    }
  };
  walk(absTarget);
  return out.sort();
}

/**
 * Fail closed before Oxlint: disable directives that can hide FormatJS /
 * raft-i18n findings are not allowed in the lint target.
 */
export function assertNoForbiddenI18nDisableDirectives({
  root,
  target = "src",
  readFile = (absPath) => readFileSync(absPath, "utf8"),
}) {
  const absTarget = assertTargetInsideRoot(root, target);
  const files = listTargetSourceFiles(absTarget);
  const violations = [];
  for (const absPath of files) {
    const rel = toPosix(relative(resolve(root), absPath));
    const source = readFile(absPath);
    for (const hit of findForbiddenDisableDirectivesInSource(source, absPath)) {
      violations.push(`${rel}: ${hit.message}`);
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `forbidden-directive: FormatJS/raft-i18n disable / bare disable-all is not allowed under the i18n literal gate:\n${violations.map((v) => `  - ${v}`).join("\n")}`,
    );
  }
}

export function assertAcceptedOxlintStatus(status) {
  if (status !== 0 && status !== 1) {
    throw new Error(`unexpected oxlint exit status ${String(status)}; expected 0 or 1`);
  }
}

function resolveDiagnosticAbsPath(filename, root) {
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("diagnostic missing filename");
  }
  return isAbsolute(filename) ? resolve(filename) : resolve(root, filename);
}

function assertPathInsideRoot(absPath, root) {
  const absRoot = resolve(root);
  const rel = relative(absRoot, absPath);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`diagnostic path is outside root: path=${absPath} root=${absRoot}`);
  }
  return toPosix(rel);
}

export function findingsFromOxlintDiagnostics(diagnostics, { root, readFile }) {
  const cache = createFileSourceCache(readFile);
  const raw = [];
  for (const diagnostic of diagnostics ?? []) {
    const code = diagnostic.code;
    if (!EXPECTED_OXLIN_CODES.has(code)) {
      throw new Error(
        `unexpected diagnostic code ${JSON.stringify(code)}; only FormatJS/raft-i18n literal rules are accepted`,
      );
    }

    const absPath = resolveDiagnosticAbsPath(diagnostic.filename, root);
    const rel = assertPathInsideRoot(absPath, root);
    const rule = normalizeRuleId(code);
    const labels = Array.isArray(diagnostic.labels) ? diagnostic.labels : [];
    // Only the primary label (first) contributes; secondary labels must not double-count.
    const primary = labels[0];
    const span = primary?.span;
    if (!span) {
      throw new Error(
        `i18n diagnostic missing labels/span: ${rel} ${rule}`,
      );
    }
    const bytes = cache.readUtf8Bytes(absPath);
    const source = normalizeSourceIdentity(extractSourceSnippet(bytes, span));
    if (source.length === 0) {
      throw new Error(
        `i18n diagnostic produced empty source identity after normalize: ${rel} ${rule}`,
      );
    }
    raw.push({ path: rel, rule, source });
  }
  return raw;
}

export function validateBaselineEntries(entries) {
  const errors = [];
  if (!Array.isArray(entries)) {
    return ["baseline must be a JSON array"];
  }
  const seenKeys = new Map();
  for (const [index, entry] of entries.entries()) {
    const prefix = `baseline[${index}]`;
    if (!entry || typeof entry !== "object") {
      errors.push(`${prefix}: entry must be an object`);
      continue;
    }
    for (const field of ["path", "rule", "source"]) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        errors.push(`${prefix}: missing non-empty ${field}`);
      }
    }
    if (typeof entry.source === "string" && entry.source.length > 0) {
      if (entry.source !== normalizeSourceIdentity(entry.source)) {
        errors.push(
          `${prefix}: source must already be normalizeSourceIdentity'd (no multiline/indent/extra spaces)`,
        );
      }
    }
    if (!Number.isInteger(entry.count) || entry.count < 1) {
      errors.push(`${prefix}: count must be a positive integer`);
    }
    if (!ALL_CLASSIFICATIONS.has(entry.classification)) {
      errors.push(
        `${prefix}: classification must be one of ${[...ALL_CLASSIFICATIONS].join(", ")}`,
      );
    } else if (INTENTIONAL_CLASSIFICATIONS.has(entry.classification)) {
      if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
        errors.push(
          `${prefix} (${entry.path} ${entry.classification}): intentional classification requires a non-empty reason`,
        );
      }
    }

    if (
      typeof entry.path === "string" &&
      typeof entry.rule === "string" &&
      typeof entry.source === "string"
    ) {
      const key = findingKey(entry);
      if (seenKeys.has(key)) {
        errors.push(
          `${prefix}: duplicate path+rule+source key (also at baseline[${seenKeys.get(key)}])`,
        );
      } else {
        seenKeys.set(key, index);
      }
    }
  }
  return errors;
}

export function compareFindingsToBaseline(current, baseline) {
  const classificationErrors = validateBaselineEntries(baseline);
  if (classificationErrors.length > 0) {
    return {
      ok: false,
      exitCode: 1,
      newFindings: [],
      staleBaseline: [],
      classificationErrors,
    };
  }

  const currentMap = new Map(current.map((f) => [findingKey(f), f]));
  const baselineMap = new Map(baseline.map((f) => [findingKey(f), f]));
  const newFindings = [];
  const staleBaseline = [];

  for (const [key, finding] of currentMap) {
    const base = baselineMap.get(key);
    const baseCount = base?.count ?? 0;
    if (finding.count > baseCount) {
      newFindings.push({
        path: finding.path,
        rule: finding.rule,
        source: finding.source,
        count: finding.count - baseCount,
      });
    }
  }

  for (const [key, entry] of baselineMap) {
    const cur = currentMap.get(key);
    const curCount = cur?.count ?? 0;
    if (entry.count > curCount) {
      staleBaseline.push({
        ...entry,
        count: entry.count - curCount,
      });
    }
  }

  const sortedNew = sortFindings(newFindings);
  const sortedStale = sortFindings(staleBaseline);
  const ok = sortedNew.length === 0 && sortedStale.length === 0;
  return {
    ok,
    exitCode: ok ? 0 : 1,
    newFindings: sortedNew,
    staleBaseline: sortedStale,
    classificationErrors: [],
  };
}

export function parseOxlintJson(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    throw new Error("oxlint produced empty stdout; expected JSON diagnostics");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const preview = text.slice(0, 400);
    throw new Error(
      `oxlint did not emit JSON diagnostics (plugin/config/execution error):\n${preview}`,
      { cause: error },
    );
  }
  if (!parsed || !Array.isArray(parsed.diagnostics)) {
    throw new Error("oxlint JSON missing diagnostics array");
  }
  return parsed;
}

/** Always resolve oxlint from packages/web so temporary --root fixtures work. */
export function resolveOxlintBin() {
  const require = createRequire(join(PACKAGE_ROOT, "package.json"));
  const pkgJson = require.resolve("oxlint/package.json");
  const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.oxlint;
  if (!binRel) {
    throw new Error("oxlint package.json missing bin.oxlint");
  }
  return resolve(dirname(pkgJson), binRel);
}

export function runOxlintI18n({
  root,
  configPath = DEFAULT_CONFIG,
  target = "src",
  oxlintBin,
  readFile = (absPath) => readFileSync(absPath, "utf8"),
}) {
  const absTarget = assertTargetInsideRoot(root, target);
  // Fail closed before spawning Oxlint so disable comments cannot fake-green.
  assertNoForbiddenI18nDisableDirectives({ root, target, readFile });
  const bin = oxlintBin ?? resolveOxlintBin();
  // Cross-platform: run the oxlint JS entry via node instead of relying on a
  // shebang executable (Windows cannot exec shebang bins directly).
  const result = spawnSync(
    process.execPath,
    [
      bin,
      "-c",
      configPath,
      "--disable-nested-config",
      "--format=json",
      absTarget,
    ],
    {
      encoding: "utf8",
      cwd: root,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw new Error(`failed to spawn oxlint: ${result.error.message}`);
  }

  // Lint findings exit 1 with valid JSON. Plugin/config/parse failures also
  // exit non-zero but print a prose error — reject those separately.
  let report;
  try {
    report = parseOxlintJson(result.stdout);
  } catch (error) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `oxlint execution failed (exit ${result.status ?? "null"}):\n${detail || error.message}`,
      { cause: error },
    );
  }

  try {
    assertAcceptedOxlintStatus(result.status);
  } catch (error) {
    throw new Error(
      `${error.message}; refusing JSON from unexpected oxlint status`,
      { cause: error },
    );
  }

  return {
    report,
    status: result.status,
    stderr: result.stderr,
  };
}

export function collectCurrentFindings({
  root,
  configPath = DEFAULT_CONFIG,
  target = "src",
  oxlintBin,
  readFile = (absPath) => readFileSync(absPath, "utf8"),
  /** @type {ReadonlySet<string> | undefined} injected catalog for tests */
  catalogMessageIds,
  /** @type {string | undefined} override en.ts path (default: packages/web en.ts) */
  catalogPath,
} = {}) {
  const { report } = runOxlintI18n({ root, configPath, target, oxlintBin, readFile });
  const raw = findingsFromOxlintDiagnostics(report.diagnostics, { root, readFile });
  const catalogIds =
    catalogMessageIds ??
    (catalogPath
      ? loadCatalogMessageIdsFromPath(catalogPath)
      : loadDefaultCatalogMessageIds());
  // Drop structural/template-glue noise, then exact catalog MessageId object
  // literals, before multiset aggregate / baseline compare.
  const afterStructural = filterIgnorableStructuralFindings(raw, catalogIds);
  return aggregateFindings(filterCatalogMessageIdFindings(afterStructural, catalogIds));
}

export function toBaselineEntries(findings, classification = "debt") {
  return sortFindings(findings).map((finding) => ({
    path: finding.path,
    rule: finding.rule,
    source: finding.source,
    count: finding.count,
    classification,
  }));
}

function parseArgs(argv) {
  const args = {
    root: PACKAGE_ROOT,
    baseline: DEFAULT_BASELINE,
    config: DEFAULT_CONFIG,
    target: "src",
    printCurrent: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      args.root = resolve(argv[++i] ?? "");
    } else if (arg === "--baseline") {
      args.baseline = resolve(argv[++i] ?? "");
    } else if (arg === "--config") {
      args.config = resolve(argv[++i] ?? "");
    } else if (arg === "--target") {
      args.target = argv[++i] ?? "src";
    } else if (arg === "--print-current") {
      args.printCurrent = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/check-i18n-literals.mjs [options]

Compare FormatJS + raft-i18n AST literal diagnostics against a reviewed baseline.

Options:
  --root <dir>         Package root (default: packages/web)
  --baseline <file>    Baseline JSON (default: scripts/i18n-literal-baseline.json)
  --config <file>      Oxlint config (default: scripts/oxlint-i18n.json)
  --target <path>      Lint target relative to root (default: src)
  --print-current      Print current findings as baseline-shaped JSON (all debt) and exit 0
  --help               Show this help

There is no auto-update / write-baseline command. Edit the baseline by hand
after reviewing --print-current output.`);
}

function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    printHelp();
    process.exit(2);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  let current;
  try {
    // Fail closed on root/target before spawning oxlint.
    assertTargetInsideRoot(args.root, args.target);
    current = collectCurrentFindings({
      root: args.root,
      configPath: args.config,
      target: args.target,
    });
  } catch (error) {
    console.error(`i18n literal check failed to run oxlint:\n${error.message}`);
    process.exit(2);
  }

  if (args.printCurrent) {
    const entries = toBaselineEntries(current, "debt");
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    // Do not call process.exit() while stdout may still be draining to a pipe.
    // Large inventories can exceed the pipe buffer and would be truncated.
    process.exitCode = 0;
    return;
  }

  if (!existsSync(args.baseline)) {
    console.error(`baseline file not found: ${args.baseline}`);
    process.exit(2);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(args.baseline, "utf8"));
  } catch (error) {
    console.error(`failed to read baseline JSON: ${error.message}`);
    process.exit(2);
  }

  const result = compareFindingsToBaseline(current, baseline);
  if (result.classificationErrors.length > 0) {
    console.error("i18n literal baseline classification errors:");
    for (const err of result.classificationErrors) console.error(`  - ${err}`);
  }
  if (result.newFindings.length > 0) {
    console.error("i18n literal check: NEW findings (not in baseline):");
    for (const f of result.newFindings) {
      console.error(`  + ${f.path} ${f.rule} ${JSON.stringify(f.source)} x${f.count}`);
    }
  }
  if (result.staleBaseline.length > 0) {
    console.error("i18n literal check: STALE baseline entries (no longer present):");
    for (const f of result.staleBaseline) {
      console.error(`  - ${f.path} ${f.rule} ${JSON.stringify(f.source)} x${f.count}`);
    }
  }
  if (!result.ok) {
    console.error(
      `\nBaseline ratchet failed. Remove fixed entries or migrate new literals; do not broaden exemptions.`,
    );
    process.exit(result.exitCode);
  }

  console.log(
    `✓ i18n literal check: ${current.length} finding keys match baseline`,
  );
  process.exit(0);
}

{
  const invocation = resolveDirectCliInvocation(process.argv[1]);
  if (invocation.kind === "error") {
    // Fail closed: never silently skip main with exit 0 when paths won't resolve.
    console.error(`failed to resolve CLI invocation paths: ${invocation.message}`);
    process.exit(2);
  } else if (invocation.kind === "direct") {
    main();
  }
}
