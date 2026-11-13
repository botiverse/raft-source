import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";

import { checkEndpoint, findCandidates, parseArgs, revokeDepartedAttacherComputer, run, type RunOptions } from "../../scripts/revoke-departed-attacher-computers";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agentCredentials, agents, computers, integrationAuditEvents, serverMembers } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { generateComputerApiKeyMaterial } from "../services/computerCredentialService";
import type { DeviceSessionKeyReach } from "../services/deviceSessionKeys";
import { registerMachine } from "../services/machineService";

// The one-time cleanup (scripts/revoke-departed-attacher-computers.ts) revokes
// the live Computers whose attacher is no longer a member of the Computer's
// server, as a removal now does, with no actor.

const test = createApiTest();

/** A Computer `userId` attached to `serverId`, with a real key, an agent `creatorId` made on it and a runner credential its machine minted. */
async function attachComputer(serverId: string, userId: string, name: string, creatorId = userId) {
  const { machine } = await registerMachine(serverId, userId, name);
  const material = await generateComputerApiKeyMaterial();
  const [computer] = await getDb().insert(computers).values({
    serverId, name, apiKeyHash: material.apiKeyHash, apiKeyPrefix: material.apiKeyPrefix, apiKeyHmac: material.apiKeyHmac,
    attachedByUserId: userId, machineId: machine.id,
  }).returning();
  const agent = await createAgent(serverId, `${name}-agent`, { runtime: "external", creatorType: "user", creatorId });
  await getDb().update(agents).set({ machineId: machine.id, status: "active" }).where(eq(agents.id, agent.id));
  const runner = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: `${name}-runner`, issuedVia: "computer", createdByUserId: null });
  await getDb().update(agentCredentials).set({ issuedByMachineId: machine.id }).where(eq(agentCredentials.id, runner.credentialId));
  return { computerId: computer!.id, machineId: machine.id, apiKey: material.apiKey, agentId: agent.id, runnerCredentialId: runner.credentialId };
}

async function preflight(baseUrl: string, apiKey: string): Promise<number> {
  const res = await fetch(`${baseUrl}/internal/computer/preflight`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  });
  await res.body?.cancel();
  return res.status;
}

/** A departure from before removals revoked Computers: only the member row goes. */
const dropMembership = (serverId: string, userId: string) =>
  getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));

const credentialRevokedAt = async (credentialId: string) =>
  (await getDb().select({ revokedAt: agentCredentials.revokedAt }).from(agentCredentials).where(eq(agentCredentials.id, credentialId)))[0]!.revokedAt;

function options(overrides: Partial<RunOptions> = {}) {
  const lines: string[] = [];
  const closed: DeviceSessionKeyReach[] = [];
  const opts: RunOptions = {
    apply: false, batchSize: 1, sleepMs: 0, log: (line) => lines.push(line),
    close: async (reach) => { closed.push(reach); },
    ...overrides,
  };
  return { opts, lines, closed };
}

