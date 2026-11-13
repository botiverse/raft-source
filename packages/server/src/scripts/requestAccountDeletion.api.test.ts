import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { checkEndpoint, parseArgs, run, type RunOptions } from "../../scripts/request-account-deletion";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { accountDeletionRequests, agentCredentials, agents, computers, featureFlags, integrationAuditEvents, machines, serverMembers, sessions } from "../db/schema";
import { requestAccountDeletion } from "../services/accountDeletion/requests";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "../services/emailService";
import { signInForTest } from "../test/integration/credentials";

// The ops entry (scripts/request-account-deletion.ts): a dry-run prints the
// app's deletion preview and writes nothing; --apply asks through the in-app
// path with source "ops"; a pending request or a 409 gate refuses, unwritten.

/** The retired `account_deletion_v0` row as production may still hold it (#raft-architecture:#32): read by nothing now. */
async function seedRetiredDeletionFlag(defaultEnabled: boolean): Promise<void> {
  await getDb().insert(featureFlags)
    .values({ key: "account_deletion_v0", randomizationUnit: "user", salt: "test", defaultEnabled })
    .onConflictDoUpdate({ target: featureFlags.key, set: { defaultEnabled } });
}

const test = createApiTest();

const savedPepper = process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
beforeAll(() => { process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = "ops-account-deletion-test-pepper-0123456789abcdef"; });
afterAll(() => {
  if (savedPepper === undefined) delete process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
  else process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = savedPepper;
});

function captureEmails() {
  const deliveries: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => deliveries.push(delivery));
  return { deliveries, stop: () => __setEmailDeliveryObserverForTests(null) };
}

function options(overrides: Partial<RunOptions> & Pick<RunOptions, "userId">) {
  const lines: string[] = [];
  const opts: RunOptions = { ticketRef: "SUP-123", apply: false, actorUserId: null, log: (line) => lines.push(line), ...overrides };
  return { opts, lines };
}

const requestRows = (userId: string) => getDb().select().from(accountDeletionRequests).where(eq(accountDeletionRequests.userId, userId));

/** What a request writes: compared before and after a run that must write nothing. */
const snapshot = async (userId: string) => ({
  requests: await requestRows(userId),
  sessions: await getDb().select().from(sessions).where(eq(sessions.userId, userId)),
  credentials: await getDb().select().from(agentCredentials).orderBy(agentCredentials.id),
  computers: await getDb().select().from(computers).orderBy(computers.id),
  agents: await getDb().select().from(agents).orderBy(agents.id),
});

