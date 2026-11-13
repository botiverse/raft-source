import assert from "node:assert/strict";

import type { ServerToMachineMessage } from "./index";
import {
  RUNTIME_LIMIT_RESET_KINDS,
  claudeFiveHourLimitOf,
  isRuntimeLimitResetIdempotencyKey,
  isRuntimeLimitResetKind,
  runtimeLimitResetKindSchema,
  runtimeLimitResetsReadResultSchema,
  type RuntimeLimitResetIdempotencyKey,
  maskRuntimeAccountEmail,
  runtimeLimitResetResultSchema,
  safeParseRuntimeAccountUsageSnapshot,
  withoutLimitResets,
  withoutModelsScopes,
  withoutWindowScopes,
  runtimeAccountUsageSnapshotForClient,
  runtimeUsageModelGroupOf,
  runtimeUsageWindowScopeClientVersion,
  runtimeAccountUsageReadableWith,
  DAEMON_CAPABILITY_RUNTIME_ACCOUNT_USAGE_ANTIGRAVITY,
  type RuntimeAccountUsageSnapshot,
} from "./runtimeAccountUsage";

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
  assert.equal(maskRuntimeAccountEmail(" placeholder1@EXAMPLE.com "), "pla****lder1@example.com");
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

test("limitResetsAvailable is optional and must be a sane whole count", () => {
  const withResets = (value: unknown) => ({ ...validSnapshot, accounts: [{ ...validSnapshot.accounts[0], limitResetsAvailable: value }] });
  assert.equal(safeParseRuntimeAccountUsageSnapshot(validSnapshot).success, true, "a snapshot from an older Computer, without the field");
  for (const ok of [0, 2, 999]) assert.equal(safeParseRuntimeAccountUsageSnapshot(withResets(ok)).success, true, `count ${ok}`);
  for (const bad of [-1, 1.5, 1000, "2", null]) assert.equal(safeParseRuntimeAccountUsageSnapshot(withResets(bad)).success, false, `count ${String(bad)}`);
});

test("withoutLimitResets gives an older server's strict schema only what it knows", () => {
  const parsed = safeParseRuntimeAccountUsageSnapshot({ ...validSnapshot, accounts: [{ ...validSnapshot.accounts[0], limitResetsAvailable: 2 }] });
  assert.ok(parsed.success);
  const stripped: RuntimeAccountUsageSnapshot = withoutLimitResets(parsed.data);
  assert.equal("limitResetsAvailable" in stripped.accounts[0]!, false);
  assert.deepEqual(stripped, safeParseRuntimeAccountUsageSnapshot(validSnapshot).data);
  const without = safeParseRuntimeAccountUsageSnapshot(validSnapshot).data!;
  assert.equal(withoutLimitResets(without), without, "nothing to strip: the same snapshot");
});

test("a window's scope is optional: the account, or one model by the runtime's name", () => {
  const withScope = (scope: unknown) => ({
    ...validSnapshot,
    accounts: [{ ...validSnapshot.accounts[0], windows: [{ ...validSnapshot.accounts[0].windows[0], scope }] }],
  });
  assert.equal(safeParseRuntimeAccountUsageSnapshot(validSnapshot).success, true, "an older Computer sends none");
  for (const ok of [{ kind: "account" }, { kind: "model", name: "Opus" }, { kind: "model", name: "GPT-5.3-Codex-Spark" }, { kind: "models", name: "Gemini Models" }]) {
    assert.equal(safeParseRuntimeAccountUsageSnapshot(withScope(ok)).success, true, JSON.stringify(ok));
  }
  for (const bad of [{ kind: "model" }, { kind: "model", name: "" }, { kind: "model", name: "a\u0007b" }, { kind: "account", name: "x" }, { kind: "models" }, { kind: "models", name: " " }, { kind: "org" }, "account", null]) {
    assert.equal(safeParseRuntimeAccountUsageSnapshot(withScope(bad)).success, false, JSON.stringify(bad));
  }
});

