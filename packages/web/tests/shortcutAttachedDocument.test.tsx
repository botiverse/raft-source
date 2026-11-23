import "./helpers/domSetup";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { attachShortcutDocument, pushShortcutLayer, registerShortcutHandler, SHORTCUT_SCOPE_ATTRIBUTE } from "../src/features/shortcuts/dispatcher";
import type { ShortcutCommand } from "../src/features/shortcuts/registry";

// #337 object windows: an object window's document is the main page's code's
// too, so the shortcut registry hears its keys (attachShortcutDocument): the
// same scopes, its own last press for a key on its <body>, and a global
// command typed there runs as usual and then tells the source (the host
// raises the main window).

type ChildWindow = Window & typeof globalThis;

const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");

function command(id: string, scope: ShortcutCommand["scope"]): ShortcutCommand {
  return { id, scope, group: "other", defaults: { all: [{ mod: true, key: "J" }] }, label: "keyboardShortcuts.search", rebindable: false, handler: "tests" };
}

/** The jsdom windows a test made, closed after it. */
const windows: ChildWindow[] = [];

function childDocument(): { win: ChildWindow; doc: Document } {
  const win = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true }).window as unknown as ChildWindow;
  windows.push(win);
  return { win, doc: win.document };
}

/** Ctrl+J (the tests run as Windows) on `target`, from `target`'s own window; whether something took it. */
function pressCtrlJ(target: EventTarget, view: Window & typeof globalThis): boolean {
  const event = new view.KeyboardEvent("keydown", { key: "j", code: "KeyJ", ctrlKey: true, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Esc on `target`; whether something took it. */
function pressEscape(target: EventTarget, view: Window & typeof globalThis): boolean {
  const event = new view.KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
});

afterEach(() => {
  if (originalPlatform) Object.defineProperty(navigator, "platform", originalPlatform);
  else delete (navigator as { platform?: string }).platform;
  document.body.replaceChildren();
  for (const win of windows.splice(0)) win.close();
});

test("a global command typed in an attached document runs, then tells the source; detached, the document is not heard", () => {
  const { win, doc } = childDocument();
  const ran: string[] = [];
  const told: string[] = [];
  const unregister = registerShortcutHandler(command("test-global", "global"), () => () => { ran.push("global"); });
  const detach = attachShortcutDocument(doc, { onGlobalCommand: (taken) => told.push(taken.id) });
  try {
    const field = doc.createElement("div");
    doc.body.append(field);
    assert.equal(pressCtrlJ(field, win), true, "taken in the object window");
    assert.deepEqual(ran, ["global"]);
    assert.deepEqual(told, ["test-global"]);

    // The main document's keys run the command and tell no object window.
    assert.equal(pressCtrlJ(document.body, window as ChildWindow), true);
    assert.deepEqual(ran, ["global", "global"]);
    assert.deepEqual(told, ["test-global"]);

    detach();
    assert.equal(pressCtrlJ(field, win), false, "detached: not heard");
    assert.deepEqual(ran, ["global", "global"]);
  } finally {
    detach();
    unregister();
  }
});

test("a scoped command takes a key in its scope in the attached document, and that is not a global command", () => {
  const { win, doc } = childDocument();
  const ran: string[] = [];
  const told: string[] = [];
  const scope = doc.createElement("section");
  scope.setAttribute(SHORTCUT_SCOPE_ATTRIBUTE, "artifact");
  const inside = doc.createElement("button");
  scope.append(inside);
  doc.body.append(scope);
  const unregisterGlobal = registerShortcutHandler(command("test-global", "global"), () => () => { ran.push("global"); });
  const unregisterArtifact = registerShortcutHandler(command("test-artifact", "artifact"), () => () => { ran.push("artifact"); }, { node: () => scope, doc });
  const detach = attachShortcutDocument(doc, { onGlobalCommand: (taken) => told.push(taken.id) });
  try {
    assert.equal(pressCtrlJ(inside, win), true);
    assert.deepEqual(ran, ["artifact"], "the scope the key is in, before global");
    assert.deepEqual(told, []);
  } finally {
    detach();
    unregisterArtifact();
    unregisterGlobal();
  }
});

test("a key on the attached document's <body> goes to the scope last pressed in that document, not the main one's", () => {
  const { win, doc } = childDocument();
  const ran: string[] = [];
  const scope = doc.createElement("section");
  scope.setAttribute(SHORTCUT_SCOPE_ATTRIBUTE, "artifact");
  const inside = doc.createElement("button");
  scope.append(inside);
  doc.body.append(scope);
  // The main window's last press is in a thread.
  const mainThread = document.createElement("div");
  mainThread.setAttribute(SHORTCUT_SCOPE_ATTRIBUTE, "thread");
  document.body.append(mainThread);
  mainThread.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));

  const unregisterThread = registerShortcutHandler(command("test-thread", "thread"), () => () => { ran.push("thread"); });
  const unregisterArtifact = registerShortcutHandler(command("test-artifact", "artifact"), () => () => { ran.push("artifact"); }, { doc });
  const detach = attachShortcutDocument(doc);
  try {
    inside.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
    assert.equal(pressCtrlJ(doc.body, win), true);
    assert.deepEqual(ran, ["artifact"], "the object window's own last press");

    assert.equal(pressCtrlJ(document.body, window as ChildWindow), true);
    assert.deepEqual(ran, ["artifact", "thread"], "the main window's body still goes to the main window's last press");
  } finally {
    detach();
    unregisterArtifact();
    unregisterThread();
  }
});