test("one server only they are in, no Computers: the dry-run prints the preview and writes nothing; --apply asks as the in-app button does, with source ops", async ({ app, seed }) => {
  const operator = await seed.human();
  const human = await seed.human();
  const server = await seed.server({ owner: human, name: "Solo" });
  const agent = await createAgent(server.id, "helper", { runtime: "external", creatorType: "user", creatorId: human.id });
  const key = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "key", issuedVia: "human", createdByUserId: human.id });
  await signInForTest(human.id);
  const emails = captureEmails();
  try {
    const before = await snapshot(human.id);
    const dry = options({ userId: human.id });
    assert.deepEqual(await run(dry.opts), { outcome: "dry_run", blocked: [] });
    assert.deepEqual(await snapshot(human.id), before, "a dry-run writes nothing");
    assert.equal(emails.deliveries.length, 0);
    const masked = `${human.email[0]}***@test.invalid`;
    assert.equal(dry.lines[0], `[OPS_ACCOUNT_DELETION_PERSON] user=${human.id} email=${masked} retired=no`);
    assert.ok(!dry.lines.join("\n").includes(human.email), "the email is masked");
    assert.equal(dry.lines[1], "[OPS_ACCOUNT_DELETION_STATUS] pending=no");
    assert.equal(dry.lines[2], `[OPS_ACCOUNT_DELETION_SOLE_MEMBER_SERVER] server=${server.id} slug=${server.slug} name="Solo" (deleted with the account)`);
    assert.equal(dry.lines[3], `[OPS_ACCOUNT_DELETION_AGENT] agent=${agent.id} server=${server.id} outcome=closes_with_server to_user=- name="helper"`);
    assert.match(dry.lines[4]!, /^\[OPS_ACCOUNT_DELETION_EFFECTIVE\] grace_days=7 scheduled_for=\S+ \(if requested now\)$/);
    assert.equal(dry.lines[5], "[OPS_ACCOUNT_DELETION_TOTAL] sole_owner_servers=0 sole_member_servers=1 paid_servers=0 agents=1 computers=0 others_agents=0");
    assert.equal(dry.lines.length, 6, dry.lines.join("\n"));

    const applied = options({ userId: human.id, apply: true, actorUserId: operator.id });
    const startedAt = Date.now();
    const result = await run(applied.opts);
    assert.equal(result.outcome, "requested", applied.lines.join("\n"));
    const [row, ...more] = await requestRows(human.id);
    assert.equal(more.length, 0);
    assert.deepEqual(
      { source: row!.source, ticketRef: row!.ticketRef, actorUserId: row!.actorUserId, state: row!.state, hasUndoLink: row!.cancelTokenHash !== null },
      { source: "ops", ticketRef: "SUP-123", actorUserId: operator.id, state: "pending", hasUndoLink: true },
    );
    const graceMs = row!.scheduledFor.getTime() - row!.requestedAt.getTime();
    assert.equal(graceMs, 7 * 24 * 60 * 60_000, "the same grace period");
    assert.ok(row!.requestedAt.getTime() >= startedAt - 1_000);
    assert.deepEqual(result, { outcome: "requested", requestId: row!.id, scheduledFor: row!.scheduledFor.toISOString(), notStoppedAgentIds: [agent.id], subscriptionServerIds: [] });
    const requested = applied.lines.find((line) => line.startsWith("[OPS_ACCOUNT_DELETION_REQUESTED]"));
    assert.ok(requested?.includes(`request=${row!.id} user=${human.id} source=ops actor=${operator.id} ticket_ref="SUP-123" `), applied.lines.join("\n"));
    assert.ok(requested!.includes("undo_link=yes") && requested!.includes(`not_stopped_agents=${agent.id}`), requested);

    // The same revocations: every sign-in, and the person's agent keys.
    assert.deepEqual(await getDb().select().from(sessions).where(eq(sessions.userId, human.id)), []);
    const [revokedKey] = await getDb().select({ revokedAt: agentCredentials.revokedAt }).from(agentCredentials).where(eq(agentCredentials.id, key.credentialId));
    assert.ok(revokedKey!.revokedAt);
    // The same email, sent the same way, whose undo link cancels the request.
    assert.equal(emails.deliveries.length, 1, emails.deliveries.map((mail) => mail.subject).join(" | "));
    assert.equal(emails.deliveries[0]!.to, human.email);
    assert.match(emails.deliveries[0]!.subject, /will be deleted on/);
    const token = /[?&]cancel_account_deletion=([A-Za-z0-9_-]+)/.exec(emails.deliveries[0]!.html)?.[1];
    assert.ok(token, "the email carries the undo link");
    const undo = await fetch(`${app.baseUrl}/api/auth/account-deletion/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    assert.equal(undo.status, 200, await undo.text());
    assert.equal((await requestRows(human.id))[0]!.state, "cancelled");
  } finally {
    emails.stop();
  }
});

test("a Computer the person attached on someone else's machine refuses --apply: a script cannot tell its agents' owners", async ({ seed }) => {
  const operator = await seed.human();
  const colleague = await seed.human();
  const human = await seed.human();
  const server = await seed.server({ owner: colleague, members: [human] });
  const [box] = await getDb().insert(machines).values({ serverId: server.id, userId: colleague.id, name: "their-box", apiKeyHash: `hash-${randomUUID()}` }).returning();
  const [computer] = await getDb().insert(computers).values({
    serverId: server.id, name: "their-box", machineId: box!.id, apiKeyHash: "h", apiKeyPrefix: `sk_computer_${randomUUID().slice(0, 8)}`, attachedByUserId: human.id,
  }).returning();
  const emails = captureEmails();
  try {
    const dry = options({ userId: human.id });
    assert.deepEqual(await run(dry.opts), { outcome: "dry_run", blocked: ["computers_on_others_machines"] });
    assert.ok(dry.lines.includes(`[OPS_ACCOUNT_DELETION_OTHERS_MACHINE_COMPUTER] computer=${computer!.id} machine=${box!.id} (a script cannot tell its agents' owners: use the in-app path or handle by hand)`), dry.lines.join("\n"));

    const before = await snapshot(human.id);
    const applied = options({ userId: human.id, apply: true, actorUserId: operator.id });
    assert.deepEqual(await run(applied.opts), { outcome: "blocked", blocked: ["computers_on_others_machines"] });
    assert.ok(applied.lines.includes("[OPS_ACCOUNT_DELETION_REFUSED] reason=computers_on_others_machines (nothing written)"), applied.lines.join("\n"));
    assert.deepEqual(await snapshot(human.id), before, "nothing written");
    assert.deepEqual(await requestRows(human.id), []);
    const [still] = await getDb().select({ revokedAt: computers.revokedAt }).from(computers).where(eq(computers.id, computer!.id));
    assert.equal(still!.revokedAt, null, "the Computer is not revoked");
    assert.equal(emails.deliveries.length, 0);
  } finally {
    emails.stop();
  }
});

