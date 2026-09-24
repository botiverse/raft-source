import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createIntl } from "react-intl";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { en } from "../src/i18n/messages/en";
import { getGlobalSearchShortcutLabel } from "../src/utils/keyboardShortcuts";
import { SEARCH_FOCUS_REQUEST_EVENT } from "../src/utils/searchFocusRequest";
import api from "../src/api/client";
import { DEFAULT_SIDEBAR_ORDER } from "../src/store/events/serverEvents";
import { TestIntlProvider } from "./helpers/intl";

const EXPECTED_SEARCH_PLACEHOLDER = "Search channels, DMs, messages…   {shortcutHint}";
const originalGet = api.get;

afterEach(() => {
  cleanup();
  api.get = originalGet;
});

test("search input placeholder keeps the global shortcut hint visible", async () => {
  assert.equal(
    en["search.placeholder"],
    EXPECTED_SEARCH_PLACEHOLDER,
    "catalog must keep the shortcutHint slot in the search placeholder",
  );

  const intl = createIntl({ locale: "en", defaultLocale: "en", messages: en });
  const expectedHint = getGlobalSearchShortcutLabel(undefined, intl.formatMessage);
  assert.ok(expectedHint.length > 0);

  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  const { default: MessageSearchPage } = await import("../src/components/search/MessageSearchPage");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useServerStore } = await import("../src/store/serverStore");
  const { useChannelStore } = await import("../src/store/channelStore");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useMachineStore } = await import("../src/store/machineStore");
  const { useSearchContentStore } = await import("../src/store/searchContentStore");
  const { useThreadStore } = await import("../src/store/threadStore");

  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "current@example.com",
      name: "current",
      displayName: "Current User",
    },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      slug: "server",
      role: "owner",
    },
    members: [],
    sidebarOrder: { ...DEFAULT_SIDEBAR_ORDER },
  } as never);
  useChannelStore.setState({ channels: [], dmChannels: [] } as never);
  useAgentStore.setState({ agents: [], agentActivities: {} } as never);
  useMachineStore.setState({ machines: [] } as never);
  useSearchContentStore.setState({ slot: null } as never);
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
  } as never);

  render(
    <MemoryRouter initialEntries={["/s/server/search"]}>
      <TestIntlProvider>
        <MessageSearchPage />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const input = screen.getByPlaceholderText(/Search channels/) as HTMLInputElement;
  assert.match(input.placeholder, /Search channels, DMs, messages…/);
  assert.ok(
    input.placeholder.includes(expectedHint),
    `mounted search input must include the live shortcut hint ${expectedHint}; got ${input.placeholder}`,
  );

  fireEvent.change(input, { target: { value: "needle" } });
  const outside = document.createElement("button");
  document.body.append(outside);
  try {
    outside.focus();
    assert.equal(document.activeElement, outside);

    fireEvent(document, new window.Event(SEARCH_FOCUS_REQUEST_EVENT));
    assert.equal(document.activeElement, input);
    assert.equal(input.selectionStart, 0);
    assert.equal(input.selectionEnd, input.value.length);
  } finally {
    outside.remove();
  }
});
