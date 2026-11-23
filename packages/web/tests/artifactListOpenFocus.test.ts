import assert from "node:assert/strict";
import "./helpers/domSetup";
import { focusListOnOpen } from "../src/apps/artifacts/artifactListOpenFocus";

// #proj-workspace:#323: the header's Comment button opens the list to write, and its foot box focuses its
// field before the list's own open focus runs; the list must not take that focus back (staging, 11-19).

afterEach(() => {
  document.body.innerHTML = "";
});

function list(): { region: HTMLElement; field: HTMLTextAreaElement } {
  const region = document.createElement("section");
  region.tabIndex = -1;
  const field = document.createElement("textarea");
  region.append(field);
  document.body.append(region);
  return { region, field };
}

test("opened to write: the foot box's field keeps the focus", () => {
  const { region, field } = list();
  field.focus();
  focusListOnOpen(() => region);
  assert.ok(document.activeElement === field, "focus must stay in the foot box's field");
});

test("opened without a place to start from: the region takes the focus", () => {
  const { region } = list();
  focusListOnOpen(() => region);
  assert.ok(document.activeElement === region, "the region must be focused");
});
