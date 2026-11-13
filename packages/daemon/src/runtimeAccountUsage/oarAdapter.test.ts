import assert from "node:assert/strict";

import { utcInstantFromDate } from "@botiverse/oar";

import { runtimeAccountUsageSnapshotSchema } from "@botiverse/raft-shared";

import {
  projectOarAccountUsageFailure,
  projectOarAccountUsageSnapshot,
  type OarAccountUsageSnapshot,
} from "./oarAdapter";

const OBSERVED_AT_MS = Date.parse("2026-08-26T09:00:00.000Z");
const BASE = {
  localAccountSlot: "/home/agent/.slock",
  collectorVersion: "1.0.19",
  observedAtMs: OBSERVED_AT_MS,
} as const;

function project(snapshot: OarAccountUsageSnapshot) {
  return projectOarAccountUsageSnapshot({ provider: "codex", snapshot, ...BASE });
}

/** Every projection must satisfy the wire schema, not merely typecheck. */
function assertOnWire(snapshot: unknown) {
  const parsed = runtimeAccountUsageSnapshotSchema.safeParse(snapshot);
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
}

test("raw email never reaches the snapshot; it is masked at the boundary", () => {
  const snapshot = project({
    kind: "available",
    email: "someone@example.com",
    rateLimited: false,
    windows: [{ label: "7 days", usedRatio: 0.5 }],
  } satisfies OarAccountUsageSnapshot);

  const serialized = JSON.stringify(snapshot);
  assert.ok(
    !serialized.includes("someone@example.com"),
    "raw email must not appear anywhere in the projected snapshot",
  );
  const label = snapshot.accounts[0]?.maskedLabel;
  assert.ok(label, "a maskable email must yield a masked label");
  assert.match(label, /[*•…]/u, "masked label must carry an explicit mask marker");
  assertOnWire(snapshot);
});

test("an unmaskable email is dropped rather than passed through", () => {
  const snapshot = project({
    kind: "available",
    email: "not-an-email",
    rateLimited: false,
    windows: [{ label: "7 days", usedRatio: 0.1 }],
  } satisfies OarAccountUsageSnapshot);

  assert.equal(snapshot.accounts[0]?.maskedLabel, undefined);
  assert.ok(!JSON.stringify(snapshot).includes("not-an-email"));
  assertOnWire(snapshot);
});

test("a failed read is an error account with NO windows, never zero usage", () => {
  const snapshot = projectOarAccountUsageFailure({ provider: "codex", ...BASE });
  assert.equal(snapshot.accounts[0]?.health, "error");
  assert.deepEqual(snapshot.accounts[0]?.windows, []);
  // The regression this pins: a consumer must not be able to read a failure as 0.
  assert.ok(
    !JSON.stringify(snapshot).includes("usedRatio"),
    "a failure must not carry a usedRatio in any form",
  );
  assertOnWire(snapshot);
});

test("unsupported and reauth_required carry no windows", () => {
  for (const kind of ["unsupported", "reauth_required"] as const) {
    const snapshot = project({ kind } satisfies OarAccountUsageSnapshot);
    assert.equal(snapshot.accounts[0]?.health, kind);
    assert.deepEqual(snapshot.accounts[0]?.windows, []);
    assert.ok(!JSON.stringify(snapshot).includes("usedRatio"));
    assertOnWire(snapshot);
  }
});

test("an out-of-range ratio becomes parse_unavailable and is never clamped", () => {
  const snapshot = project({
    kind: "available",
    rateLimited: false,
    windows: [
      { label: "bad", usedRatio: 42 },
      { label: "also bad", usedRatio: Number.NaN },
    ],
  } satisfies OarAccountUsageSnapshot);

  const windows = snapshot.accounts[0]?.windows ?? [];
  assert.equal(windows.length, 2);
  for (const window of windows) {
    assert.equal(window.status, "parse_unavailable");
    assert.equal("usedRatio" in window, false, "an unreadable ratio must not be reported as a number");
  }
  assert.equal(snapshot.accounts[0]?.parseErrorCode, "oar_window_ratio_unreadable");
  assertOnWire(snapshot);
});

test("rateLimited maps to rate_limited health and a full window maps to limit_reached", () => {
  const snapshot = project({
    kind: "available",
    rateLimited: true,
    windows: [{
      label: "7 days",
      usedRatio: 1,
      resetsAt: utcInstant("2026-08-27T00:00:00.000Z"),
    }],
  } satisfies OarAccountUsageSnapshot);

  assert.equal(snapshot.accounts[0]?.health, "rate_limited");
  assert.equal(snapshot.accounts[0]?.windows[0]?.status, "limit_reached");
  assert.equal(snapshot.accounts[0]?.windows[0]?.resetsAt, "2026-08-27T00:00:00.000Z");
  assertOnWire(snapshot);
});

test("accountKey is provider-scoped and does not reveal the local slot", async () => {
  const { createHash } = await import("node:crypto");
  for (const provider of ["codex", "claude", "kimi"] as const) {
    const expected = createHash("sha256")
      .update(`${provider}\u0000${BASE.localAccountSlot}`)
      .digest("hex");
    const snapshot = projectOarAccountUsageSnapshot({
      provider,
      snapshot: { kind: "unsupported" },
      ...BASE,
    });
    assert.equal(
      snapshot.accounts[0]?.accountKey,
      expected,
      `${provider} accountKey must identify the provider and local slot`,
    );
  }
});

/**
 * OAR's `utcInstantFromDate` returns `UtcInstant | null`, while
 * `AccountUsageWindow.resetsAt` is `UtcInstant | undefined`. Narrow by throwing
 * on an invalid fixture date rather than casting — a cast here would hide the
 * very mismatch the public types exist to surface.
 */
