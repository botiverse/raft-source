// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import type { RuntimeAccountUsageSnapshot } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import RuntimeAccountUsageChip from "../src/components/machine/RuntimeAccountUsageChip";
import { RuntimeAccountUsageClient } from "../src/utils/runtimeAccountUsageClient";
import { RuntimeAuthClient } from "../src/utils/runtimeAuthClient";

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(window, "matchMedia", { writable: true, configurable: true, value: originalMatchMedia });
});

function setMobileMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("max-width: 767px") ? matches : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function createClients() {
  const snapshot: RuntimeAccountUsageSnapshot = {
    protocolVersion: 2,
    provider: "codex",
    collectedAt: "2026-11-19T03:00:00.000Z",
    staleAfter: "2099-11-19T03:30:00.000Z",
    collectorVersion: "test",
    accounts: [{
      accountKey: "a".repeat(64),
      planLabel: "pro",
      maskedLabel: "t***t@botiverse.dev",
      health: "ok",
      windows: [{ id: "w_week", label: "Codex · 1 week", status: "ok", usedRatio: 0.42, resetsAt: "2099-11-24T09:00:00.000Z" }],
    }],
  };
  const usageClient = new RuntimeAccountUsageClient(
    async () => ({ state: "fresh", snapshot }),
    async () => ({ accepted: true, state: "fresh", snapshot }),
  );
  const authClient = new RuntimeAuthClient(
    {
      get: async <T,>() => ({
        status: { collectedAt: "2026-11-19T03:00:00.000Z", runtimes: { codex: { kind: "logged_in" } } },
        availability: "ok",
        runtimes: ["codex"],
        logoutRuntimes: ["codex"],
        canAct: true,
        runtimeUpgrade: false,
        upgradableRuntimes: [],
      }) as T,
      post: async <T,>() => ({}) as T,
    },
    { current: () => null, onReplaced: () => () => {} },
  );
  return { usageClient, authClient };
}

function renderChip(machineId = "m1", clients = createClients()) {
  return render(
    <TestIntlProvider>
      <button type="button" data-testid="outside">Outside</button>
      <div data-testid="outside-inert">Inert background</div>
      <RuntimeAccountUsageChip
        runtimeId="codex"
        serverId="s1"
        machineId={machineId}
        client={clients.usageClient}
        authClient={clients.authClient}
      >
        Codex CLI
      </RuntimeAccountUsageChip>
    </TestIntlProvider>,
  );
}

test("mouse hover opens after 200ms, pins cleanly even past 500ms with active focus guards, and closes on leave when unpinned", async () => {
  setMobileMatchMedia(false);
  renderChip();

  await waitFor(() => {
    assert.equal(screen.queryByTestId("runtime-usage-health-codex") !== null, true);
  });

  vi.useFakeTimers();
  const trigger = screen.getByRole("button", { name: "Codex CLI" });
  assert.equal(trigger.getAttribute("data-slot"), "popover-trigger");

  // Hover opens unpinned after 200ms.
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  act(() => { vi.advanceTimersByTime(150); });
  assert.equal(screen.queryByRole("dialog") === null, true, "not open before 200ms");

  await act(async () => {
    vi.advanceTimersByTime(60);
    await Promise.resolve();
  });
  assert.equal(screen.queryByRole("dialog")?.getAttribute("data-dismiss-layer"), "false");

  // Moving into popover cancels leave; leaving closes after 160ms.
  fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
  fireEvent.pointerEnter(screen.getByRole("dialog"), { pointerType: "mouse" });
  act(() => { vi.advanceTimersByTime(300); });
  assert.equal(screen.queryByRole("dialog") !== null, true, "entering popover cancels close");

  fireEvent.pointerLeave(screen.getByRole("dialog"), { pointerType: "mouse" });
  await act(async () => {
    vi.advanceTimersByTime(200);
    await Promise.resolve();
  });
  assert.equal(screen.queryByRole("dialog") === null, true);

  // Hover again, wait PAST Base UI's 500ms patient-click window, then click to pin.
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  await act(async () => {
    vi.advanceTimersByTime(220);
    await Promise.resolve();
  });
  assert.equal(screen.queryByRole("dialog")?.getAttribute("data-dismiss-layer"), "false");
  act(() => { vi.advanceTimersByTime(700); });

  await act(async () => {
    fireEvent.click(trigger);
    await Promise.resolve();
  });
  const pinnedDialog = screen.queryByRole("dialog");
  assert.equal(pinnedDialog !== null, true);
  assert.equal(pinnedDialog?.getAttribute("data-dismiss-layer"), "");
  // FloatingFocusManager must stay enabled (focus guards mounted) when pinned from hover >500ms.
  assert.equal(document.querySelector("[data-base-ui-focus-guard]") !== null, true);

  // Pointer leaving a pinned card keeps it open.
  fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
  act(() => { vi.advanceTimersByTime(300); });
  assert.equal(screen.queryByRole("dialog") !== null, true);
});

