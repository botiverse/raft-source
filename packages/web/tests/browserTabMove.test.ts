import { describe, expect, it } from "vitest";

import { moveBrowserTab } from "../src/features/webPreview/browserTabsStore";

// The built-in browser's tab order (#proj-workspace:#296): a drag puts the tab where the one it was dropped on
// stands; the keyboard moves it one place; nothing else changes place.
describe("moveBrowserTab", () => {
  const tabs = ["a", "b", "c", "d"].map((id) => ({ id }));
  const order = (moved: readonly { id: string }[]) => moved.map((tab) => tab.id).join("");

  it.each([
    ["a", "c", "bcad"],
    ["d", "a", "dabc"],
    ["b", "c", "acbd"],
    ["b", "left", "bacd"],
    ["b", "right", "acbd"],
  ])("moves %s to %s", (tabId, to, expected) => {
    expect(order(moveBrowserTab(tabs, tabId, to))).toBe(expected);
  });

  it.each([
    ["a", "a"],
    ["a", "left"],
    ["d", "right"],
    ["x", "a"],
    ["a", "x"],
  ])("leaves the list as it is for %s to %s", (tabId, to) => {
    expect(moveBrowserTab(tabs, tabId, to)).toBe(tabs);
  });
});
