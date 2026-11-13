import assert from "node:assert/strict";
import { defineRuntime } from "@botiverse/oar";
import type { AvailableInstallation, InstallationSnapshot, LimitResetInspection, LimitResetInspectOptions, LimitResetOptions, LimitResetResult, Runtime } from "@botiverse/oar";
import type { RuntimeLimitResetIdempotencyKey } from "@botiverse/raft-shared";

import { createRuntimeLimitResetRedeemer, projectOarLimitResetInspection, projectOarLimitResetResult, readOarLimitResets, redeemOarLimitReset } from "./limitReset";

const KEY = "0f6b1f8e-5c3a-4c55-9c1e-6a7b8c9d0e1f" as RuntimeLimitResetIdempotencyKey;
const AVAILABLE: InstallationSnapshot = { kind: "available", via: "executable", command: "/usr/local/bin/codex", version: "0.130.0" };

function runtimeWith(options: {
  installation?: InstallationSnapshot;
  redeem?: ((installation: AvailableInstallation, options: LimitResetOptions) => Promise<LimitResetResult>) | null;
  inspect?: ((installation: AvailableInstallation, options?: LimitResetInspectOptions) => Promise<LimitResetInspection>) | null;
}) {
  const calls: Array<{ installation: AvailableInstallation; options: LimitResetOptions }> = [];
  const inspections: Array<LimitResetInspectOptions | undefined> = [];
  const runtime = defineRuntime({
    id: "recording",
    session: (() => {
      throw new Error("a redeem must not open a session");
    }) as unknown as Runtime["session"],
    installation: async () => options.installation ?? AVAILABLE,
    ...(options.redeem === null ? {} : {
      redeemLimitReset: async (installation: AvailableInstallation, given: LimitResetOptions) => {
        calls.push({ installation, options: given });
        return options.redeem ? options.redeem(installation, given) : { kind: "reset" } as const;
      },
    }),
    ...(options.inspect ? {
      inspectLimitResets: async (installation: AvailableInstallation, given?: LimitResetInspectOptions) => {
        inspections.push(given);
        return options.inspect!(installation, given);
      },
    } : {}),
  });
  return { runtime, calls, inspections };
}

test("each OAR outcome reaches the wire as it is", async () => {
  const outcomes: LimitResetResult[] = [
    { kind: "reset" },
    { kind: "nothing_to_reset" },
    { kind: "no_reset" },
    { kind: "already_redeemed" },
    { kind: "reauth_required", reason: "credentials_rejected" },
    { kind: "unsupported", reason: "unsupported_installation" },
  ];
  for (const outcome of outcomes) {
    const { runtime } = runtimeWith({ redeem: async () => outcome });
    assert.deepEqual(await redeemOarLimitReset({ provider: "codex", idempotencyKey: KEY, deps: { runtime } }), outcome);
  }
});

test("the key is passed exactly, with no env, bounded by a timeout", async () => {
  const { runtime, calls } = runtimeWith({});
  await redeemOarLimitReset({ provider: "codex", idempotencyKey: KEY, deps: { runtime, timeoutMs: 1234 } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.options, { idempotencyKey: KEY, timeoutMs: 1234 });
  assert.ok(!("env" in calls[0]!.options), "same as the usage read: no env overlay");
  assert.equal(calls[0]!.installation, AVAILABLE as AvailableInstallation, "the probed installation itself");
});

test("a rejection is unknown: whether a reset was spent is not known", async () => {
  const { runtime } = runtimeWith({ redeem: async () => { throw new Error("timed out"); } });
  assert.deepEqual(await redeemOarLimitReset({ provider: "codex", idempotencyKey: KEY, deps: { runtime } }), { kind: "unknown" });
});

test("a runtime without redeemLimitReset, or not installed, is unsupported and nothing is called", async () => {
  const { runtime: noMethod } = runtimeWith({ redeem: null });
  assert.deepEqual(await redeemOarLimitReset({ provider: "claude", idempotencyKey: KEY, deps: { runtime: noMethod } }), { kind: "unsupported", reason: "capability_unavailable" });

  const { runtime: missing, calls } = runtimeWith({ installation: { kind: "not_found" } as InstallationSnapshot });
  assert.deepEqual(await redeemOarLimitReset({ provider: "codex", idempotencyKey: KEY, deps: { runtime: missing } }), { kind: "unsupported", reason: "not_installed" });
  assert.equal(calls.length, 0);
});

test("a reason this Raft does not know keeps its kind; an unknown kind is unknown", async () => {
  const cases: Array<[unknown, unknown]> = [
    [{ kind: "reauth_required", reason: "something_new" }, { kind: "reauth_required", reason: "not_authenticated" }],
    [{ kind: "unsupported", reason: "something_new" }, { kind: "unsupported", reason: "capability_unavailable" }],
    [{ kind: "something_new" }, { kind: "unknown" }],
  ];
  for (const [given, expected] of cases) {
    const { runtime } = runtimeWith({ redeem: async () => given as LimitResetResult });
    assert.deepEqual(await redeemOarLimitReset({ provider: "codex", idempotencyKey: KEY, deps: { runtime } }), expected);
  }
});

test("Claude redeems through OAR with the kind as resetId; without a kind it is unsupported and nothing runs", async () => {
  const { runtime, calls } = runtimeWith({});
  const redeem = createRuntimeLimitResetRedeemer({ runtime });
  assert.deepEqual(await redeem("claude", KEY), { kind: "unsupported", reason: "capability_unavailable" }, "the Computer never picks a kind");
  assert.equal(calls.length, 0);

  const seen: unknown[] = [];
  assert.deepEqual(await redeem("claude", KEY, "weekly", (report) => seen.push(report)), { kind: "reset" });
  assert.deepEqual(calls[0]!.options, { idempotencyKey: KEY, resetId: "weekly", timeoutMs: 75_000 });
  assert.ok(!("fiveHourLimitConsent" in calls[0]!.options), "a redeem never carries consent: the web offers only the 5-hour reset at the limit");
  assert.deepEqual(seen, [{ oarOutcome: "reset" }]);
});

test("Codex is unchanged by a kind: no resetId, Codex's own timeout", async () => {
  const { runtime, calls } = runtimeWith({});
  const redeem = createRuntimeLimitResetRedeemer({ runtime });
  assert.deepEqual(await redeem("codex", KEY), { kind: "reset" });
  assert.deepEqual(await redeem("codex", KEY, "weekly"), { kind: "reset" });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.options, { idempotencyKey: KEY, timeoutMs: 20_000 });
});

