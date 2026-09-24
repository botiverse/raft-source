import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import QuotedMessageCard from "../src/components/ui/cards/QuotedMessageCard";
import { TestIntlProvider } from "./helpers/intl";

// Locks the fix for task #291 (iPad Safari tall message bubble).
// QuotedMessageCard's Root is a <button> when onClick is provided. A bare
// button defaults to inline-block and can strut the parent bubble; `block`
// collapses it to the card's actual height.

afterEach(() => {
  cleanup();
});

const author = { name: "Ada", kind: "user" as const };

test("QuotedMessageCard Root carries `block` class so the button variant does not strut the parent bubble", () => {
  render(
    <TestIntlProvider>
      <QuotedMessageCard
        channelName="research"
        timestamp="12:00"
        author={author}
        content="quoted parent"
        onClick={() => undefined}
      />
      <QuotedMessageCard
        channelName="research"
        timestamp="12:00"
        author={author}
        content="gone"
        unavailable
        onClick={() => undefined}
      />
    </TestIntlProvider>,
  );

  const roots = screen.getAllByTestId("quoted-message-card");
  assert.equal(roots.length, 2, "normal + unavailable variants");
  for (const root of roots) {
    assert.equal(root.tagName, "BUTTON");
    assert.match(
      root.className,
      /(^|\s)block(\s|$)/,
      `Root className "${root.className}" must include the \`block\` utility — task #291 regresses if Root is left inline-block`,
    );
  }
});
