import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import MessageSelectionShortcut from "../src/components/message/MessageSelectionShortcut";
import {
  getMessageSelectionShortcutTarget,
  placeMessageSelectionShortcut,
} from "../src/components/message/messageSelectionShortcutUtils";
import type {
  RectLike,
} from "../src/components/message/messageSelectionShortcutUtils";
import { SELECTED_TEXT_QUOTE_EVENT } from "../src/components/message/selectedTextQuote";
import type { SelectedTextQuoteDetail } from "../src/components/message/selectedTextQuote";
import { renderWithIntl } from "./helpers/intl";

const RECT: RectLike = { left: 40, top: 80, right: 120, bottom: 100, width: 80, height: 20 };

function installRangeRect(range: Range, rect: RectLike = RECT, boundingRect: RectLike = rect, rects: RectLike[] = [rect]) {
  Object.defineProperty(range, "getClientRects", {
    configurable: true,
    value: () => rects,
  });
  Object.defineProperty(range, "getBoundingClientRect", {
    configurable: true,
    value: () => boundingRect,
  });
}

function createSelectableMessage({
  text = "selected message text",
  quoteChannelId = "thread-1",
  messageId = "msg-1",
}: {
  text?: string;
  quoteChannelId?: string;
  messageId?: string;
} = {}) {
  const body = document.createElement("div");
  body.dataset.messageSelectable = "true";
  body.dataset.quoteChannelId = quoteChannelId;
  body.dataset.messageId = messageId;
  const textNode = document.createTextNode(text);
  body.append(textNode);
  document.body.append(body);
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, text.length);
  installRangeRect(range);
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: textNode,
    focusNode: textNode,
    getRangeAt: () => range,
    toString: () => text,
  } as unknown as Selection;

  return { body, range, selection, textNode };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

test("resolves selected text inside one message body with quote routing metadata", () => {
  const { range, selection } = createSelectableMessage({ text: "hello selection", quoteChannelId: "quote-channel", messageId: "message-123" });
  installRangeRect(
    range,
    { left: 40, top: 112, right: 90, bottom: 132, width: 50, height: 20 },
    { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    [
      { left: 100, top: 80, right: 180, bottom: 100, width: 80, height: 20 },
      { left: 40, top: 112, right: 90, bottom: 132, width: 50, height: 20 },
      { left: 0, top: 0, right: 0, bottom: 20, width: 0, height: 20 },
    ],
  );

  assert.deepEqual(getMessageSelectionShortcutTarget(selection), {
    messageId: "message-123",
    quoteChannelId: "quote-channel",
    text: "hello selection",
    anchorRect: { left: 40, top: 112, right: 90, bottom: 132, width: 50, height: 20 },
    selectionRect: { left: 40, top: 80, right: 180, bottom: 132, width: 140, height: 52 },
  });
});

test("rejects selections spanning multiple message bodies", () => {
  const first = createSelectableMessage({ text: "first", quoteChannelId: "first-channel" });
  const second = createSelectableMessage({ text: "second", quoteChannelId: "second-channel" });
  const range = document.createRange();
  range.setStart(first.textNode, 0);
  range.setEnd(second.textNode, 3);
  installRangeRect(range);
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: first.textNode,
    focusNode: second.textNode,
    getRangeAt: () => range,
    toString: () => "first second",
  } as unknown as Selection;

  assert.equal(getMessageSelectionShortcutTarget(selection), null);
});

test("accepts a whole-paragraph selection whose browser endpoint lands just outside one message body", () => {
  const outer = document.createElement("div");
  document.body.append(outer);
  const { body, textNode } = createSelectableMessage({
    text: "whole message",
    quoteChannelId: "whole-channel",
    messageId: "whole-message",
  });
  outer.append(body);
  outer.append(createSelectableMessage({ text: "next message" }).body);

  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(outer, 1);
  installRangeRect(range);
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: textNode,
    focusNode: outer,
    getRangeAt: () => range,
    toString: () => "whole message\n\n",
  } as unknown as Selection;

  assert.deepEqual(getMessageSelectionShortcutTarget(selection), {
    messageId: "whole-message",
    quoteChannelId: "whole-channel",
    text: "whole message",
    anchorRect: RECT,
    selectionRect: RECT,
  });
});

test("rejects a boundary selection when its range intersects more than one message body", () => {
  const outer = document.createElement("div");
  document.body.append(outer);
  const first = createSelectableMessage({ text: "first", quoteChannelId: "first-channel" });
  const second = createSelectableMessage({ text: "second", quoteChannelId: "second-channel" });
  outer.append(first.body, second.body);

  const range = document.createRange();
  range.setStart(first.textNode, 0);
  range.setEnd(outer, 2);
  installRangeRect(range);
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: first.textNode,
    focusNode: outer,
    getRangeAt: () => range,
    toString: () => "first second",
  } as unknown as Selection;

  assert.equal(getMessageSelectionShortcutTarget(selection), null);
});

