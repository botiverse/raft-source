import assert from "node:assert/strict";
import type { ReadinessFact } from "@botiverse/raft-shared";
import {
  agentReadinessForViewer,
  COMPUTER_RESTART_GRACE_MS,
  composeAgentReadiness,
  computerAttentionForViewer,
  computerReadinessForViewer,
  newlyBlockedFacts,
  pruneReadinessNotified,
  READINESS_NOTIFIED_MAX_KEYS,
  READINESS_RENOTIFY_AFTER_MS,
  readinessFactsToNotify,
  readinessNoticePlan,
  readinessViewerForRole,
  serverFactsForComputer,
  type ComputerReadinessInputs,
} from "./runtimeReadinessService";

const NOW = 10_000_000;
const verify = (key: string): ReadinessFact => ({ resource: { kind: "login", key }, code: "verification_required", behaviour: "blocked", since: 5_000 });
const online = { online: true, lastSeenAtMs: 9_900_000, outage: null as { state: "pending" | "notified"; sinceMs: number } | null, upgrade: null as { requestedAtMs: number; deadlineAtMs: number } | null, managed: true, versionHeld: false, managedByDesktop: false, confirmedRuntimes: ["claude", "codex"] };

const onMachineLogin = { id: "a1", name: "ada", runtime: "claude", model: "sonnet", creatorType: "user", creatorId: "agent-owner", ownerUserId: "agent-owner" };
const alsoOnMachineLogin = { id: "a3", name: "bo", runtime: "claude", model: "opus", creatorType: "user", creatorId: "someone", ownerUserId: "someone" };
const ownHome = { id: "a2", name: "cy", runtime: "claude", model: "sonnet", envVars: { HOME: "/srv/a2" }, creatorType: "user", creatorId: "agent-owner", ownerUserId: "agent-owner" };
const onCodex = { id: "a4", name: "di", runtime: "codex", model: "gpt", creatorType: "user", creatorId: "agent-owner", ownerUserId: "agent-owner" };

function computer(server: Partial<typeof online> = {}, daemonFacts: ReadinessFact[] = []): ComputerReadinessInputs {
  return { server: { ...online, ...server }, ownerUserIds: ["computer-owner", "connector"], ownerName: "Olive", daemonFacts };
}

test("a disconnect reads the outage machinery: inside the dwell reconnecting (advisory), told offline (blocked), planned restarting (waiting)", () => {
  const offline = { ...online, online: false, versionHeld: true };
  assert.deepEqual(serverFactsForComputer({ ...offline, outage: { state: "pending", sinceMs: 9_500_000 } }, ["kimi"], NOW), [
    { resource: { kind: "computer" }, code: "computer_reconnecting", behaviour: "advisory", since: 9_500_000 },
  ]);
  assert.deepEqual(serverFactsForComputer({ ...offline, outage: { state: "notified", sinceMs: 9_500_000 } }, ["kimi"], NOW), [
    { resource: { kind: "computer" }, code: "computer_offline", behaviour: "blocked", since: 9_500_000 },
  ]);
  assert.deepEqual(serverFactsForComputer({ ...offline, outage: null }, ["kimi"], NOW), [
    { resource: { kind: "computer" }, code: "computer_restarting", behaviour: "waiting", since: 9_900_000 },
  ]);
  // A legacy daemon or a revoked Computer has no outage machinery: offline is offline.
  assert.deepEqual(serverFactsForComputer({ ...offline, managed: false }, ["kimi"], NOW), [
    { resource: { kind: "computer" }, code: "computer_offline", behaviour: "blocked", since: 9_900_000 },
  ]);
  // Reconnecting is advisory: a login hold behind it is still the answer; offline is not.
  const reconnecting = serverFactsForComputer({ ...offline, outage: { state: "pending", sinceMs: 9_500_000 } }, ["claude"], NOW);
  assert.equal(composeAgentReadiness(onMachineLogin, [...reconnecting, verify("shared:claude")], NOW).primary?.code, "verification_required");
  assert.equal(composeAgentReadiness(onMachineLogin, reconnecting, NOW).state, "advisory");
});