test("dry-run lists only the departed attacher's Computer; apply revokes only it, audited with no actor; a re-run does nothing", async ({ app, seed }) => {
  const owner = await seed.human();
  const departed = await seed.human();
  const member = await seed.human();
  const rejoiner = await seed.human();
  const server = await seed.server({ owner, members: [departed, member, rejoiner] });
  const theirs = await attachComputer(server.id, departed.id, "departed-laptop", member.id);
  const members = await attachComputer(server.id, member.id, "member-box");
  const rejoiners = await attachComputer(server.id, rejoiner.id, "rejoiner-box");
  await dropMembership(server.id, departed.id);
  // Left and came back: a member again, so their Computer is not touched.
  await dropMembership(server.id, rejoiner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: rejoiner.id, role: "member" });

  const before = await getDb().select().from(computers).orderBy(computers.id);
  const dry = options();
  const listed = await run(dry.opts);
  assert.deepEqual(listed.candidates.map((c) => c.computerId), [theirs.computerId]);
  assert.deepEqual(
    { ...listed.candidates[0]!, lastUsedAt: undefined, lastHeartbeat: undefined },
    { computerId: theirs.computerId, computerName: "departed-laptop", serverId: server.id, machineId: theirs.machineId, attachedByUserId: departed.id,
      agents: 1, othersAgents: 1, lastUsedAt: undefined, lastHeartbeat: undefined },
  );
  assert.equal(dry.lines.length, 2, dry.lines.join("\n"));
  assert.match(dry.lines[0]!, new RegExp(`^\\[DEPARTED_ATTACHER_COMPUTERS_CANDIDATE\\] computer=${theirs.computerId} server=${server.id} machine=${theirs.machineId} attached_by=${departed.id} agents=1 others_agents=1 `));
  assert.equal(dry.lines[1], "[DEPARTED_ATTACHER_COMPUTERS_TOTAL] computers=1 servers=1 agents=1 others_agents=1 selected=1 excluded=0");
  assert.deepEqual(await getDb().select().from(computers).orderBy(computers.id), before, "dry-run writes nothing");
  assert.equal(await preflight(app.baseUrl, theirs.apiKey), 200);

  const applied = options({ apply: true });
  const result = await run(applied.opts);
  assert.deepEqual([result.revoked, result.skipped], [[theirs.computerId], []]);
  assert.equal(await preflight(app.baseUrl, theirs.apiKey), 401, "the departed attacher's Computer key is refused");
  assert.ok(await credentialRevokedAt(theirs.runnerCredentialId), "what its machine minted is revoked");
  assert.deepEqual(applied.closed, [{ agentIds: [theirs.agentId], machineIds: [theirs.machineId] }], "its connection is closed after commit");
  assert.ok(applied.lines.some((line) => line.startsWith(`[DEPARTED_ATTACHER_COMPUTERS_REVOKED] computer=${theirs.computerId} `) && line.includes(`notify_agents=${theirs.agentId}`)), applied.lines.join("\n"));
  const [revoked] = await getDb().select().from(computers).where(eq(computers.id, theirs.computerId));
  assert.equal(revoked!.revokedByUserId, null);
  const [bound] = await getDb().select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, theirs.agentId));
  assert.equal(bound!.machineId, theirs.machineId, "the agent on it stays bound");

  for (const kept of [members, rejoiners]) {
    assert.equal(await preflight(app.baseUrl, kept.apiKey), 200, "a member's Computer is untouched");
    assert.equal(await credentialRevokedAt(kept.runnerCredentialId), null);
  }

  const audits = await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.serverId, server.id));
  const keyRevoked = audits.filter((row) => row.eventType === "computer.key_revoked");
  assert.equal(keyRevoked.length, 1);
  assert.equal(keyRevoked[0]!.targetId, theirs.computerId);
  assert.deepEqual([keyRevoked[0]!.actorType, keyRevoked[0]!.actorId, keyRevoked[0]!.source], ["system", null, "system"], "no actor");
  assert.deepEqual(
    { via: keyRevoked[0]!.metadata.via, departureReason: keyRevoked[0]!.metadata.departureReason, actorRole: keyRevoked[0]!.metadata.actorRole, operationId: keyRevoked[0]!.metadata.operationId, revokedCount: keyRevoked[0]!.metadata.revokedCount },
    { via: "member_removed", departureReason: "removed", actorRole: undefined, operationId: result.operationId, revokedCount: 1 },
  );
  const credentialRevoked = audits.filter((row) => row.eventType === "agent_credential.revoked");
  assert.deepEqual(credentialRevoked.map((row) => [row.targetId, row.actorId, row.metadata.departureReason]), [[theirs.runnerCredentialId, null, "removed"]]);

  const after = await getDb().select().from(computers).orderBy(computers.id);
  const again = options({ apply: true });
  const rerun = await run(again.opts);
  assert.deepEqual([rerun.candidates, rerun.revoked, again.closed], [[], [], []]);
  assert.equal(again.lines.at(-1), "[DEPARTED_ATTACHER_COMPUTERS_TOTAL] computers=0 servers=0 agents=0 others_agents=0 selected=0 excluded=0");
  assert.deepEqual(await getDb().select().from(computers).orderBy(computers.id), after, "a re-run changes nothing");
  assert.equal((await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "computer.key_revoked"))).length, 1);
});

test("each revoke re-checks the rule in its transaction: someone who rejoined after the listing is skipped", async ({ app, seed }) => {
  const owner = await seed.human();
  const person = await seed.human();
  const server = await seed.server({ owner, members: [person] });
  const theirs = await attachComputer(server.id, person.id, "their-laptop");
  await dropMembership(server.id, person.id);

  const [listed] = await findCandidates();
  assert.equal(listed!.computerId, theirs.computerId);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: person.id, role: "member" });

  assert.deepEqual(await revokeDepartedAttacherComputer(listed!, "op-1"), { outcome: "skipped", reason: "rejoined" });
  assert.equal(await preflight(app.baseUrl, theirs.apiKey), 200);
  assert.equal(await credentialRevokedAt(theirs.runnerCredentialId), null);

  // Revoked by someone else meanwhile: nothing more to do, nothing audited twice.
  await dropMembership(server.id, person.id);
  await getDb().update(computers).set({ revokedAt: new Date() }).where(eq(computers.id, theirs.computerId));
  assert.deepEqual(await revokeDepartedAttacherComputer(listed!, "op-2"), { outcome: "skipped", reason: "already_revoked" });
  assert.deepEqual(await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "computer.key_revoked")), []);
});