function utcInstant(iso: string) {
  const value = utcInstantFromDate(new Date(iso));
  if (value === null) throw new Error(`invalid fixture instant: ${iso}`);
  return value;
}

function windows(n: number) {
  return Array.from({ length: n }, (_, i) => ({ label: `Window ${i}`, usedRatio: 0.1 }));
}

test("an OAR snapshot at the wire's window ceiling still projects to a valid snapshot", () => {
  const snapshot = project({
    kind: "available",
    rateLimited: false,
    windows: windows(12),
  } satisfies OarAccountUsageSnapshot);

  assert.equal(snapshot.accounts[0]?.windows.length, 12);
  assert.equal(snapshot.accounts[0]?.health, "ok");
  assertOnWire(snapshot); // upper-bound positive control: 12 is accepted
});

test("an OAR snapshot ABOVE the wire's window ceiling becomes an explicit error, not a truncation", () => {
  const snapshot = project({
    kind: "available",
    rateLimited: false,
    windows: windows(13),
  } satisfies OarAccountUsageSnapshot);

  // Never silently keep the first 12 and present it as a successful reading.
  assert.equal(snapshot.accounts[0]?.health, "error", "an unrepresentable reading is an error");
  assert.deepEqual(snapshot.accounts[0]?.windows, [], "no window may survive an overflow");
  assert.ok(
    !JSON.stringify(snapshot).includes("usedRatio"),
    "an overflowed reading must not carry any usedRatio",
  );
  assertOnWire(snapshot); // and the result must itself be wire-valid
});

test("OAR's count of limit resets is carried per account; detail rows and odd counts never are", () => {
  const withResets = project({
    kind: "available",
    email: "someone@example.com",
    rateLimited: true,
    windows: [{ label: "5 hours", usedRatio: 1 }],
    limitResets: { available: 2, resets: [{ id: "credit-1", status: "available", title: "Reset" }] },
  } satisfies OarAccountUsageSnapshot);
  assert.equal(withResets.accounts[0]?.limitResetsAvailable, 2);
  assert.ok(!JSON.stringify(withResets).includes("credit-1"), "reset ids and details stay on the Computer");
  assertOnWire(withResets);

  const none = project({ kind: "available", rateLimited: false, windows: [], limitResets: { available: 0 } } satisfies OarAccountUsageSnapshot);
  assert.equal(none.accounts[0]?.limitResetsAvailable, 0, "zero is a reading, not an absence");
  assertOnWire(none);

  const absent = project({ kind: "available", rateLimited: false, windows: [] } satisfies OarAccountUsageSnapshot);
  assert.equal("limitResetsAvailable" in absent.accounts[0]!, false, "a runtime that reports none sends nothing");

  for (const available of [-1, 1.5, 1000, Number.NaN]) {
    const odd = project({ kind: "available", rateLimited: false, windows: [], limitResets: { available } } satisfies OarAccountUsageSnapshot);
    assert.equal("limitResetsAvailable" in odd.accounts[0]!, false, `count ${available} is not carried`);
    assertOnWire(odd);
  }
});

test("OAR's window scope is forwarded as given; an absent one stays absent, an unsafe model name is dropped", () => {
  const snapshot = projectOarAccountUsageSnapshot({
    provider: "claude",
    snapshot: {
      kind: "available",
      rateLimited: false,
      windows: [
        { label: "Current session", usedRatio: 0.2, id: "five_hour", scope: { kind: "account" } },
        { label: "Current week (all models)", usedRatio: 0.6, id: "seven_day", scope: { kind: "account" } },
        { label: "Current week (OAuth apps)", usedRatio: 0.1, id: "seven_day_oauth_apps" },
        { label: "Current week (Opus)", usedRatio: 1, id: "model_scoped:Opus", scope: { kind: "model", name: "Opus" } },
        { label: "Current week (Odd)", usedRatio: 0.3, scope: { kind: "model", name: "bad\u0007name" } },
      ],
    } satisfies OarAccountUsageSnapshot,
    ...BASE,
  });
  const windows = snapshot.accounts[0]!.windows;
  assert.deepEqual(windows.map((window) => window.scope), [
    { kind: "account" },
    { kind: "account" },
    undefined,
    { kind: "model", name: "Opus" },
    undefined,
  ]);
  assert.equal("scope" in windows[2]!, false, "no scope is not sent as an account scope");
  assert.equal(windows[3]!.status, "limit_reached");
  assertOnWire(snapshot);
});

test("OAR 0.103's models scope (Antigravity's model groups) is forwarded with the group's name; an unsafe one is dropped", () => {
  const snapshot = projectOarAccountUsageSnapshot({
    provider: "antigravity",
    snapshot: {
      kind: "available",
      rateLimited: false,
      windows: [
        { label: "Gemini Models · Weekly", usedRatio: 1, id: "gemini_weekly", scope: { kind: "models", name: "Gemini Models" } },
        { label: "Claude and GPT models · 5h", usedRatio: 0.25, id: "claude_5h", scope: { kind: "models", name: "Claude and GPT models" } },
        { label: "Odd · Weekly", usedRatio: 0.1, scope: { kind: "models", name: "bad\u0007group" } },
      ],
    } satisfies OarAccountUsageSnapshot,
    ...BASE,
  });
  const account = snapshot.accounts[0]!;
  assert.deepEqual(account.windows.map((window) => window.scope), [
    { kind: "models", name: "Gemini Models" },
    { kind: "models", name: "Claude and GPT models" },
    undefined,
  ]);
  assert.equal(account.windows[0]!.status, "limit_reached", "one group used up shows on its own window");
  assert.equal(account.health, "ok", "the account is rate limited only as OAR says (every group used up, no credits)");
  assertOnWire(snapshot);
});
