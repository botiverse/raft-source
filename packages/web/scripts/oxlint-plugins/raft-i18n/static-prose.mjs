/**
 * Walk static string-ish expression trees without parsing source text.
 * Handles literal / template / conditional / logical / static concat (+)
 * and TypeScript expression wrappers (as/satisfies/!/assertion/chain).
 */

import { templateLiteralResidue } from "../../i18n-literal-heuristics.mjs";

/** ESTree / TS-ESTree wrappers that still carry a single inner expression. */
const EXPRESSION_WRAPPERS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "TSNonNullExpression",
  "ChainExpression",
  "TSInstantiationExpression",
]);

/**
 * Peel TS/JS expression wrappers until a concrete expression remains.
 * Does not parse source text — only follows `.expression` edges.
 */
export function unwrapExpression(node) {
  let cur = node;
  while (cur && EXPRESSION_WRAPPERS.has(cur.type)) {
    cur = cur.expression;
  }
  return cur;
}

/** @deprecated Use unwrapExpression — kept as alias for call sites. */
export function unwrapParens(node) {
  return unwrapExpression(node);
}

/**
 * Collect Literal / TemplateLiteral nodes under a static expression tree.
 * Does not descend into CallExpression / NewExpression / ObjectExpression.
 */
export function collectStaticStringNodes(node, out = []) {
  const cur = unwrapExpression(node);
  if (!cur) return out;

  switch (cur.type) {
    case "Literal":
      if (typeof cur.value === "string") out.push(cur);
      break;
    case "TemplateLiteral":
      out.push(cur);
      break;
    case "ConditionalExpression":
      collectStaticStringNodes(cur.consequent, out);
      collectStaticStringNodes(cur.alternate, out);
      break;
    case "LogicalExpression":
      collectStaticStringNodes(cur.left, out);
      collectStaticStringNodes(cur.right, out);
      break;
    case "BinaryExpression":
      if (cur.operator === "+") {
        collectStaticStringNodes(cur.left, out);
        collectStaticStringNodes(cur.right, out);
      }
      break;
    default:
      break;
  }
  return out;
}

export function stringNodeText(node) {
  if (!node) return "";
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") return templateLiteralResidue(node);
  return "";
}

const NESTED_FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ClassDeclaration",
  "ClassExpression",
]);

const SKIP_WALK_KEYS = new Set([
  "parent",
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "superTypeParameters",
  "implements",
  "decorators",
]);

/**
 * Collect Identifier names used as *values* under `node`.
 * Skips nested function/class bodies, non-computed object keys, and non-computed
 * member properties. Shorthand `{ message }`, computed `{[message]: x}` /
 * `obj[message]`, and direct `return message` still count.
 * Generic ESTree walk — no source-text regex.
 */
export function collectReferencedIdentifierNames(node, out = new Set(), seen = new WeakSet()) {
  if (!node || typeof node !== "object") return out;
  if (seen.has(node)) return out;
  seen.add(node);

  if (typeof node.type === "string" && NESTED_FUNCTION_TYPES.has(node.type)) {
    // Nested function/class: do not walk its body for outer-scope reference analysis.
    return out;
  }

  if (node.type === "Identifier") {
    out.add(node.name);
    return out;
  }

  // Object property: non-computed key is a name, not a value reference.
  // Shorthand `{ message }` and computed `{[message]: x}` still count the key.
  if (node.type === "Property" || node.type === "PropertyDefinition") {
    if (node.computed || node.shorthand) {
      collectReferencedIdentifierNames(node.key, out, seen);
    }
    collectReferencedIdentifierNames(node.value, out, seen);
    return out;
  }

  // Member access: `obj.label` property is not a value ref; `obj[message]` is.
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    collectReferencedIdentifierNames(node.object, out, seen);
    if (node.computed) {
      collectReferencedIdentifierNames(node.property, out, seen);
    }
    return out;
  }

  for (const [key, value] of Object.entries(node)) {
    if (SKIP_WALK_KEYS.has(key)) continue;
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && typeof item.type === "string") {
          collectReferencedIdentifierNames(item, out, seen);
        }
      }
    } else if (typeof value.type === "string") {
      collectReferencedIdentifierNames(value, out, seen);
    }
  }
  return out;
}
