import assert from "node:assert/strict";
import "./helpers/domSetup";
import { nextMessageMenuItem } from "../src/components/message/messageMenuKeyboard";

function menu() {
  const root = document.createElement("div");
  root.innerHTML = `
    <div data-message-affordance="reaction-quick-row">
      <button role="menuitem" id="r1"></button><button role="menuitem" id="r2"></button><button role="menuitem" id="add"></button>
    </div>
    <hr role="separator">
    <button role="menuitem" id="reply">Reply in Thread</button>
    <button role="menuitem" id="off" disabled>Disabled</button>
    <button role="menuitem" id="save">Save</button>`;
  document.body.append(root);
  const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  return { root, $ };
}

afterEach(() => { document.body.innerHTML = ""; });

test("outside the menu, the first key focuses the first item, Up and End the last", () => {
  const { root, $ } = menu();
  assert.equal(nextMessageMenuItem(root, document.body, "ArrowDown"), $("r1"));
  assert.equal(nextMessageMenuItem(root, document.body, "ArrowUp"), $("save"));
  assert.equal(nextMessageMenuItem(root, document.body, "End"), $("save"));
  assert.equal(nextMessageMenuItem(root, document.body, "Tab"), null);
});

test("Left and Right move along the reactions and stop at their ends", () => {
  const { root, $ } = menu();
  assert.equal(nextMessageMenuItem(root, $("r1"), "ArrowRight"), $("r2"));
  assert.equal(nextMessageMenuItem(root, $("add"), "ArrowRight"), $("add"));
  assert.equal(nextMessageMenuItem(root, $("r1"), "ArrowLeft"), $("r1"));
  assert.equal(nextMessageMenuItem(root, $("reply"), "ArrowRight"), null, "outside the row, Left and Right do nothing");
});

test("Up and Down treat the row as one stop, skip disabled items and loop", () => {
  const { root, $ } = menu();
  assert.equal(nextMessageMenuItem(root, $("r2"), "ArrowDown"), $("reply"));
  assert.equal(nextMessageMenuItem(root, $("reply"), "ArrowDown"), $("save"), "the disabled item is skipped");
  assert.equal(nextMessageMenuItem(root, $("reply"), "ArrowUp"), $("r1"), "Up enters the row at its first reaction");
  assert.equal(nextMessageMenuItem(root, $("save"), "ArrowDown"), $("r1"));
  assert.equal(nextMessageMenuItem(root, $("r1"), "ArrowUp"), $("save"));
});