test("fails closed when a browser cannot test the boundary range intersection", () => {
  const outer = document.createElement("div");
  document.body.append(outer);
  const { body, textNode } = createSelectableMessage({ text: "whole message" });
  outer.append(body);

  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(outer, 1);
  installRangeRect(range);
  Object.defineProperty(range, "intersectsNode", {
    configurable: true,
    value: () => {
      throw new DOMException("unsupported");
    },
  });
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: textNode,
    focusNode: outer,
    getRangeAt: () => range,
    toString: () => "whole message",
  } as unknown as Selection;

  assert.equal(getMessageSelectionShortcutTarget(selection), null);
});

test("rejects editable selections", () => {
  const input = document.createElement("textarea");
  input.value = "editable";
  document.body.append(input);
  const textNode = document.createTextNode("editable");
  input.append(textNode);
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: textNode,
    focusNode: textNode,
    toString: () => "editable",
  } as unknown as Selection;

  assert.equal(getMessageSelectionShortcutTarget(selection), null);
});

test("places the shortcut above the selection when there is room, otherwise below", () => {
  assert.deepEqual(
    placeMessageSelectionShortcut({
      anchorRect: { left: 100, top: 100, right: 180, bottom: 120, width: 80, height: 20 },
      floatingSize: { width: 120, height: 36 },
      viewport: { width: 320, height: 240 },
    }),
    { x: 80, y: 56 },
  );

  assert.deepEqual(
    placeMessageSelectionShortcut({
      anchorRect: { left: 0, top: 12, right: 40, bottom: 32, width: 40, height: 20 },
      floatingSize: { width: 120, height: 36 },
      viewport: { width: 160, height: 240 },
    }),
    { x: 8, y: 40 },
  );
});

test("places the shortcut around the full selected range instead of over selected text", () => {
  assert.deepEqual(
    placeMessageSelectionShortcut({
      anchorRect: { left: 100, top: 150, right: 180, bottom: 170, width: 80, height: 20 },
      avoidRect: { left: 80, top: 80, right: 220, bottom: 170, width: 140, height: 90 },
      floatingSize: { width: 120, height: 36 },
      viewport: { width: 320, height: 240 },
    }),
    { x: 90, y: 36 },
  );

  assert.deepEqual(
    placeMessageSelectionShortcut({
      anchorRect: { left: 0, top: 50, right: 40, bottom: 70, width: 40, height: 20 },
      avoidRect: { left: 0, top: 12, right: 80, bottom: 70, width: 80, height: 58 },
      floatingSize: { width: 120, height: 36 },
      viewport: { width: 160, height: 240 },
    }),
    { x: 8, y: 78 },
  );
});

test("does not show the selection shortcut on mobile viewports", async () => {
  const { selection } = createSelectableMessage({ text: "mobile selection", quoteChannelId: "composer-channel" });
  const prevGetSelection = window.getSelection;
  const prevMatchMedia = window.matchMedia;
  const prevInnerWidth = window.innerWidth;
  Object.defineProperty(window, "getSelection", {
    configurable: true,
    value: () => selection,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: true }),
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });

  try {
    renderWithIntl(<MessageSelectionShortcut />);
    document.dispatchEvent(new window.Event("selectionchange"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(screen.queryByRole("menu", { name: "Selected text actions" }), null);
  } finally {
    Object.defineProperty(window, "getSelection", { configurable: true, value: prevGetSelection });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: prevMatchMedia });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: prevInnerWidth });
  }
});

