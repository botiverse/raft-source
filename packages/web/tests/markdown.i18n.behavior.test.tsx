import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";

import { MarkdownOutlineNav } from "../src/components/markdown/MarkdownOutline";
import { MarkdownPreviewPane } from "../src/components/message/attachmentPreviewSurfaces";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { TestIntlProvider } from "./helpers/intl";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

afterEach(() => {
  cleanup();
});

test("MarkdownOutlineNav renders zh-cn catalog copy", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <MarkdownOutlineNav
        outline={[{ id: "h1", title: "Probe heading", level: 1 }]}
      />
    </TestIntlProvider>,
  );
  assert.ok(screen.getByRole("navigation", { name: zh["markdown.outline.ariaLabel"] }));
  assert.ok(screen.getByText(zh["markdown.outline.title"]));
  assert.doesNotMatch(document.body.textContent ?? "", /\bOutline\b/);
});

test("Markdown preview renders a linked large-screen outline for its real headings", () => {
  const { container } = render(
    <TestIntlProvider>
      <MarkdownPreviewPane
        markdown={["# Release notes", "", "## Install API", "", "### Install API"].join("\n")}
        truncated={false}
      />
    </TestIntlProvider>,
  );

  const navigation = screen.getByRole("navigation", { name: en["markdown.outline.ariaLabel"] });
  const outlineShell = navigation.parentElement;
  assert.ok(outlineShell);
  assert.match(outlineShell.className, /\bhidden\b/);
  assert.match(outlineShell.className, /\bxl:sticky\b/);
  assert.match(outlineShell.className, /\bxl:block\b/);
  assert.match(outlineShell.className, /\bxl:overflow-auto\b/);

  const links = [...navigation.querySelectorAll<HTMLAnchorElement>("a")];
  assert.deepEqual(links.map((link) => link.getAttribute("href")), [
    "#release-notes",
    "#install-api",
    "#install-api-2",
  ]);
  assert.deepEqual(links.map((link) => link.textContent), [
    "Release notes",
    "Install API",
    "Install API",
  ]);
  for (const id of ["release-notes", "install-api", "install-api-2"]) {
    assert.ok(container.querySelector(`#${id}`), `preview heading #${id} is the link target`);
  }
});
