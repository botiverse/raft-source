// @ts-nocheck
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import NotificationTrigger from "../src/components/layout/NotificationTrigger";
import type { NotificationEntry } from "../src/components/layout/useSystemNotifications";
import { TestIntlProvider } from "./helpers/intl";

const unread: NotificationEntry[] = [
  {
    id: "needs-attention",
    kind: "warning",
    title: "Needs attention",
    body: "Review this notification.",
  },
];

function renderTrigger(
  flavor: "rail-bottom" | "mobile-navbar",
  notifications: NotificationEntry[],
  direction: "ltr" | "rtl" = "ltr",
) {
  return render(
    <MemoryRouter>
      <TestIntlProvider>
        <div dir={direction}>
          <NotificationTrigger flavor={flavor} notifications={notifications} />
        </div>
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

test("the permanent rail Bell opens an empty drawer without an unread dot", () => {
  renderTrigger("rail-bottom", []);

  const trigger = screen.getByTestId("notification-trigger-rail");
  assert.equal(trigger.getAttribute("aria-label"), "Notification center");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(trigger.getAttribute("data-state"), "closed");
  assert.equal(trigger.getAttribute("data-has-unread"), "false");
  assert.equal(screen.queryByTestId("notification-trigger-rail-unread-dot"), null);
  assert.match(trigger.className, /border-transparent/);
  assert.doesNotMatch(trigger.className, /shadow-brutal-sm/);

  fireEvent.click(trigger);

  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(trigger.getAttribute("data-state"), "open");
  assert.match(trigger.className, /border-black/);
  assert.match(trigger.className, /shadow-brutal-sm/);
  assert.ok(screen.getByRole("dialog", { name: "Notification center" }));
  assert.ok(screen.getByText("No notifications right now"));
  assert.ok(screen.getByText("You'll see things here that need your attention."));
});

test("unread attention and open disclosure remain independent states", () => {
  const { rerender } = renderTrigger("rail-bottom", unread);

  const trigger = screen.getByTestId("notification-trigger-rail");
  assert.equal(trigger.getAttribute("aria-label"), "Notification center (1 active)");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(trigger.getAttribute("data-state"), "closed");
  assert.equal(trigger.getAttribute("data-has-unread"), "true");
  assert.match(trigger.className, /border-transparent/);
  assert.doesNotMatch(trigger.className, /shadow-brutal-sm/);

  const dot = screen.getByTestId("notification-trigger-rail-unread-dot");
  assert.equal(dot.getAttribute("aria-hidden"), "true");
  assert.match(dot.className, /-end-1/);
  assert.match(dot.className, /-top-1/);
  assert.doesNotMatch(dot.className, /-(?:left|right)-/);
  assert.equal(dot.parentElement?.classList.contains("relative"), true, "dot anchors to the Bell, not the button edge");

  fireEvent.click(trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(trigger.getAttribute("data-state"), "open");
  assert.ok(screen.getByText("Needs attention"));

  rerender(
    <MemoryRouter>
      <TestIntlProvider>
        <div dir="ltr">
          <NotificationTrigger flavor="rail-bottom" notifications={[]} />
        </div>
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.equal(trigger.getAttribute("aria-expanded"), "true", "draining the last row must not close the drawer");
  assert.equal(trigger.getAttribute("data-has-unread"), "false");
  assert.equal(screen.queryByTestId("notification-trigger-rail-unread-dot"), null);
  assert.ok(screen.getByText("No notifications right now"));
});

test("desktop popover trigger keeps its counted aria label without also rendering a Tooltip trigger", () => {
  renderTrigger("rail-bottom", unread);

  const trigger = screen.getByTestId("notification-trigger-rail");
  assert.equal(trigger.getAttribute("aria-label"), "Notification center (1 active)");
  assert.equal(trigger.getAttribute("title"), null, "rail trigger must use raft-ui Tooltip instead of native title");
  assert.equal(trigger.getAttribute("data-slot"), "popover-trigger");
  assert.equal(trigger.hasAttribute("data-base-ui-tooltip-trigger"), false);
});

test("mobile keeps the Bell but not Help semantics, and RTL keeps the dot inside the icon anchor", () => {
  renderTrigger("mobile-navbar", unread, "rtl");

  const trigger = screen.getByTestId("notification-trigger-mobile");
  const dot = screen.getByTestId("notification-trigger-mobile-unread-dot");
  assert.equal(trigger.getAttribute("data-state"), "closed");
  assert.equal(trigger.getAttribute("data-has-unread"), "true");
  assert.match(trigger.className, /size-8/);
  assert.match(dot.className, /-end-1/);
  assert.doesNotMatch(dot.className, /-(?:left|right)-/);
  assert.equal(dot.parentElement?.parentElement, trigger, "dot remains inside the viewport-safe button box");

  fireEvent.click(trigger);
  assert.ok(screen.getByRole("dialog", { name: "Notification center" }));
});
