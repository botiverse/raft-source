/**
 * Flag display-prose string/template returns (incl. concise arrow bodies) and
 * local static producers (conditional / logical / concat / template / literal)
 * that flow into a same-function return in .ts modules.
 * Skips .tsx / .d.ts, prose allowlist paths, and object properties (FormatJS).
 */

import {
  isProseAllowlisted,
  looksLikeDisplayProse,
} from "../../i18n-literal-heuristics.mjs";
import {
  collectReferencedIdentifierNames,
  collectStaticStringNodes,
  stringNodeText,
  unwrapExpression,
} from "./static-prose.mjs";

function normalizeFilename(filename) {
  return String(filename ?? "").split("\\").join("/");
}

function isTsProseTarget(filename) {
  const f = normalizeFilename(filename);
  // .tsx does not end with ".ts"; .d.ts does, so exclude declarations explicitly.
  if (!f.endsWith(".ts") || f.endsWith(".d.ts")) return false;
  if (isProseAllowlisted(f)) return false;
  return true;
}

function reportProseNodes(context, expr) {
  for (const strNode of collectStaticStringNodes(expr)) {
    const text = stringNodeText(strNode);
    if (!looksLikeDisplayProse(text)) continue;
    context.report({
      node: strNode,
      messageId: "literalReturnProse",
    });
  }
}

function pushScope(stack) {
  stack.push({
    /** @type {Array<{ name: string, init: object }>} */
    localProseDeclarators: [],
    /** @type {object[]} */
    returnArgs: [],
  });
}

function popScopeAndReport(context, stack) {
  const scope = stack.pop();
  if (!scope) return;

  const referenced = new Set();
  for (const arg of scope.returnArgs) {
    collectReferencedIdentifierNames(arg, referenced);
  }

  for (const decl of scope.localProseDeclarators) {
    if (!referenced.has(decl.name)) continue;
    reportProseNodes(context, decl.init);
  }
}

/** Inits that collectStaticStringNodes can walk for local return-flow producers. */
function isLocalStaticProseProducerInit(init) {
  const cur = unwrapExpression(init);
  if (!cur) return false;
  switch (cur.type) {
    case "ConditionalExpression":
    case "LogicalExpression":
    case "Literal":
    case "TemplateLiteral":
      return true;
    case "BinaryExpression":
      return cur.operator === "+";
    default:
      return false;
  }
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hardcoded display prose in .ts returns (incl. concise arrows) and local static producers that flow into a return (not object props)",
    },
    schema: [],
    messages: {
      literalReturnProse:
        "Hardcoded display prose in a .ts return (or local static producer returned nearby); use formatMessage / catalog.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? "";
    if (!isTsProseTarget(filename)) return {};

    /** Nearest-function scopes; nested functions get their own frame. */
    const stack = [];
    pushScope(stack); // module / program scope

    const exitFunction = () => popScopeAndReport(context, stack);

    /** Treat concise arrow expression bodies as implicit returns. */
    function enterArrowFunction(node) {
      pushScope(stack);
      if (!node.body || node.body.type === "BlockStatement") return;
      reportProseNodes(context, node.body);
      const scope = stack[stack.length - 1];
      if (scope) scope.returnArgs.push(node.body);
    }

    return {
      Program() {
        // Program scope already pushed; keep for module-level returns/declarators.
      },
      "Program:exit"() {
        popScopeAndReport(context, stack);
      },

      FunctionDeclaration() {
        pushScope(stack);
      },
      "FunctionDeclaration:exit": exitFunction,
      FunctionExpression() {
        pushScope(stack);
      },
      "FunctionExpression:exit": exitFunction,
      ArrowFunctionExpression: enterArrowFunction,
      "ArrowFunctionExpression:exit": exitFunction,

      ReturnStatement(node) {
        if (!node.argument) return;
        reportProseNodes(context, node.argument);
        const scope = stack[stack.length - 1];
        if (scope) scope.returnArgs.push(node.argument);
      },

      VariableDeclarator(node) {
        if (!node.id || node.id.type !== "Identifier" || !node.init) return;
        if (!isLocalStaticProseProducerInit(node.init)) return;
        const scope = stack[stack.length - 1];
        if (!scope) return;
        scope.localProseDeclarators.push({
          name: node.id.name,
          init: node.init,
        });
      },
    };
  },
};
export default rule;