test("focus-opened unpinned card closes when focus inside the card blurs to non-focusable outside space", async () => {
  setMobileMatchMedia(false);
  renderChip();

  await waitFor(() => {
    assert.equal(screen.queryByTestId("runtime-usage-health-codex") !== null, true);
  });

  const trigger = screen.getByRole("button", { name: "Codex CLI" });
  fireEvent.focus(trigger);
  await waitFor(() => {
    const dialog = screen.queryByRole("dialog");
    assert.equal(dialog !== null, true);
    assert.equal(dialog?.getAttribute("data-dismiss-layer"), "false");
  });

  // Tab from trigger into Refresh inside the card: card stays open.
  const refresh = screen.getByTestId("runtime-usage-refresh");
  fireEvent.blur(trigger, { relatedTarget: refresh });
  fireEvent.focus(refresh);
  assert.equal(screen.queryByRole("dialog") !== null, true);

  // Click non-focusable background (relatedTarget === null): unpinned card closes cleanly.
  fireEvent.blur(refresh, { relatedTarget: null });
  await waitFor(() => {
    assert.equal(screen.queryByRole("dialog") === null, true);
  });
});

test("closing a pinned card returns focus to trigger without reopening, and later Tab still opens unpinned", async () => {
  setMobileMatchMedia(false);
  renderChip();

  await waitFor(() => {
    assert.equal(screen.queryByTestId("runtime-usage-health-codex") !== null, true);
  });

  const trigger = screen.getByRole("button", { name: "Codex CLI" });
  // Simulate desktop mouse click (pointerdown -> focus -> click): pins once.
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  fireEvent.focus(trigger);
  fireEvent.click(trigger);

  await waitFor(() => {
    const dialog = screen.queryByRole("dialog");
    assert.equal(dialog !== null, true);
    assert.equal(dialog?.getAttribute("data-dismiss-layer"), "");
  });

  // Move focus inside the pinned card, then press Escape.
  const refresh = screen.getByTestId("runtime-usage-refresh");
  refresh.focus();
  assert.equal(document.activeElement === refresh, true);

  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => {
    assert.equal(screen.queryByRole("dialog") === null, true);
  });
  // Wait for FloatingFocusManager's microtask returnFocus + 0ms suppression clear.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.equal(document.activeElement === trigger, true, "focus returned to trigger on pinned close");
  assert.equal(screen.queryByRole("dialog") === null, true, "returning focus did not reopen the card");

  // Later, blurring and tabbing back onto the trigger opens unpinned again;
  // Esc is only consumed when pinned (unpinned leaves Esc for enclosing layers).
  fireEvent.blur(trigger, { relatedTarget: screen.getByTestId("outside") });
  fireEvent.focus(trigger);
  await waitFor(() => {
    assert.equal(screen.queryByRole("dialog")?.getAttribute("data-dismiss-layer"), "false");
  });
  fireEvent.keyDown(document, { key: "Escape" });
  assert.equal(screen.queryByRole("dialog")?.getAttribute("data-dismiss-layer"), "false", "unpinned card does not consume Escape");

  // Pin again and verify an outside pointer press dismisses the pinned card.
  fireEvent.click(trigger);
  await waitFor(() => {
    assert.equal(screen.queryByRole("dialog")?.getAttribute("data-dismiss-layer"), "");
  });
  fireEvent.pointerDown(screen.getByTestId("outside"), { button: 0, pointerType: "mouse" });
  fireEvent.mouseDown(screen.getByTestId("outside"));
  fireEvent.click(screen.getByTestId("outside"));
  await waitFor(() => {
    assert.equal(screen.queryByRole("dialog") === null, true, "outside press closes pinned card");
  });
});

