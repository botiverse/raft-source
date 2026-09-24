import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";

import { TestIntlProvider } from "./helpers/intl";
import {
  connectedAppDistributionStatus,
  connectedAppOverviewDistributionLabel,
  sourceOwnedConnectedAppStatusHint,
  ConnectedAppDistributionBadge,
} from "../src/components/settings/SettingsPanel";
import type {
  ConnectedAppStatus,
} from "../src/components/settings/SettingsPanel";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Settings sub-batch F (react-intl migration acceptance): the app-editor STATUS
// VOCABULARY — the short state words feeding the editor rail and the marketplace
// distribution badge.
//
// This batch is a SHAPE CHANGE, not a string swap, and that is what makes it
// testable. The two helpers used to return display text, so their logic could only
// be checked by rendering the whole editor (which needs API-loaded marketplace data
// — the exact wall sub-batch E hit, leaving E with no render tooth). They now return
// a `MessageId`, so:
//
//   - the status -> id mapping is a pure function, exhaustively unit-testable here;
//   - the MessageId return type makes a typo a COMPILE error, not a silent
//     runtime fallback to the raw id string;
//   - ConnectedAppDistributionBadge is presentational, so it renders directly and
//     gives this batch a real zh render tooth.
//
// Sub-batch E's ids remain render-unverified. F is not a fix for that; it is the
// shape that would have avoided it.

afterEach(() => {
  cleanup();
});

const ALL_STATUSES: ConnectedAppStatus[] = [
  "private",
  "publish_requested",
  "in_review",
  "published",
  "rejected",
  "unpublish_requested",
];

test("every status maps to a real, translated catalog id (both helpers, all arms)", () => {
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;

  // `null` is only meaningful for the editor helper (unsaved app).
  const editorInputs: Array<ConnectedAppStatus | null> = [null, ...ALL_STATUSES];

  for (const status of editorInputs) {
    const id = connectedAppDistributionStatus(status);
    assert.ok(en[id], `distributionStatus(${status}) -> ${id} missing from en.ts`);
    assert.ok(zh[id], `distributionStatus(${status}) -> ${id} missing from zh-cn.ts`);
    assert.notEqual(zh[id], en[id], `${id} is still English in zh-cn.ts`);
    assert.match(zh[id], /\p{Script=Han}|OAuth/u, `${id} has no Chinese characters`);
  }

  for (const status of ALL_STATUSES) {
    const id = connectedAppOverviewDistributionLabel(status);
    assert.ok(en[id], `overviewLabel(${status}) -> ${id} missing from en.ts`);
    assert.ok(zh[id], `overviewLabel(${status}) -> ${id} missing from zh-cn.ts`);
    assert.notEqual(zh[id], en[id], `${id} is still English in zh-cn.ts`);
  }
});

test("the two helpers stay DIFFERENT where the product copy differs", () => {
  // The editor rail says "Offline pending" while the marketplace overview badge
  // says "Offline requested" for the same underlying status. They were two separate
  // hardcoded strings; collapsing them onto one id during migration would have been
  // an invisible copy change. This pins the distinction.
  assert.notEqual(
    connectedAppDistributionStatus("unpublish_requested"),
    connectedAppOverviewDistributionLabel("unpublish_requested"),
    "editor rail and overview badge must keep distinct copy for unpublish_requested",
  );

  // ...and stay the SAME where the copy genuinely is shared, so a future edit does
  // not silently fork them.
  for (const status of ["published", "rejected", "private"] as ConnectedAppStatus[]) {
    assert.equal(
      connectedAppDistributionStatus(status),
      connectedAppOverviewDistributionLabel(status),
      `${status} should share one id across rail and badge`,
    );
  }
});

test("each status arm resolves to a DISTINCT message (no accidental collapse)", () => {
  // If two arms returned the same id, one branch would be dead and the UI would
  // show the wrong state — the failure a string-returning helper hides well.
  const ids = ALL_STATUSES.map((s) => connectedAppOverviewDistributionLabel(s));
  const byStatus = new Map<string, string[]>();
  ALL_STATUSES.forEach((s, i) => {
    const list = byStatus.get(ids[i]) ?? [];
    list.push(s);
    byStatus.set(ids[i], list);
  });

  // publish_requested and in_review deliberately share "Review pending"; nothing else may.
  for (const [id, statuses] of byStatus) {
    if (statuses.length === 1) continue;
    assert.deepEqual(
      statuses.sort(),
      ["in_review", "publish_requested"],
      `unexpected id collision on ${id}: ${statuses.join(", ")}`,
    );
  }
});

test("the marketplace status hint helper maps every status to a translated id", () => {
  // Added after @Wug's review of PR #5689. This helper was scoped out of E/F and
  // kept returning English display text while the ADJACENT distribution helper
  // was migrated in F — so zh users saw English here, from two call sites (the
  // my-apps card and the editor distribution section).
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;

  const withHint: ConnectedAppStatus[] = ["publish_requested", "in_review", "unpublish_requested"];
  for (const status of withHint) {
    const id = sourceOwnedConnectedAppStatusHint(status);
    assert.ok(id, `${status} should produce a hint`);
    assert.ok(en[id!], `${id} missing from en.ts`);
    assert.ok(zh[id!], `${id} missing from zh-cn.ts`);
    assert.notEqual(zh[id!], en[id!], `${id} is still English in zh-cn.ts`);
    assert.match(zh[id!], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }

  // The no-hint statuses must stay null — returning an id here would render an
  // empty-looking banner on apps that should show none.
  for (const status of ["private", "published", "rejected"] as ConnectedAppStatus[]) {
    assert.equal(sourceOwnedConnectedAppStatusHint(status), null, `${status} should have no hint`);
  }
});

test("the distribution badge renders the migrated Chinese copy", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <ConnectedAppDistributionBadge status="published" />
    </TestIntlProvider>,
  );
  assert.ok(screen.getByText("已发布"), "published badge in Chinese");
  assert.equal(screen.queryByText("Published"), null, "no untranslated Published");
});

test("the distribution badge renders nothing for a null status", () => {
  const { container } = render(
    <TestIntlProvider locale="zh-cn">
      <ConnectedAppDistributionBadge status={null} />
    </TestIntlProvider>,
  );
  assert.equal(container.textContent, "", "null status renders nothing");
});