test("withoutWindowScopes gives an older server's strict schema only what it knows", () => {
  const parsed = safeParseRuntimeAccountUsageSnapshot({
    ...validSnapshot,
    accounts: [{ ...validSnapshot.accounts[0], windows: [{ ...validSnapshot.accounts[0].windows[0], scope: { kind: "model", name: "Opus" } }] }],
  });
  assert.ok(parsed.success);
  assert.deepEqual(withoutWindowScopes(parsed.data), safeParseRuntimeAccountUsageSnapshot(validSnapshot).data);
  const without = safeParseRuntimeAccountUsageSnapshot(validSnapshot).data!;
  assert.equal(withoutWindowScopes(without), without, "nothing to strip: the same snapshot");
});

test("withoutModelsScopes leaves a models window unscoped and keeps the account's and a model's scope", () => {
  const scoped = (scopes: readonly unknown[]) => safeParseRuntimeAccountUsageSnapshot({
    ...validSnapshot,
    provider: "antigravity",
    accounts: [{
      ...validSnapshot.accounts[0],
      windows: scopes.map((scope, index) => ({ ...validSnapshot.accounts[0].windows[0], id: `w${index}`, ...(scope ? { scope } : {}) })),
    }],
  }).data!;
  const sent = scoped([{ kind: "models", name: "Gemini Models" }, { kind: "model", name: "Opus" }, { kind: "account" }, null]);
  assert.deepEqual(withoutModelsScopes(sent), scoped([null, { kind: "model", name: "Opus" }, { kind: "account" }, null]));
  const none = scoped([{ kind: "model", name: "Opus" }]);
  assert.equal(withoutModelsScopes(none), none, "nothing to strip: the same snapshot");
});

test("a web client gets the scopes its declared version reads: @2 all, @1 no models scope, none no scope", () => {
  const sent = safeParseRuntimeAccountUsageSnapshot({
    ...validSnapshot,
    accounts: [{
      ...validSnapshot.accounts[0],
      windows: [
        { ...validSnapshot.accounts[0].windows[0], id: "w0", scope: { kind: "models", name: "Gemini Models" } },
        { ...validSnapshot.accounts[0].windows[0], id: "w1", scope: { kind: "model", name: "Opus" } },
      ],
    }],
  }).data!;
  const scopes = (header: unknown) => runtimeAccountUsageSnapshotForClient(sent, header).accounts[0]!.windows.map((window) => window.scope ?? null);
  assert.deepEqual(scopes("runtime-usage-window-scope@2"), [{ kind: "models", name: "Gemini Models" }, { kind: "model", name: "Opus" }]);
  assert.deepEqual(scopes("other@3, runtime-usage-window-scope@1"), [null, { kind: "model", name: "Opus" }]);
  assert.deepEqual(scopes(undefined), [null, null]);
  assert.equal(runtimeUsageWindowScopeClientVersion("runtime-usage-window-scope@1,runtime-usage-window-scope@2"), 2);
  assert.equal(runtimeUsageWindowScopeClientVersion("runtime-usage-window-scope@0"), 0);
});

test("an Antigravity model's usage group, by Raft's reading of agy's model ids", () => {
  assert.equal(runtimeUsageModelGroupOf("antigravity", "gemini-4-carbon-medium"), "Gemini Models");
  assert.equal(runtimeUsageModelGroupOf("antigravity", "Gemini-3.8-Flash"), "Gemini Models");
  assert.equal(runtimeUsageModelGroupOf("antigravity", "claude-sonnet-5"), "Claude and GPT models");
  assert.equal(runtimeUsageModelGroupOf("antigravity", "gpt-oss-120b"), "Claude and GPT models");
  for (const unknown of ["default", "", null, undefined, "claudette", "o4-mini"]) {
    assert.equal(runtimeUsageModelGroupOf("antigravity", unknown), null, String(unknown));
  }
  assert.equal(runtimeUsageModelGroupOf("claude", "claude-sonnet-5"), null, "only Antigravity groups its models");
});