test("an ambient registration hears only keys typed in its own document", () => {
  const { win, doc } = childDocument();
  const ran: string[] = [];
  const target = doc.createElement("div");
  doc.body.append(target);
  // The object window's first, the main window's last: the latest would win if documents were not told apart.
  const unregisterChild = registerShortcutHandler(command("test-child-find", "artifact"), () => () => { ran.push("child"); }, { ambient: true, doc });
  const unregisterMain = registerShortcutHandler(command("test-main-find", "settings"), () => () => { ran.push("main"); }, { ambient: true });
  const detach = attachShortcutDocument(doc);
  try {
    assert.equal(pressCtrlJ(target, win), true);
    assert.deepEqual(ran, ["child"], "the main window's ambient (Settings' find) is not the object window's");
    assert.equal(pressCtrlJ(document.body, window as ChildWindow), true);
    assert.deepEqual(ran, ["child", "main"], "nor the object window's the main window's");

    unregisterChild();
    assert.equal(pressCtrlJ(target, win), false, "with only the main window's ambient, the object window's key goes untaken");
    assert.deepEqual(ran, ["child", "main"]);
  } finally {
    detach();
    unregisterChild();
    unregisterMain();
  }
});

test("a layer takes Esc only in its own document; a modal layer hides its own document's commands, and a main-window modal also hides global commands typed elsewhere", () => {
  const { win, doc } = childDocument();
  const ran: string[] = [];
  const target = doc.createElement("div");
  doc.body.append(target);
  const closeChildLayer = pushShortcutLayer("dialog", { doc, onEscape: () => () => { ran.push("child-esc"); } });
  const detach = attachShortcutDocument(doc);
  try {
    assert.equal(pressEscape(document.body, window as ChildWindow), false, "the object window's dialog doesn't take the main window's Esc");
    assert.deepEqual(ran, []);
    assert.equal(pressEscape(target, win), true);
    assert.deepEqual(ran, ["child-esc"]);
  } finally {
    closeChildLayer();
  }

  const unregisterGlobal = registerShortcutHandler(command("test-global", "global"), () => () => { ran.push("global"); });
  const closeMainModal = pushShortcutLayer("dialog", { modal: true });
  try {
    // Global commands act on the main window, so its modal hides them wherever the key was typed.
    assert.equal(pressCtrlJ(target, win), false, "a modal dialog in the main window hides a global command typed in the object window");
    assert.deepEqual(ran, ["child-esc"]);
    assert.equal(pressCtrlJ(document.body, window as ChildWindow), false, "and in the main window, as before");
    assert.deepEqual(ran, ["child-esc"]);
  } finally {
    closeMainModal();
  }
  try {
    assert.equal(pressCtrlJ(target, win), true, "with the main window's modal closed, the object window's global key runs");
    assert.deepEqual(ran, ["child-esc", "global"]);
  } finally {
    unregisterGlobal();
    detach();
  }
});
