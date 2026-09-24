import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import { LeftRail } from "../src/components/layout/LeftRail";
import { TestIntlProvider } from "./helpers/intl";
import { useServerStore } from "../src/store/serverStore";

// Teeth for task #750/#751 (artin's rail chrome reports, #proj-uiux 2026-08-02):
//   #750 — the server-switcher attention dot painted UNDER the avatar image:
//          AvatarImageWithFallback gives its img `relative z-[1]`; a z-auto
//          positioned dot always loses to an explicit stack level regardless
//          of DOM order. The dot must carry an explicit level above it.
//   #751 — the rail's bottom Settings button sat flush to the edge; the rail
//          column now keeps bottom padding.
// Both teeth pin the exact stacking/spacing relationships at DOM level (RED
// if the marker classes are removed); the pixel-level proof is the browser
// verification attached to the PR.

const originalApiGet = api.get;
const originalServerState = useServerStore.getState();

afterEach(() => {
  cleanup();
  api.get = originalApiGet;
  useServerStore.setState(originalServerState, true);
});

function seedServers() {
  useServerStore.setState({
    ...originalServerState,
    current: {
      id: "server-1",
      name: "Botiverse",
      slug: "botiverse",
      avatarUrl: "https://cdn.example.com/botiverse-avatar.png",
    } as never,
    servers: [
      { id: "server-1", name: "Botiverse", slug: "botiverse" },
      { id: "server-2", name: "Other", slug: "other" },
    ] as never,
  });
  api.get = ((url: string) => {
    if (url === "/servers/unread-summary") {
      return Promise.resolve({
        data: [{ serverId: "server-2", unreadCount: 3, serverPushMuted: false, activityUnreadCount: 3 }],
      });
    }
    return new Promise(() => {});
  }) as typeof api.get;
}

function renderRail() {
  return render(
    <MemoryRouter initialEntries={["/s/botiverse/channel/general"]}>
      <TestIntlProvider>
        <LeftRail side="left" />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

test("#750: the server-switcher attention dot outranks the avatar image's explicit z-[1]", async () => {
  seedServers();
  const { container } = renderRail();
  const switcher = container.querySelector<HTMLButtonElement>('button[aria-label*="Botiverse"]');
  assert.ok(switcher, "server switcher button renders");

  const avatar = switcher.querySelector<HTMLImageElement>('img[src="https://cdn.example.com/botiverse-avatar.png"]');
  assert.ok(avatar, "avatar image renders");
  assert.match(avatar.className, /z-\[1\]/, "the avatar image keeps its explicit stack level (the element the dot must beat)");

  const dot = await waitFor(() => {
    const found = switcher.querySelector<HTMLSpanElement>('span[aria-hidden="true"]');
    assert.ok(found, "attention dot appears once the unread summary lands");
    return found;
  });
  assert.match(
    dot.className,
    /z-\[2\]/,
    "the dot must carry an explicit level ABOVE z-[1] — a z-auto positioned element paints under the image regardless of DOM order",
  );
});

test("#751: the rail column keeps bottom padding so the Settings button is not flush to the edge", () => {
  seedServers();
  const { container } = renderRail();
  const rail = container.querySelector<HTMLDivElement>('[data-testid="workspace-left-rail"]');
  assert.ok(rail, "left rail renders");
  assert.match(rail.className, /pb-2/, "rail column keeps bottom padding for the trailing Settings button");
});
