// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TestIntlProvider } from "./helpers/intl";
import { AnchoredMenuPopover } from "../src/components/ui/AnchoredMenuPopover";
import { capturePointAnchor } from "../src/components/ui/popupAnchor";
import { SearchChannelContextMenu } from "../src/features/search/SearchChannelContextMenu";
import { InboxContextMenu } from "../src/components/thread/InboxContextMenu";
import { NotificationLevelSubmenu } from "../src/components/notifications/NotificationLevelMenu";
import { SidebarRowContextMenu } from "../src/features/sidebar/menus/SidebarRowContextMenu";
import { useNotificationSettingsStore } from "../src/store/notificationSettingsStore";
import type { SearchEntityResult } from "../src/features/search/searchEntities";
import type { InboxItem } from "../src/store/inboxStore";
import type { SidebarData } from "../src/features/sidebar/hooks/useSidebarData";
import type { SidebarViewState } from "../src/features/sidebar/hooks/useSidebarViewState";
import type { SidebarSync } from "../src/features/sidebar/hooks/useSidebarSync";
import type { SidebarItems } from "../src/features/sidebar/hooks/useSidebarItems";
import type { SidebarMenuActions } from "../src/features/sidebar/hooks/useSidebarMenuActions";

const origClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

function setDocumentViewport(width: number, height: number) {
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: height });
}

