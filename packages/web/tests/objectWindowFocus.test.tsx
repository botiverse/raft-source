import "./helpers/domSetup";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { cleanup, render } from "@testing-library/react";
import { ObjectWindowFocus } from "../src/features/objectWindows/ObjectWindowFocus";
import { installObjectWindowFocus, restoreOpenerFocus } from "../src/features/objectWindows/objectWindowFocusWiring";
import { resetObjectWindowsForTests, useObjectWindowStore } from "../src/features/objectWindows/objectWindowStore";
import type { ObjectWindowEntry } from "../src/features/objectWindows/objectWindowStore";

// #337 object windows, focus (Kirby's review item 5; Kaze's keepKeyboard):
// a window coming back to the front gives the keyboard to its document, not
// to the element that had it, so that element is remembered on the window's
// blur and focused again on its focus; a window closing gives the focus back
// to the element it was opened from in the main window.

type ChildWindow = Window & typeof globalThis;

/** The jsdom windows a test made, closed after it. */
const windows: ChildWindow[] = [];

function child(): { win: ChildWindow; doc: Document } {
  const win = new JSDOM("<!doctype html><html><body><input id='field'><button id='other'>Other</button></body></html>", { pretendToBeVisual: true }).window as unknown as ChildWindow;
  windows.push(win);
  return { win, doc: win.document };
}

function blurWindow(win: ChildWindow) {
  win.dispatchEvent(new win.FocusEvent("blur"));
}

function focusWindow(win: ChildWindow) {
  win.dispatchEvent(new win.FocusEvent("focus"));
}

afterEach(() => {
  cleanup();
  resetObjectWindowsForTests();
  document.body.replaceChildren();
  for (const win of windows.splice(0)) win.close();
});

test("the element focused when the window lost the focus gets it back when the window does", () => {
  const { win, doc } = child();
  const stop = installObjectWindowFocus(win, doc);
  try {
    const field = doc.getElementById("field") as HTMLInputElement;
    field.focus();
    blurWindow(win);
    // Activating the window again puts the focus on its document, not the field.
    field.blur();
    assert.ok(doc.activeElement === doc.body);
    focusWindow(win);
    assert.ok(doc.activeElement === field, "the field has the focus again");
  } finally {
    stop();
  }
});

test("nothing is restored over a focus that moved meanwhile, to an element that left, or once stopped", () => {
  const { win, doc } = child();
  const stop = installObjectWindowFocus(win, doc);
  const field = doc.getElementById("field") as HTMLInputElement;
  const other = doc.getElementById("other") as HTMLButtonElement;

  field.focus();
  blurWindow(win);
  other.focus();
  focusWindow(win);
  assert.ok(doc.activeElement === other, "the focus the person (or the object) put elsewhere stays");

  field.focus();
  blurWindow(win);
  field.remove();
  other.blur();
  focusWindow(win);
  assert.ok(doc.activeElement === doc.body, "a removed element takes nothing");

  doc.body.append(field);
  field.focus();
  blurWindow(win);
  stop();
  field.blur();
  focusWindow(win);
  assert.ok(doc.activeElement === doc.body, "stopped");
});

test("restoreOpenerFocus gives the focus back to the opener in the main window only when focus there was lost", () => {
  const opener = document.createElement("button");
  const field = document.createElement("input");
  document.body.append(opener, field);

  assert.equal(restoreOpenerFocus(opener), true);
  assert.ok(document.activeElement === opener);

  field.focus();
  assert.equal(restoreOpenerFocus(opener), false, "focus the person put in a field stays there");
  assert.ok(document.activeElement === field);

  field.blur();
  opener.remove();
  assert.equal(restoreOpenerFocus(opener), false, "an opener that left takes nothing");
  assert.equal(restoreOpenerFocus(null), false);
});

test("ObjectWindowFocus: the window closing (gone from the store) gives the focus back to its opener; a remount does not", () => {
  const { win, doc } = child();
  const opener = document.createElement("button");
  document.body.append(opener);
  const entry: ObjectWindowEntry = {
    name: "raft-object-window-1",
    kind: "demo",
    payload: null,
    win,
    doc,
    root: doc.body,
    openedFrom: new WeakRef(opener),
    revision: 0,
  };

  // Still open: unmounting the portal (a remount) leaves the focus alone.
  useObjectWindowStore.setState({ windows: new Map([[entry.name, entry]]) });
  const first = render(<ObjectWindowFocus entry={entry} />);
  first.unmount();
  assert.ok(document.activeElement === document.body);

  // Closed: removed from the store, then unmounted.
  const second = render(<ObjectWindowFocus entry={entry} />);
  useObjectWindowStore.setState({ windows: new Map() });
  second.unmount();
  assert.ok(document.activeElement === opener, "back on the row it was opened from");
});