test("a planned restart is restarting for 5 min after the last heartbeat, then offline since that heartbeat", () => {
  const stopped = { ...online, online: false, outage: null };
  const lastSeenAtMs = NOW - COMPUTER_RESTART_GRACE_MS + 1;
  assert.deepEqual(serverFactsForComputer({ ...stopped, lastSeenAtMs }, [], NOW), [
    { resource: { kind: "computer" }, code: "computer_restarting", behaviour: "waiting", since: lastSeenAtMs },
  ]);
  assert.deepEqual(serverFactsForComputer({ ...stopped, lastSeenAtMs: NOW - COMPUTER_RESTART_GRACE_MS }, [], NOW), [
    { resource: { kind: "computer" }, code: "computer_offline", behaviour: "blocked", since: NOW - COMPUTER_RESTART_GRACE_MS },
  ]);
  // Told offline (a notified outage) wins over a planned stop, with the outage's time.
  assert.deepEqual(serverFactsForComputer({ ...stopped, lastSeenAtMs, outage: { state: "notified", sinceMs: 7 }, upgrade: { requestedAtMs: 1, deadlineAtMs: NOW + 1 } }, [], NOW), [
    { resource: { kind: "computer" }, code: "computer_offline", behaviour: "blocked", since: 7 },
  ]);
});

test("offline while the upgrade the server sent it runs: updating until the request's deadline, then offline", () => {
  const upgrading = { ...online, online: false, lastSeenAtMs: NOW - 20 * 60_000, upgrade: { requestedAtMs: NOW - 21 * 60_000, deadlineAtMs: NOW + 60_000 } };
  assert.deepEqual(serverFactsForComputer(upgrading, [], NOW), [
    { resource: { kind: "computer" }, code: "computer_updating", behaviour: "waiting", since: NOW - 21 * 60_000, until: NOW + 60_000 },
  ]);
  // Inside the dwell too: updating, not reconnecting.
  assert.equal(serverFactsForComputer({ ...upgrading, outage: { state: "pending", sinceMs: NOW - 1_000 } }, [], NOW)[0]!.code, "computer_updating");
  // Past the deadline: offline since its last heartbeat.
  assert.deepEqual(serverFactsForComputer({ ...upgrading, upgrade: { ...upgrading.upgrade, deadlineAtMs: NOW } }, [], NOW), [
    { resource: { kind: "computer" }, code: "computer_offline", behaviour: "blocked", since: NOW - 20 * 60_000 },
  ]);
  // Online, an open request says nothing.
  assert.deepEqual(serverFactsForComputer({ ...upgrading, online: true }, [], NOW), []);
});

test("server facts: version floor; a runtime missing only once detection confirmed the list", () => {
  assert.deepEqual(serverFactsForComputer({ ...online, versionHeld: true, managedByDesktop: true }, ["claude"], NOW), [
    { resource: { kind: "computer" }, code: "computer_too_old", behaviour: "blocked", since: NOW, params: { managedByDesktop: true } },
  ]);
  assert.deepEqual(serverFactsForComputer(online, ["claude", "kimi", "kimi"], NOW), [
    { resource: { kind: "runtime", runtime: "kimi" }, code: "runtime_missing", behaviour: "blocked", since: NOW },
  ]);
  // A Computer whose detection never reported: unknown, never missing.
  assert.deepEqual(serverFactsForComputer({ ...online, confirmedRuntimes: null }, ["kimi"], NOW), []);
});

test("a machine-login fact holds every agent on that login and no other; the chain's first broken link wins", () => {
  const facts = [verify("shared:claude")];
  assert.equal(composeAgentReadiness(onMachineLogin, facts, NOW).primary?.code, "verification_required");
  assert.equal(composeAgentReadiness(alsoOnMachineLogin, facts, NOW).scope, "computer");
  assert.equal(composeAgentReadiness(ownHome, facts, NOW).state, "ready");
  assert.equal(composeAgentReadiness(onCodex, facts, NOW).state, "ready");
  assert.equal(composeAgentReadiness(ownHome, [verify("agent:a2")], NOW).scope, "agent");

  const offlineFirst = [...facts, ...serverFactsForComputer({ ...online, online: false, outage: { state: "notified", sinceMs: 1 } }, ["claude"], NOW)];
  const readiness = composeAgentReadiness(onMachineLogin, offlineFirst, NOW);
  assert.equal(readiness.primary?.code, "computer_offline");
  assert.deepEqual(readiness.also.map((fact) => fact.code), ["verification_required"]);
});

