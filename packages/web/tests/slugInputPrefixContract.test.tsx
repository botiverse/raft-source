import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import SlugInput from "../src/components/ui/SlugInput";

afterEach(() => {
  cleanup();
});

test("slug input renders a fixed slash prefix before the editable slug", () => {
  render(<SlugInput aria-label="URL slug" placeholder="my-team" />);

  const prefix = screen.getByText("/");
  assert.equal(prefix.getAttribute("aria-hidden"), "true");
  const input = screen.getByLabelText("URL slug");
  assert.equal(input.tagName, "INPUT");
  assert.equal(input.getAttribute("placeholder"), "my-team");
  assert.ok(
    prefix.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING,
    "the slash prefix must sit before the editable slug",
  );
});