test("an agent of the person's that can be running (on a Computer, or cloud) refuses --apply: a script cannot stop it", async ({ seed }) => {
  const operator = await seed.human();
  const human = await seed.human();
  const server = await seed.server({ owner: human, name: "Solo" });
  const [box] = await getDb().insert(machines).values({ serverId: server.id, userId: human.id, name: "own-box", apiKeyHash: `hash-${randomUUID()}` }).returning();
  const onComputer = await createAgent(server.id, "on-box", { runtime: "external", creatorType: "user", creatorId: human.id });
  await getDb().update(agents).set({ machineId: box!.id, status: "active" }).where(eq(agents.id, onComputer.id));
  const nowhere = await createAgent(server.id, "nowhere", { runtime: "external", creatorType: "user", creatorId: human.id });
  const emails = captureEmails();
  try {
    const dry = options({ userId: human.id });
    assert.deepEqual(await run(dry.opts), { outcome: "dry_run", blocked: ["agents_left_running"] });
    assert.ok(dry.lines.includes(`[OPS_ACCOUNT_DELETION_RUNNING_AGENT] agent=${onComputer.id} (a script cannot stop it: use the in-app path, or stop it first)`), dry.lines.join("\n"));
    assert.ok(!dry.lines.some((line) => line.includes(`_RUNNING_AGENT] agent=${nowhere.id}`)), "an agent on no Computer has no process to stop");

    const before = await snapshot(human.id);
    const applied = options({ userId: human.id, apply: true, actorUserId: operator.id });
    assert.deepEqual(await run(applied.opts), { outcome: "blocked", blocked: ["agents_left_running"] });
    assert.deepEqual(await snapshot(human.id), before, "nothing written");
    assert.deepEqual(await requestRows(human.id), []);
    assert.equal(emails.deliveries.length, 0);

    // Stopped first, the same person goes through.
    await getDb().update(agents).set({ status: "stopped" }).where(eq(agents.id, onComputer.id));
    const again = options({ userId: human.id, apply: true, actorUserId: operator.id });
    assert.equal((await run(again.opts)).outcome, "requested", again.lines.join("\n"));
  } finally {
    emails.stop();
  }
});