test("per-viewer trimming: the Computer's owner or connector, the agent's owner and admins see the reason; a member sees the state alone", () => {
  const inputs = computer({}, [verify("shared:claude")]);
  const full = agentReadinessForViewer(onMachineLogin, inputs, { userId: "member", isServerAdmin: true }, NOW);
  assert.equal(full.primary?.code, "verification_required");
  assert.equal(full.actor, "computer_owner");
  for (const userId of ["computer-owner", "connector", "agent-owner"]) {
    assert.equal(agentReadinessForViewer(onMachineLogin, inputs, { userId, isServerAdmin: false }, NOW).primary?.code, "verification_required", userId);
  }
  // A member keeps who can fix it: the Computer's owner, by display name.
  assert.deepEqual(agentReadinessForViewer(onMachineLogin, inputs, { userId: "member", isServerAdmin: false }, NOW), {
    state: "blocked", primary: null, scope: null, actor: "computer_owner", actorName: "Olive", action: "fix", also: [],
  });
  // Agent owner is not the Computer owner: the broken resource's owner is named.
  assert.deepEqual(agentReadinessForViewer(ownHome, computer({}, [verify("agent:a2")]), { userId: "member", isServerAdmin: false }, NOW, "Agnes"), {
    state: "blocked", primary: null, scope: null, actor: "agent_owner", actorName: "Agnes", action: "fix", also: [],
  });
  // A personal assistant's person is its owner.
  assert.equal(agentReadinessForViewer({ ...onMachineLogin, assistantOwnerUserId: "person" }, inputs, { userId: "person", isServerAdmin: false }, NOW).primary?.code, "verification_required");

  const runtimeRow = computerReadinessForViewer(["claude", "codex"], inputs, { userId: "computer-owner", isServerAdmin: false }, NOW);
  assert.equal(runtimeRow.state, "ready", "the Computer itself is fine");
  assert.equal(runtimeRow.runtimes.claude?.primary?.code, "verification_required");
  assert.equal(runtimeRow.runtimes.codex?.state, "ready");
  const memberRow = computerReadinessForViewer(["claude"], inputs, { userId: "member", isServerAdmin: false }, NOW);
  assert.deepEqual(memberRow.runtimes.claude, { state: "blocked", primary: null, scope: null, actor: "computer_owner", actorName: "Olive", action: "fix", also: [] });
  // Tenny (#14587): nothing a member receives names the account problem.
  const memberPayload = JSON.stringify([memberRow, agentReadinessForViewer(onMachineLogin, inputs, { userId: "member", isServerAdmin: false }, NOW)]);
  for (const leak of ["verify_account", "sign_in", "verification_required"]) assert.ok(!memberPayload.includes(leak), leak);
});

test("notice: one per newly blocked fact, listing every agent on that login; machine login to the Computer's owner, own login to the agent's owner", () => {
  const agents = [onMachineLogin, alsoOnMachineLogin, ownHome, onCodex];
  assert.deepEqual(readinessNoticePlan(verify("shared:claude"), agents, "computer-owner"), {
    recipientUserId: "computer-owner",
    agents: [{ id: "a1", name: "ada" }, { id: "a3", name: "bo" }],
  });
  assert.deepEqual(readinessNoticePlan(verify("agent:a2"), agents, "computer-owner"), {
    recipientUserId: "agent-owner",
    agents: [{ id: "a2", name: "cy" }],
  });
  assert.equal(readinessNoticePlan(verify("shared:kimi"), agents, "computer-owner"), null, "no agent on it: nobody to tell");

  // Appear → told once → not again while it stays → again after it was gone.
  const first = newlyBlockedFacts([], [verify("shared:claude")]);
  assert.equal(first.length, 1);
  assert.deepEqual(newlyBlockedFacts([verify("shared:claude")], [{ ...verify("shared:claude"), since: 9 }]), []);
  assert.deepEqual(newlyBlockedFacts([verify("shared:claude")], []), []);
  assert.equal(newlyBlockedFacts([], [verify("shared:claude")]).length, 1);
  assert.deepEqual(newlyBlockedFacts([], [{ ...verify("shared:claude"), behaviour: "waiting" }]), []);
});

