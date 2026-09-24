import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";

import MarkdownContent, {
  BASE_MARKDOWN_COMPONENTS,
  getMarkdownComponents,
} from "../src/components/markdown/MarkdownContent";
import { MarkdownPreviewPane } from "../src/components/message/attachmentPreviewSurfaces";
import { TestIntlProvider } from "./helpers/intl";

afterEach(cleanup);

const source = [
  "# Shared heading",
  "",
  "Paragraph with `untrusted_reason=cold_start|reconnect_gap`.",
  "",
  "- list item",
  "",
  "> quoted",
  "",
  "[Raft](https://raft.build)",
].join("\n");

test("markdown component maps are stable and document density inherits every shared block primitive", () => {
  const compact = getMarkdownComponents("compact");
  const document = getMarkdownComponents("document");

  assert.equal(getMarkdownComponents("compact"), compact, "compact map stays referentially stable");
  assert.equal(getMarkdownComponents("document"), document, "document map stays referentially stable");
  assert.notEqual(document, compact, "document density owns its deliberate rhythm overrides");

  for (const tag of ["pre", "code", "p", "ul", "ol", "li", "blockquote", "table", "th", "td", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "a"] as const) {
    assert.ok(BASE_MARKDOWN_COMPONENTS[tag], `shared markdown map is missing ${tag}`);
    assert.ok(document[tag], `document markdown map is missing inherited ${tag}`);
  }
  assert.equal(document.code, compact.code, "document density inherits the shared inline-code renderer");
  assert.equal(document.pre, compact.pre, "document density inherits the shared fenced-code renderer");
});

test("mounted compact and document MarkdownContent share tokens while keeping their density rhythm", () => {
  const compact = render(createElement(MarkdownContent, { source, density: "compact" }));
  const compactHeading = compact.getByRole("heading", { name: "Shared heading" });
  const compactCode = compact.container.querySelector("code");
  const compactParagraph = compact.container.querySelector("p");
  assert.ok(compactCode);
  assert.ok(compactParagraph);
  assert.match(compactHeading.className, /text-\[1\.286em\]/);
  assert.match(compactParagraph.className, /mb-1/);
  const sharedInlineCodeClass = compactCode.className;
  compact.unmount();

  const document = render(createElement(MarkdownContent, { source, density: "document" }));
  const documentHeading = document.getByRole("heading", { name: "Shared heading" });
  const documentCode = document.container.querySelector("code");
  const documentParagraph = document.container.querySelector("p");
  assert.ok(documentCode);
  assert.ok(documentParagraph);
  assert.match(documentHeading.className, /text-3xl/);
  assert.match(documentParagraph.className, /mb-3/);
  assert.equal(documentCode.className, sharedInlineCodeClass);
  assert.match(documentCode.className, /border-0/);
  assert.match(documentCode.className, /bg-black\/\[0\.05\]/);
  assert.match(documentCode.className, /\[overflow-wrap:break-word\]/);
  assert.doesNotMatch(documentCode.className, /\[overflow-wrap:anywhere\]/);
  assert.ok(document.getByRole("link", { name: "Raft" }));
});

test("real markdown attachment preview delegates its document body to MarkdownContent", () => {
  const { container } = render(createElement(
    TestIntlProvider,
    null,
    createElement(MarkdownPreviewPane, { markdown: source, truncated: false }),
  ));

  const shell = container.querySelector<HTMLElement>("[data-anchor-md-root]");
  const sharedBody = container.querySelector<HTMLElement>("[data-raft-markdown-content]");
  const heading = screen.getByRole("heading", { name: "Shared heading" });
  const code = container.querySelector("code");
  const paragraph = container.querySelector("p");
  assert.ok(shell);
  assert.ok(sharedBody, "preview must mount the shared MarkdownContent body");
  assert.match(shell.className, /card-brutal/);
  assert.match(shell.className, /font-display/);
  assert.match(heading.className, /text-3xl/);
  assert.ok(paragraph);
  assert.match(paragraph.className, /mb-3/);
  assert.ok(code);
  assert.match(code.className, /bg-black\/\[0\.05\]/);
  assert.equal(container.querySelector("[data-testid='markdown-preview-truncated']"), null);
});
