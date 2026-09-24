import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import AvatarListRow from "../src/components/ui/AvatarListRow";

afterEach(cleanup);

test("mounted AvatarListRow keeps the row and peer action as independent click targets", () => {
  const calls: string[] = [];
  render(createElement(AvatarListRow, {
    align: "start",
    avatar: createElement("span", { "data-testid": "avatar" }, "A"),
    name: "design.png",
    subtitle: createElement("span", null, "631 bytes"),
    onClick: () => calls.push("preview"),
    buttonProps: { "data-testid": "preview-row", title: "Preview file" },
    actionContent: createElement(
      "button",
      { type: "button", onClick: () => calls.push("download") },
      "Download file",
    ),
  }));

  const row = screen.getByTestId("preview-row");
  const action = screen.getByRole("button", { name: "Download file" });
  assert.equal(row.contains(action), false, "the action must be a peer, never a nested button");
  assert.match(row.className, /items-start/);
  assert.match(action.parentElement?.className ?? "", /self-center/);

  fireEvent.click(action);
  fireEvent.click(row);
  assert.deepEqual(calls, ["download", "preview"]);
});

test("mounted AvatarListRow top-aligns tall content while centering both trailing slots", () => {
  render(createElement(AvatarListRow, {
    align: "start",
    avatar: createElement("span", null, "A"),
    name: "very-long-file-name.png",
    subtitle: createElement("span", null, "metadata"),
    rightContent: createElement("span", { "data-testid": "status" }, "ready"),
    actionContent: createElement("button", { type: "button" }, "More"),
  }));

  const status = screen.getByTestId("status");
  const action = screen.getByRole("button", { name: "More" });
  assert.match(status.parentElement?.className ?? "", /self-center/);
  assert.match(action.parentElement?.className ?? "", /self-center/);
  assert.ok(screen.getByText("metadata"));
});
