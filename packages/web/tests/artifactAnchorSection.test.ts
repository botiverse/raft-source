import assert from "node:assert/strict";
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createIntl, IntlProvider } from "react-intl";
import { vi } from "vitest";
import type { ArtifactCommentAnchor } from "@botiverse/raft-shared";

import { en } from "../src/i18n/messages/en";
import { zhCn } from "../src/i18n/messages/zh-cn";

// The section a comment is in (Porthole 0.17.0 P152 `anchor.context`), on a
// thread's anchor line: the section's own heading (the last), before the place,
// the whole chain and the region in its tooltip. Comments without one (older
// ones, lines, rows, a place the page names) read as before.
vi.mock("../src/components/ui/Tooltip", async () => {
  const react = await import("react");
  return {
    default: ({ children, content }: { children: ReactNode; content: ReactNode }) =>
      react.createElement("span", { "data-tooltip": "" }, children, react.createElement("span", { "data-tooltip-content": "" }, content)),
  };
});
const { AnchorMeta, anchorMetaText } = await import("../src/apps/artifacts/ArtifactActorParts");
const { anchorSection } = await import("../src/apps/artifacts/artifactAnchorSection");

const intl = createIntl({ locale: "en", messages: en });
const element = (context?: { headings?: string[]; region?: string }, label = "ins 新增"): ArtifactCommentAnchor => ({
  type: "annotation",
  data: { kind: "element", label, selectors: [{ type: "CssSelector", value: "#p-fulldata > div > ins:nth-of-type(4)" }], ...(context ? { context } : {}) },
});
const draw = (anchor: ArtifactCommentAnchor, found = true, locale: "en" | "zh-CN" = "en") =>
  renderToStaticMarkup(createElement(IntlProvider, { locale, messages: locale === "en" ? en : zhCn }, createElement(AnchorMeta, { anchor, found })));

test("the section: its own heading, else the region; the full chain and the region for the tooltip; none where there is none", () => {
  assert.deepEqual(anchorSection(element({ headings: ["Agent 收件箱现状", "P5 · 读取页"], region: "设计" })), { shown: "P5 · 读取页", full: "Agent 收件箱现状 › P5 · 读取页 · 设计" });
  assert.deepEqual(anchorSection(element({ headings: ["Pricing", "Plans"] })), { shown: "Plans", full: "Pricing › Plans" });
  assert.deepEqual(anchorSection(element({ headings: ["Plans"] })), { shown: "Plans", full: "Plans" });
  assert.deepEqual(anchorSection(element({ region: "Design" })), { shown: "Design", full: "Design" });
  assert.equal(anchorSection(element()), null);
  assert.equal(anchorSection(element({ headings: [], region: " " })), null);
  assert.equal(anchorSection({ type: "lines", data: { start: 1, end: 2 } }), null);
  assert.equal(anchorSection({ type: "page", data: { name: "card-3" } }), null);
});

test("the section's words: nothing visible is no section (a Hangul filler); a heading's own › reads >", () => {
  assert.equal(anchorSection(element({ headings: ["\u3164"], region: "\u3164" })), null);
  assert.deepEqual(anchorSection(element({ headings: ["Plans", "\u3164"], region: " \u200B" })), { shown: "Plans", full: "Plans" });
  assert.deepEqual(anchorSection(element({ headings: ["Docs › API", "Auth"] })), { shown: "Auth", full: "Docs > API › Auth" });
});

test("a picked heading isn't said twice: the heading above it is shown, else the region, else no section", () => {
  assert.deepEqual(anchorSection(element({ headings: ["Pricing", "Plans"] }, "h2#plans.big Plans")), { shown: "Pricing", full: "Pricing › Plans" });
  assert.deepEqual(anchorSection(element({ headings: ["Plans"], region: "Design" }, "h2#plans Plans")), { shown: "Design", full: "Plans · Design" });
  assert.equal(anchorSection(element({ headings: ["Plans"] }, "h2#plans Plans")), null);
  // A selection of the whole heading likewise.
  const selection: ArtifactCommentAnchor = { type: "annotation", data: { kind: "text", label: "Plans", selectors: [{ type: "TextQuoteSelector", exact: "Plans" }], context: { headings: ["Pricing", "Plans"] } } };
  assert.equal(anchorSection(selection)?.shown, "Pricing");
  assert.equal(draw(element({ headings: ["Plans"] }, "h2#plans Plans")), `<bdi dir="auto" data-page-text="">h2#plans Plans</bdi>`);
});

test("the anchor line as text: the section, then the place as before", () => {
  assert.equal(anchorMetaText(element({ headings: ["Pricing", "Plans"] }), true, intl), "Plans · ins 新增");
  assert.equal(anchorMetaText(element(), true, intl), "ins 新增");
  assert.equal(anchorMetaText({ type: "lines", data: { start: 3, end: 5 } }, true, intl), intl.formatMessage({ id: "artifacts.comments.anchor.lines" }, { start: 3, end: 5 }));
});

test("the anchor line drawn: the section's heading first, the page's words isolated, the chain in a tooltip only when there is more of it", () => {
  const html = draw(element({ headings: ["Agent 收件箱现状", "P5 · 读取页"], region: "设计" }));
  assert.match(html, /^<span data-tooltip=""><span data-testid="artifact-comment-anchor-section"><bdi dir="auto" data-page-text="">P5 · 读取页<\/bdi><\/span><span data-tooltip-content=""><bdi dir="auto" data-page-text="">Agent 收件箱现状 › P5 · 读取页 · 设计<\/bdi><\/span><\/span> · <span><bdi dir="auto" data-page-text="">ins 新增<\/bdi><\/span>$/);
  const one = draw(element({ headings: ["Plans"] }));
  assert.doesNotMatch(one, /data-tooltip/);
  assert.match(one, /data-testid="artifact-comment-anchor-section"><bdi dir="auto" data-page-text="">Plans<\/bdi><\/span> · /);
  // The same in Simplified Chinese.
  assert.match(draw(element({ headings: ["Plans"] }), true, "zh-CN"), /Plans<\/bdi><\/span> · <span>/);
  // No section: the line as before.
  assert.equal(draw(element()), `<bdi dir="auto" data-page-text="">ins 新增</bdi>`);
});

test("a place no longer found: the section dimmed with it; a screen reader hears both, without the tooltip", () => {
  const lost = draw(element({ headings: ["Pricing", "Plans"] }), false);
  const [dimmed, spoken] = lost.split(`<span class="sr-only">`);
  assert.match(dimmed!, /^<span aria-hidden="true" class="text-foreground-hint" data-anchor-lost=""><span data-tooltip=""><span data-testid="artifact-comment-anchor-section">/);
  assert.match(dimmed!, /Plans<\/bdi><\/span><span data-tooltip-content="">.*<\/span><\/span> · <span>/);
  assert.match(spoken!, /^<span data-testid="artifact-comment-anchor-section"><bdi dir="auto" data-page-text="">Plans<\/bdi><\/span> · <span>/);
  assert.doesNotMatch(spoken!, /data-tooltip/);
});
