import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render } from "@testing-library/react";
import { MessageHoverToolbar } from "../src/components/message/MessageHoverToolbar";
import { TestIntlProvider } from "./helpers/intl";

afterEach(() => {
  cleanup();
});

test("extracted hover toolbar does not render a resting saved overlay", () => {
  const { container } = render(
    <TestIntlProvider>
      <div className="group/message relative">
        <MessageHoverToolbar
          isSaved
          reactionActive
          onReplyInThread={() => undefined}
          onReactionClick={() => undefined}
          onToggleSave={() => undefined}
        />
      </div>
    </TestIntlProvider>,
  );

  const bookmark = container.querySelector('[data-message-affordance="bookmark"]');
  assert.ok(bookmark, "saved state must stay on the hover bookmark button");
  assert.equal(container.querySelector('[data-message-affordance="saved-indicator"]'), null);
  const toolbar = container.querySelector('[data-message-affordance="toolbar"]');
  assert.ok(toolbar);
  assert.doesNotMatch(toolbar.className, /absolute top-1 right-1/);
  assert.doesNotMatch(toolbar.className, /(^|\s)top-1(\s|$)/);
});
