/**
 * Parse packages/web en.ts MessageId keys (TypeScript AST) and filter FormatJS
 * object-literal findings that are exact catalog members.
 *
 * Fail closed: missing `export const en`, non-object initializer, or unsupported
 * property/key shapes throw. No regex / dotted-string guessing for membership.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_EN_CATALOG_PATH = resolve(
  SCRIPT_DIR,
  "../src/i18n/messages/en.ts",
);

const OBJECT_LITERAL_RULE = "formatjs/no-literal-string-in-object";

/** @type {ReadonlySet<string> | null} */
let cachedDefaultCatalogIds = null;

/**
 * Unwrap `as const` / satisfies / parentheses around the en initializer.
 * @param {ts.Expression} expr
 * @returns {ts.Expression}
 */
function unwrapEnInitializer(expr) {
  let current = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * @param {ts.ObjectLiteralElementLike} prop
 * @returns {string}
 */
function catalogKeyFromProperty(prop) {
  if (ts.isSpreadAssignment(prop)) {
    throw new Error("unsupported en catalog property: spread assignment");
  }
  if (!ts.isPropertyAssignment(prop)) {
    throw new Error(
      `unsupported en catalog property kind: ${ts.SyntaxKind[prop.kind] ?? prop.kind}`,
    );
  }
  const name = prop.name;
  if (ts.isComputedPropertyName(name)) {
    throw new Error("unsupported en catalog key: computed property name");
  }
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isNumericLiteral(name)) {
    throw new Error("unsupported en catalog key: numeric literal");
  }
  throw new Error(
    `unsupported en catalog key kind: ${ts.SyntaxKind[name.kind] ?? name.kind}`,
  );
}

/**
 * Extract MessageId keys from `export const en = { ... } as const` source text.
 * @param {string} sourceText
 * @param {string} [fileName]
 * @returns {Set<string>}
 */
export function loadCatalogMessageIdsFromSource(sourceText, fileName = "en.ts") {
  const sf = ts.createSourceFile(
    fileName,
    String(sourceText ?? ""),
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
    ts.ScriptKind.TS,
  );

  /** @type {ts.Expression | null} */
  let enInitializer = null;
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const isExport = Boolean(
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
    );
    if (!isExport) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === "en" && decl.initializer) {
        enInitializer = decl.initializer;
      }
    }
  }
  if (!enInitializer) {
    throw new Error(`missing export const en in ${fileName}`);
  }

  const objectExpr = unwrapEnInitializer(enInitializer);
  if (!ts.isObjectLiteralExpression(objectExpr)) {
    throw new Error(
      `export const en initializer is not an object literal in ${fileName}`,
    );
  }

  const ids = new Set();
  for (const prop of objectExpr.properties) {
    ids.add(catalogKeyFromProperty(prop));
  }
  return ids;
}

/**
 * @param {string} catalogPath
 * @returns {Set<string>}
 */
export function loadCatalogMessageIdsFromPath(catalogPath) {
  const path = resolve(catalogPath);
  let sourceText;
  try {
    sourceText = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`failed to read en catalog at ${path}: ${error.message}`, {
      cause: error,
    });
  }
  return loadCatalogMessageIdsFromSource(sourceText, path);
}

/**
 * Default catalog = packages/web real en.ts (cached).
 * @returns {ReadonlySet<string>}
 */
export function loadDefaultCatalogMessageIds() {
  if (cachedDefaultCatalogIds) return cachedDefaultCatalogIds;
  cachedDefaultCatalogIds = loadCatalogMessageIdsFromPath(DEFAULT_EN_CATALOG_PATH);
  return cachedDefaultCatalogIds;
}

/** @visibleForTesting */
export function clearDefaultCatalogMessageIdsCache() {
  cachedDefaultCatalogIds = null;
}

/**
 * Plain quoted finding source only (`"id"` / `'id'`). Rejects attr=, templates,
 * bare text, and escapes (MessageIds never need escapes).
 * @param {string} source
 * @returns {string | null}
 */
export function plainQuotedLiteralText(source) {
  const s = String(source ?? "");
  if (s.length < 2) return null;
  // Attr form `title="..."` is not a plain object-literal string finding.
  if (/^[A-Za-z_:$][\w:$.-]*=/.test(s)) return null;
  const q = s[0];
  if (q !== '"' && q !== "'") return null;
  if (!s.endsWith(q)) return null;
  const inner = s.slice(1, -1);
  if (inner.includes("\\") || inner.includes(q)) return null;
  return inner;
}

/**
 * True only for formatjs object-literal + plain quoted + exact catalog member.
 * @param {{ rule?: string, source?: string }} finding
 * @param {ReadonlySet<string>} catalogMessageIds
 */
export function isCatalogMessageIdObjectLiteralFinding(finding, catalogMessageIds) {
  if (finding?.rule !== OBJECT_LITERAL_RULE) return false;
  const text = plainQuotedLiteralText(finding.source);
  if (text === null) return false;
  return catalogMessageIds.has(text);
}

/**
 * @template {{ rule?: string, source?: string }} T
 * @param {T[]} rawFindings
 * @param {ReadonlySet<string>} catalogMessageIds
 * @returns {T[]}
 */
export function filterCatalogMessageIdFindings(rawFindings, catalogMessageIds) {
  return rawFindings.filter(
    (finding) => !isCatalogMessageIdObjectLiteralFinding(finding, catalogMessageIds),
  );
}
