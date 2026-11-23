// The page-error bar (#proj-workspace:#131) offers only the agent's page's own errors to it; a
// browser's ResizeObserver loop notice is not one (#proj-workspace:#324: xxchan saw it on Raft's
// Diagram/Code switch in a Markdown Artifact).
import assert from "node:assert/strict";

import { isBenignPageError, pageErrorsAreTheAgents } from "../src/apps/artifacts/artifactPageErrorRules";

test("the browser's ResizeObserver loop notices are not page errors, however the shell prefixes them", () => {
  for (const message of [
    "ResizeObserver loop completed with undelivered notifications.",
    "ResizeObserver loop completed with undelivered notifications",
    "ResizeObserver loop limit exceeded",
    "Uncaught ResizeObserver loop completed with undelivered notifications.",
    "Error: ResizeObserver loop limit exceeded",
    "ResizeObserver loop completed with undelivered notifications. (line 1)",
    "  ResizeObserver loop completed with undelivered notifications.\n",
  ]) {
    assert.equal(isBenignPageError(message), true, message);
  }
});

test("a page's real errors still reach the bar, including ones that only mention ResizeObserver", () => {
  for (const message of [
    "TypeError: Cannot read properties of undefined (reading 'x')",
    "ReferenceError: ResizeObserver is not defined",
    "ResizeObserver loop completed with undelivered notifications. Then: TypeError: x is null",
    "my chart: ResizeObserver loop limit exceeded",
    "",
  ]) {
    assert.equal(isBenignPageError(message), false, message);
  }
});

test("only an HTML page's errors are the agent's: Markdown and PDF are drawn by Raft", () => {
  assert.equal(pageErrorsAreTheAgents("html"), true);
  assert.equal(pageErrorsAreTheAgents("markdown"), false);
  assert.equal(pageErrorsAreTheAgents("pdf"), false);
});
