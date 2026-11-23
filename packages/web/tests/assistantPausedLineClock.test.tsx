import assert from "node:assert/strict";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useAssistantPausedLine } from "../src/assistant/AssistantPaused";
import { TestIntlProvider } from "./helpers/intl";

// Review of task #441: "Paused by X · 2 minutes ago" was worked out from the
// clock at render and kept current only because the layout rendered the page
// often. The main column no longer renders with the layout, so the line reads
// the live clock itself.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("a paused assistant's line moves with the clock without anything rendering it", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-16T12:00:00.000Z"));
  let renders = 0;
  const wrapper = ({ children }: { children: ReactNode }) => <TestIntlProvider>{children}</TestIntlProvider>;
  const line = renderHook(() => {
    renders += 1;
    return useAssistantPausedLine("2026-11-16T11:58:00.000Z", { name: "Ada" } as never);
  }, { wrapper });
  assert.match(line.result.current, /Ada/);
  assert.match(line.result.current, /2 minutes ago/);
  const rendersAtMount = renders;

  // The clock's tick (it also ticks when the page is shown again) with the same words renders nothing.
  act(() => { document.dispatchEvent(new window.Event("visibilitychange")); });
  assert.equal(renders, rendersAtMount);

  vi.setSystemTime(new Date("2026-11-16T12:03:00.000Z"));
  act(() => { document.dispatchEvent(new window.Event("visibilitychange")); });
  assert.match(line.result.current, /5 minutes ago/);
});
