import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, render, screen } from "@testing-library/react";
import { toast } from "@botiverse/raft-ui";
import LocalizedToastProvider from "../src/components/LocalizedToastProvider";
import { TestIntlProvider } from "./helpers/intl";

// One toast at a time: a newer toast takes the older one's place. The viewport
// sits on the page's floor and lays its toasts out in flow, newest first, so a
// closing toast that kept its slot while it fades would hold the newer one a
// slot above it, and the newer one would drop when it went (an Activity row's
// Done twice in quick succession: "Marked as done" jumping). The closing toast
// leaves the flow as it starts to close and fades where it was, under the newer.

// jsdom runs no transitions, so a closing toast would go at once. Hold every
// toast's exit as a browser does for its 220ms fade, until the test is done.
let releaseExits: () => void = () => {};
beforeEach(() => {
  const exits = new Promise<void>((resolve) => {
    releaseExits = resolve;
  });
  const fade = { finished: exits, pending: false, playState: "running", effect: { getTiming: () => ({ duration: 220, iterations: 1 }) } };
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [fade] });
});

afterEach(() => {
  act(() => toast.dismiss());
  releaseExits();
  cleanup();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

function rowOf(title: string): HTMLElement {
  const row = screen.getByText(title).closest<HTMLElement>("[data-testid='localized-toast-row']");
  assert.ok(row, `no toast row for ${title}`);
  return row;
}

const classesOf = (element: HTMLElement) => element.className.split(/\s+/);

test("a toast replacing a closing one takes its place: the closing one leaves the flow", () => {
  render(
    <TestIntlProvider>
      <LocalizedToastProvider>
        <div />
      </LocalizedToastProvider>
    </TestIntlProvider>,
  );

  let first = "";
  act(() => {
    first = toast.success("First done", { action: { label: "Undo" } });
  });
  assert.equal(classesOf(rowOf("First done")).includes("absolute"), false, "a showing toast is laid out in flow");

  // As activitySwipeActions' flush-then-toast does: close the older, show the newer.
  act(() => {
    toast.dismiss(first);
    toast.success("Second done", { action: { label: "Undo" } });
  });

  const rows = screen.getAllByTestId("localized-toast-row");
  const closing = rowOf("First done");
  const showing = rowOf("Second done");
  assert.equal(rows.length, 2, "the older toast is still fading out");
  assert.ok(rows[0] === showing && rows[1] === closing, "newest first");
  assert.ok(classesOf(closing).includes("absolute"), "the closing toast is out of flow, holding no slot under the newer");
  assert.equal(classesOf(closing).includes("relative"), false, "its in-flow position gives way");
  assert.ok(classesOf(closing).includes("bottom-0"), "and fades on the viewport's floor, where the newer one sits");
  assert.ok(classesOf(closing).includes("pointer-events-none"), "and never takes a press meant for the newer one's Undo");
  assert.equal(classesOf(showing).includes("absolute"), false, "the newer toast is in flow, on the floor");
});
