/**
 * Never hand a DOM node to a node:assert comparison.
 *
 * Why: when `assert.equal(screen.queryByText("x"), null)` FAILS, node:assert
 * builds its error message by inspecting the jsdom node (depth 1000, getters,
 * the React fiber graph hanging off it) into tens of thousands of lines and then
 * runs a quadratic Myers diff over them, off the V8 heap. Inside `waitFor` that
 * repeats on every retry. Heap caps (--max-old-space-size) do not bound it: a
 * web test worker reached 15.7 GiB on 2026-10-21 and 13.7 GB in 17 s on
 * 2026-10-22. The boolean form fails readably and costs nothing:
 * `assert.ok(x === null, "...")`.
 *
 * Flags assert.equal / strictEqual / deepEqual / deepStrictEqual / notEqual /
 * notStrictEqual / notDeepEqual / notDeepStrictEqual (on an `assert` imported
 * from node:assert or node:assert/strict) when either compared argument is a
 * statically recognisable DOM node:
 * - a query call: Testing Library `getBy* / getAllBy* / queryBy* / queryAllBy* /
 *   findBy* / findAllBy*` (awaited or not), `querySelector(All)`, `closest`,
 *   `getElementById`, `getElementsBy*`, `elementFromPoint`;
 * - a node property: `activeElement`, `parentElement`, `parentNode`,
 *   `first/lastChild`, `first/lastElementChild`, `next/previous(Element)Sibling`,
 *   `offsetParent`, and `document.body / head / documentElement`;
 * - a local variable assigned one of those (incl. `const [a] = getAllBy…()` and
 *   `const { container } = render(…)`), or a call to a local function whose
 *   returned expression is one of those.
 *
 * Out of scope (no type information): nodes reached through anything else,
 * e.g. a function parameter. Review still has to catch those.
 *
 * Autofix: `assert.equal(a, b, msg)` → `assert.ok(a === b, msg)` (`!==` for the
 * `not*` forms). Deep forms are only fixed when the other side is
 * `null`/`undefined`, where identity and deep equality agree.
 */

const ASSERT_MODULES = new Set(["node:assert", "assert", "node:assert/strict", "assert/strict"]);

/** method → [operator, isDeep] */
const COMPARE_METHODS = new Map([
  ["equal", ["===", false]],
  ["strictEqual", ["===", false]],
  ["deepEqual", ["===", true]],
  ["deepStrictEqual", ["===", true]],
  ["notEqual", ["!==", false]],
  ["notStrictEqual", ["!==", false]],
  ["notDeepEqual", ["!==", true]],
  ["notDeepStrictEqual", ["!==", true]],
]);

const TESTING_LIBRARY_QUERY =
  /^(?:get|query|find)(?:All)?By(?:Role|Text|LabelText|PlaceholderText|DisplayValue|AltText|Title|TestId)$/;
const DOM_QUERY_METHODS = new Set([
  "querySelector",
  "querySelectorAll",
  "closest",
  "getElementById",
  "getElementsByClassName",
  "getElementsByTagName",
  "getElementsByName",
  "elementFromPoint",
  "elementsFromPoint",
]);
const NODE_PROPERTIES = new Set([
  "activeElement",
  "parentElement",
  "parentNode",
  "firstChild",
  "lastChild",
  "firstElementChild",
  "lastElementChild",
  "nextSibling",
  "previousSibling",
  "nextElementSibling",
  "previousElementSibling",
  "offsetParent",
]);
const DOCUMENT_PROPERTIES = new Set(["body", "head", "documentElement"]);
/** Keys of a Testing Library `render()` result that are DOM nodes. */
const RENDER_RESULT_NODES = new Set(["container", "baseElement"]);

const WRAPPERS = new Set([
  "ChainExpression",
  "TSNonNullExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "AwaitExpression",
  "ParenthesizedExpression",
]);

function unwrap(node) {
  let cur = node;
  while (cur && WRAPPERS.has(cur.type)) cur = cur.expression ?? cur.argument;
  return cur;
}

function propertyName(member) {
  if (!member || member.type !== "MemberExpression") return null;
  if (!member.computed && member.property?.type === "Identifier") return member.property.name;
  if (member.computed && member.property?.type === "Literal" && typeof member.property.value === "string") {
    return member.property.value;
  }
  return null;
}