test("OAR 0.102's new redeem answers map onto the wire Raft already speaks", () => {
  const cases: Array<[LimitResetResult, unknown]> = [
    // Nothing was sent that could spend: the wire's not_attempted, "nothing was used, try again".
    [{ kind: "not_attempted", reason: "busy" }, { kind: "unsupported", reason: "not_attempted" }],
    [{ kind: "not_attempted", reason: "deadline" }, { kind: "unsupported", reason: "not_attempted" }],
    [{ kind: "not_attempted", reason: "usage_unread" }, { kind: "unsupported", reason: "not_attempted" }],
    [{ kind: "not_attempted", reason: "startup_failed" }, { kind: "unsupported", reason: "not_attempted" }],
    // Another kind refused for consent, with no fresh usage to tell why: nothing typed, the 5-hour wall's answer.
    [{ kind: "unsupported", reason: "consent_required" }, { kind: "unsupported", reason: "not_attempted" }],
    [{ kind: "unsupported", reason: "unsupported_platform" }, { kind: "unsupported", reason: "unsupported_platform" }],
    [{ kind: "unsupported", reason: "endpoint_unavailable" }, { kind: "unsupported", reason: "endpoint_unavailable" }],
    [{ kind: "unsupported", reason: "unsupported_version" }, { kind: "unsupported", reason: "unsupported_version" }],
    [{ kind: "unsupported", reason: "reset_id_required" }, { kind: "unsupported", reason: "capability_unavailable" }],
    [{ kind: "unknown" }, { kind: "unknown" }],
    [{ kind: "unknown", fiveHourSpent: true }, { kind: "unknown", fiveHourSpent: true }],
  ];
  for (const [given, expected] of cases) assert.deepEqual(projectOarLimitResetResult(given), expected, JSON.stringify(given));
});

test("a redeem refused for consent: at the 5-hour limit (or unread) not_attempted; clear of it, not available to this account here yet", async () => {
  const consent = async () => ({ kind: "unsupported", reason: "consent_required" } as const);
  const cases: Array<[() => Promise<"at_limit" | "not_at_limit" | "unknown">, unknown]> = [
    [async () => "at_limit", { kind: "unsupported", reason: "not_attempted" }],
    [async () => "unknown", { kind: "unsupported", reason: "not_attempted" }],
    [async () => { throw new Error("usage read failed"); }, { kind: "unsupported", reason: "not_attempted" }],
    // Claude Code's cached flags do not show the newer reset program: the kind isn't there for this account yet.
    [async () => "not_at_limit", { kind: "unsupported", reason: "capability_unavailable" }],
  ];
  for (const [fiveHourLimit, expected] of cases) {
    const { runtime } = runtimeWith({ redeem: consent });
    assert.deepEqual(await redeemOarLimitReset({ provider: "claude", idempotencyKey: KEY, kind: "weekly", deps: { runtime, fiveHourLimit } }), expected);
  }
  let checked = 0;
  const { runtime } = runtimeWith({ redeem: async () => ({ kind: "not_attempted", reason: "busy" }) });
  await redeemOarLimitReset({ provider: "claude", idempotencyKey: KEY, kind: "weekly", deps: { runtime, fiveHourLimit: async () => { checked += 1; return "at_limit"; } } });
  assert.equal(checked, 0, "usage is read again only after a consent refusal");
});

