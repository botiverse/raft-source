import "./helpers/domSetup";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { createElement, useState } from "react";

import { applyRowFacts, useRowFacts } from "../src/components/layout/rowFacts";

afterEach(cleanup);

// Each `:has()` the row rules used, and the attribute selector that replaced it (#proj-frontend:#58).
const EQUIVALENT: Array<[string, string]> = [
  [':has(> .thread-side-column)', "[data-has-thread]"],
  [':has(> .thread-side-column[data-covers])', "[data-has-thread-covers]"],
  [':not(:has(> .thread-side-column[data-covers]))', ":not([data-has-thread-covers])"],
  [':has(> .thread-profile-side-column)', "[data-has-profile]"],
  [':has(> .thread-profile-side-column[data-collapse-channel="true"])', '[data-profile-collapse-channel="true"]'],
  [':has(> .thread-profile-side-column[data-collapse-thread="true"])', '[data-profile-collapse-thread="true"]'],
  [':has(> .thread-profile-side-column[data-collapse-channel="false"][data-collapse-thread="false"])', '[data-profile-collapse-channel="false"][data-profile-collapse-thread="false"]'],
  [':has(> :is([data-testid="legacy-task-panel"], [data-legacy-task-panel-fallback]))', "[data-has-legacy-task]"],
  [':has(> .shortcut-help-column)', "[data-has-help]"],
  [':has(> .shortcut-help-column:not([data-row-width]))', "[data-has-help]:not([data-help-row-width])"],
  [':has(> .shortcut-help-column[data-row-width])', "[data-help-row-width]"],
  [':has(> [data-testid="channel-side-slot"] [data-mode="beside"])', "[data-has-side-beside]"],
  [':has([data-testid="channel-side-float-slot"] [data-mode="float"])', "[data-has-side-float]"],
];

// Row contents the rules meet: each a list of the row's direct children (HTML).
const ROWS: string[][] = [
  [],
  ['<div class="thread-side-column"></div>'],
  ['<div class="thread-side-column" data-covers=""></div>'],
  ['<div class="thread-profile-side-column" data-collapse-channel="true" data-collapse-thread="false"></div>'],
  ['<div class="thread-profile-side-column" data-collapse-channel="false" data-collapse-thread="true"></div>'],
  ['<div class="thread-profile-side-column" data-collapse-channel="false" data-collapse-thread="false"></div>', '<div class="thread-side-column"></div>'],
  ['<div data-testid="legacy-task-panel"></div>'],
  ['<div data-legacy-task-panel-fallback=""></div>'],
  ['<div class="shortcut-help-column"></div>', '<div class="thread-side-column" data-covers=""></div>'],
  ['<div class="shortcut-help-column" data-row-width=""></div>'],
  ['<div data-testid="channel-side-slot"><div><section data-mode="beside"></section></div></div>'],
  ['<div data-testid="channel-side-slot"><section data-mode="beside"></section></div>', '<div><div data-testid="channel-side-float-slot"><i data-mode="float"></i></div></div>'],
  // Not direct children: none of the `> …` facts hold.
  ['<div><div class="thread-side-column"></div><div class="shortcut-help-column"></div></div>'],
];

test("each row fact attribute matches exactly when the :has() it replaced does", () => {
  for (const children of ROWS) {
    const row = document.createElement("div");
    row.className = "thread-layout-container";
    row.innerHTML = children.join("");
    applyRowFacts(row);
    for (const [hasSelector, attributeSelector] of EQUIVALENT) {
      assert.equal(row.matches(attributeSelector), row.matches(hasSelector), `${attributeSelector} vs ${hasSelector} for ${children.join(" ") || "(empty)"}`);
    }
  }
});

function Row({ children }: { children?: React.ReactNode }) {
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  useRowFacts(row);
  return createElement("div", { ref: setRow, className: "thread-layout-container", "data-testid": "row" }, children);
}

const settle = () => new Promise((done) => setTimeout(done, 0));

test("the row's attributes are there before the first paint and follow its columns as they change", async () => {
  const view = render(createElement(Row, null, createElement("div", { className: "thread-side-column" })));
  const row = view.getByTestId("row");
  assert.ok(row.hasAttribute("data-has-thread"), "set in the layout effect, before paint");
  assert.ok(!row.hasAttribute("data-has-help"));

  // A column added outside React (as rowLayout and the side areas write their attributes).
  const help = document.createElement("div");
  help.className = "shortcut-help-column";
  row.append(help);
  await settle();
  assert.ok(row.hasAttribute("data-has-help"));
  assert.ok(!row.hasAttribute("data-help-row-width"));

  help.setAttribute("data-row-width", "");
  await settle();
  assert.ok(row.hasAttribute("data-help-row-width"));

  row.querySelector(".thread-side-column")!.setAttribute("data-covers", "");
  await settle();
  assert.ok(row.hasAttribute("data-has-thread-covers"));

  help.remove();
  await settle();
  assert.ok(!row.hasAttribute("data-has-help") && !row.hasAttribute("data-help-row-width"));
});

test("facts changed in place, deep in the conversation's side area, are followed; a message alone is not a fact", async () => {
  const view = render(createElement(Row, null,
    createElement("div", { className: "thread-main-column" },
      createElement("div", { className: "messages" }),
      createElement("div", { "data-testid": "channel-side-float-slot" }, createElement("i", { "data-mode": "beside" }))),
    createElement("div", { className: "thread-profile-side-column", "data-collapse-channel": "false", "data-collapse-thread": "false" })));
  const row = view.getByTestId("row");
  assert.ok(!row.hasAttribute("data-has-side-float"));
  assert.equal(row.getAttribute("data-profile-collapse-channel"), "false");

  row.querySelector("[data-mode]")!.setAttribute("data-mode", "float");
  await settle();
  assert.ok(row.hasAttribute("data-has-side-float"), "a side area turning float inside the conversation column");

  row.querySelector(".thread-profile-side-column")!.setAttribute("data-collapse-channel", "true");
  await settle();
  assert.equal(row.getAttribute("data-profile-collapse-channel"), "true", "a profile folding the channel, in place");

  row.querySelector(".messages")!.append(document.createElement("p"));
  await settle();
  assert.ok(row.hasAttribute("data-has-side-float") && row.getAttribute("data-profile-collapse-channel") === "true", "a message changes no fact");
});

test("an observer on the row created after the facts' sees them already updated (useSideRoom's order)", async () => {
  const view = render(createElement(Row, null));
  const row = view.getByTestId("row");
  const seen: boolean[] = [];
  const reader = new MutationObserver(() => seen.push(row.hasAttribute("data-has-thread")));
  reader.observe(row, { childList: true });
  const thread = document.createElement("div");
  thread.className = "thread-side-column";
  row.append(thread);
  await settle();
  reader.disconnect();
  assert.deepEqual(seen, [true], "the later observer reads the new fact, not the old one");
});

test("index.css reads no :has() on the row", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../src/index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const offending = css.split(/[{}]/).map((part) => part.trim()).filter((selector) => selector.includes(".thread-layout-container") && selector.includes(":has("));
  assert.deepEqual(offending, [], "a :has() on the row restyles the whole page after a channel switch (#proj-frontend:#58); write the fact onto the row in rowFacts.ts instead");
});
