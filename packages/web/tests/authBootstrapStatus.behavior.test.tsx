import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, test, vi } from "vitest";

import { AuthBootstrapStatus } from "../src/components/auth/AuthBootstrapStatus";
import { useAuthStore } from "../src/store/authStore";
import { MAX_AUTH_RESTORE_MS } from "../src/utils/authRestoreMachine";
import { TestIntlProvider } from "./helpers/intl";

// #triage:#393: "Restoring session…" waited with no end while /auth/me kept
// failing (a timer never signs anyone out). Past MAX_AUTH_RESTORE_MS the
// screen offers the way out: Try again (reload) and Sign out.

const originalLogout = useAuthStore.getState().logout;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAuthStore.setState({ logout: originalLogout });
});

let reloads = 0;
const countReload = () => { reloads += 1; };
function renderStatus(view: "loading" | "restoring") {
  reloads = 0;
  return render(<TestIntlProvider><AuthBootstrapStatus view={view} reload={countReload} /></TestIntlProvider>);
}

test("restoring: no actions before the restore limit, Try again and Sign out after it", () => {
  vi.useFakeTimers();
  renderStatus("restoring");
  assert.equal(screen.queryByTestId("auth-restore-retry") === null, true, "no actions yet");
  act(() => { vi.advanceTimersByTime(MAX_AUTH_RESTORE_MS - 1); });
  assert.equal(screen.queryByTestId("auth-restore-retry") === null, true, "still no actions just before the limit");
  act(() => { vi.advanceTimersByTime(1); });
  assert.equal(screen.getByTestId("auth-restore-retry").textContent, "Try again");
  assert.equal(screen.getByTestId("auth-restore-sign-out").textContent, "Sign out");
  assert.equal(screen.getByText("This is taking longer than usual.") !== null, true);
});

test("restoring: Sign out signs out as the person's own choice, then reloads", () => {
  vi.useFakeTimers();
  const triggers: unknown[] = [];
  useAuthStore.setState({ logout: (trigger?: unknown) => { triggers.push(trigger); } } as never);
  renderStatus("restoring");
  act(() => { vi.advanceTimersByTime(MAX_AUTH_RESTORE_MS); });
  fireEvent.click(screen.getByTestId("auth-restore-sign-out"));
  assert.deepEqual(triggers, ["explicit_user_logout"]);
  // A fresh page, so a restore request still in flight cannot bring the session back.
  assert.equal(reloads, 1);
});

test("restoring: Try again reloads the page and does not sign out", () => {
  vi.useFakeTimers();
  const triggers: unknown[] = [];
  useAuthStore.setState({ logout: (trigger?: unknown) => { triggers.push(trigger); } } as never);
  renderStatus("restoring");
  act(() => { vi.advanceTimersByTime(MAX_AUTH_RESTORE_MS); });
  fireEvent.click(screen.getByTestId("auth-restore-retry"));
  assert.equal(reloads, 1);
  assert.deepEqual(triggers, []);
});

test("loading never offers the actions", () => {
  vi.useFakeTimers();
  renderStatus("loading");
  act(() => { vi.advanceTimersByTime(MAX_AUTH_RESTORE_MS * 2); });
  assert.equal(screen.queryByTestId("auth-restore-retry") === null, true);
});