test("arguments and the production endpoint guard", () => {
  const base = ["--environment", "production"];
  assert.equal(parseArgs(base).apply, false);
  assert.deepEqual(parseArgs(["--", ...base, "--apply", "--approval-reference", "https://raft/msg/1", "--run-id", "dac-1"]).apply, true);
  assert.throws(() => parseArgs([]), /--environment/);
  assert.throws(() => parseArgs([...base, "--apply", "--run-id", "r"]), /--approval-reference/);
  assert.throws(() => parseArgs([...base, "--apply", "--approval-reference", "m"]), /--run-id/);
  assert.throws(() => parseArgs([...base, "--run-id", "r"]), /only for --apply/);
  assert.throws(() => parseArgs([...base, "--batch", "0"]), /--batch/);
  assert.throws(() => parseArgs([...base, "--nope"]), /Unknown argument/);
  assert.match(checkEndpoint("production", false, false, false) ?? "", /replica/);
  assert.match(checkEndpoint("production", true, true, true) ?? "", /primary/);
  assert.match(checkEndpoint("production", true, false, false) ?? "", /REDIS_URL/);
  assert.equal(checkEndpoint("production", true, false, true), null);
  assert.equal(checkEndpoint("production", false, true, false), null);
  assert.equal(checkEndpoint("staging", true, false, false), null);
});

test("--exclude-computer and --only-computer narrow the run: left-out candidates are listed _EXCLUDED and never revoked", async ({ app, seed }) => {
  const owner = await seed.human();
  const [a, b, c] = [await seed.human(), await seed.human(), await seed.human()];
  const server = await seed.server({ owner, members: [a, b, c] });
  const [ca, cb, cc] = [await attachComputer(server.id, a.id, "a-box"), await attachComputer(server.id, b.id, "b-box"), await attachComputer(server.id, c.id, "c-box")];
  for (const person of [a, b, c]) await dropMembership(server.id, person.id);
  const typo = "00000000-0000-4000-8000-000000000000";

  // Dry-run: the excluded one is listed, nothing is written.
  const dry = options({ excludeComputerIds: new Set([cb.computerId, typo]) });
  const dryResult = await run(dry.opts);
  assert.deepEqual(dryResult.excluded, [{ computerId: cb.computerId, reason: "excluded" }]);
  assert.ok(dry.lines.some((line) => line.includes("_EXCLUDED") && line.includes(cb.computerId)));
  assert.ok(dry.lines.some((line) => line.includes("_UNMATCHED") && line.includes(typo)), "a mistyped id is shown");
  assert.ok(dry.lines.some((line) => /_TOTAL\].* selected=2 excluded=1/.test(line)));

  // Apply with an exclusion: the excluded Computer keeps working.
  const first = options({ apply: true, excludeComputerIds: new Set([cb.computerId]) });
  const applied = await run(first.opts);
  assert.deepEqual(applied.revoked.sort(), [ca.computerId, cc.computerId].sort());
  assert.deepEqual(applied.excluded, [{ computerId: cb.computerId, reason: "excluded" }]);
  assert.equal(await preflight(app.baseUrl, cb.apiKey), 200);
  assert.equal(await preflight(app.baseUrl, ca.apiKey), 401);

  // --only-computer revokes just that one; an id in both lists stays excluded.
  const both = await run(options({ apply: true, onlyComputerIds: new Set([cb.computerId]), excludeComputerIds: new Set([cb.computerId]) }).opts);
  assert.deepEqual(both.revoked, []);
  assert.equal(await preflight(app.baseUrl, cb.apiKey), 200);
  const only = await run(options({ apply: true, onlyComputerIds: new Set([cb.computerId]) }).opts);
  assert.deepEqual(only.revoked, [cb.computerId]);
  assert.equal(await preflight(app.baseUrl, cb.apiKey), 401);

  // Flags: repeatable, UUIDs only.
  const parsed = parseArgs(["--environment", "staging", "--exclude-computer", ca.computerId, "--exclude-computer", cb.computerId.toUpperCase(), "--only-computer", cc.computerId]);
  assert.deepEqual(parsed.excludeComputerIds, [ca.computerId, cb.computerId]);
  assert.deepEqual(parsed.onlyComputerIds, [cc.computerId]);
  assert.throws(() => parseArgs(["--environment", "staging", "--exclude-computer", "nixos-beijing"]), /Computer id/);
  assert.throws(() => parseArgs(["--environment", "staging", "--only-computer"]), /Computer id/);
});