test("changing machineId resets a pinned card; mobile click opens the Drawer sheet", async () => {
  setMobileMatchMedia(false);
  const clients = createClients();
  const view = renderChip("m1", clients);

  await waitFor(() => {
    assert.equal(screen.queryByTestId("runtime-usage-health-codex") !== null, true);
  });

  const trigger = screen.getByRole("button", { name: "Codex CLI" });
  fireEvent.click(trigger);
  await waitFor(() => {
    assert.equal(screen.queryByRole("dialog")?.getAttribute("data-dismiss-layer"), "");
  });

  view.rerender(
    <TestIntlProvider>
      <button type="button" data-testid="outside">Outside</button>
      <div data-testid="outside-inert">Inert background</div>
      <RuntimeAccountUsageChip
        runtimeId="codex"
        serverId="s1"
        machineId="m2"
        client={clients.usageClient}
        authClient={clients.authClient}
      >
        Codex CLI
      </RuntimeAccountUsageChip>
    </TestIntlProvider>,
  );
  await waitFor(() => {
    assert.equal(screen.queryByRole("dialog") === null, true);
  });

  cleanup();
  setMobileMatchMedia(true);
  renderChip("m1", createClients());
  await waitFor(() => {
    assert.equal(screen.queryByTestId("runtime-usage-health-codex") !== null, true);
  });

  const mobileTrigger = screen.getByRole("button", { name: "Codex CLI" });
  fireEvent.click(mobileTrigger);
  await waitFor(() => {
    assert.equal(screen.queryByTestId("runtime-usage-sheet") !== null, true);
    assert.equal(document.querySelector('[data-slot="popover-content"]') === null, true);
  });
});

test("#oar-raft:#52: a press inside a hover-opened card pins it, so its account menu (in a portal) does not close it", async () => {
  setMobileMatchMedia(false);
  renderChip();
  await waitFor(() => {
    assert.equal(screen.queryByTestId("runtime-usage-health-codex") !== null, true);
  });
  vi.useFakeTimers();
  const trigger = screen.getByRole("button", { name: "Codex CLI" });
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  await act(async () => {
    vi.advanceTimersByTime(220);
    await Promise.resolve();
  });
  const card = screen.getByRole("dialog");
  assert.equal(card.getAttribute("data-dismiss-layer"), "false", "hover-opened");

  fireEvent.pointerEnter(card, { pointerType: "mouse" });
  await act(async () => {
    fireEvent.pointerDown(screen.getByTestId("runtime-account-menu"), { pointerType: "mouse", button: 0 });
    await Promise.resolve();
  });
  assert.equal(screen.queryByRole("dialog")?.getAttribute("data-dismiss-layer"), "", "pinned by the press");

  // The pointer goes to the menu's portal: a pinned card stays.
  fireEvent.pointerLeave(screen.getByRole("dialog"), { pointerType: "mouse" });
  act(() => { vi.advanceTimersByTime(300); });
  assert.equal(screen.queryByRole("dialog") !== null, true);
});

test("#oar-raft:#52: a press on plain text inside a hover-opened card leaves it a hover card", async () => {
  setMobileMatchMedia(false);
  renderChip();
  await waitFor(() => {
    assert.equal(screen.queryByTestId("runtime-usage-health-codex") !== null, true);
  });
  vi.useFakeTimers();
  fireEvent.pointerEnter(screen.getByRole("button", { name: "Codex CLI" }), { pointerType: "mouse" });
  await act(async () => {
    vi.advanceTimersByTime(220);
    await Promise.resolve();
  });
  fireEvent.pointerEnter(screen.getByRole("dialog"), { pointerType: "mouse" });
  fireEvent.pointerDown(screen.getByTestId("runtime-account-plan"), { pointerType: "mouse", button: 0 });
  assert.equal(screen.queryByRole("dialog")?.getAttribute("data-dismiss-layer"), "false", "still a hover card");
});