test("a hold that comes back after a Retry is not told again within 24 h; a day later it is", () => {
  const key = "shared:claude|verification_required";
  // Retry ended the hold (the fact went away), the next call brought it back.
  assert.deepEqual(readinessFactsToNotify([], [verify("shared:claude")], { [key]: NOW - 60_000 }, NOW), []);
  assert.deepEqual(readinessFactsToNotify([], [verify("shared:claude")], { [key]: NOW - READINESS_RENOTIFY_AFTER_MS }, NOW), [verify("shared:claude")]);
  // Another login or another code is its own notice.
  assert.deepEqual(readinessFactsToNotify([], [verify("agent:a2")], { [key]: NOW - 60_000 }, NOW), [verify("agent:a2")]);
  assert.deepEqual(readinessFactsToNotify([], [verify("shared:claude")], {}, NOW), [verify("shared:claude")]);
  // Still there in the next report: not news, whatever the window says.
  assert.deepEqual(readinessFactsToNotify([verify("shared:claude")], [verify("shared:claude")], {}, NOW), []);
});

test("needs attention: the agents' blocks and the update, named; a member keeps the count and who can fix each", () => {
  const inputs = computer({}, [verify("shared:claude"), verify("agent:a2"), verify("shared:kimi")]);
  const agents = [onMachineLogin, alsoOnMachineLogin, ownHome, onCodex];
  const owners = new Map([["agent-owner", "Agnes"]]);
  const owner = computerAttentionForViewer(inputs, agents, "available", { userId: "computer-owner", isServerAdmin: false }, NOW, owners);
  assert.equal(owner.count, 3, "machine login, a2's own login, the update; kimi's login holds nobody");
  assert.deepEqual(owner.items.map((item) => [item.code, item.actorName, item.agentIds]), [
    ["verification_required", "Olive", ["a1", "a3"]],
    ["verification_required", "Agnes", ["a2"]],
    ["computer_update_available", "Olive", []],
  ]);
  const member = computerAttentionForViewer(inputs, agents, "available", { userId: "member", isServerAdmin: false }, NOW, owners);
  assert.deepEqual(member, {
    count: 3,
    items: [
      { actor: "computer_owner", actorName: "Olive", action: "fix", agentCount: 2 },
      { actor: "agent_owner", actorName: "Agnes", action: "fix", agentCount: 1 },
      { actor: "computer_owner", actorName: "Olive", action: "update_computer", agentCount: 0 },
    ],
    waitingAgents: 0,
  });
  // Restarting is a wait, not attention; 5 min later it is offline, and counts.
  const stopped = computer({ online: false, lastSeenAtMs: NOW - 60_000 });
  assert.deepEqual(computerAttentionForViewer(stopped, agents, null, { userId: "member", isServerAdmin: false }, NOW), { count: 0, items: [], waitingAgents: 4 });
  assert.equal(computerAttentionForViewer(computer({ online: false, lastSeenAtMs: NOW - COMPUTER_RESTART_GRACE_MS }), agents, null, { userId: "member", isServerAdmin: false }, NOW).count, 1);
});

