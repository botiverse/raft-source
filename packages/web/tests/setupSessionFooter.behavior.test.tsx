import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import SetupSessionFooter from "../src/components/onboarding/SetupSessionFooter";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const render: typeof rtlRender = (ui, options) =>
  rtlRender(ui, { wrapper: TestIntlProvider, ...options });

const originalClearCurrent = useServerStore.getState().clearCurrent;

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
  useServerStore.setState({ clearCurrent: originalClearCurrent });
});

test("setup escape link navigates to the Choose server page without logging out", () => {
  let clearCurrentCalls = 0;
  useServerStore.setState({
    clearCurrent: () => {
      clearCurrentCalls += 1;
    },
  });

  window.history.replaceState({}, "", "/s/test/setup");
  render(<SetupSessionFooter />);

  fireEvent.click(screen.getByTestId("setup-switch-server"));
  assert.equal(clearCurrentCalls, 1);
  assert.equal(window.location.pathname, "/servers");
  assert.equal(screen.queryByTestId("setup-log-out"), null);
});

test("setup escape link is disabled with the owning setup action", () => {
  render(<SetupSessionFooter disabled />);

  assert.equal((screen.getByTestId("setup-switch-server") as HTMLButtonElement).disabled, true);
  assert.equal(screen.queryByTestId("setup-start-over"), null);
});
