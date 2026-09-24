import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";

import LiveAgentActivityBar, {
  useClearLiveAgentActivityOnServerChange,
} from "../src/components/layout/LiveAgentActivityBar";
import MobileBottomBarStack from "../src/components/layout/MobileBottomBarStack";
import {
  SHOW_LIVE_AGENT_ACTIVITY_BAR_STORAGE_KEY,
  useAppearanceStore,
} from "../src/store/appearanceStore";
import { useLiveAgentActivityStore } from "../src/store/liveAgentActivityStore";
import { TestIntlProvider } from "./helpers/intl";

afterEach(() => {
  cleanup();
  useLiveAgentActivityStore.setState({ items: [] });
  useAppearanceStore.setState({ showLiveAgentActivityBar: true } as never);
  localStorage.removeItem(SHOW_LIVE_AGENT_ACTIVITY_BAR_STORAGE_KEY);
});

test("the Appearance preference hides the live agent activity bar without discarding activity", () => {
  assert.equal(useAppearanceStore.getState().showLiveAgentActivityBar, true);
  useLiveAgentActivityStore.setState({
    items: [{
      id: "activity-1",
      kind: "activity",
      agentId: "agent-1",
      agentName: "Runner",
      agentAvatarUrl: null,
      text: "Thinking…",
      context: null,
      activity: "thinking",
      createdAt: Date.now(),
    }],
  });
  render(<TestIntlProvider><LiveAgentActivityBar /></TestIntlProvider>);
  assert.ok(screen.getByTestId("live-agent-activity-bar"));

  act(() => {
    useAppearanceStore.getState().setShowLiveAgentActivityBar(false);
  });

  const hiddenBar = screen.queryByTestId("live-agent-activity-bar");
  cleanup();
  assert.equal(hiddenBar, null);
  assert.equal(localStorage.getItem(SHOW_LIVE_AGENT_ACTIVITY_BAR_STORAGE_KEY), "false");
  assert.equal(useLiveAgentActivityStore.getState().items.length, 1);
});

function ServerActivityBoundary({ serverId }: { serverId: string }) {
  useClearLiveAgentActivityOnServerChange(serverId);
  return null;
}

test("changing servers synchronously clears live activity from the previous server", () => {
  const view = render(<ServerActivityBoundary serverId="server-a" />);
  useLiveAgentActivityStore.setState({
    items: [{
      id: "activity-old-server",
      kind: "activity",
      agentId: "agent-1",
      agentName: "Runner",
      agentAvatarUrl: null,
      text: "Old server work",
      context: null,
      activity: "working",
      createdAt: Date.now(),
    }],
  });

  view.rerender(<ServerActivityBoundary serverId="server-b" />);
  assert.deepEqual(useLiveAgentActivityStore.getState().items, []);
});

test("mobile live activity stays in flow immediately above the mobile tab bar", () => {
  const view = render(
    <MobileBottomBarStack
      showLiveActivity
      liveActivity={<div data-testid="live-slot-content" />}
      tabBar={<nav data-testid="mobile-tab-bar" />}
    />,
  );
  const liveSlot = screen.getByTestId("mobile-live-activity-slot");
  const tabBar = screen.getByTestId("mobile-tab-bar");

  assert.match(liveSlot.className, /md:hidden/);
  assert.match(liveSlot.className, /shrink-0/);
  assert.doesNotMatch(liveSlot.className, /(?:^|\s)(?:fixed|absolute|bottom-|inset-)/);
  assert.equal(liveSlot.getAttribute("style"), null);
  assert.equal(liveSlot.nextElementSibling, tabBar);

  view.rerender(
    <MobileBottomBarStack
      showLiveActivity={false}
      liveActivity={<div data-testid="live-slot-content" />}
      tabBar={<nav data-testid="mobile-tab-bar" />}
    />,
  );
  assert.equal(screen.queryByTestId("mobile-live-activity-slot"), null);
  assert.ok(screen.getByTestId("mobile-tab-bar"));
});
