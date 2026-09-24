import assert from "node:assert/strict";
import test from "node:test";
import {
  isAnalyticsEnabled,
  trackEvent,
  identifyUser,
  resetAnalytics,
} from "../src/analytics/posthog";
import {
  trackActivityOpen,
  trackActivityItemOpen,
  trackActivityMark,
} from "../src/analytics/activity";
import { trackComputerWindowsInterestClick } from "../src/analytics/computer";

// Privacy-critical invariant (stdrc #proj-activity:171042a3 2026-06-25):
// analytics is OFF unless an operator configures VITE_POSTHOG_KEY. With no key
// — local dev, self-host, CI, tests (no initAnalytics() call here) — every
// helper must no-op silently and never throw / never touch the network. This
// pins "a missing PostHog config never changes behaviour and never leaks".
test("analytics is disabled by default (no key / not initialised)", () => {
  assert.equal(isAnalyticsEnabled(), false);
});

test("all analytics helpers no-op (no throw) when disabled", () => {
  assert.doesNotThrow(() => trackEvent("activity_open", { variant: "rail" }));
  assert.doesNotThrow(() => identifyUser("user-1", { plan: "free" }));
  assert.doesNotThrow(() => resetAnalytics());
  assert.doesNotThrow(() => trackActivityOpen("rail"));
  assert.doesNotThrow(() => trackActivityItemOpen("thread"));
  assert.doesNotThrow(() => trackActivityMark("done"));
  assert.doesNotThrow(() => trackComputerWindowsInterestClick("computer_command_guide"));
});
