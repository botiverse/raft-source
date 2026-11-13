import assert from "node:assert/strict";
import {
  READINESS_CODES,
  READINESS_CODE_SPEC,
  READY,
  agentReadinessChain,
  composeReadiness,
  mergeSharedLoginEvidence,
  composeReadinessAttention,
  parseRuntimeReadinessReport,
  readinessActionOf,
  trimReadinessAttentionForViewer,
  readinessLoginKey,
  runtimeReadinessChain,
  trimReadinessForViewer,
  type ReadinessFact,
} from "./readiness";

const NOW = 1_000_000;
const fact = (resource: ReadinessFact["resource"], code: string, behaviour: ReadinessFact["behaviour"] = "blocked", extra: Partial<ReadinessFact> = {}): ReadinessFact => ({
  resource,
  code,
  behaviour,
  since: 1_000,
  ...extra,
});

const offline = fact({ kind: "computer" }, "computer_offline");
const claudeMissing = fact({ kind: "runtime", runtime: "claude" }, "runtime_missing");
const machineLoginVerify = fact({ kind: "login", key: "shared:claude" }, "verification_required");
const ownLoginVerify = fact({ kind: "login", key: "agent:a2" }, "verification_required");

const onMachineLogin = agentReadinessChain({ agentId: "a1", runtime: "claude", loginKey: readinessLoginKey("a1", "claude") });
const onOwnLogin = agentReadinessChain({ agentId: "a2", runtime: "claude", loginKey: readinessLoginKey("a2", null) });
const onCodex = agentReadinessChain({ agentId: "a3", runtime: "codex", loginKey: readinessLoginKey("a3", "codex") });

test("every blocked code has an exit, and each code names the resource it is about", () => {
  for (const code of READINESS_CODES) {
    const spec = READINESS_CODE_SPEC[code];
    if (spec.behaviour === "blocked") assert.ok(spec.exits.length > 0, `${code} has no exit`);
  }
  assert.equal(READINESS_CODE_SPEC.verification_required.resource, "login");
});

test("no fact on the chain: ready", () => {
  assert.deepEqual(composeReadiness([], onMachineLogin, NOW), READY);
  assert.deepEqual(composeReadiness([ownLoginVerify], onMachineLogin, NOW), READY, "another agent's own login is not on this chain");
});

test("a machine-login fact reaches every agent on that login, and only them: the Computer's problem, its owner acts", () => {
  const readiness = composeReadiness([machineLoginVerify], onMachineLogin, NOW);
  assert.equal(readiness.state, "blocked");
  assert.equal(readiness.primary, machineLoginVerify);
  assert.equal(readiness.scope, "computer");
  assert.equal(readiness.actor, "computer_owner");
  assert.deepEqual(composeReadiness([machineLoginVerify], onOwnLogin, NOW), READY);
  assert.deepEqual(composeReadiness([machineLoginVerify], onCodex, NOW), READY);
});

test("an own-login fact is the agent's problem, its owner acts", () => {
  const readiness = composeReadiness([ownLoginVerify], onOwnLogin, NOW);
  assert.equal(readiness.primary, ownLoginVerify);
  assert.equal(readiness.scope, "agent");
  assert.equal(readiness.actor, "agent_owner");
});

test("the first broken link is the answer: Computer before runtime before login; the rest under also, in chain order", () => {
  const readiness = composeReadiness([machineLoginVerify, claudeMissing, offline], onMachineLogin, NOW);
  assert.equal(readiness.primary, offline);
  assert.deepEqual(readiness.also, [claudeMissing, machineLoginVerify]);
  assert.equal(composeReadiness([machineLoginVerify, claudeMissing], onMachineLogin, NOW).primary, claudeMissing);
});