afterEach(() => {
  cleanup();
  delete (document.documentElement as unknown as Record<string, unknown>).clientWidth;
  delete (document.documentElement as unknown as Record<string, unknown>).clientHeight;
  if (origClientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", origClientWidth);
  if (origClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", origClientHeight);
});

test("AnchoredMenuPopover defaults role='menu' (never 'dialog'), does not swallow Escape, and closes on detach or anchor swap", async () => {
  let hiddenCalls = 0;
  let capturedPopupRole: string | null = null;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const anchor = capturePointAnchor(120, 180, host);

  const view = render(
    <AnchoredMenuPopover
      open
      anchor={anchor}
      onAnchorHidden={() => { hiddenCalls += 1; }}
      ref={(node) => { capturedPopupRole = node?.getAttribute("role") ?? null; }}
      aria-label="Test menu"
      data-testid="test-anchored-menu"
    >
      <button type="button" role="menuitem">Action</button>
    </AnchoredMenuPopover>,
  );

  await waitFor(() => {
    const popup = screen.queryByTestId("test-anchored-menu");
    assert.equal(popup !== null, true);
    assert.equal(popup?.getAttribute("data-slot"), "popover-content");
    assert.equal(capturedPopupRole, "menu", "defaults to role='menu', never Base UI role='dialog'");
    assert.equal(screen.queryByRole("dialog") === null, true);
  });

  // Base UI's internal useDismiss must NOT preventDefault or stopPropagation on Escape
  // so caller-owned shortcut layers / enclosing overlays still receive Escape cleanly.
  let docSawEscape = false;
  let docEscapePrevented = true;
  const onDocKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    docSawEscape = true;
    docEscapePrevented = event.defaultPrevented;
  };
  document.addEventListener("keydown", onDocKeyDown);
  try {
    const item = screen.getByRole("menuitem", { name: "Action" });
    item.focus();
    fireEvent.keyDown(item, { key: "Escape" });
  } finally {
    document.removeEventListener("keydown", onDocKeyDown);
  }
  assert.equal(docSawEscape, true, "Escape bubbles to document listeners");
  assert.equal(docEscapePrevented, false, "Escape is not defaultPrevented by unmanaged Popover useDismiss");

  // In default 0x0 jsdom viewport, data-anchor-hidden does not falsely close the menu.
  const positioner = screen.getByTestId("test-anchored-menu").parentElement!;
  act(() => {
    positioner.setAttribute("data-anchor-hidden", "");
  });
  await act(async () => { await Promise.resolve(); });
  assert.equal(hiddenCalls, 0, "0x0 jsdom viewport ignores Floating UI initial data-anchor-hidden");

  // Inside a real laid-out viewport, data-anchor-hidden triggers onAnchorHidden.
  setDocumentViewport(1280, 800);
  act(() => {
    positioner.removeAttribute("data-anchor-hidden");
    positioner.setAttribute("data-anchor-hidden", "");
  });
  await waitFor(() => {
    assert.equal(hiddenCalls, 1, "real viewport closes menu when anchor hides");
  });

  // Clear manual data-anchor-hidden before testing anchor swap lifecycle.
  act(() => {
    positioner.removeAttribute("data-anchor-hidden");
  });

  // Swapping anchor from element `host` to a fixed-point anchor (no contextElement)
  // clears trackedElement so detaching `host` afterward does NOT falsely dismiss.
  let swapCalls = 0;
  const swapAnchorA = capturePointAnchor(40, 60, host);
  const fixedAnchor = capturePointAnchor(90, 90, null);
  view.rerender(
    <AnchoredMenuPopover
      open
      anchor={swapAnchorA}
      onAnchorHidden={undefined}
      data-testid="test-anchored-menu"
    >
      <button type="button" role="menuitem">Action</button>
    </AnchoredMenuPopover>,
  );
  // Transition onAnchorHidden from undefined -> callback + swap to fixedAnchor.
  view.rerender(
    <AnchoredMenuPopover
      open
      anchor={fixedAnchor}
      onAnchorHidden={() => { swapCalls += 1; }}
      data-testid="test-anchored-menu"
    >
      <button type="button" role="menuitem">Action</button>
    </AnchoredMenuPopover>,
  );
  act(() => {
    host.remove();
  });
  await act(async () => { await Promise.resolve(); });
  assert.equal(swapCalls, 0, "detaching previous anchor does not dismiss after swap to fixed-point anchor");

  // Swapping to an already-detached element anchor immediately dismisses.
  const detachedEl = document.createElement("div");
  view.rerender(
    <AnchoredMenuPopover
      open
      anchor={detachedEl}
      onAnchorHidden={() => { swapCalls += 1; }}
      data-testid="test-anchored-menu"
    >
      <button type="button" role="menuitem">Action</button>
    </AnchoredMenuPopover>,
  );
  await waitFor(() => {
    assert.equal(swapCalls, 1, "swapping to an already-detached element immediately closes");
  });
  view.unmount();

  // Separate mount: removing the anchor's DOM node WITHOUT any scroll/resize event closes immediately.
  let detachCalls = 0;
  const row = document.createElement("div");
  document.body.appendChild(row);
  const detachAnchor = capturePointAnchor(40, 60, row);
  const view2 = render(
    <AnchoredMenuPopover
      open
      anchor={detachAnchor}
      onAnchorHidden={() => { detachCalls += 1; }}
      data-testid="test-detach-menu"
    >
      <button type="button" role="menuitem">Action</button>
    </AnchoredMenuPopover>,
  );
  await waitFor(() => {
    assert.equal(screen.queryByTestId("test-detach-menu") !== null, true);
  });
  act(() => {
    row.remove();
  });
  await waitFor(() => {
    assert.equal(detachCalls, 1, "detaching contextElement closes menu immediately without scroll");
  });
  view2.unmount();
});

test("SearchChannelContextMenu focuses first item, closes on Escape/backdrop/detach without scroll, and invokes onOpen", async () => {
  const row = document.createElement("div");
  document.body.appendChild(row);
  let closed = 0;
  let opened = 0;
  const result: SearchEntityResult = {
    key: "channel:ch-1",
    type: "channel",
    title: "general",
    channelId: "ch-1",
  };
  const view = render(
    <TestIntlProvider>
      <SearchChannelContextMenu
        menu={{ result, anchor: capturePointAnchor(100, 120, row) }}
        onClose={() => { closed += 1; }}
        onOpen={() => { opened += 1; }}
      />
    </TestIntlProvider>,
  );

  await waitFor(() => {
    const menu = screen.queryByRole("menu");
    assert.equal(menu !== null, true);
    assert.equal(menu?.getAttribute("data-slot"), "popover-content");
    const firstBtn = menu?.querySelector("button");
    assert.equal(document.activeElement === firstBtn, true, "focuses first menu button on mount");
  });

  fireEvent.click(screen.getByRole("menuitem"));
  assert.equal(opened, 1);

  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  assert.equal(closed, 1);

  const backdrop = document.querySelector('[data-slot="dismiss-backdrop"]');
  assert.equal(backdrop !== null, true);
  fireEvent.click(backdrop!);
  assert.equal(closed, 2);

  act(() => {
    row.remove();
  });
  await waitFor(() => {
    assert.equal(closed, 3, "detaching anchored row closes SearchChannelContextMenu without scroll");
  });
  view.unmount();
});

test("InboxContextMenu renders inside PopoverContent, runs onDone + onClose, and closes when row detaches without scroll", async () => {
  const row = document.createElement("div");
  document.body.appendChild(row);
  let closed = 0;
  let doneItemId: string | null = null;
  const item = {
    kind: "channel",
    channelId: "ch-inbox-1",
    channelName: "general",
    channelType: "public",
    unreadCount: 0,
    hasMention: false,
    lastActivityAt: "2026-11-19T08:00:00.000Z",
    lastMessagePreview: "hello",
    lastMessageSenderId: "u1",
    lastMessageSenderName: "Alice",
    lastMessageSenderType: "user",
    latestDelegatedBy: null,
    latestRetracted: false,
  } as unknown as InboxItem;

  const view = render(
    <TestIntlProvider>
      <InboxContextMenu
        ctxMenu={{ anchor: capturePointAnchor(60, 80, row), item }}
        onClose={() => { closed += 1; }}
        onDone={(picked) => { doneItemId = picked.kind === "channel" ? picked.channelId : null; }}
        onUnfollow={() => {}}
      />
    </TestIntlProvider>,
  );

  await waitFor(() => {
    const menu = screen.queryByTestId("activity-context-menu");
    assert.equal(menu !== null, true);
    assert.equal(menu?.getAttribute("data-slot"), "popover-content");
    assert.equal(menu?.getAttribute("role"), "menu");
  });

  const menuItems = screen.getAllByRole("menuitem");
  const doneButton = menuItems.find((el) => /done/i.test(el.textContent ?? ""));
  assert.equal(doneButton !== undefined, true);
  fireEvent.click(doneButton!);
  assert.equal(doneItemId, "ch-inbox-1");
  assert.equal(closed, 1);

  act(() => {
    row.remove();
  });
  await waitFor(() => {
    assert.equal(closed, 2, "detaching anchored row closes InboxContextMenu without scroll");
  });
  view.unmount();
});

test("NotificationLevelSubmenu opens inside PopoverContent on trigger hover and closes when another parent item hovers", async () => {
  // Pre-mark server levels loaded so useEnsureServerLevels does not attempt network fetch.
  useNotificationSettingsStore.setState((s) => ({
    ...s,
    explicit: {
      ...s.explicit,
      "srv-1": { loaded: true, channels: {}, threads: {} },
    },
  }));

  let doneCount = 0;
  const view = render(
    <TestIntlProvider>
      <div role="menu">
        <button type="button" role="menuitem" data-testid="other-parent-item">Pin</button>
        <NotificationLevelSubmenu
          target={{ scope: "channel", serverId: "srv-1", channelId: "ch-1" }}
          onDone={() => { doneCount += 1; }}
        />
      </div>
    </TestIntlProvider>,
  );

  const trigger = screen.getByTestId("sidebar-ctx-notification-level");
  assert.equal(screen.queryByTestId("sidebar-ctx-notification-level-menu") === null, true);

  fireEvent.mouseEnter(trigger);
  await waitFor(() => {
    const submenu = screen.queryByTestId("sidebar-ctx-notification-level-menu");
    assert.equal(submenu !== null, true);
    assert.equal(submenu?.getAttribute("data-slot"), "popover-content");
    assert.equal(submenu?.getAttribute("role"), "menu");
  });

  // Hovering a sibling item in the parent menu closes the submenu.
  fireEvent.mouseOver(screen.getByTestId("other-parent-item"));
  await waitFor(() => {
    assert.equal(screen.queryByTestId("sidebar-ctx-notification-level-menu") === null, true);
  });

  // Clicking opens again, and choosing an option invokes onDone and closes the submenu.
  fireEvent.click(trigger);
  await waitFor(() => {
    assert.equal(screen.queryByTestId("sidebar-ctx-notification-level-menu") !== null, true);
  });
  const choice = screen.getAllByRole("menuitemradio")[0];
  fireEvent.click(choice);
  await waitFor(() => {
    assert.equal(screen.queryByTestId("sidebar-ctx-notification-level-menu") === null, true);
  });
  assert.equal(doneCount, 1);
  view.unmount();
});

test("SidebarRowContextMenu uses role='menu', absorbs clicks while ctxMenuClickShielded is true, and opens Move to section submenu", async () => {
  const row = document.createElement("div");
  document.body.appendChild(row);
  let pinnedCalls = 0;
  let movedHome = 0;
  const triggerRef = { current: null as HTMLDivElement | null };

  const makeProps = (opts: { shielded: boolean; submenuOpen: boolean }) => ({
    data: {
      formatMessage: ({ id }: { id: string }) => id,
      customSections: [],
      ctxMenu: { anchor: capturePointAnchor(80, 120, row), type: "channel" as const, id: "ch-1" },
      moveToSectionTriggerRef: triggerRef,
      moveToSectionMenuOpen: opts.submenuOpen,
    } as unknown as SidebarData,
    view: {
      ctxMenuClickShielded: opts.shielded,
      capabilities: { archiveChannels: false },
    } as unknown as SidebarViewState,
    sync: {
      clearCtxMenu: () => {},
      closeCtx: () => {},
    } as unknown as SidebarSync,
    items: {
      pinnedRefs: [],
      pinnedAgentIds: [],
    } as unknown as SidebarItems,
    menuActions: {
      contextMovableItem: { kind: "channel", id: "ch-1" },
      contextItemPinned: false,
      ctxChannel: { id: "ch-1", name: "general", type: "public", joined: true },
      ctxHumanDmChannel: undefined,
      ctxDmChannel: undefined,
      ctxAgent: undefined,
      ctxAgentDmChannelId: undefined,
      closeMoveToSectionMenuFromHover: () => {},
      closeMoveToSectionMenuFromFocus: () => {},
      openMoveToSectionMenu: () => {},
      closeMoveToSectionMenu: () => {},
      ctxMuteTarget: undefined,
      toggleContextActivityMute: () => {},
      contextNotificationLevelTarget: null,
      toggleContextChannelPin: () => { pinnedCalls += 1; },
      archiveContextChannel: () => {},
      leaveContextChannel: () => {},
      toggleContextHumanPin: () => {},
      toggleContextDmPin: () => {},
      toggleContextAgentPin: () => {},
      closeContextDm: () => {},
      ctxLounge: undefined,
      toggleContextLoungePin: () => {},
      closeContextLounge: () => {},
      moveContextItemToPinned: () => {},
      moveContextItemToSection: () => {},
      moveContextItemToHome: () => { movedHome += 1; },
      createSectionWithContextItem: () => {},
      contextHomeLabelId: "layout.sidebar.channels",
      contextItemHome: false,
      contextCurrentSectionId: null,
    } as unknown as SidebarMenuActions,
  });

  // While shielded, clicks on menu items must be absorbed by onClickCapture.
  const view = render(
    <TestIntlProvider>
      <SidebarRowContextMenu {...makeProps({ shielded: true, submenuOpen: false })} />
    </TestIntlProvider>,
  );
  await waitFor(() => {
    assert.equal(screen.queryByRole("menu") !== null, true);
    assert.equal(screen.queryByRole("dialog") === null, true, "SidebarRowContextMenu must never render role='dialog'");
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "layout.sidebar.pin" }));
  assert.equal(pinnedCalls, 0, "shielded menu swallows phantom clicks before menu item runs");

  // Once shield expires and submenu opens, both main menu and Move to section submenu work.
  view.rerender(
    <TestIntlProvider>
      <SidebarRowContextMenu {...makeProps({ shielded: false, submenuOpen: true })} />
    </TestIntlProvider>,
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "layout.sidebar.pin" }));
  assert.equal(pinnedCalls, 1);

  await waitFor(() => {
    assert.equal(screen.queryByTestId("sidebar-move-to-home") !== null, true);
  });
  fireEvent.click(screen.getByTestId("sidebar-move-to-home"));
  assert.equal(movedHome, 1);

  view.unmount();
  row.remove();
});