function isDocumentObject(node) {
  const cur = unwrap(node);
  if (cur?.type === "Identifier") return cur.name === "document" || cur.name === "ownerDocument";
  const name = propertyName(cur);
  return name === "document" || name === "ownerDocument";
}

function isNullish(node) {
  const cur = unwrap(node);
  if (!cur) return false;
  if (cur.type === "Literal" && cur.value === null && !cur.regex && !cur.bigint) return true;
  return cur.type === "Identifier" && cur.name === "undefined";
}

function findVariable(context, identifier) {
  let scope = context.sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set?.get(identifier.name);
    if (variable) return variable;
    scope = scope.upper;
  }
  return null;
}

/** The expression a function hands back: concise arrow body, or a lone `return x;`. */
function returnedExpression(fn) {
  if (!fn) return null;
  if (fn.type === "ArrowFunctionExpression" && fn.body?.type !== "BlockStatement") return fn.body;
  const body = fn.body?.type === "BlockStatement" ? fn.body.body : null;
  if (body?.length === 1 && body[0].type === "ReturnStatement") return body[0].argument;
  return null;
}

/**
 * @param depth guards against cycles through variables and helpers
 *   (`let a = b; let b = a;`).
 */
function isDomNodeExpression(context, node, depth = 0) {
  const cur = unwrap(node);
  if (!cur || depth > 3) return false;

  if (cur.type === "CallExpression") {
    const callee = unwrap(cur.callee);
    const name = callee?.type === "Identifier" ? callee.name : propertyName(callee);
    if (name && (TESTING_LIBRARY_QUERY.test(name) || DOM_QUERY_METHODS.has(name))) return true;
    if (callee?.type === "Identifier") {
      const variable = findVariable(context, callee);
      for (const def of variable?.defs ?? []) {
        const fn =
          def.node?.type === "FunctionDeclaration" ? def.node : def.node?.type === "VariableDeclarator" ? def.node.init : null;
        const returned = returnedExpression(unwrap(fn));
        if (returned && isDomNodeExpression(context, returned, depth + 1)) return true;
      }
    }
    return false;
  }

  if (cur.type === "MemberExpression") {
    const name = propertyName(cur);
    if (name && NODE_PROPERTIES.has(name)) return true;
    if (name && DOCUMENT_PROPERTIES.has(name) && isDocumentObject(cur.object)) return true;
    // `getAllByRole("row")[0]`, `el.children[0]`
    if (cur.computed && (isDomNodeExpression(context, cur.object, depth + 1) || isChildrenCollection(cur.object))) {
      return true;
    }
    return false;
  }

  if (cur.type === "Identifier") {
    const variable = findVariable(context, cur);
    if (!variable) return false;
    for (const def of variable.defs ?? []) {
      const decl = def.node;
      if (decl?.type !== "VariableDeclarator" || !decl.init) continue;
      if (decl.id?.type === "ArrayPattern" && isDomNodeExpression(context, decl.init, depth + 1)) return true;
      if (decl.id?.type === "ObjectPattern" && isRenderResultNode(decl.id, cur.name)) return true;
    }
    for (const reference of variable.references ?? []) {
      if (!reference.isWrite?.() || !reference.writeExpr) continue;
      if (reference.writeExpr === cur) continue;
      if (isDomNodeExpression(context, reference.writeExpr, depth + 1)) return true;
    }
    return false;
  }

  return false;
}

function isChildrenCollection(node) {
  const name = propertyName(unwrap(node));
  return name === "children" || name === "childNodes";
}

/** `const { container } = render(...)` — Testing Library hands back DOM nodes. */
function isRenderResultNode(pattern, localName) {
  for (const prop of pattern.properties ?? []) {
    if (prop.type !== "Property") continue;
    const key = prop.key?.type === "Identifier" ? prop.key.name : null;
    const value = prop.value?.type === "AssignmentPattern" ? prop.value.left : prop.value;
    if (key && RENDER_RESULT_NODES.has(key) && value?.type === "Identifier" && value.name === localName) {
      return true;
    }
  }
  return false;
}

