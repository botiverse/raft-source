import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, test, vi } from "vitest";

import { AgentToolStuckNotice } from "../src/components/agent/AgentToolStuckNotice";
import { TestIntlProvider } from "./helpers/intl";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// The line's minutes come from the live clock, not from a read at render: a
// profile left open keeps counting how long the tool call has been quiet.
test("the stuck line's minutes keep counting while it stays on screen", () => {
  vi.useFakeTimers();
  const toolStuck = {
    toolName: "bash",
    toolDetailKind: "running_command" as const,
    startedAtMs: Date.now() - 6 * 60_000,
    quietSinceMs: Date.now() - 5 * 60_000,
    thresholdMs: 5 * 60_000,
    queuedMessages: 0,
  };
  render(<TestIntlProvider><AgentToolStuckNotice toolStuck={toolStuck} /></TestIntlProvider>);
  assert.match(screen.getByTestId("agent-tool-stuck").textContent ?? "", /\b5 min/);

  act(() => { vi.advanceTimersByTime(2 * 60_000); });
  assert.match(screen.getByTestId("agent-tool-stuck").textContent ?? "", /\b7 min/);
});
