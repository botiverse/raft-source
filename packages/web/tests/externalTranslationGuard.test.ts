import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import "./helpers/domSetup";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import type { ComponentType, ReactNode } from "react";
import MarkdownContent, { BASE_MARKDOWN_COMPONENTS } from "../src/components/markdown/MarkdownContent";
import {
  installExternalTranslationGuard,
  withExternalTranslationGuardClass,
} from "../src/utils/externalTranslationGuard";

test.afterEach(cleanup);

function hasNotranslateMarker(element: Element | null): boolean {
  return element?.getAttribute("translate") === "no"
    && element.classList.contains("notranslate");
}

function assertGuardedClass(element: Element | null, expectedClasses: string[]): void {
  assert.ok(element, `Expected ${expectedClasses.join(" ")} element to render`);
  assert.equal(hasNotranslateMarker(element), true);
  for (const className of expectedClasses) {
    assert.equal(
      element.classList.contains(className),
      true,
      `Expected ${element.tagName.toLowerCase()} to keep ${className}`,
    );
  }
}

function simulateExternalTranslator(root: Element): number {
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest('[translate="no"], .notranslate')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  while (walker.nextNode()) {
    textNodes.push(walker.currentNode as Text);
  }

  for (const text of textNodes) {
    const replacement = document.createElement("font");
    replacement.textContent = text.textContent;
    text.parentNode?.replaceChild(replacement, text);
  }

  return textNodes.length;
}

test("html shell opts the React-owned document out of external translators before boot", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /<html[^>]*\btranslate="no"[^>]*\bclass="notranslate"/);
  assert.match(html, /<meta\s+name="google"\s+content="notranslate"\s*\/>/);
  assert.match(html, /<body[^>]*\btranslate="no"[^>]*\bclass="notranslate"/);
  assert.match(html, /<div\s+id="root"[^>]*\btranslate="no"[^>]*\bclass="notranslate"/);
});

test("runtime guard is idempotent and repairs test/HMR shells", () => {
  const doc = document.implementation.createHTMLDocument("Raft");
  const root = doc.createElement("div");
  root.id = "root";
  doc.body.appendChild(root);

  installExternalTranslationGuard(doc);
  installExternalTranslationGuard(doc);

  assert.equal(doc.head.querySelectorAll('meta[name="google"]').length, 1);
  assert.equal(doc.head.querySelector('meta[name="google"]')?.getAttribute("content"), "notranslate");
  assert.equal(hasNotranslateMarker(doc.documentElement), true);
  assert.equal(hasNotranslateMarker(doc.body), true);
  assert.equal(hasNotranslateMarker(root), true);
});

test("runtime guard creates the google notranslate meta with the exact contract", () => {
  const doc = document.implementation.createHTMLDocument("Raft");

  installExternalTranslationGuard(doc);

  assert.equal(
    doc.head.querySelector('meta[name="google"]')?.outerHTML,
    '<meta name="google" content="notranslate">',
  );
});

test("runtime guard corrects a stale google translate meta tag", () => {
  const doc = document.implementation.createHTMLDocument("Raft");
  const meta = doc.createElement("meta");
  meta.setAttribute("name", "google");
  meta.setAttribute("content", "translate");
  doc.head.append(meta);

  installExternalTranslationGuard(doc);

  assert.equal(doc.head.querySelectorAll('meta[name="google"]').length, 1);
  assert.equal(meta.getAttribute("content"), "notranslate");
});

test("runtime guard tolerates missing document and class helper keeps exact spacing", () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: undefined,
  });
  try {
    assert.doesNotThrow(() => installExternalTranslationGuard());
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, "document", originalDocument);
    }
  }
  assert.equal(withExternalTranslationGuardClass(), "notranslate");
  assert.equal(withExternalTranslationGuardClass("rounded border"), "rounded border notranslate");
});

