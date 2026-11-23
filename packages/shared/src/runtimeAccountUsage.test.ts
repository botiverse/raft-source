import assert from "node:assert/strict";

import type { ServerToMachineMessage } from "./index";
import { runtimeAccountUsageAccountHomeEnv, runtimeAccountUsageAccountHomes } from "./index";
import {
  RUNTIME_LIMIT_RESET_KINDS,
  allModelsUsageAccount,
  claudeFiveHourLimitOf,
  inferClaudeUsageWindowScopes,
  isRuntimeLimitResetIdempotencyKey,
  isRuntimeLimitResetKind,
  runtimeLimitResetKindSchema,
  runtimeLimitResetsReadResultSchema,
  type RuntimeLimitResetIdempotencyKey,
  maskRuntimeAccountEmail,
  runtimeLimitResetResultSchema,
  safeParseRuntimeAccountUsageSnapshot,
  withoutCredits,
  withoutUnsupportedReasons,
  RUNTIME_ACCOUNT_USAGE_UNSUPPORTED_REASONS,
  RUNTIME_USAGE_UNSUPPORTED_REASON_CLIENT_CAPABILITY,
  withoutLimitResets,
  withoutModelsScopes,
  withoutWindowScopes,
  runtimeAccountUsageSnapshotForClient,
  runtimeUsageModelGroupOf,
  runtimeUsageWindowScopeClientVersion,
  runtimeAccountUsageReadableWith,
  DAEMON_CAPABILITY_RUNTIME_ACCOUNT_USAGE_ANTIGRAVITY,
  RUNTIME_USAGE_ACCOUNT_FOLDERS_CLIENT_CAPABILITY,
  RUNTIME_USAGE_CREDITS_CLIENT_CAPABILITY,
  RUNTIME_USAGE_WINDOW_SCOPE_CLIENT_CAPABILITY,
  defaultRuntimeUsageAccount,
  parseRuntimeAccountUsageAccountHomes,
  runtimeUsageAccountsForAgent,
  withoutHiddenAccountAgentIds,
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

test("credits are optional, a closed shape, and a balance is a number string", () => {
  const withCredits = (value: unknown) => ({ ...validSnapshot, accounts: [{ ...validSnapshot.accounts[0], credits: value }] });
  for (const ok of [{ available: true, balance: "30784" }, { available: false }, { available: true, unlimited: true }, { available: true, balance: "1,234.50" }, { available: false, balance: "-3" }]) {
    assert.equal(safeParseRuntimeAccountUsageSnapshot(withCredits(ok)).success, true, JSON.stringify(ok));
  }
  for (const bad of [{}, { available: "yes" }, { available: true, balance: 30784 }, { available: true, balance: "30784 USD" }, { available: true, balance: "" }, { available: true, extra: 1 }, null]) {
    assert.equal(safeParseRuntimeAccountUsageSnapshot(withCredits(bad)).success, false, JSON.stringify(bad));
  }
});

test("withoutCredits gives an older server or web bundle only what it knows; the web gets credits only when it declares them", () => {
  const parsed = safeParseRuntimeAccountUsageSnapshot({ ...validSnapshot, accounts: [{ ...validSnapshot.accounts[0], credits: { available: true, balance: "30784" } }] });
  assert.ok(parsed.success);
  const stripped = withoutCredits(parsed.data);
  assert.equal("credits" in stripped.accounts[0]!, false);
  assert.deepEqual(stripped, safeParseRuntimeAccountUsageSnapshot(validSnapshot).data);
  const without = safeParseRuntimeAccountUsageSnapshot(validSnapshot).data!;
  assert.equal(withoutCredits(without), without, "nothing to strip: the same snapshot");

  assert.equal(runtimeAccountUsageSnapshotForClient(parsed.data, undefined).accounts[0]!.credits, undefined, "an older bundle");
  assert.equal(runtimeAccountUsageSnapshotForClient(parsed.data, RUNTIME_USAGE_WINDOW_SCOPE_CLIENT_CAPABILITY).accounts[0]!.credits, undefined);
  assert.deepEqual(
    runtimeAccountUsageSnapshotForClient(parsed.data, `${RUNTIME_USAGE_WINDOW_SCOPE_CLIENT_CAPABILITY}, ${RUNTIME_USAGE_CREDITS_CLIENT_CAPABILITY}`).accounts[0]!.credits,
    { available: true, balance: "30784" },
  );
});

test("unsupportedReason: a known OAR reason, only on an unsupported account; stripped for an older server or a web bundle that does not declare it", () => {
  const unsupported = (extra: Record<string, unknown>) => ({ ...validSnapshot, accounts: [{ accountKey: validSnapshot.accounts[0].accountKey, health: "unsupported", windows: [], ...extra }] });
  for (const reason of RUNTIME_ACCOUNT_USAGE_UNSUPPORTED_REASONS) {
    assert.equal(safeParseRuntimeAccountUsageSnapshot(unsupported({ unsupportedReason: reason })).success, true, reason);
  }
  assert.equal(safeParseRuntimeAccountUsageSnapshot(unsupported({ unsupportedReason: "made_up" })).success, false);
  assert.equal(safeParseRuntimeAccountUsageSnapshot({ ...validSnapshot, accounts: [{ ...validSnapshot.accounts[0], unsupportedReason: "quota_unavailable" }] }).success, false, "only with unsupported health");

  const parsed = safeParseRuntimeAccountUsageSnapshot(unsupported({ unsupportedReason: "quota_unavailable" }));
  assert.ok(parsed.success);
  assert.equal("unsupportedReason" in withoutUnsupportedReasons(parsed.data).accounts[0]!, false);
  const plain = safeParseRuntimeAccountUsageSnapshot(unsupported({})).data!;
  assert.equal(withoutUnsupportedReasons(plain), plain, "nothing to strip: the same snapshot");
  assert.equal(runtimeAccountUsageSnapshotForClient(parsed.data, RUNTIME_USAGE_CREDITS_CLIENT_CAPABILITY).accounts[0]!.unsupportedReason, undefined, "an older bundle");
  assert.equal(runtimeAccountUsageSnapshotForClient(parsed.data, `${RUNTIME_USAGE_CREDITS_CLIENT_CAPABILITY},${RUNTIME_USAGE_UNSUPPORTED_REASON_CLIENT_CAPABILITY}`).accounts[0]!.unsupportedReason, "quota_unavailable");
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
  for (const reason of ["unsupported_version", "unsupported_platform", "not_attempted", "onboarding_required"]) {
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

test("an older Computer's scope-less Claude windows: a model's label is its model's window; the account is used up only on all models", () => {
  const snapshot = (provider: "claude" | "codex", allModels: "ok" | "limit_reached"): RuntimeAccountUsageSnapshot => ({
    protocolVersion: 2,
    provider,
    collectedAt: "2026-08-02T02:00:00.000Z",
    staleAfter: "2026-08-02T02:30:00.000Z",
    collectorVersion: "test",
    accounts: [{
      accountKey: "a".repeat(64),
      health: "rate_limited",
      windows: [
        { id: "w0", label: "Current week (all models)", status: allModels, usedRatio: allModels === "ok" ? 0.85 : 1 },
        { id: "w1", label: "Current week (OAuth apps)", status: "ok", usedRatio: 0.9 },
        { id: "w2", label: "Current week (Fable)", status: "limit_reached", usedRatio: 1 },
        { id: "w3", label: "Current session (Opus)", status: "ok", usedRatio: 0.1, scope: { kind: "model", name: "Opus 4" } },
      ],
    }],
  });
  const read = inferClaudeUsageWindowScopes(snapshot("claude", "ok"));
  assert.deepEqual(read.accounts[0]!.windows.map((window) => window.scope), [undefined, undefined, { kind: "model", name: "Fable" }, { kind: "model", name: "Opus 4" }], "a scope given stays as given");
  assert.equal(allModelsUsageAccount(read.accounts[0]!).account.health, "ok", "only Fable at its limit: not used up");
  assert.equal(allModelsUsageAccount(inferClaudeUsageWindowScopes(snapshot("claude", "limit_reached")).accounts[0]!).account.health, "rate_limited");
  const codex = snapshot("codex", "ok");
  assert.equal(inferClaudeUsageWindowScopes(codex), codex, "another provider's labels are not read");
});

describe("agents' own account folders", () => {
  const account = (key: string, agentIds?: string[]) => ({
    accountKey: key.repeat(64),
    health: "ok" as const,
    windows: [{ id: "current_session", label: "Current session", status: "ok" as const, usedRatio: 0.2 }],
    ...(agentIds ? { agentIds } : {}),
  });
  const folders = (accounts: RuntimeAccountUsageSnapshot["accounts"]): RuntimeAccountUsageSnapshot => ({
    ...validSnapshot,
    accounts,
  } as RuntimeAccountUsageSnapshot);

  it("an account may list the agents read under its folder: valid ids, bounded", () => {
    assert.ok(safeParseRuntimeAccountUsageSnapshot(folders([account("a"), account("b", ["agent-1", "0f8e2c1a-7d1e-4c3b-9a55-0b8d2a7c6e11"])])).success);
    assert.equal(safeParseRuntimeAccountUsageSnapshot(folders([account("a", [])])).success, false, "an empty list is no list");
    assert.equal(safeParseRuntimeAccountUsageSnapshot(folders([account("a", ["../etc"])])).success, false);
    assert.equal(safeParseRuntimeAccountUsageSnapshot(folders([account("a", Array.from({ length: 501 }, (_, i) => `a${i}`))])).success, false);
  });

  it("an agent reads its own folder's account, else the default account; a snapshot without folders reads as before", () => {
    const snapshot = folders([account("a"), account("b", ["agent-1"]), account("c", ["agent-2", "agent-3"])]);
    assert.deepEqual(runtimeUsageAccountsForAgent(snapshot, "agent-1").map((a) => a.accountKey[0]), ["b"]);
    assert.deepEqual(runtimeUsageAccountsForAgent(snapshot, "agent-3").map((a) => a.accountKey[0]), ["c"]);
    assert.deepEqual(runtimeUsageAccountsForAgent(snapshot, "agent-9").map((a) => a.accountKey[0]), ["a"]);
    assert.deepEqual(runtimeUsageAccountsForAgent(snapshot, null).map((a) => a.accountKey[0]), ["a"]);
    const older = folders([account("a"), account("b")]);
    assert.deepEqual(runtimeUsageAccountsForAgent(older, "agent-1").map((a) => a.accountKey[0]), ["a", "b"]);
    assert.deepEqual(runtimeUsageAccountsForAgent(null, "agent-1"), []);
  });

  it("the default account is the first without agents, else the first", () => {
    assert.equal(defaultRuntimeUsageAccount(folders([account("b", ["agent-1"]), account("a")]))?.accountKey[0], "a");
    assert.equal(defaultRuntimeUsageAccount(folders([account("b", ["agent-1"])]))?.accountKey[0], "b");
    assert.equal(defaultRuntimeUsageAccount(null), null);
  });

  it("the 5-hour limit reads the default account only, even beside agents' folders", () => {
    const snapshot = folders([account("a"), { ...account("b", ["agent-1"]), health: "rate_limited", windows: [{ id: "current_session", label: "Current session", status: "limit_reached", usedRatio: 1 }] }]);
    assert.equal(claudeFiveHourLimitOf(snapshot), "not_at_limit");
    assert.equal(claudeFiveHourLimitOf(folders([account("a"), account("b")])), "unknown", "two default accounts: no answer, as before");
  });

  it("a web client gets agentIds only when it declares it reads them", () => {
    const snapshot = folders([account("a"), account("b", ["agent-1"])]);
    assert.equal(runtimeAccountUsageSnapshotForClient(snapshot, RUNTIME_USAGE_WINDOW_SCOPE_CLIENT_CAPABILITY).accounts[1]!.agentIds, undefined);
    assert.deepEqual(runtimeAccountUsageSnapshotForClient(snapshot, `${RUNTIME_USAGE_WINDOW_SCOPE_CLIENT_CAPABILITY},${RUNTIME_USAGE_ACCOUNT_FOLDERS_CLIENT_CAPABILITY}`).accounts[1]!.agentIds, ["agent-1"]);
    assert.ok(safeParseRuntimeAccountUsageSnapshot(runtimeAccountUsageSnapshotForClient(snapshot, undefined)).success);
  });

  it("an agent the viewer may not find leaves every account; an account left listing no one is dropped, never read as the default", () => {
    const snapshot = folders([account("a"), account("b", ["assistant"]), account("c", ["assistant", "agent-1"])]);
    const seen = withoutHiddenAccountAgentIds(snapshot, new Set(["assistant"]));
    assert.deepEqual(seen.accounts.map((a) => [a.accountKey[0], a.agentIds ?? null]), [["a", null], ["c", ["agent-1"]]]);
    assert.ok(safeParseRuntimeAccountUsageSnapshot(seen).success);
    assert.equal(withoutHiddenAccountAgentIds(snapshot, new Set()), snapshot);
  });

  it("a refresh's accountHomes keep only folder providers, valid ids and HOME plus the folder key", () => {
    assert.equal(parseRuntimeAccountUsageAccountHomes("codex", undefined), undefined);
    assert.equal(parseRuntimeAccountUsageAccountHomes("kimi", [{ agentIds: ["a"], env: { HOME: "/x" } }]), undefined);
    assert.deepEqual(parseRuntimeAccountUsageAccountHomes("codex", [
      { agentIds: ["a", "a", "../x"], env: { CODEX_HOME: "/srv/codex-a", OPENAI_API_KEY: "sk", PATH: "/bin" } },
      { agentIds: ["b"], env: { CLAUDE_CONFIG_DIR: "/srv/claude" } },
      { agentIds: [], env: { HOME: "/srv/home" } },
      { agentIds: ["c"], env: { HOME: "   " } },
      "junk",
    ]), [{ agentIds: ["a"], env: { CODEX_HOME: "/srv/codex-a" } }]);
    assert.deepEqual(parseRuntimeAccountUsageAccountHomes("claude", [{ agentIds: ["d"], env: { HOME: "/h", CLAUDE_CONFIG_DIR: "rel" } }]), [{ agentIds: ["d"], env: { HOME: "/h", CLAUDE_CONFIG_DIR: "rel" } }]);
    const message: ServerToMachineMessage = { type: "machine:runtime_account_usage:refresh", requestId: "r", provider: "codex", reason: "scheduled", accountHomes: [{ agentIds: ["a"], env: { CODEX_HOME: "/x" } }] };
    assert.equal(message.type, "machine:runtime_account_usage:refresh");
  });

  it("the server sends an agent's folder env only for the provider's own default-provider agents without an API key", () => {
    assert.deepEqual(runtimeAccountUsageAccountHomeEnv("codex", { runtime: "codex", envVars: { CODEX_HOME: "/srv/a", TEAM: "x" } }), { CODEX_HOME: "/srv/a" });
    assert.deepEqual(runtimeAccountUsageAccountHomeEnv("codex", { runtime: "codex", envVars: { HOME: "/home/b" } }), { HOME: "/home/b" });
    assert.equal(runtimeAccountUsageAccountHomeEnv("codex", { runtime: "codex", envVars: { CODEX_HOME: "/srv/a", OPENAI_API_KEY: "sk-x" } }), null);
    assert.equal(runtimeAccountUsageAccountHomeEnv("codex", { runtime: "codex" }), null);
    assert.equal(runtimeAccountUsageAccountHomeEnv("codex", { runtime: "claude", envVars: { CODEX_HOME: "/srv/a" } }), null);
    assert.deepEqual(runtimeAccountUsageAccountHomeEnv("claude", { runtime: null, envVars: { CLAUDE_CONFIG_DIR: "/srv/c" } }), { CLAUDE_CONFIG_DIR: "/srv/c" });
    assert.equal(runtimeAccountUsageAccountHomeEnv("claude", { runtime: "claude", envVars: { CLAUDE_CONFIG_DIR: "/srv/c", ANTHROPIC_AUTH_TOKEN: "t" } }), null);
    assert.equal(runtimeAccountUsageAccountHomeEnv("claude", {
      runtime: "claude",
      envVars: { CLAUDE_CONFIG_DIR: "/srv/c", ANTHROPIC_BASE_URL: "https://gateway.example.test/v1", ANTHROPIC_API_KEY: "sk-ant-test" },
    }), null, "a custom provider has no signed-in account");
  });

  it("agents with the same folder env share one accountHomes entry, deterministically", () => {
    const homes = runtimeAccountUsageAccountHomes("codex", [
      { id: "b2", runtime: "codex", envVars: { CODEX_HOME: "/srv/b" } },
      { id: "a1", runtime: "codex", envVars: { CODEX_HOME: "/srv/a" } },
      { id: "b1", runtime: "codex", envVars: { CODEX_HOME: "/srv/b" } },
      { id: "d1", runtime: "codex" },
      { id: "k1", runtime: "codex", envVars: { CODEX_HOME: "/srv/k", OPENAI_API_KEY: "sk" } },
      { id: "c1", runtime: "claude", envVars: { CODEX_HOME: "/srv/c" } },
    ]);
    assert.deepEqual(homes, [
      { agentIds: ["a1"], env: { CODEX_HOME: "/srv/a" } },
      { agentIds: ["b1", "b2"], env: { CODEX_HOME: "/srv/b" } },
    ]);
  });
});
