import assert from "node:assert/strict";
import "./helpers/domSetup";
import { focusLost, mayTakeFocus } from "../src/utils/focusGuard";

// #triage:#278: a composer that mounts late must not take focus from the top search box.

afterEach(() => {
  document.body.innerHTML = "";
});

function composer(): HTMLTextAreaElement {
  const textarea = document.createElement("textarea");
  document.body.append(textarea);
  return textarea;
}

test("nothing focused, or the composer itself: it may take focus", () => {
  const textarea = composer();
  assert.equal(mayTakeFocus(textarea), true);
  textarea.focus();
  assert.equal(mayTakeFocus(textarea), true);
});

test("the user is typing in the search box (in its overlay): the composer leaves it", () => {
  const textarea = composer();
  const overlay = document.createElement("div");
  overlay.setAttribute("role", "dialog");
  const search = document.createElement("input");
  overlay.append(search);
  document.body.append(overlay);
  search.focus();
  assert.equal(mayTakeFocus(textarea), false);
});

test("another editor outside any overlay keeps focus too", () => {
  const textarea = composer();
  const other = document.createElement("input");
  document.body.append(other);
  other.focus();
  assert.equal(mayTakeFocus(textarea), false);
});

test("a focused checkbox outside any dialog is not a text field and does not hold it", () => {
  const textarea = composer();
  const box = document.createElement("input");
  box.type = "checkbox";
  document.body.append(box);
  box.focus();
  assert.equal(mayTakeFocus(textarea), true);
});

test("focus on a button or link (a sidebar click) does not hold it", () => {
  const textarea = composer();
  const link = document.createElement("button");
  document.body.append(link);
  link.focus();
  assert.equal(mayTakeFocus(textarea), true);
});

test("a button inside an open dialog holds focus; a composer in that dialog may still take it", () => {
  const outside = composer();
  const dialog = document.createElement("div");
  dialog.setAttribute("aria-modal", "true");
  const button = document.createElement("button");
  const inside = document.createElement("textarea");
  dialog.append(button, inside);
  document.body.append(dialog);
  button.focus();
  assert.equal(mayTakeFocus(outside), false);
  assert.equal(mayTakeFocus(inside), true);
});

test("focus lost: <body>, or a dialog's popup itself only for a place inside that dialog", () => {
  document.body.focus();
  assert.equal(focusLost(), true);
  const popup = document.createElement("div");
  popup.setAttribute("role", "dialog");
  popup.tabIndex = -1;
  const inside = document.createElement("button");
  popup.append(inside);
  const behind = document.createElement("button");
  document.body.append(popup, behind);
  popup.focus();
  assert.equal(focusLost(), false, "nothing is lost for the page behind an open dialog");
  assert.equal(focusLost(behind), false);
  assert.equal(focusLost(inside), true);
});