test("an advisory does not break a link; blocked comes before waiting on one link; an expired wait does not count", () => {
  const advisory = fact({ kind: "computer" }, "some_future_note", "advisory");
  const readiness = composeReadiness([advisory, machineLoginVerify], onMachineLogin, NOW);
  assert.equal(readiness.primary, machineLoginVerify);
  assert.deepEqual(readiness.also, [advisory]);
  const onlyAdvisory = composeReadiness([advisory], onMachineLogin, NOW);
  assert.equal(onlyAdvisory.state, "advisory");
  assert.equal(onlyAdvisory.primary, advisory);

  const wait = fact({ kind: "login", key: "shared:claude" }, "some_future_wait", "waiting", { since: 1 });
  assert.equal(composeReadiness([wait, machineLoginVerify], onMachineLogin, NOW).primary, machineLoginVerify);
  const expired = fact({ kind: "login", key: "shared:claude" }, "some_future_wait", "waiting", { until: NOW });
  assert.deepEqual(composeReadiness([expired], onMachineLogin, NOW), READY);
  assert.equal(composeReadiness([{ ...expired, until: NOW + 1 }], onMachineLogin, NOW).state, "waiting");
});

test("an unknown code acts on its carried behaviour", () => {
  const unknown = fact({ kind: "runtime", runtime: "claude" }, "a_code_from_the_future", "blocked");
  const readiness = composeReadiness([unknown], onMachineLogin, NOW);
  assert.equal(readiness.state, "blocked");
  assert.equal(readiness.primary?.code, "a_code_from_the_future");
});

test("a runtime's chain on a Computer includes its machine login", () => {
  assert.equal(composeReadiness([machineLoginVerify], runtimeReadinessChain("claude", "shared:claude"), NOW).primary, machineLoginVerify);
  assert.deepEqual(composeReadiness([machineLoginVerify], runtimeReadinessChain("codex", "shared:codex"), NOW), READY);
  assert.deepEqual(composeReadiness([machineLoginVerify], runtimeReadinessChain("claude", null), NOW), READY);
});

test("a viewer who may not see the reason gets the state alone; advisories say nothing", () => {
  const blocked = composeReadiness([offline, machineLoginVerify], onMachineLogin, NOW);
  assert.deepEqual(trimReadinessForViewer(blocked, true), blocked);
  assert.deepEqual(trimReadinessForViewer(blocked, false), { state: "blocked", primary: null, scope: null, actor: "computer_owner", action: "fix", also: [] });
  // Who can fix it and how stay: the actor, their display name and the action, never the reason.
  const verifyOnly = composeReadiness([machineLoginVerify], onMachineLogin, NOW);
  assert.deepEqual(trimReadinessForViewer({ ...verifyOnly, actorName: "Ada" }, false), { state: "blocked", primary: null, scope: null, actor: "computer_owner", actorName: "Ada", action: "fix", also: [] });
  // Tenny (#14587): a member never reads an action that gives the account reason away.
  for (const viewerSees of [false]) assert.ok(!["verify_account", "sign_in"].includes(String(trimReadinessForViewer(verifyOnly, viewerSees).action)));
  const advisory = composeReadiness([fact({ kind: "computer" }, "note", "advisory")], onMachineLogin, NOW);
  assert.deepEqual(trimReadinessForViewer(advisory, false), READY);
});

test("the report parser keeps unknown codes with their behaviour and drops only unreadable facts", () => {
  const report = parseRuntimeReadinessReport({
    seq: 7,
    facts: [
      machineLoginVerify,
      fact({ kind: "login", key: "shared:claude" }, "a_code_from_the_future", "waiting"),
      { resource: { kind: "galaxy" }, code: "verification_required", behaviour: "blocked", since: 1 },
      { resource: { kind: "login", key: "shared:claude" }, code: "verification_required", behaviour: "panicking", since: 1 },
      { resource: { kind: "login", key: "shared:claude" }, code: "Not A Code", behaviour: "blocked", since: 1 },
      { resource: { kind: "login", key: "shared:claude" }, code: "verification_required", behaviour: "blocked" },
      { ...machineLoginVerify, params: { model: "opus", nested: { no: true }, ok: true } },
    ],
  });
  assert.deepEqual(report, {
    seq: 7,
    facts: [
      machineLoginVerify,
      fact({ kind: "login", key: "shared:claude" }, "a_code_from_the_future", "waiting"),
      { ...machineLoginVerify, params: { model: "opus", ok: true } },
    ],
  });
  assert.equal(parseRuntimeReadinessReport({ seq: 0, facts: [] }), null);
  assert.equal(parseRuntimeReadinessReport({ seq: 1.5, facts: [] }), null);
  assert.deepEqual(parseRuntimeReadinessReport({ seq: 3 }), { seq: 3, facts: [] });
});