/** Operands that need parentheses next to `===`. */
const LOOSE_OPERANDS = new Set([
  "ConditionalExpression",
  "LogicalExpression",
  "BinaryExpression",
  "AssignmentExpression",
  "SequenceExpression",
  "ArrowFunctionExpression",
  "YieldExpression",
]);

function operandText(sourceCode, node) {
  const text = sourceCode.getText(node);
  return LOOSE_OPERANDS.has(node.type) ? `(${text})` : text;
}

const rule = {
  meta: {
    type: "problem",
    fixable: "code",
    docs: {
      description:
        "Disallow DOM nodes as arguments of node:assert equal/deepEqual-style comparisons; use assert.ok(a === b)",
    },
    schema: [],
    messages: {
      domNodeInAssert:
        "Do not hand a DOM node to assert.{{method}}: if it fails, node:assert inspects the jsdom node " +
        "(React fiber tree, getters) into tens of thousands of lines and runs a quadratic diff off the V8 heap; " +
        "heap caps do not bound it (a test worker reached 15.7 GiB). " +
        'Use assert.ok(x {{operator}} null, "...") / assert.ok(a {{operator}} b, "...") instead.',
    },
  },
  create(context) {
    /** Local names bound to the node:assert module object (`assert`, `{ strict as assert }`). */
    const assertObjects = new Set();
    /** Local names of directly imported compare functions → method name. */
    const assertFunctions = new Map();

    function compareMethodOf(callee) {
      const cur = unwrap(callee);
      if (cur?.type === "Identifier") return assertFunctions.get(cur.name) ?? null;
      if (cur?.type !== "MemberExpression") return null;
      const method = propertyName(cur);
      if (!method || !COMPARE_METHODS.has(method)) return null;
      const object = unwrap(cur.object);
      if (object?.type === "Identifier" && assertObjects.has(object.name)) return method;
      // assert.strict.equal(...)
      if (
        object?.type === "MemberExpression" &&
        propertyName(object) === "strict" &&
        unwrap(object.object)?.type === "Identifier" &&
        assertObjects.has(unwrap(object.object).name)
      ) {
        return method;
      }
      return null;
    }

    return {
      ImportDeclaration(node) {
        if (!ASSERT_MODULES.has(node.source?.value)) return;
        for (const spec of node.specifiers ?? []) {
          if (spec.type === "ImportDefaultSpecifier" || spec.type === "ImportNamespaceSpecifier") {
            assertObjects.add(spec.local.name);
            continue;
          }
          const imported = spec.imported?.name ?? spec.imported?.value;
          if (imported === "strict" || imported === "default") assertObjects.add(spec.local.name);
          else if (COMPARE_METHODS.has(imported)) assertFunctions.set(spec.local.name, imported);
        }
      },

      CallExpression(node) {
        if (assertObjects.size === 0 && assertFunctions.size === 0) return;
        const method = compareMethodOf(node.callee);
        if (!method) return;
        const [actual, expected] = node.arguments ?? [];
        if (!actual || !expected) return;
        if (actual.type === "SpreadElement" || expected.type === "SpreadElement") return;
        if (!isDomNodeExpression(context, actual) && !isDomNodeExpression(context, expected)) return;

        const [operator, isDeep] = COMPARE_METHODS.get(method);
        const sourceCode = context.sourceCode;
        const callee = unwrap(node.callee);
        // A comment between the two arguments would be dropped by the rewrite.
        const between = sourceCode.text.slice(actual.range[1], expected.range[0]);
        const canFix =
          callee.type === "MemberExpression" &&
          !callee.computed &&
          !/\/[/*]/.test(between) &&
          (!isDeep || isNullish(actual) || isNullish(expected));

        context.report({
          node,
          messageId: "domNodeInAssert",
          data: { method, operator },
          fix: canFix
            ? (fixer) => [
                fixer.replaceText(callee.property, "ok"),
                fixer.replaceTextRange(
                  [actual.range[0], expected.range[1]],
                  `${operandText(sourceCode, actual)} ${operator} ${operandText(sourceCode, expected)}`,
                ),
              ]
            : null,
        });
      },
    };
  },
};

export default rule;