test("already pending: the dry-run says so, --apply refuses and writes nothing", async ({ seed }) => {
  const operator = await seed.human();
  const human = await seed.human();
  await seed.server({ owner: human });
  await requestAccountDeletion({ userId: human.id, source: "self", actorUserId: human.id });
  const [pending] = await requestRows(human.id);
  const emails = captureEmails();
  try {
    const dry = options({ userId: human.id });
    assert.deepEqual(await run(dry.opts), { outcome: "dry_run", blocked: ["already_pending"] });
    assert.equal(dry.lines[1], `[OPS_ACCOUNT_DELETION_STATUS] pending=yes requested_at=${pending!.requestedAt.toISOString()} scheduled_for=${pending!.scheduledFor.toISOString()}`);
    assert.equal(dry.lines.at(-1), "[OPS_ACCOUNT_DELETION_BLOCKED] reasons=already_pending (--apply would be refused)");

    const before = await snapshot(human.id);
    const applied = options({ userId: human.id, apply: true, actorUserId: operator.id });
    assert.deepEqual(await run(applied.opts), { outcome: "refused", code: "already_pending" });
    assert.equal(applied.lines.at(-1), `[OPS_ACCOUNT_DELETION_REFUSED] reason=already_pending request=${pending!.id} source=self `
      + `requested_at=${pending!.requestedAt.toISOString()} scheduled_for=${pending!.scheduledFor.toISOString()} (nothing written)`);
    assert.deepEqual(await snapshot(human.id), before);
    assert.equal(emails.deliveries.length, 0);
  } finally {
    emails.stop();
  }
});

test("the 409 gates refuse --apply with their details and nothing written: someone else's agent on the person's Computer; sole owner with members; flag off", async ({ seed }) => {
  const operator = await seed.human();
  const colleague = await seed.human({ name: "Colleague" });
  const human = await seed.human();
  const server = await seed.server({ owner: human, members: [colleague], name: "Home" });
  await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, colleague.id)));
  const [laptop] = await getDb().insert(machines).values({ serverId: server.id, userId: human.id, name: "laptop", apiKeyHash: `hash-${randomUUID()}` }).returning();
  await getDb().insert(computers).values({ serverId: server.id, name: "laptop", machineId: laptop!.id, apiKeyHash: "h", apiKeyPrefix: `sk_computer_${randomUUID().slice(0, 8)}`, attachedByUserId: human.id });
  const alpha = await createAgent(server.id, "alpha", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  await getDb().update(agents).set({ machineId: laptop!.id, status: "active" }).where(eq(agents.id, alpha.id));
  await signInForTest(human.id);
  const emails = captureEmails();
  try {
    const othersLine = `[OPS_ACCOUNT_DELETION_OTHERS_AGENT] agent=${alpha.id} computer=${laptop!.id} server=${server.id} owner=${colleague.id} `
      + `personal_assistant=false owner_notified_at=- name="alpha" computer_name="laptop" owner_name="Colleague"`;
    const dry = options({ userId: human.id });
    assert.deepEqual(await run(dry.opts), { outcome: "dry_run", blocked: ["others_agents_on_computers"] });
    assert.ok(dry.lines.includes(`[OPS_ACCOUNT_DELETION_COMPUTER] computer=${laptop!.id} server=${server.id} agents=1 others_agents=1 name="laptop" (key revoked)`), dry.lines.join("\n"));
    assert.ok(dry.lines.includes(othersLine), dry.lines.join("\n"));

    const before = await snapshot(human.id);
    const applied = options({ userId: human.id, apply: true, actorUserId: operator.id });
    assert.deepEqual(await run(applied.opts), { outcome: "refused", code: "others_agents_on_computers" });
    assert.deepEqual(applied.lines.slice(-2), ["[OPS_ACCOUNT_DELETION_REFUSED] reason=others_agents_on_computers (nothing written)", othersLine]);
    assert.deepEqual(await snapshot(human.id), before, "nothing revoked, unbound or requested");

    // Sole owner of a server with other members: refused first, listing it.
    await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, colleague.id)));
    const soleOwner = options({ userId: human.id, apply: true, actorUserId: operator.id });
    assert.deepEqual(await run(soleOwner.opts), { outcome: "refused", code: "sole_owner_servers" });
    assert.deepEqual(soleOwner.lines.slice(-2), [
      "[OPS_ACCOUNT_DELETION_REFUSED] reason=sole_owner_servers (nothing written)",
      `[OPS_ACCOUNT_DELETION_SOLE_OWNER_SERVER] server=${server.id} slug=${server.slug} members=2 name="Home" (hand over or delete first)`,
    ]);

    // The retired account_deletion_v0 row, even left off, no longer blocks: deletion is always available.
    await getDb().update(agents).set({ machineId: null }).where(eq(agents.id, alpha.id));
    await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, colleague.id)));
    await seedRetiredDeletionFlag(false);
    const retiredFlagOff = options({ userId: human.id, apply: true, actorUserId: operator.id });
    assert.equal((await run(retiredFlagOff.opts)).outcome, "requested", retiredFlagOff.lines.join("\n"));
    assert.equal((await requestRows(human.id)).length, 1);
  } finally {
    emails.stop();
  }
});