test("a Claude read inspects through OAR with consent and the 5-hour kind as asked, and maps each kind", async () => {
  const { runtime, inspections } = runtimeWith({
    inspect: async () => ({
      kind: "inspected",
      version: "2.1.330",
      resets: [
        { id: "weekly", state: "available", resetsLeft: 2, expiresText: "use by Nov 19, 4:59pm" },
        { id: "fable", state: "none" },
        { id: "full", state: "not_offered" },
        { id: "something_new", state: "available" },
      ],
    }),
  });
  const seen: unknown[] = [];
  const result = await readOarLimitResets({
    provider: "claude",
    read: { atFiveHourLimit: true, atFiveHourLimitConsent: true, includeFiveHour: true },
    deps: { runtime },
    observe: (report) => seen.push(report),
  });
  assert.deepEqual(inspections, [{ fiveHourLimitConsent: true, includeFiveHour: true, timeoutMs: 75_000 }]);
  assert.deepEqual(result, {
    kind: "read",
    resets: [
      { kind: "five_hour", state: "not_checked" },
      { kind: "weekly", state: "available", resetsLeft: 2, expiresText: "use by Nov 19, 4:59pm" },
      { kind: "fable", state: "none" },
      { kind: "full", state: "not_offered" },
    ],
  });
  assert.deepEqual(seen, [{ oarOutcome: "inspected", claudeVersion: "2.1.330" }]);
});

test("a read at the 5-hour limit without consent is refused before Claude Code starts; clear of it, OAR checks again itself", async () => {
  const { runtime, inspections } = runtimeWith({ inspect: async () => ({ kind: "unsupported", reason: "consent_required" }) });
  assert.deepEqual(
    await readOarLimitResets({ provider: "claude", read: { atFiveHourLimit: true, atFiveHourLimitConsent: false, includeFiveHour: true }, deps: { runtime } }),
    { kind: "unsupported", reason: "consent_required" },
  );
  assert.equal(inspections.length, 0);
  // The server's "not at the limit" may be minutes old: OAR's own usage read decides, and its consent_required reaches the web's consent step.
  assert.deepEqual(
    await readOarLimitResets({ provider: "claude", read: { atFiveHourLimit: false, atFiveHourLimitConsent: false, includeFiveHour: true }, deps: { runtime } }),
    { kind: "unsupported", reason: "consent_required" },
  );
  assert.deepEqual(inspections, [{ includeFiveHour: true, timeoutMs: 75_000 }]);
});

test("a read's other answers: legacy program, not attempted, unsupported platform, unknown, a rejection, no method", async () => {
  const cases: Array<[LimitResetInspection, unknown]> = [
    [{ kind: "inspected", program: "legacy", fiveHourSpent: true, resets: [{ id: "five_hour", state: "unknown" }] },
      { kind: "read", program: "legacy", fiveHourSpent: true, resets: [{ kind: "five_hour", state: "unknown" }, { kind: "weekly", state: "not_checked" }, { kind: "fable", state: "not_checked" }, { kind: "full", state: "not_checked" }] }],
    [{ kind: "not_attempted", reason: "busy" }, { kind: "unsupported", reason: "not_attempted" }],
    [{ kind: "not_attempted", reason: "startup_failed" }, { kind: "unsupported", reason: "not_attempted" }],
    [{ kind: "unsupported", reason: "unsupported_platform" }, { kind: "unsupported", reason: "unsupported_platform" }],
    [{ kind: "unsupported", reason: "endpoint_unavailable" }, { kind: "unsupported", reason: "endpoint_unavailable" }],
    [{ kind: "reauth_required", reason: "not_authenticated" }, { kind: "reauth_required", reason: "not_authenticated" }],
    [{ kind: "unknown" }, { kind: "unknown" }],
  ];
  for (const [given, expected] of cases) assert.deepEqual(projectOarLimitResetInspection(given), expected, JSON.stringify(given));

  const { runtime: rejecting } = runtimeWith({ inspect: async () => { throw new Error("timed out"); } });
  assert.deepEqual(await readOarLimitResets({ provider: "claude", read: { atFiveHourLimit: false, atFiveHourLimitConsent: false, includeFiveHour: false }, deps: { runtime: rejecting } }), { kind: "unknown" });

  const { runtime: codex } = runtimeWith({ inspect: null });
  assert.deepEqual(
    await readOarLimitResets({ provider: "codex", read: { atFiveHourLimit: true, atFiveHourLimitConsent: false, includeFiveHour: false }, deps: { runtime: codex } }),
    { kind: "unsupported", reason: "capability_unavailable" },
    "a runtime without inspectLimitResets has nothing to read, at the limit or not",
  );
});
