// Which pane of the workspace holds the keyboard focus (components/layout paneFocus.ts), the one source the shell's
// pane keys read (apps/desktop paneKeys.ts): the browser pane's frame takes Cmd+R / Cmd+W for its tab wherever in it
// the focus is, the new-tab page included. Needs a DOM: run with RAFT_WEB_TEST_DOM=1.
import "./helpers/domSetup";
import { act, useRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { DesktopPaneFocus } from "@botiverse/raft-shared";

import { PANE_KIND_ATTRIBUTE, reportedPaneFocus, usePaneFrame } from "../src/components/layout/paneFocus";

let told: Array<DesktopPaneFocus | null> = [];

function Pane({ owner = "c1", tabId = "t1" }: { owner?: string; tabId?: string | null }) {
  const ref = useRef<HTMLElement | null>(null);
  usePaneFrame(ref, "browser", owner, tabId);
  return (
    <section ref={ref} tabIndex={-1} data-testid="pane">
      <input data-testid="address" />
      <div data-testid="new-tab">New tab</div>
    </section>
  );
}

function Window({ pane = true, tabId = "t1" }: { pane?: boolean; tabId?: string | null }) {
  return (
    <>
      <button data-testid="outside">Channel</button>
      {pane ? <Pane tabId={tabId} /> : null}
    </>
  );
}

beforeEach(() => {
  told = [];
  (window as unknown as { raftDesktop?: unknown }).raftDesktop = { paneFocus: { set: (focus: DesktopPaneFocus | null) => told.push(focus) } };
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { raftDesktop?: unknown }).raftDesktop;
});

it("says the browser pane has the focus wherever in its frame it is, and no pane once it leaves the frame", () => {
  render(<Window />);
  expect(screen.getByTestId("pane").getAttribute(PANE_KIND_ATTRIBUTE)).toBe("browser");
  expect(told).toEqual([]);
  act(() => screen.getByTestId("pane").focus());
  expect(told).toEqual([{ kind: "browser", owner: "c1", tabId: "t1" }]);
  // Within the frame (the address row): no change, nothing told.
  act(() => screen.getByTestId("address").focus());
  expect(told).toHaveLength(1);
  act(() => screen.getByTestId("outside").focus());
  expect(told.at(-1)).toBeNull();
  expect(reportedPaneFocus()).toBeNull();
});

it("follows the tab in front while the focus is in the pane", () => {
  const { rerender } = render(<Window />);
  act(() => screen.getByTestId("address").focus());
  rerender(<Window tabId="t2" />);
  expect(told.at(-1)).toEqual({ kind: "browser", owner: "c1", tabId: "t2" });
});

it("releases the pane when it unmounts with the focus in it, without waiting for a blur", () => {
  const { rerender } = render(<Window />);
  act(() => screen.getByTestId("address").focus());
  expect(told.at(-1)).toEqual({ kind: "browser", owner: "c1", tabId: "t1" });
  rerender(<Window pane={false} />);
  expect(told.at(-1)).toBeNull();
  // Focus coming back to the app's own UI keeps it none.
  act(() => screen.getByTestId("outside").focus());
  expect(told.at(-1)).toBeNull();
});

it("tells a shell that predates pane keys nothing, and does not break", () => {
  (window as unknown as { raftDesktop?: unknown }).raftDesktop = {};
  render(<Window />);
  expect(() => act(() => screen.getByTestId("pane").focus())).not.toThrow();
  expect(told).toEqual([]);
});