test("markdown component class merging preserves upstream class boundaries", () => {
  const Ul = BASE_MARKDOWN_COMPONENTS.ul as ComponentType<{
    className?: string;
    children?: ReactNode;
  }>;
  const { container } = render(createElement(
    Ul,
    { className: "incoming", children: createElement("li", null, "item") },
  ));

  assert.equal(container.querySelector("ul")?.className, "incoming mb-1 pl-5 list-disc notranslate");
});

test("markdown compact density guards every text container without dropping chrome classes", () => {
  const { container } = render(createElement(MarkdownContent, {
    source: [
      "# One",
      "## Two",
      "### Three",
      "#### Four",
      "##### Five",
      "###### Six",
      "",
      "plain [link](https://raft.build)",
      "",
      "> quote",
      "",
      "- bullet",
      "",
      "2. ordered",
      "",
      "| Head |",
      "| --- |",
      "| Cell |",
    ].join("\n"),
  }));

  assertGuardedClass(container.querySelector("p"), ["mb-1"]);
  assertGuardedClass(container.querySelector("a"), ["text-blue-700", "select-text"]);
  assertGuardedClass(container.querySelector("blockquote"), ["border-l-2", "my-1"]);
  assertGuardedClass(container.querySelector("ul"), ["mb-1", "pl-5", "list-disc"]);
  assertGuardedClass(container.querySelector("ol"), ["mb-1", "pl-5", "list-decimal"]);
  for (const listItem of container.querySelectorAll("li")) {
    assertGuardedClass(listItem, ["mb-0.5"]);
  }
  assertGuardedClass(container.querySelector("div > table")?.parentElement ?? null, ["my-2", "overflow-x-auto"]);
  assertGuardedClass(container.querySelector("th"), ["border-2", "bg-brutal-cyan", "whitespace-nowrap"]);
  assertGuardedClass(container.querySelector("td"), ["border", "px-2"]);
  assertGuardedClass(container.querySelector("h1"), ["text-[1.286em]", "mt-3"]);
  assertGuardedClass(container.querySelector("h2"), ["text-[1.143em]", "mt-2"]);
  assertGuardedClass(container.querySelector("h3"), ["text-[1.071em]", "mt-2"]);
  assertGuardedClass(container.querySelector("h4"), ["text-[1em]", "mt-1"]);
  assertGuardedClass(container.querySelector("h5"), ["text-[1em]", "mt-1"]);
  assertGuardedClass(container.querySelector("h6"), ["text-[1em]", "text-black/70"]);
});

test("markdown document density guards reader-scale overrides", () => {
  const { container } = render(createElement(MarkdownContent, {
    density: "document",
    source: [
      "# One",
      "## Two",
      "### Three",
      "",
      "paragraph",
      "",
      "- bullet",
      "",
      "2. ordered",
    ].join("\n"),
  }));

  assertGuardedClass(container.querySelector("p"), ["mb-3"]);
  assertGuardedClass(container.querySelector("ul"), ["mb-3", "pl-6", "list-disc"]);
  assertGuardedClass(container.querySelector("ol"), ["mb-3", "pl-6", "list-decimal"]);
  for (const listItem of container.querySelectorAll("li")) {
    assertGuardedClass(listItem, ["mb-1"]);
  }
  assertGuardedClass(container.querySelector("h1"), ["text-3xl", "mt-6"]);
  assertGuardedClass(container.querySelector("h2"), ["text-2xl", "mt-5"]);
  assertGuardedClass(container.querySelector("h3"), ["text-xl", "mt-4"]);
});

test("markdown text containers block extension-style text node replacement before rerender", () => {
  const { container, rerender } = render(
    createElement(MarkdownContent, { source: "## Release note\n\n[https](https://raft.build) tail" }),
  );

  assert.equal(hasNotranslateMarker(container.querySelector("h2")), true);
  assert.equal(hasNotranslateMarker(container.querySelector("p")), true);
  assert.equal(hasNotranslateMarker(container.querySelector("a")), true);
  assert.equal(simulateExternalTranslator(container), 0);

  assert.doesNotThrow(() => {
    rerender(createElement(MarkdownContent, { source: "## Release note\n\n[https](https://raft.build)" }));
  });
});
