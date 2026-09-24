import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import { cleanup, screen } from "@testing-library/react";
import { normalizeCodeLanguage } from "../src/components/markdown/codeBlockLanguages";
import { extractCodeBlockText } from "../src/components/markdown/CodeBlock";
import MarkdownContent, { extractCodeBlockLanguage } from "../src/components/markdown/MarkdownContent";
import { renderWithIntl } from "./helpers/intl";

afterEach(() => {
  cleanup();
});

test("extractCodeBlockText preserves nested code text for clipboard copy", () => {
  const block = createElement("code", { className: "language-ts" }, [
    "const value = 1;",
    createElement("span", { key: "newline" }, "\n"),
    "console.log(value);",
  ]);

  assert.equal(extractCodeBlockText(block), "const value = 1;\nconsole.log(value);");
});

test("extractCodeBlockLanguage reads fenced language classes from markdown code nodes", () => {
  const block = createElement("code", { className: "language-ts" }, "const value = 1;");

  assert.equal(extractCodeBlockLanguage(block), "ts");
});

test("normalizeCodeLanguage supports common aliases and falls back to plaintext", () => {
  assert.equal(normalizeCodeLanguage("language-tsx"), "tsx");
  assert.equal(normalizeCodeLanguage("shell"), "shellscript");
  assert.equal(normalizeCodeLanguage("java"), "java");
  assert.equal(normalizeCodeLanguage("c++"), "cpp");
  assert.equal(normalizeCodeLanguage("clj"), "clojure");
  assert.equal(normalizeCodeLanguage("cljs"), "clojure");
  assert.equal(normalizeCodeLanguage("cs"), "csharp");
  assert.equal(normalizeCodeLanguage("dart"), "dart");
  assert.equal(normalizeCodeLanguage("kt"), "kotlin");
  assert.equal(normalizeCodeLanguage("kts"), "kotlin");
  assert.equal(normalizeCodeLanguage("pl"), "perl");
  assert.equal(normalizeCodeLanguage("perl5"), "perl");
  assert.equal(normalizeCodeLanguage("rb"), "ruby");
  assert.equal(normalizeCodeLanguage("haskell"), "haskell");
  assert.equal(normalizeCodeLanguage("hs"), "haskell");
  assert.equal(normalizeCodeLanguage("scala"), "scala");
  assert.equal(normalizeCodeLanguage("lua"), "lua");
  assert.equal(normalizeCodeLanguage("elixir"), "elixir");
  assert.equal(normalizeCodeLanguage("exs"), "elixir");
  assert.equal(normalizeCodeLanguage("txt"), "text");
  assert.equal(normalizeCodeLanguage("unknown-product-log"), "text");
  assert.equal(normalizeCodeLanguage(null), "text");
});

test("markdown fenced code blocks keep a reachable Copy code affordance", () => {
  renderWithIntl(
    <MarkdownContent
      source={["```ts", "const value = 1;", "```"].join("\n")}
      density="compact"
    />,
  );

  const copy = screen.getByRole("button", { name: "Copy code" });
  assert.ok(copy);
  assert.match(copy.className, /absolute/);
  assert.match(copy.className, /right-2/);
  assert.match(copy.className, /top-2/);
});
