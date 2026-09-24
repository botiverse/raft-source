import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { readMermaidSource } from "../src/components/markdown/mermaid/mermaidSource";

const codeEl = (className: string | undefined, children: unknown) =>
  createElement("code", className === undefined ? {} : { className }, children as never);

test("extracts trimmed source from a language-mermaid code node", () => {
  const el = codeEl("language-mermaid", "graph TD\n  A --> B\n");
  assert.equal(readMermaidSource(el), "graph TD\n  A --> B");
});

test("handles array children (react-markdown sometimes splits text)", () => {
  const el = codeEl("language-mermaid", ["graph LR\n", "  A --> B\n"]);
  assert.equal(readMermaidSource(el), "graph LR\n  A --> B");
});

test("matches language-mermaid even with extra classes", () => {
  const el = codeEl("hljs language-mermaid foo", "stateDiagram-v2\n  [*] --> S");
  assert.equal(readMermaidSource(el), "stateDiagram-v2\n  [*] --> S");
});

test("non-mermaid code blocks return null (fall back to normal code block)", () => {
  assert.equal(readMermaidSource(codeEl("language-ts", "const x = 1")), null);
  assert.equal(readMermaidSource(codeEl("language-mermaidish", "nope")), null);
  assert.equal(readMermaidSource(codeEl(undefined, "inline")), null);
});

test("non-element children return null", () => {
  assert.equal(readMermaidSource("just a string"), null);
  assert.equal(readMermaidSource(null), null);
  assert.equal(readMermaidSource(42), null);
});