test("limit-reset idempotency keys and results are closed shapes", () => {
  assert.equal(isRuntimeLimitResetIdempotencyKey("0f6b1f8e-5c3a-4c55-9c1e-6a7b8c9d0e1f"), true);
  for (const bad of ["", "short", "has space in it 123", "x".repeat(129), 42, null]) {
    assert.equal(isRuntimeLimitResetIdempotencyKey(bad), false, `key ${String(bad)}`);
  }
  for (const ok of [
    { kind: "reset" }, { kind: "nothing_to_reset" }, { kind: "no_reset" }, { kind: "already_redeemed" }, { kind: "unknown" },
    { kind: "reauth_required", reason: "not_authenticated" }, { kind: "unsupported", reason: "not_installed" },
  ]) assert.equal(runtimeLimitResetResultSchema.safeParse(ok).success, true, JSON.stringify(ok));
  for (const bad of [{ kind: "reset", extra: 1 }, { kind: "reauth_required" }, { kind: "unsupported", reason: "nope" }, { kind: "spent" }]) {
    assert.equal(runtimeLimitResetResultSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("limit-reset kinds are the four Claude Code holds, and a redeem message may or may not name one", () => {
  assert.deepEqual([...RUNTIME_LIMIT_RESET_KINDS], ["five_hour", "weekly", "fable", "full"]);
  for (const kind of RUNTIME_LIMIT_RESET_KINDS) {
    assert.equal(isRuntimeLimitResetKind(kind), true, kind);
    assert.equal(runtimeLimitResetKindSchema.safeParse(kind).success, true, kind);
  }
  for (const bad of ["5-hour", "session", "", "Weekly", 1, null, undefined]) {
    assert.equal(isRuntimeLimitResetKind(bad), false, String(bad));
    assert.equal(runtimeLimitResetKindSchema.safeParse(bad).success, false, String(bad));
  }
  const idempotencyKey = "0f6b1f8e-5c3a-4c55-9c1e-6a7b8c9d0e1f" as RuntimeLimitResetIdempotencyKey;
  // What an older server sends (no kind) and what a newer one sends for Claude are both the same message type.
  const messages: ServerToMachineMessage[] = [
    { type: "machine:runtime_account_usage:limit_reset:redeem", requestId: "r1", provider: "codex", idempotencyKey },
    { type: "machine:runtime_account_usage:limit_reset:redeem", requestId: "r2", provider: "claude", idempotencyKey, kind: "weekly" },
  ];
  assert.deepEqual(messages.map((message) => (message.type === "machine:runtime_account_usage:limit_reset:redeem" ? message.kind : "other")), [undefined, "weekly"]);
});

test("the Claude driver's refusals are redeem results; consent_required belongs to a read only", () => {
  for (const reason of ["unsupported_version", "unsupported_platform", "not_attempted"]) {
    assert.equal(runtimeLimitResetResultSchema.safeParse({ kind: "unsupported", reason }).success, true, reason);
    assert.equal(runtimeLimitResetsReadResultSchema.safeParse({ kind: "unsupported", reason }).success, true, reason);
  }
  assert.equal(runtimeLimitResetResultSchema.safeParse({ kind: "unsupported", reason: "consent_required" }).success, false);
  // The older program spending its 5-hour reset unasked is said, not hidden in a bare unknown.
  assert.equal(runtimeLimitResetResultSchema.safeParse({ kind: "unknown", fiveHourSpent: true }).success, true);
  assert.equal(runtimeLimitResetResultSchema.safeParse({ kind: "unknown", fiveHourSpent: false }).success, false);
  assert.equal(runtimeLimitResetResultSchema.safeParse({ kind: "reset", fiveHourSpent: true }).success, false);
  assert.equal(runtimeLimitResetsReadResultSchema.safeParse({ kind: "unsupported", reason: "consent_required" }).success, true);
});

test("a read of the resets held is a closed shape that carries only what the screen said", () => {
  const resets = [
    { kind: "five_hour", state: "not_checked" },
    { kind: "weekly", state: "available", resetsLeft: 1, expiresText: "Nov 16, 4:59pm" },
    { kind: "fable", state: "available" },
    { kind: "full", state: "none" },
  ];
  for (const ok of [
    { kind: "read", resets },
    { kind: "read", resets: [{ kind: "weekly", state: "available", resetsLeft: 2, resetsTotal: 3, expiresAt: "2026-11-16T16:59:00.000Z" }, { kind: "full", state: "unknown" }] },
    { kind: "read", program: "legacy", resets: [{ kind: "five_hour", state: "none" }, { kind: "weekly", state: "not_offered" }] },
    { kind: "read", program: "legacy", fiveHourSpent: true, resets: [{ kind: "five_hour", state: "unknown" }, { kind: "weekly", state: "not_offered" }] },
    { kind: "reauth_required", reason: "not_authenticated" },
    { kind: "unknown" },
  ]) assert.equal(runtimeLimitResetsReadResultSchema.safeParse(ok).success, true, JSON.stringify(ok));
  for (const bad of [
    { kind: "read" },
    { kind: "read", resets: [{ kind: "monthly", state: "none" }] },
    { kind: "read", resets: [{ kind: "weekly", state: "spent" }] },
    { kind: "read", resets: [{ kind: "weekly", state: "none", resetsLeft: 1 }] },
    { kind: "read", resets: [{ kind: "weekly", state: "available", resetsLeft: -1 }] },
    { kind: "read", resets: [{ kind: "weekly", state: "available", expiresAt: "Nov 16" }] },
    { kind: "read", resets: [{ kind: "weekly", state: "available", screen: "Use a weekly reset?" }] },
    { kind: "read", program: "newer", resets },
    { kind: "read", resets: [...resets, ...resets] },
    { kind: "reset" },
  ]) assert.equal(runtimeLimitResetsReadResultSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test("claudeFiveHourLimitOf reads Claude's Current session window and nothing else", () => {
  const snapshot = (windows: RuntimeAccountUsageSnapshot["accounts"][number]["windows"], health: "ok" | "rate_limited" | "error" = "ok", provider: "claude" | "codex" = "claude"): RuntimeAccountUsageSnapshot => ({
    protocolVersion: 2,
    provider,
    collectedAt: "2026-11-11T10:00:00.000Z",
    staleAfter: "2026-11-11T10:30:00.000Z",
    collectorVersion: "test",
    accounts: [{ accountKey: "c".repeat(64), health, windows }],
  });
  const week = { id: "w", label: "Current week (all models)", status: "limit_reached" as const, usedRatio: 1 };
  assert.equal(claudeFiveHourLimitOf(snapshot([{ id: "s", label: "Current session", status: "ok", usedRatio: 0.4 }, week])), "not_at_limit");
  assert.equal(claudeFiveHourLimitOf(snapshot([{ id: "s", label: "Current session", status: "limit_reached", usedRatio: 1 }], "rate_limited")), "at_limit");
  assert.equal(claudeFiveHourLimitOf(snapshot([{ id: "s", label: "Current session", status: "ok", usedRatio: 1 }])), "unknown");
  assert.equal(claudeFiveHourLimitOf(snapshot([week])), "unknown");
  assert.equal(claudeFiveHourLimitOf(snapshot([{ id: "s", label: "Current session", status: "ok", usedRatio: 0.4 }], "error")), "unknown");
  assert.equal(claudeFiveHourLimitOf(snapshot([{ id: "s", label: "Current session", status: "ok", usedRatio: 0.4 }], "ok", "codex")), "unknown");
  assert.equal(claudeFiveHourLimitOf(null), "unknown");
});

test("Antigravity's usage is read only where the daemon says it reads it; the other providers everywhere", () => {
  assert.equal(runtimeAccountUsageReadableWith("antigravity", []), false);
  assert.equal(runtimeAccountUsageReadableWith("antigravity", new Set([DAEMON_CAPABILITY_RUNTIME_ACCOUNT_USAGE_ANTIGRAVITY])), true);
  for (const provider of ["claude", "codex", "kimi", "grok"] as const) assert.equal(runtimeAccountUsageReadableWith(provider, []), true, provider);
});