test("only a browser final triple-click rechecks an already-settled selection", async () => {
  const { body, selection } = createSelectableMessage({
    text: "final triple-click selection",
    quoteChannelId: "composer-channel",
  });
  const prevGetSelection = window.getSelection;
  Object.defineProperty(window, "getSelection", {
    configurable: true,
    value: () => selection,
  });

  try {
    renderWithIntl(<MessageSelectionShortcut />);

    await act(async () => {
      fireEvent.click(body, { detail: 2 });
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    assert.equal(screen.queryByRole("menu", { name: "Selected text actions" }), null);

    fireEvent.click(body, { detail: 3 });
    await waitFor(() => {
      assert.ok(screen.getByRole("menu", { name: "Selected text actions" }));
    });
  } finally {
    Object.defineProperty(window, "getSelection", { configurable: true, value: prevGetSelection });
  }
});

test("final triple-click snapshots the browser selection before later layout work clears it", async () => {
  const { body, selection } = createSelectableMessage({
    text: "transient final triple-click selection",
    quoteChannelId: "composer-channel",
  });
  const prevGetSelection = window.getSelection;
  let activeSelection: Selection | null = selection;
  Object.defineProperty(window, "getSelection", {
    configurable: true,
    value: () => activeSelection,
  });

  try {
    renderWithIntl(<MessageSelectionShortcut />);

    await act(async () => {
      fireEvent.mouseUp(body, { detail: 3 });
      fireEvent.click(body, { detail: 3 });
      activeSelection = null;
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    assert.ok(screen.getByRole("menu", { name: "Selected text actions" }));
  } finally {
    Object.defineProperty(window, "getSelection", { configurable: true, value: prevGetSelection });
  }
});

test("selection shortcut actions stay closed while the native selection survives", async () => {
  const quoteMessage = createSelectableMessage({ text: "quote me", quoteChannelId: "composer-channel" });
  const copyMessage = createSelectableMessage({
    text: "copy me",
    quoteChannelId: "composer-channel",
    messageId: "copy-message",
  });
  const prevGetSelection = window.getSelection;
  const prevCustomEvent = globalThis.CustomEvent;
  const selectionClears: string[] = [];
  for (const selection of [quoteMessage.selection, copyMessage.selection]) {
    (selection as Selection & { removeAllRanges: () => void }).removeAllRanges = () => {
      selectionClears.push("clear");
    };
  }
  let activeSelection = quoteMessage.selection;
  Object.defineProperty(window, "getSelection", {
    configurable: true,
    value: () => activeSelection,
  });
  Object.defineProperty(globalThis, "CustomEvent", {
    configurable: true,
    value: window.CustomEvent,
  });
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text); } },
  });
  const received: SelectedTextQuoteDetail[] = [];
  const onQuote = (event: Event) => received.push((event as CustomEvent<SelectedTextQuoteDetail>).detail);
  window.addEventListener(SELECTED_TEXT_QUOTE_EVENT, onQuote);

  try {
    renderWithIntl(<MessageSelectionShortcut />);
    document.dispatchEvent(new window.Event("selectionchange"));

    await waitFor(() => {
      assert.ok(screen.getByRole("menu", { name: "Selected text actions" }));
    });

    const quoteButton = screen.getByRole("menuitem", { name: "Quote" });
    fireEvent.pointerDown(quoteButton);
    fireEvent.mouseDown(quoteButton);
    fireEvent.mouseUp(quoteButton);
    fireEvent.click(quoteButton, { detail: 1 });
    assert.deepEqual(received, [{ channelId: "composer-channel", quote: "> quote me" }]);
    await waitFor(() => {
      assert.equal(screen.queryByRole("menu", { name: "Selected text actions" }), null);
    });
    document.dispatchEvent(new window.Event("selectionchange"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    assert.equal(screen.queryByRole("menu", { name: "Selected text actions" }), null);

    activeSelection = copyMessage.selection;
    document.dispatchEvent(new window.Event("selectionchange"));
    await waitFor(() => {
      assert.ok(screen.getByRole("menuitem", { name: "Copy" }));
    });
    const copyButton = screen.getByRole("menuitem", { name: "Copy" });
    fireEvent.pointerDown(copyButton);
    fireEvent.mouseDown(copyButton);
    fireEvent.mouseUp(copyButton);
    fireEvent.click(copyButton, { detail: 1 });
    assert.deepEqual(copied, ["copy me"]);
    assert.deepEqual(selectionClears, ["clear"]);
    await waitFor(() => {
      assert.equal(screen.queryByRole("menu", { name: "Selected text actions" }), null);
    });
    document.dispatchEvent(new window.Event("selectionchange"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    assert.equal(screen.queryByRole("menu", { name: "Selected text actions" }), null);

    activeSelection = quoteMessage.selection;
    document.dispatchEvent(new window.Event("selectionchange"));
    await waitFor(() => {
      assert.ok(screen.getByRole("menuitem", { name: "Copy" }));
    });
    const keyboardCopyButton = screen.getByRole("menuitem", { name: "Copy" });
    const realSetTimeout = globalThis.setTimeout;
    let scheduledKeyboardRefresh: (() => void) | null = null;
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (timeout === 100 && typeof handler === "function") {
          scheduledKeyboardRefresh = () => handler(...args);
          return 1;
        }
        return realSetTimeout(handler, timeout, ...args);
      }) as typeof setTimeout,
    });
    try {
      keyboardCopyButton.focus();
      fireEvent.keyDown(keyboardCopyButton, { key: " ", code: "Space" });
      fireEvent.keyUp(keyboardCopyButton, { key: " ", code: "Space" });
      fireEvent.click(keyboardCopyButton, { detail: 0 });
    } finally {
      Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: realSetTimeout });
    }
    assert.deepEqual(copied, ["copy me", "quote me"]);
    assert.deepEqual(selectionClears, ["clear", "clear"]);
    assert.equal(
      scheduledKeyboardRefresh,
      null,
      "a shortcut keyboard activation must not schedule a selection refresh after the click closes it",
    );
    await waitFor(() => {
      assert.equal(screen.queryByRole("menu", { name: "Selected text actions" }), null);
    });
  } finally {
    window.removeEventListener(SELECTED_TEXT_QUOTE_EVENT, onQuote);
    Object.defineProperty(window, "getSelection", { configurable: true, value: prevGetSelection });
    Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: prevCustomEvent });
  }
});

