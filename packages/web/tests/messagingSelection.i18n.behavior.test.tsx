import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

import MessageSelectionShortcut from "../src/components/message/MessageSelectionShortcut";
import type { RectLike } from "../src/components/message/messageSelectionShortcutUtils";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { renderWithIntl } from "./helpers/intl";

const zh = zhMessages as Record<string, string>;

const RECT: RectLike = { left: 40, top: 80, right: 120, bottom: 100, width: 80, height: 20 };

function installRangeRect(range: Range, rect: RectLike = RECT) {
  Object.defineProperty(range, "getClientRects", {
    configurable: true,
    value: () => [rect],
  });
  Object.defineProperty(range, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

test("selection shortcut renders zh-cn labels", async () => {
  const body = document.createElement("div");
  body.dataset.messageSelectable = "true";
  body.dataset.quoteChannelId = "thread-1";
  body.dataset.messageId = "msg-1";
  const textNode = document.createTextNode("selected message text");
  body.append(textNode);
  document.body.append(body);
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, textNode.textContent!.length);
  installRangeRect(range);
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: textNode,
    focusNode: textNode,
    getRangeAt: () => range,
    toString: () => "selected message text",
  } as unknown as Selection;

  const prevGetSelection = window.getSelection;
  const prevInnerWidth = window.innerWidth;
  Object.defineProperty(window, "getSelection", {
    configurable: true,
    value: () => selection,
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1280,
  });

  try {
    renderWithIntl(<MessageSelectionShortcut />, { locale: "zh-cn" });
    await act(async () => {
      fireEvent.click(body, { detail: 3 });
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    await waitFor(() => {
      assert.ok(screen.getByRole("menu", { name: zh["message.selectionShortcut.actionsAria"] }));
    });
    assert.ok(screen.getByRole("menuitem", { name: zh["message.selectionShortcut.quote"] }));
    assert.ok(screen.getByRole("menuitem", { name: zh["message.selectionShortcut.copy"] }));
    assert.equal(screen.queryByRole("menuitem", { name: "Quote" }), null);
  } finally {
    Object.defineProperty(window, "getSelection", { configurable: true, value: prevGetSelection });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: prevInnerWidth });
  }
});
