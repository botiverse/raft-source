import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Recovery } from "./Recovery.js";

test("Recovery renders scrubbed detail, code, action id, and copy diagnostics control", () => {
  const markup = renderToStaticMarkup(
    <Recovery
      failedStep="connect"
      message="Could not load workspaces with sk_agent_secret"
      errorCode="WORKSPACES_FAILED"
      actionId="action-123"
      onRetry={() => {}}
      onClose={() => {}}
    />,
  );

  assert.match(markup, /Could not load workspaces with \*\*\*REDACTED\*\*\*/);
  assert.match(markup, /Error WORKSPACES_FAILED/);
  assert.match(markup, /Action action-123/);
  assert.match(markup, /Copy diagnostics/);
  assert.doesNotMatch(markup, /sk_agent_secret/);
});
