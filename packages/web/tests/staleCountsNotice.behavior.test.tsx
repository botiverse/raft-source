import "./helpers/domSetup";

import assert from "node:assert/strict";
import { cleanup, screen } from "@testing-library/react";
import { ACTIVITY_SURFACES, StaleCountsNotice, UNREAD_COUNT_SURFACES } from "../src/components/layout/StaleCountsNotice";
import { markRwSeeded, markRwStale, markRwUnavailable, resetRwFreshness } from "../src/store/rwFreshness";
import { renderWithIntl } from "./helpers/intl";

// #triage:#517 (artin): a read that may only be out of date says nothing and
// updates silently; only RisingWave not configured, which never catches up on
// its own, shows the "temporarily unavailable" warning.

afterEach(() => {
  cleanup();
  resetRwFreshness();
});

function show() {
  renderWithIntl(
    <StaleCountsNotice surfaces={ACTIVITY_SURFACES} unavailableMessageId="thread.unavailableNotice" data-testid="notice" />,
  );
}

function showCounts() {
  renderWithIntl(
    <StaleCountsNotice surfaces={UNREAD_COUNT_SURFACES} unavailableMessageId="layout.sidebar.countsUnavailableNotice" data-testid="notice" />,
  );
}

test("a stale answer shows no notice", () => {
  markRwStale("inbox", 2000);
  show();
  assert.equal(screen.queryAllByTestId("notice").length, 0);
});

test("an overloaded read that failed shows no notice", () => {
  markRwUnavailable("inbox", 2000, "rw_overloaded");
  show();
  assert.equal(screen.queryAllByTestId("notice").length, 0);
});

test("values seeded from the saved copy, or a read that failed, show no notice", () => {
  markRwSeeded("inbox");
  markRwUnavailable("summary", null, "rw_read_failed");
  show();
  showCounts();
  assert.equal(screen.queryAllByTestId("notice").length, 0);
});

test("unread counts: stale shows nothing, RisingWave not configured shows the warning", () => {
  markRwStale("unread", 2000);
  showCounts();
  assert.equal(screen.queryAllByTestId("notice").length, 0);
  cleanup();
  markRwUnavailable("followed", null, "rw_unconfigured");
  showCounts();
  assert.equal(screen.getByTestId("notice").textContent, "Unread counts are temporarily unavailable.");
});

test("RisingWave not configured shows the unavailable warning", () => {
  markRwUnavailable("inbox", null, "rw_unconfigured");
  show();
  const notice = screen.getByTestId("notice");
  assert.equal(notice.getAttribute("data-reason"), "rw_unconfigured");
  assert.equal(notice.textContent, "Activity is temporarily unavailable.");
});
