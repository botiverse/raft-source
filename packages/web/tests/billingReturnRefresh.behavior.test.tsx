import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useBillingReturnRefresh } from "../src/hooks/useBillingReturnRefresh";
import { useServerStore } from "../src/store/serverStore";

// Raft Desktop opens Stripe in the system browser and the page stays: once
// Stripe was opened, every return to the window refetches billing and usage
// (the backstop for server:plan-updated). Before that, focus does nothing.

const initial = useServerStore.getState();
afterEach(() => {
  cleanup();
  useServerStore.setState(initial, true);
});

test("focus refetches billing only after Stripe was opened, and on every return", () => {
  const calls: string[] = [];
  useServerStore.setState({
    loadBilling: async () => { calls.push("billing"); },
    loadUsage: async () => { calls.push("usage"); },
  } as never);
  const { result } = renderHook(() => useBillingReturnRefresh());
  act(() => { window.dispatchEvent(new window.Event("focus")); });
  assert.deepEqual(calls, [], "no Stripe yet: nothing to refetch");
  act(() => result.current());
  act(() => { window.dispatchEvent(new window.Event("focus")); });
  act(() => { window.dispatchEvent(new window.Event("focus")); });
  assert.deepEqual(calls, ["billing", "usage", "billing", "usage"]);
});
