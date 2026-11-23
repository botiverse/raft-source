import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, test, vi } from "vitest";

import { ReminderReceiptFireAtTime } from "../src/components/message/ReminderReceiptFireAtTime";
import { TestIntlProvider } from "./helpers/intl";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// A receipt line stays mounted while the channel is open. Its words were read
// at the row's render, so a reminder set "tomorrow" still said so on the day.
test("a reminder receipt's \"tomorrow at\" becomes \"today at\" when the day turns, on a channel left open", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 3, 25, 12, 0, 0));
  const fireAt = new Date(2026, 3, 26, 12, 30, 0).toISOString();
  const { container } = render(<TestIntlProvider><ReminderReceiptFireAtTime value={fireAt} /></TestIntlProvider>);
  assert.match(container.textContent ?? "", /^tomorrow at /);

  act(() => { vi.advanceTimersByTime(12 * 60 * 60 * 1000 + 60_000); });
  assert.match(container.textContent ?? "", /^today at /);
});