test("a fact on one usage window of a login holds only the agents whose model draws from it", () => {
  const windows = { "*": ["seven_day"], "claude-fable": ["seven_day_fable"] };
  const fableUsedUp = fact({ kind: "login_window", key: "shared:claude", window: "seven_day_fable" }, "a_future_quota_code", "waiting");
  const onFable = agentReadinessChain({ agentId: "f", runtime: "claude", loginKey: "shared:claude", model: "claude-fable", modelWindows: windows });
  const onOpus = agentReadinessChain({ agentId: "o", runtime: "claude", loginKey: "shared:claude", model: "claude-opus", modelWindows: windows });
  assert.equal(composeReadiness([fableUsedUp], onFable, NOW).state, "waiting");
  assert.equal(composeReadiness([fableUsedUp], onFable, NOW).scope, "computer");
  assert.deepEqual(composeReadiness([fableUsedUp], onOpus, NOW), READY);
  // The all-models window holds both.
  const allUsedUp = fact({ kind: "login_window", key: "shared:claude", window: "seven_day" }, "a_future_quota_code", "waiting");
  assert.equal(composeReadiness([allUsedUp], onFable, NOW).state, "waiting");
  assert.equal(composeReadiness([allUsedUp], onOpus, NOW).state, "waiting");
  // A login block comes before any window on it.
  assert.equal(composeReadiness([fableUsedUp, machineLoginVerify], onFable, NOW).primary, machineLoginVerify);
  // The parser reads the window resource.
  assert.deepEqual(parseRuntimeReadinessReport({ seq: 1, facts: [fableUsedUp] })?.facts, [fableUsedUp]);
});

test("#69: one machine login seen by several runners: the latest evidence wins, a finding or an end", () => {
  const found = (recordedAt: number, since = recordedAt) => ({ state: "verification_required", since, recordedAt });
  const ended = (at: number, cause: "model_output" | "credentials_changed" | "explicit_stop" = "model_output") => ({ at, cause });
  assert.equal(mergeSharedLoginEvidence([], []), null);
  // Only findings: the latest one.
  assert.deepEqual(mergeSharedLoginEvidence([found(1_000), found(3_000), found(2_000)], []), { kind: "finding", entry: found(3_000) });
  // Only ends: the latest one, with its cause.
  assert.deepEqual(mergeSharedLoginEvidence([], [ended(1_000), ended(4_000, "credentials_changed")]), { kind: "end", end: ended(4_000, "credentials_changed") });
  // An end later than every finding: the hold is over.
  assert.deepEqual(mergeSharedLoginEvidence([found(2_000), found(1_000)], [ended(9_000)]), { kind: "end", end: ended(9_000) });
  // A finding later than the latest end: held.
  assert.deepEqual(mergeSharedLoginEvidence([found(6_000)], [ended(5_000), ended(1_000)]), { kind: "finding", entry: found(6_000) });
  // The same instant: the finding wins.
  assert.equal(mergeSharedLoginEvidence([found(5_000)], [ended(5_000)])?.kind, "finding");
});

// ── Needs attention ──

const attention = (facts: ReadinessFact[], update: "available" | "required" | null = null, agents = [{ id: "a1", chain: onMachineLogin }, { id: "a2", chain: onOwnLogin }]) =>
  composeReadinessAttention({ facts, agents, update, nowMs: NOW });

test("a Computer installing its update is in progress, not needing attention for that update", () => {
  const updating = fact({ kind: "computer" }, "computer_updating", "waiting");
  assert.equal(attention([updating], "available").items.some((item) => item.code === "computer_update_available"), false);
  assert.equal(attention([updating], "required").items.some((item) => item.code === "computer_update_required"), false);
  assert.equal(attention([], "available").count, 1);
});

