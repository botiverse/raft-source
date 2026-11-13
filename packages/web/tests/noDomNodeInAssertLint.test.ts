// Fixture snippets for the raft-test/no-dom-node-in-assert lint rule
// (scripts/oxlint-plugins/raft-test). The rule replaces the old regex ratchet
// tests/assertionNullCompareGuard.test.ts; the repo-wide run is a lint step.
import { RuleTester } from "oxlint/plugins-dev";
import rule from "../scripts/oxlint-plugins/raft-test/no-dom-node-in-assert";

RuleTester.describe = describe;
RuleTester.it = it;

const STRICT = 'import assert from "node:assert/strict";\n';
const error = { messageId: "domNodeInAssert" };

new RuleTester({ languageOptions: { sourceType: "module", parserOptions: { lang: "ts" } } }).run(
  "no-dom-node-in-assert",
  rule,
  {
    valid: [
      `${STRICT}assert.ok(screen.queryByText("x") === null, "x is gone");`,
      // Numbers and strings read off a node are fine.
      `${STRICT}assert.equal(screen.queryAllByText("x").length, 0);`,
      `${STRICT}const el = screen.getByRole("button"); assert.equal(el.textContent, "Save");`,
      `${STRICT}assert.equal(document.querySelector("a")?.getAttribute("href"), null);`,
      // Same method names on non-DOM objects.
      `${STRICT}assert.equal(store.getById(1), null);`,
      `${STRICT}assert.equal(response.body, null);`,
      // Only node:assert: chai's assert, vitest's expect and an un-imported name are out of scope.
      'import { assert } from "vitest";\nassert.equal(screen.queryByText("x"), null);',
      'assert.equal(screen.queryByText("x"), null);',
      'import assert from "node:assert/strict";\nexpect(screen.queryByText("x")).toBe(null);',
      // A parameter carries no static hint that it is a node.
      `${STRICT}function check(el: unknown) { assert.equal(el, null); }`,
    ],
    invalid: [
      {
        code: `${STRICT}assert.equal(screen.queryByText("x"), null);`,
        output: `${STRICT}assert.ok(screen.queryByText("x") === null);`,
        errors: [error],
      },
      {
        name: "message argument and multi-line layout survive the fix",
        code: `${STRICT}assert.notEqual(\n  container.querySelector(".dot"),\n  null,\n  "dot shows",\n);`,
        output: `${STRICT}assert.ok(\n  container.querySelector(".dot") !== null,\n  "dot shows",\n);`,
        errors: [error],
      },
      {
        name: "inside waitFor",
        code: `${STRICT}await waitFor(() => assert.equal(within(row).queryByRole("button"), null));`,
        output: `${STRICT}await waitFor(() => assert.ok(within(row).queryByRole("button") === null));`,
        errors: [error],
      },
      {
        name: "node on the right-hand side, element compared with element",
        code: `${STRICT}assert.strictEqual(input, document.activeElement);`,
        output: `${STRICT}assert.ok(input === document.activeElement);`,
        errors: [error],
      },
      {
        name: "strict named import, element property, undefined",
        code: 'import { strict as assert } from "node:assert";\nassert.deepEqual(el.parentElement, undefined);',
        output: 'import { strict as assert } from "node:assert";\nassert.ok(el.parentElement === undefined);',
        errors: [error],
      },
      {
        name: "deep compare of two nodes is reported but not rewritten (=== is stricter)",
        code: `${STRICT}assert.deepEqual(document.activeElement, input);`,
        output: null,
        errors: [error],
      },
      {
        name: "assert.strict.*",
        code: 'import assert from "node:assert";\nassert.strict.equal(document.getElementById("x"), null);',
        output: 'import assert from "node:assert";\nassert.strict.ok(document.getElementById("x") === null);',
        errors: [error],
      },
      {
        name: "directly imported compare function is reported without a fix",
        code: 'import { equal } from "node:assert/strict";\nequal(screen.queryByText("x"), null);',
        output: null,
        errors: [error],
      },
      {
        name: "a comment between the arguments blocks the fix",
        code: `${STRICT}assert.equal(screen.queryByText("x"), /* gone */ null);`,
        output: null,
        errors: [error],
      },
      {
        name: "const holding a query result",
        code: `${STRICT}const row = screen.queryByRole("row");\nassert.equal(row, null);`,
        output: `${STRICT}const row = screen.queryByRole("row");\nassert.ok(row === null);`,
        errors: [error],
      },
      {
        name: "let assigned later (e.g. in a waitFor callback)",
        code: `${STRICT}let dot: Element | null = null;\ndot = document.querySelector(".dot");\nassert.notStrictEqual(dot, null);`,
        output: `${STRICT}let dot: Element | null = null;\ndot = document.querySelector(".dot");\nassert.ok(dot !== null);`,
        errors: [error],
      },
      {
        name: "local helper returning a query",
        code: `${STRICT}const railDot = () => document.querySelector(".dot");\nfunction badge() { return screen.queryByTestId("badge"); }\nassert.equal(railDot(), null);\nassert.equal(badge(), null);`,
        output: `${STRICT}const railDot = () => document.querySelector(".dot");\nfunction badge() { return screen.queryByTestId("badge"); }\nassert.ok(railDot() === null);\nassert.ok(badge() === null);`,
        errors: [error, error],
      },
      {
        name: "destructured getAllBy result and render() container",
        code: `${STRICT}const [first] = screen.getAllByRole("option");\nconst { container } = render(null);\nassert.equal(first, other);\nassert.equal(container.firstChild, null);`,
        output: `${STRICT}const [first] = screen.getAllByRole("option");\nconst { container } = render(null);\nassert.ok(first === other);\nassert.ok(container.firstChild === null);`,
        errors: [error, error],
      },
      {
        name: "awaited findBy, indexed getAllBy, children[n], document.body",
        code: `${STRICT}assert.equal(await screen.findByText("x"), node);\nassert.equal(screen.getAllByRole("row")[0], node);\nassert.equal(list.children[0], node);\nassert.notEqual(document.body, null);`,
        output: `${STRICT}assert.ok(await screen.findByText("x") === node);\nassert.ok(screen.getAllByRole("row")[0] === node);\nassert.ok(list.children[0] === node);\nassert.ok(document.body !== null);`,
        errors: [error, error, error, error],
      },
      {
        name: "loose operands get parentheses",
        code: `${STRICT}assert.equal(document.activeElement, open ? input : button);`,
        output: `${STRICT}assert.ok(document.activeElement === (open ? input : button));`,
        errors: [error],
      },
    ],
  },
);