test("arguments and the production endpoint guard", () => {
  const userId = randomUUID();
  const base = ["--environment", "production", "--user-id", userId, "--ticket-ref", "SUP-1"];
  const accountable = randomUUID();
  const apply = [...base, "--apply", "--approval-reference", "https://raft/msg/1", "--run-id", "oad-1", "--accountable-user-id", accountable];
  assert.equal(parseArgs(apply).actorUserId, accountable, "--accountable-user-id is recorded as the request's actor");
  const alias = [...base, "--apply", "--approval-reference", "https://raft/msg/1", "--run-id", "oad-1", "--actor-user-id", accountable];
  assert.equal(parseArgs(alias).actorUserId, accountable, "--actor-user-id stays an alias");
  assert.deepEqual(parseArgs(base), { environment: "production", userId, ticketRef: "SUP-1", apply: false, approvalReference: null, runId: null, actorUserId: null });
  assert.equal(parseArgs(["--", ...apply]).apply, true);
  assert.throws(() => parseArgs(["--user-id", userId, "--ticket-ref", "t"]), /--environment/);
  assert.throws(() => parseArgs(["--environment", "production", "--ticket-ref", "t"]), /--user-id/);
  assert.throws(() => parseArgs(["--environment", "production", "--user-id", "nope", "--ticket-ref", "t"]), /--user-id/);
  assert.throws(() => parseArgs(["--environment", "production", "--user-id", userId]), /--ticket-ref/);
  assert.throws(() => parseArgs(["--environment", "production", "--user-id", userId, "--ticket-ref", "  "]), /--ticket-ref/);
  assert.throws(() => parseArgs(apply.filter((arg, i) => arg !== "--approval-reference" && apply[i - 1] !== "--approval-reference")), /--approval-reference/);
  assert.throws(() => parseArgs(apply.filter((arg, i) => arg !== "--run-id" && apply[i - 1] !== "--run-id")), /--run-id/);
  assert.throws(() => parseArgs(apply.filter((arg, i) => arg !== "--accountable-user-id" && apply[i - 1] !== "--accountable-user-id")), /--accountable-user-id <the user id of the human who approved it> \(never an agent/);
  assert.throws(() => parseArgs([...base, "--run-id", "r"]), /only for --apply/);
  assert.throws(() => parseArgs([...base, "--actor-user-id", randomUUID()]), /only for --apply/);
  assert.throws(() => parseArgs([...base, "--force"]), /Unknown argument/);
  const all = { redis: true, email: true, pepper: true };
  assert.match(checkEndpoint("production", false, false, all) ?? "", /replica/);
  assert.equal(checkEndpoint("production", false, true, { redis: false, email: false, pepper: false }), null);
  assert.match(checkEndpoint("production", true, true, all) ?? "", /primary/);
  assert.match(checkEndpoint("production", true, false, { ...all, redis: false }) ?? "", /REDIS_URL/);
  assert.match(checkEndpoint("production", true, false, { ...all, email: false }) ?? "", /RESEND_API_KEY/);
  assert.match(checkEndpoint("production", true, false, { ...all, pepper: false }) ?? "", /PEPPER/);
  assert.equal(checkEndpoint("production", true, false, all), null);
  assert.equal(checkEndpoint("staging", true, false, { redis: false, email: false, pepper: false }), null);
});
