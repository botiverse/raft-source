// The address field's key (Cmd/Ctrl+L) pressed in a tab's page (#proj-workspace:#294): the shell hands it over as a
// command (browserCommands.test.ts) and the address row becomes its field, focused, the address selected.
// Needs a DOM: run with RAFT_WEB_TEST_DOM=1.
import "./helpers/domSetup";
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import { BrowserAddressBar } from "../src/features/webPreview/BrowserAddressBar";
import { useBrowserTabsStore } from "../src/features/webPreview/browserTabsStore";

const conversation = "c1";
const other = "c2";
const bridge = {} as DesktopWebPreviewTabsBridge;
const store = () => useBrowserTabsStore.getState();
const front = () => store().browsers[conversation]!.tabs.find((tab) => tab.id === store().browsers[conversation]!.activeId)!;
const command = (name: "focus-address" | "new-tab") =>
  act(() => store().runCommand(conversation, { type: "command", command: name, tabId: front().id }));

function Bar({ conversationId = conversation }: { conversationId?: string }) {
  const tab = useBrowserTabsStore((s) => s.browsers[conversationId]!.tabs.find((candidate) => candidate.id === s.browsers[conversationId]!.activeId)!);
  return <BrowserAddressBar key={tab.id} bridge={bridge} conversationId={conversationId} tab={tab} />;
}

beforeEach(() => {
  useBrowserTabsStore.setState({ browsers: {}, addressFocus: {} });
  store().openUrl(conversation, "https://example.com/docs");
  render(<TestIntlProvider><Bar /></TestIntlProvider>);
});
afterEach(cleanup);

it("turns the address into its field, focused, with the address selected; again after the field was left", () => {
  expect(screen.queryByTestId("web-preview-address-input")).toBeNull();
  command("focus-address");
  const input = screen.getByTestId("web-preview-address-input") as HTMLInputElement;
  expect(input.value).toBe("https://example.com/docs");
  expect(document.activeElement === input).toBe(true);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
  // Leaving the field puts the address back; the key makes it the field again.
  act(() => input.blur());
  expect(screen.queryByTestId("web-preview-address-input")).toBeNull();
  command("focus-address");
  expect(document.activeElement === screen.getByTestId("web-preview-address-input")).toBe(true);
});

it("a new tab opens with its empty field focused", () => {
  command("new-tab");
  const input = screen.getByTestId("web-preview-address-input") as HTMLInputElement;
  expect(input.value).toBe("");
  expect(document.activeElement === input).toBe(true);
});

it("asks only its own conversation's address bar: another conversation's, mounted beside it, stays as it was", () => {
  act(() => store().openUrl(other, "https://example.org/other"));
  render(<TestIntlProvider><div data-testid="other-bar"><Bar conversationId={other} /></div></TestIntlProvider>);
  command("focus-address");
  const inputs = screen.getAllByTestId("web-preview-address-input") as HTMLInputElement[];
  expect(inputs.map((input) => input.value)).toEqual(["https://example.com/docs"]);
  expect(screen.getByTestId("other-bar").contains(inputs[0]!)).toBe(false);
  expect(document.activeElement === inputs[0]).toBe(true);
  // And a new tab in one browser does not open the other's field.
  command("new-tab");
  expect(screen.getByTestId("other-bar").querySelector("input")).toBeNull();
});