test("needs attention counts a blocked fact once, with every agent it holds and who fixes it", () => {
  const summary = attention([machineLoginVerify, ownLoginVerify]);
  assert.equal(summary.count, 2);
  assert.deepEqual(summary.items.map((item) => [item.code, item.actor, item.agentIds]), [
    ["verification_required", "computer_owner", ["a1"]],
    ["verification_required", "agent_owner", ["a2"]],
  ]);
  const shared = attention([machineLoginVerify], null, [{ id: "a1", chain: onMachineLogin }, { id: "a4", chain: agentReadinessChain({ agentId: "a4", runtime: "claude", loginKey: "shared:claude" }) }]);
  assert.equal(shared.count, 1);
  assert.deepEqual(shared.items[0]!.agentIds, ["a1", "a4"]);
  assert.equal(shared.items[0]!.agentCount, 2);
});

test("a runtime login nobody on the Computer uses does not count", () => {
  const codexSignedOut = fact({ kind: "login", key: "shared:codex" }, "verification_required");
  assert.equal(attention([codexSignedOut]).count, 0);
  assert.equal(attention([fact({ kind: "runtime", runtime: "gemini" }, "runtime_missing")]).count, 0);
  assert.equal(attention([codexSignedOut], null, [{ id: "a3", chain: onCodex }]).count, 1);
});

test("quota and rate-limit waits are not counted; they are waiting agents with the earliest end", () => {
  const quota = fact({ kind: "login", key: "shared:claude" }, "quota_exhausted", "waiting", { until: NOW + 5_000 });
  const limited = fact({ kind: "login", key: "agent:a2" }, "rate_limited", "waiting", { until: NOW + 2_000 });
  const summary = attention([quota, limited]);
  assert.equal(summary.count, 0);
  assert.deepEqual(summary.items, []);
  assert.equal(summary.waitingAgents, 2);
  assert.equal(summary.waitingUntil, NOW + 2_000);
});

test("a Computer offline counts once, with or without agents; a restart does not", () => {
  const summary = attention([offline, machineLoginVerify]);
  assert.equal(summary.count, 1, "the offline Computer is the one thing; the login behind it is not reached");
  assert.deepEqual(summary.items[0]!.agentIds, ["a1", "a2"]);
  assert.equal(attention([offline], null, []).count, 1);
  const restarting = attention([fact({ kind: "computer" }, "computer_restarting", "waiting")]);
  assert.equal(restarting.count, 0);
  assert.equal(restarting.waitingAgents, 2);
});

test("an update available and an update required both count; an enforced floor counts once", () => {
  assert.deepEqual(attention([], "available").items, [{ code: "computer_update_available", resource: { kind: "computer" }, actor: "computer_owner", action: "update_computer", agentIds: [], agentCount: 0 }]);
  assert.equal(attention([], "required").items[0]!.code, "computer_update_required");
  assert.equal(attention([machineLoginVerify], "available").count, 2);
  const tooOld = attention([fact({ kind: "computer" }, "computer_too_old")], "required");
  assert.equal(tooOld.count, 1);
  assert.equal(tooOld.items[0]!.code, "computer_too_old");
});

test("a viewer who may not see the reasons keeps the count, who can fix each and how many agents", () => {
  const summary = attention([machineLoginVerify]);
  summary.items[0]!.actorName = "Ada";
  assert.deepEqual(trimReadinessAttentionForViewer(summary, false), { count: 1, items: [{ actor: "computer_owner", actorName: "Ada", action: "fix", agentCount: 1 }], waitingAgents: 0 });
  assert.equal(readinessActionOf("signed_out"), "sign_in");
  assert.equal(readinessActionOf("computer_offline"), "fix");
  assert.equal(trimReadinessAttentionForViewer(summary, true), summary);
});

test("a report is bounded: the first 50 readable facts, at most 8 params each", () => {
  const facts = Array.from({ length: 60 }, (_, index) => fact({ kind: "login", key: `shared:r${index}` }, "verification_required"));
  const report = parseRuntimeReadinessReport({ seq: 1, facts: [{ junk: true }, ...facts] });
  assert.equal(report?.facts.length, 50);
  assert.equal((report?.facts[0]?.resource as { key: string }).key, "shared:r0");
  const params = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`p${index}`, index]));
  const many = parseRuntimeReadinessReport({ seq: 2, facts: [{ ...machineLoginVerify, params }] });
  assert.deepEqual(Object.keys(many?.facts[0]?.params ?? {}), ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
});
