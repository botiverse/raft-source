// A tab whose page is loading says so in the strip (#proj-workspace:#295): raft-ui's Spinner in the icon's place.
// Needs a DOM: run with RAFT_WEB_TEST_DOM=1.
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { TestIntlProvider } from "./helpers/intl";
import { BrowserTabStrip } from "../src/features/webPreview/BrowserTabStrip";
import type { BrowserTab } from "../src/features/webPreview/browserTabsStore";

const tab = (id: string, loading: boolean): BrowserTab => ({
  id, url: `https://example.com/${id}`, askedUrl: null, navigation: 0, title: `Page ${id}`, canGoBack: false, canGoForward: false, loading, blocked: null, blockedDismissedAt: 0,
});

afterEach(cleanup);

it("shows the spinner on the tab that is loading, and only there; the title and the close button stay", () => {
  render(
    <TestIntlProvider>
      <BrowserTabStrip bridge={{} as never} conversationId="c1" tabs={[tab("a", false), tab("b", true)]} activeId="a" tabsShown={2} measureFront={() => {}} />
    </TestIntlProvider>,
  );
  const [idle, loading] = screen.getAllByTestId("web-preview-tab-slot");
  expect(idle!.querySelector('[data-testid="web-preview-tab-loading"]')).toBeNull();
  expect(idle!.querySelector('[role="tab"]')!.getAttribute("aria-busy")).toBeNull();
  expect(loading!.querySelector('[data-testid="web-preview-tab-loading"]')).not.toBeNull();
  expect(loading!.querySelector('[role="tab"]')!.getAttribute("aria-busy")).toBe("true");
  expect(loading!.textContent).toContain("Page b");
  expect(loading!.querySelector('[data-testid="web-preview-tab-close"]')).not.toBeNull();
});