test("message action controls do not re-arm the shortcut while the native selection survives", async () => {
  const { body, selection } = createSelectableMessage({
    text: "selected before using an action",
    quoteChannelId: "composer-channel",
  });
  const prevGetSelection = window.getSelection;
  const selectionClears: string[] = [];
  (selection as Selection & { removeAllRanges: () => void }).removeAllRanges = () => {
    selectionClears.push("clear");
  };
  Object.defineProperty(window, "getSelection", {
    configurable: true,
    value: () => selection,
  });

  const toolbar = document.createElement("div");
  toolbar.setAttribute("role", "toolbar");
  const action = document.createElement("button");
  const icon = document.createElement("span");
  const toolbarBlank = document.createElement("span");
  action.append(icon);
  toolbar.append(action, toolbarBlank);
  const link = document.createElement("a");
  const roleButton = document.createElement("span");
  roleButton.setAttribute("role", "button");
  body.append(toolbar, link, roleButton);
  let actionCalls = 0;
  action.addEventListener("click", () => {
    actionCalls += 1;
  });
  const realSetTimeout = globalThis.setTimeout;

  try {
    renderWithIntl(<MessageSelectionShortcut />);
    document.dispatchEvent(new window.Event("selectionchange"));
    await waitFor(() => {
      assert.ok(screen.getByRole("menu", { name: "Selected text actions" }));
    });

    let scheduledRefreshes = 0;
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (timeout === 100 && typeof handler === "function") {
          scheduledRefreshes += 1;
          return 1;
        }
        return realSetTimeout(handler, timeout, ...args);
      }) as typeof setTimeout,
    });
    try {
      fireEvent.pointerDown(icon);
      fireEvent.mouseUp(icon, { detail: 1 });
      fireEvent.click(icon, { detail: 1 });
      fireEvent.mouseUp(icon, { detail: 2 });
      fireEvent.click(icon, { detail: 2 });
      fireEvent.doubleClick(icon, { detail: 2 });
      for (const control of [link, roleButton, toolbarBlank]) {
        fireEvent.mouseUp(control, { detail: 1 });
        fireEvent.click(control, { detail: 1 });
      }
    } finally {
      Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: realSetTimeout });
    }
    assert.equal(actionCalls, 2, "the message action itself still runs for both clicks");
    assert.equal(scheduledRefreshes, 0, "control mouseup and double-click must not schedule a selection refresh");
    assert.equal(screen.queryByRole("menu", { name: "Selected text actions" }), null);
    assert.deepEqual(selectionClears, [], "using message actions must preserve the user's native selection");

    document.dispatchEvent(new window.Event("selectionchange"));
    await waitFor(() => {
      assert.ok(screen.getByRole("menu", { name: "Selected text actions" }));
    });
  } finally {
    Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: realSetTimeout });
    Object.defineProperty(window, "getSelection", { configurable: true, value: prevGetSelection });
  }
});

test("selection shortcut stays visible when a message context menu opens from right-click", async () => {
  const { selection } = createSelectableMessage({ text: "menu stays", quoteChannelId: "composer-channel" });
  const prevGetSelection = window.getSelection;
  Object.defineProperty(window, "getSelection", {
    configurable: true,
    value: () => selection,
  });

  try {
    renderWithIntl(<MessageSelectionShortcut />);
    document.dispatchEvent(new window.Event("selectionchange"));

    await waitFor(() => {
      assert.ok(screen.getByRole("menu", { name: "Selected text actions" }));
    });

    document.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      button: 2,
    }));
    document.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      button: 2,
    }));

    assert.ok(screen.getByRole("menu", { name: "Selected text actions" }));
  } finally {
    Object.defineProperty(window, "getSelection", { configurable: true, value: prevGetSelection });
  }
});
