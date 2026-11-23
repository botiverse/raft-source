// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import { RUNTIME_ACCOUNT_USAGE_UNSUPPORTED_REASONS } from "@botiverse/raft-shared";
import type { RuntimeAccountUsageSnapshot, RuntimeAccountUsageUnsupportedReason } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import { RuntimeUsageContents } from "../src/components/machine/RuntimeUsageSurface";
import { unsupportedReasonBadgeId, unsupportedReasonTextId } from "../src/components/machine/runtimeUsageUnsupportedReason";
import { RUNTIME_USAGE_REQUEST_HEADERS } from "../src/utils/runtimeAccountUsageClient";

// An account OAR reads as `unsupported` says why when the Computer passed the
// reason on (#oar-raft:#30): an account with no quota data reads "no usage
// data" (Kimi, a Claude API key), a CLI too old to report usage "update
// required", with no line repeating the badge (Kirby); any other reason keeps "unsupported" with a line saying why, and
// no reason (an older Computer) reads as before.

afterEach(cleanup);

function snapshotOf(unsupportedReason?: RuntimeAccountUsageUnsupportedReason): RuntimeAccountUsageSnapshot {
  return {
    protocolVersion: 2,
    provider: "kimi",
    collectedAt: "2026-11-18T09:00:00.000Z",
    staleAfter: "2099-11-18T09:30:00.000Z",
    collectorVersion: "test",
    accounts: [{ accountKey: "a".repeat(64), health: "unsupported", windows: [], ...(unsupportedReason ? { unsupportedReason } : {}) }],
  };
}

function renderCard(reason?: RuntimeAccountUsageUnsupportedReason) {
  render(
    <TestIntlProvider>
      <RuntimeUsageContents result={{ state: "fresh", snapshot: snapshotOf(reason) }} loading={false} loadError={false} />
    </TestIntlProvider>,
  );
}

test("usage requests declare that this build reads an unsupported account's reason", () => {
  assert.match(Object.values(RUNTIME_USAGE_REQUEST_HEADERS).join(","), /runtime-usage-unsupported-reason@1/);
});

test("no quota data: 'no usage data' and no line repeating it, never an error", () => {
  renderCard("quota_unavailable");
  assert.equal(screen.queryByText("no usage data") !== null, true);
  assert.equal(screen.queryByTestId("runtime-account-unsupported-reason") === null, true);
  assert.equal(screen.queryByText("unsupported") === null, true);
  assert.equal(screen.queryByText("Couldn't read usage.") === null, true);
});

test("a CLI too old: 'update required' and no line repeating it", () => {
  renderCard("version_unsupported");
  assert.equal(screen.queryByText("update required") !== null, true);
  assert.equal(screen.queryByTestId("runtime-account-unsupported-reason") === null, true);
});

test("no reason (an older Computer) and capability_unavailable read as before: 'unsupported', no line", () => {
  for (const reason of [undefined, "capability_unavailable"] as const) {
    renderCard(reason);
    assert.equal(screen.queryByText("unsupported") !== null, true, String(reason));
    assert.equal(screen.queryByTestId("runtime-account-unsupported-reason") === null, true, String(reason));
    cleanup();
  }
});

test("every other reason keeps 'unsupported' with a line saying why", () => {
  for (const reason of RUNTIME_ACCOUNT_USAGE_UNSUPPORTED_REASONS) {
    if (reason === "capability_unavailable" || reason === "quota_unavailable" || reason === "version_unsupported") continue;
    assert.ok(unsupportedReasonTextId(reason), reason);
    assert.equal(unsupportedReasonBadgeId(reason), null, reason);
  }
});
