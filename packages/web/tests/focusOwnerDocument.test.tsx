import "./helpers/domSetup";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { behindModalLayer, focusLost, mayTakeFocus } from "../src/utils/focusGuard";
import { requestFocus, watchFocusIntent } from "../src/utils/focusRequest";

// #337 object windows: a surface drawn in an object window has its own
// document, with its own focus. The focus rules (focusGuard) and requests
// (focusRequest) read the target's own document, wait on its window's frames
// and hear its presses, not the main window's.

type ChildWindow = Window & typeof globalThis;

/** The jsdom windows a test made, closed after it. */
const windows: ChildWindow[] = [];

function child(): { win: ChildWindow; doc: Document } {
  const win = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true }).window as unknown as ChildWindow;
  windows.push(win);
  return { win, doc: win.document };
}

function nextFrame(win: ChildWindow): Promise<void> {
  return new Promise((resolve) => win.requestAnimationFrame(() => resolve()));
}

afterEach(() => {
  (document.activeElement as HTMLElement | null)?.blur?.();
  document.body.replaceChildren();
  for (const win of windows.splice(0)) win.close();
});

test("mayTakeFocus and focusLost read the target's own document", () => {
  const { doc } = child();
  const mainField = document.createElement("input");
  document.body.append(mainField);
  mainField.focus();
  const target = doc.createElement("button");
  const childField = doc.createElement("input");
  doc.body.append(target, childField);

  assert.equal(mayTakeFocus(target), true, "a field focused in the main window takes nothing from the object window");
  assert.equal(focusLost(target), true, "nothing has the focus in the object window");

  childField.focus();
  assert.equal(mayTakeFocus(target), false, "a field focused in its own document is the person's");
  assert.equal(focusLost(target), false);
  assert.equal(mayTakeFocus(mainField), true, "and the main window's target reads the main document");
});

test("behindModalLayer reads the modal layer holding the focus in the target's own document", () => {
  const { doc } = child();
  const layer = doc.createElement("div");
  layer.setAttribute("aria-modal", "true");
  const inLayer = doc.createElement("button");
  layer.append(inLayer);
  const behind = doc.createElement("button");
  doc.body.append(layer, behind);
  const mainTarget = document.createElement("button");
  document.body.append(mainTarget);

  inLayer.focus();
  assert.equal(behindModalLayer(behind), true);
  assert.equal(behindModalLayer(inLayer), false);
  assert.equal(behindModalLayer(mainTarget), false, "the object window's modal layer hides nothing in the main window");
});

test("requestFocus focuses a target in another document, over a field focused in the main window", () => {
  const { doc } = child();
  const mainField = document.createElement("input");
  document.body.append(mainField);
  mainField.focus();
  const target = doc.createElement("button");
  doc.body.append(target);

  requestFocus(() => target, { reason: "mount" });
  assert.ok(doc.activeElement === target);
  assert.ok(document.activeElement === mainField, "the main window's focus is its own");
});

test("requestFocus for a target not there yet waits for its document's window's frame; a press there cancels it", async () => {
  const { win, doc } = child();
  let late: HTMLButtonElement | null = null;
  requestFocus(() => late, { reason: "user", doc });
  late = doc.createElement("button");
  doc.body.append(late);
  await nextFrame(win);
  assert.ok(doc.activeElement === late, "tried again on the object window's next frame");

  late.blur();
  let cancelled: HTMLButtonElement | null = null;
  requestFocus(() => cancelled, { reason: "user", doc });
  doc.body.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
  cancelled = doc.createElement("button");
  doc.body.append(cancelled);
  await nextFrame(win);
  assert.ok(doc.activeElement !== cancelled, "the person's press in that document cancelled it");
});

test("watchFocusIntent hears presses in the scope's own document", () => {
  const { win, doc } = child();
  const scope = doc.createElement("section");
  const button = doc.createElement("button");
  scope.append(button);
  doc.body.append(scope);

  const stillWanted = watchFocusIntent(() => scope);
  document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  button.focus();
  assert.equal(stillWanted(), true, "a press in the main window is not one in the object window; focus is in the scope");

  const cancelled = watchFocusIntent(() => scope);
  doc.body.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
  assert.equal(cancelled(), false, "a press in the object window cancels it");
});