test("a guest gets who fixes it and how, never their name; a member still gets the name", () => {
  assert.deepEqual(readinessViewerForRole("g", "guest"), { userId: "g", isServerAdmin: false, isGuest: true });
  assert.deepEqual(readinessViewerForRole("m", "member"), { userId: "m", isServerAdmin: false, isGuest: false });
  assert.deepEqual(readinessViewerForRole("a", "admin"), { userId: "a", isServerAdmin: true, isGuest: false });
  const inputs = computer({}, [verify("shared:claude"), verify("agent:a2")]);
  const agents = [onMachineLogin, alsoOnMachineLogin, ownHome, onCodex];
  const owners = new Map([["agent-owner", "Agnes"]]);
  const guest = readinessViewerForRole("guest", "guest");
  const member = readinessViewerForRole("member", "member");

  assert.deepEqual(agentReadinessForViewer(onMachineLogin, inputs, guest, NOW), {
    state: "blocked", primary: null, scope: null, actor: "computer_owner", action: "fix", also: [],
  });
  assert.deepEqual(agentReadinessForViewer(ownHome, inputs, guest, NOW, "Agnes"), {
    state: "blocked", primary: null, scope: null, actor: "agent_owner", action: "fix", also: [],
  });
  const guestRow = computerReadinessForViewer(["claude"], inputs, guest, NOW);
  assert.deepEqual(guestRow.runtimes.claude, { state: "blocked", primary: null, scope: null, actor: "computer_owner", action: "fix", also: [] });
  const guestAttention = computerAttentionForViewer(inputs, agents, "available", guest, NOW, owners);
  assert.deepEqual(guestAttention.items, [
    { actor: "computer_owner", action: "fix", agentCount: 2 },
    { actor: "agent_owner", action: "fix", agentCount: 1 },
    { actor: "computer_owner", action: "update_computer", agentCount: 0 },
  ]);
  const guestPayload = JSON.stringify([guestRow, guestAttention, agentReadinessForViewer(ownHome, inputs, guest, NOW, "Agnes")]);
  for (const leak of ["actorName", "Olive", "Agnes"]) assert.ok(!guestPayload.includes(leak), leak);

  assert.equal(agentReadinessForViewer(onMachineLogin, inputs, member, NOW).actorName, "Olive");
  assert.equal(computerReadinessForViewer(["claude"], inputs, member, NOW).runtimes.claude?.actorName, "Olive");
  assert.deepEqual(computerAttentionForViewer(inputs, agents, "available", member, NOW, owners).items.map((item) => item.actorName), ["Olive", "Agnes", "Olive"]);
});

test("only codes the notice has words for are told: 1,000 made-up codes tell nobody", () => {
  const madeUp = Array.from({ length: 1_000 }, (_, index): ReadinessFact => ({ resource: { kind: "login", key: "shared:claude" }, code: `made_up_${index}`, behaviour: "blocked", since: 1 }));
  assert.deepEqual(readinessFactsToNotify([], madeUp, {}, NOW), []);
  // A known code that is not a login problem the notice explains is not told either.
  assert.deepEqual(readinessFactsToNotify([], [{ resource: { kind: "login", key: "shared:claude" }, code: "runtime_missing", behaviour: "blocked", since: 1 }], {}, NOW), []);
  assert.deepEqual(readinessFactsToNotify([], [verify("shared:claude")], {}, NOW), [verify("shared:claude")]);
});

test("an agent key tells its owner only when that agent is bound to this Computer", () => {
  const here = [onMachineLogin, ownHome];
  assert.equal(readinessNoticePlan(verify("agent:somewhere-else"), here, "computer-owner"), null);
  assert.equal(readinessNoticePlan(verify("agent:a1"), here, "computer-owner"), null, "a1 uses the machine login, not its own");
  assert.equal(readinessNoticePlan(verify("agent:a2"), here, "computer-owner")?.recipientUserId, "agent-owner");
  assert.equal(readinessNoticePlan(verify("shared:made-up"), here, "computer-owner"), null);
});

test("the remembered notices stay bounded: older than the window out, then the newest kept", () => {
  assert.deepEqual(pruneReadinessNotified({ old: NOW - READINESS_RENOTIFY_AFTER_MS, recent: NOW - 1 }, NOW), { recent: NOW - 1 });
  const many = Object.fromEntries(Array.from({ length: READINESS_NOTIFIED_MAX_KEYS + 50 }, (_, index) => [`k${index}`, NOW - index]));
  const kept = pruneReadinessNotified(many, NOW);
  assert.equal(Object.keys(kept).length, READINESS_NOTIFIED_MAX_KEYS);
  assert.ok("k0" in kept && !(`k${READINESS_NOTIFIED_MAX_KEYS}` in kept));
});
