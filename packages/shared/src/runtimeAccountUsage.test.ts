import assert from "node:assert/strict";
import test from "node:test";

import {
  maskRuntimeAccountEmail,
  safeParseRuntimeAccountUsageSnapshot,
} from "./runtimeAccountUsage.js";

const validSnapshot = {
  protocolVersion: 2,
  provider: "claude",
  collectedAt: "2026-08-02T02:00:00.000Z",
  staleAfter: "2026-08-02T02:30:00.000Z",
  collectorVersion: "0.1.0",
  sourceVersion: "2.1.220",
  accounts: [{
    accountKey: "a".repeat(64),
    maskedLabel: "a•••@example.com",
    planLabel: "Max",
    health: "ok",
    windows: [{
      id: "current_session",
      label: "Current session",
      status: "ok",
      usedRatio: 0.24,
      resetsAt: "2026-08-02T04:13:00.000Z",
    }],
  }],
} as const;

test("accepts a closed sanitized runtime-account usage snapshot", () => {
  assert.equal(safeParseRuntimeAccountUsageSnapshot(validSnapshot).success, true);
});

test("masks runtime account emails deterministically without exposing short local parts", () => {
  assert.equal(maskRuntimeAccountEmail(" lenlongxsasd@GMAIL.com "), "len****xsasd@gmail.com");
  assert.equal(maskRuntimeAccountEmail("teamuser@example.com"), "tea****r@example.com");
  assert.equal(maskRuntimeAccountEmail("a@example.com"), "a****@example.com");
  assert.equal(maskRuntimeAccountEmail("ab@example.com"), "a****@example.com");
});

test("keeps missing and malformed runtime account identities absent", () => {
  assert.equal(maskRuntimeAccountEmail(undefined), undefined);
  assert.equal(maskRuntimeAccountEmail(""), undefined);
  assert.equal(maskRuntimeAccountEmail("opaque-account-id"), undefined);
  assert.equal(maskRuntimeAccountEmail("alice@@example.com"), undefined);
  assert.equal(maskRuntimeAccountEmail("alice@localhost"), undefined);
  assert.equal(maskRuntimeAccountEmail("alice..ops@example.com"), undefined);
});

test("rejects raw provider fields and unmasked account labels", () => {
  const withRaw = {
    ...validSnapshot,
    rawResponse: { token: "secret" },
  };
  assert.equal(safeParseRuntimeAccountUsageSnapshot(withRaw).success, false);

  const withEmail = structuredClone(validSnapshot) as any;
  withEmail.accounts[0].maskedLabel = "alice@example.com";
  assert.equal(safeParseRuntimeAccountUsageSnapshot(withEmail).success, false);
});

test("keeps percent usable when reset metadata is unavailable", () => {
  const missingUsage = structuredClone(validSnapshot) as any;
  delete missingUsage.accounts[0].windows[0].usedRatio;
  assert.equal(safeParseRuntimeAccountUsageSnapshot(missingUsage).success, false);

  const missingReset = structuredClone(validSnapshot) as any;
  delete missingReset.accounts[0].windows[0].resetsAt;
  assert.equal(safeParseRuntimeAccountUsageSnapshot(missingReset).success, true);

  const unavailable = structuredClone(validSnapshot) as any;
  unavailable.accounts[0].windows[0] = {
    id: "current_session",
    label: "Current session",
    status: "parse_unavailable",
  };
  unavailable.accounts[0].parseErrorCode = "claude_usage_format_changed";
  assert.equal(safeParseRuntimeAccountUsageSnapshot(unavailable).success, true);
});

test("rejects duplicate account/window identities and invalid freshness", () => {
  const duplicateAccount = structuredClone(validSnapshot) as any;
  duplicateAccount.accounts.push(structuredClone(duplicateAccount.accounts[0]));
  assert.equal(safeParseRuntimeAccountUsageSnapshot(duplicateAccount).success, false);

  const duplicateWindow = structuredClone(validSnapshot) as any;
  duplicateWindow.accounts[0].windows.push(structuredClone(duplicateWindow.accounts[0].windows[0]));
  assert.equal(safeParseRuntimeAccountUsageSnapshot(duplicateWindow).success, false);

  const backwardsFreshness = structuredClone(validSnapshot) as any;
  backwardsFreshness.staleAfter = backwardsFreshness.collectedAt;
  assert.equal(safeParseRuntimeAccountUsageSnapshot(backwardsFreshness).success, false);
});
test("accepts only current OAR snapshots, without legacy source-composition metadata", () => {
  assert.equal(safeParseRuntimeAccountUsageSnapshot({ ...validSnapshot, protocolVersion: 1 }).success, false);
  assert.equal(safeParseRuntimeAccountUsageSnapshot({ ...validSnapshot, acquisition: "text_parse" }).success, false);
  assert.equal(safeParseRuntimeAccountUsageSnapshot({
    ...validSnapshot,
    accounts: [{ ...validSnapshot.accounts[0], healthObservedAt: validSnapshot.collectedAt }],
  }).success, false);
});
