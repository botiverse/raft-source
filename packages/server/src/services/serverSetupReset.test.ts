import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, computers, integrationAuditEvents, machines, serverMembers, servers, users } from "../db/schema";
import { createServer, removeMember } from "./serverService";
import { createAgent } from "./agentService";
import { __setAgentCreateLockObserverForTests } from "./planService";
import {
  CURRENT_CONTRACT_VERSION,
  projectServerSetup,
  resetServerSetup,
  resolveServerSetup,
  resolveServerSetupLiveFacts,
  ServerSetupStateError,
} from "./serverSetupStateService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

/**
 * "Start over" — the rollback that replaces "Set up later".
 *
 * The whole design rests on one promise: before this server has ever had an agent, it holds
 * nothing anyone could lose, so throwing it away is safe. These teeth guard that promise from
 * both sides — that the rollback really does clear the way, and that it REFUSES the moment
 * the promise stops being true.
 */

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: "test-hash",
    emailVerified: true,
  }).returning();
  return user;
}

async function attachComputer(serverId: string, name: string, attachedByUserId: string | null = null) {
  const [computer] = await getDb().insert(computers).values({
    serverId,
    name,
    attachedByUserId,
    apiKeyHash: "argon2-placeholder",
    apiKeyPrefix: `sk_computer_${randomUUID().slice(0, 6)}`,
  }).returning();
  return computer;
}

test("reset revokes the stranded computers and rewinds setup to the start", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("reset-owner");
  const server = await createServer("Reset", `reset-${randomUUID()}`, owner.id);
  const sold = await attachComputer(server.id, "sold-laptop", owner.id);
  const dead = await attachComputer(server.id, "dead-desktop", owner.id);
  await db.update(serverMembers)
    .set({ setupStatus: "in_progress" })
    .where(eq(serverMembers.serverId, server.id));

  const result = await resetServerSetup({ serverId: server.id, actor: { type: "user", id: owner.id } });
  assert.equal(result.revokedComputers, 2);

  const live = await db.select({ id: computers.id }).from(computers)
    .where(and(eq(computers.serverId, server.id), isNull(computers.revokedAt)));
  assert.equal(live.length, 0, "every computer this half-built server had is revoked");

  const [row] = await db.select().from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));
  assert.equal(row.setupStatus, "not_started", "the owner starts the flow again from the top");
  assert.equal(row.setupCompletionReason, null);

  const audit = await db.select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.serverId, server.id), eq(integrationAuditEvents.eventType, "computer.key_revoked")));
  assert.deepEqual(audit.map((event) => event.targetId).sort(), [sold.id, dead.id].sort(), "one event per revoked computer");
  for (const event of audit) {
    assert.equal(event.eventCategory, "computer");
    assert.equal(event.actorType, "human");
    assert.equal(event.actorId, owner.id);
    assert.equal(event.requesterType, "human");
    assert.equal(event.requesterId, owner.id, "whoever attached the computer is the requester");
    assert.equal(event.targetType, "computer");
    assert.equal((event.metadata as Record<string, unknown>).reason, "setup_reset");
    assert.equal((event.metadata as Record<string, unknown>).actorRole, "owner");
  }
  const operationIds = new Set(audit.map((event) => (event.metadata as Record<string, unknown>).operationId));
  assert.equal(operationIds.size, 1, "one reset, one operationId");
  assert.equal(typeof [...operationIds][0], "string");
});

test("reset is atomic when rewinding setup fails after computers were revoked", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("reset-atomic");
  const server = await createServer("Atomic reset", `atomic-${randomUUID()}`, owner.id);
  await attachComputer(server.id, "still-connected");
  await db.update(serverMembers)
    .set({ setupStatus: "in_progress" })
    .where(eq(serverMembers.serverId, server.id));

  // Force the SECOND reset write to fail. The computer update comes first, so this is a
  // real database rollback tooth rather than a mock that throws before destruction starts.
  // PostgreSQL validates the existing in_progress row, then rejects only the attempted
  // rewind to not_started for this server.
  await db.execute(`
    ALTER TABLE "server_members"
    ADD CONSTRAINT "server_setup_reset_second_write_${server.id.replaceAll("-", "_")}"
    CHECK (NOT ("server_id" = '${server.id}' AND "setup_status" = 'not_started'))
  `);

  await assert.rejects(
    () => resetServerSetup({ serverId: server.id, actor: { type: "user", id: owner.id } }),
    "the forced second-write failure reaches the caller",
  );

  const live = await db.select({ id: computers.id }).from(computers)
    .where(and(eq(computers.serverId, server.id), isNull(computers.revokedAt)));
  assert.equal(live.length, 1, "the first write rolls back; the computer remains connected");

  const [row] = await db.select({ status: serverMembers.setupStatus }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));
  assert.equal(row.status, "in_progress");
});

test("concurrent agent create and reset serialize to one of two complete outcomes", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("reset-race");
  const server = await createServer("Reset race", `race-${randomUUID()}`, owner.id);
  const computer = await attachComputer(server.id, "race-laptop");
  await db.update(serverMembers)
    .set({ setupStatus: "in_progress" })
    .where(eq(serverMembers.serverId, server.id));

  const [resetResult, createResult] = await Promise.allSettled([
    resetServerSetup({ serverId: server.id, actor: { type: "user", id: owner.id } }),
    createAgent(server.id, "Cindy", {
      runtime: "claude",
      machineId: computer.id,
      expectedSetupStatus: "in_progress",
    }),
  ]);

  const [row] = await db.select({ status: serverMembers.setupStatus }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));
  const live = await db.select({ id: computers.id }).from(computers)
    .where(and(eq(computers.serverId, server.id), isNull(computers.revokedAt)));
  const created = await db.select({ id: agents.id }).from(agents)
    .where(eq(agents.serverId, server.id));

  const createWon = createResult.status === "fulfilled"
    && resetResult.status === "rejected"
    && row.status === "complete"
    && live.length === 1
    && created.length === 1;
  const resetWon = resetResult.status === "fulfilled"
    && createResult.status === "rejected"
    && row.status === "not_started"
    && live.length === 0
    && created.length === 0;

  assert.equal(
    createWon || resetWon,
    true,
    `illegal half-state: reset=${resetResult.status}, create=${createResult.status}, setup=${row.status}, live=${live.length}, agents=${created.length}`,
  );
});

test("agent create and setup reset both invoke the shared checkpoint lock", async ({ app }) => {

  const lockServerIds: string[] = [];
  __setAgentCreateLockObserverForTests((serverId) => lockServerIds.push(serverId));
  try {
    const db = getDb();
    const owner = await seedUser("shared-lock-owner");
    const createServerRow = await createServer(
      "Create lock",
      `create-lock-${randomUUID()}`,
      owner.id,
    );
    await attachComputer(createServerRow.id, "create-lock-laptop");
    await db.update(serverMembers)
      .set({ setupStatus: "in_progress" })
      .where(eq(serverMembers.serverId, createServerRow.id));

    await createAgent(createServerRow.id, "Cindy", {
      runtime: "claude",
      expectedSetupStatus: "in_progress",
    });

    const resetServerRow = await createServer(
      "Reset lock",
      `reset-lock-${randomUUID()}`,
      owner.id,
    );
    await attachComputer(resetServerRow.id, "reset-lock-laptop");
    await db.update(serverMembers)
      .set({ setupStatus: "in_progress" })
      .where(eq(serverMembers.serverId, resetServerRow.id));

    await resetServerSetup({
      serverId: resetServerRow.id,
      actor: { type: "user", id: owner.id },
    });

    assert.deepEqual(lockServerIds, [
      createServerRow.id,
      resetServerRow.id,
    ]);
  } finally {
    __setAgentCreateLockObserverForTests(null);
    await app.close();
  }
});

test("an agent create request queued behind a winning reset must fail and retry from setup", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("reset-wins");
  const server = await createServer("Reset wins", `reset-wins-${randomUUID()}`, owner.id);
  const computer = await attachComputer(server.id, "stale-request-laptop");
  await db.update(serverMembers)
    .set({ setupStatus: "in_progress" })
    .where(eq(serverMembers.serverId, server.id));

  await resetServerSetup({ serverId: server.id, actor: { type: "user", id: owner.id } });

  await assert.rejects(
    () => createAgent(server.id, "Cindy", {
      runtime: "claude",
      machineId: computer.id,
      expectedSetupStatus: "in_progress",
    }),
    (error: unknown) => {
      assert.match((error as Error).message, /SERVER_SETUP_CHANGED_RETRY/);
      return true;
    },
    "the stale create must not resurrect setup after reset committed",
  );

  const created = await db.select({ id: agents.id }).from(agents)
    .where(eq(agents.serverId, server.id));
  assert.equal(created.length, 0);
  const [row] = await db.select({ status: serverMembers.setupStatus }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));
  assert.equal(row.status, "not_started");
});

test("reset still works before Cindy even when the server has non-onboarding agents", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("reset-pre-cindy");
  const server = await createServer("Has non-Cindy agent", `non-cindy-${randomUUID()}`, owner.id);
  await attachComputer(server.id, "wrong-laptop");
  await createAgent(server.id, "assistant", { runtime: "claude" });

  await db.update(serverMembers)
    .set({ setupStatus: "in_progress", setupCompletionReason: null })
    .where(eq(serverMembers.serverId, server.id));

  const result = await resetServerSetup({ serverId: server.id, actor: { type: "user", id: owner.id } });
  assert.equal(result.revokedComputers, 1);

  const live = await db.select({ id: computers.id }).from(computers)
    .where(and(eq(computers.serverId, server.id), isNull(computers.revokedAt)));
  assert.equal(live.length, 0, "pre-Cindy start over still clears the connected computers");
});

test("reset REFUSES once the official onboarding agent exists — it does not ask setup_status", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("reset-refuse");
  const server = await createServer("Has agent", `has-agent-${randomUUID()}`, owner.id);
  await attachComputer(server.id, "working-laptop");
  const cindy = await createAgent(server.id, "cindy", { runtime: "claude" });
  await db.update(servers).set({ onboardingAgentId: cindy.id }).where(eq(servers.id, server.id));

  // The dangerous shape, and the reason this tooth exists. Force `setup_status` to lie:
  // say this server was never set up, exactly as a crash between the agent insert and the
  // setup write would have left it. The flag now says "nothing here to lose" while an
  // agent sits on the server. Anything that trusts the flag will happily revoke the
  // computer that agent runs on.
  await db.update(serverMembers)
    .set({ setupStatus: "not_started", setupCompletionReason: null })
    .where(eq(serverMembers.serverId, server.id));

  await assert.rejects(
    () => resetServerSetup({ serverId: server.id, actor: { type: "user", id: owner.id } }),
    (error: unknown) => {
      assert.ok(error instanceof ServerSetupStateError);
      assert.equal(error.code, "SERVER_ALREADY_SET_UP");
      return true;
    },
    "a lying flag must not be able to authorise a demolition",
  );

  const live = await db.select({ id: computers.id }).from(computers)
    .where(and(eq(computers.serverId, server.id), isNull(computers.revokedAt)));
  assert.equal(live.length, 1, "the agent's computer is untouched");
});

test("reset REFUSES on a server whose official onboarding agent was deleted — what happened, happened", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("reset-deleted-agent");
  const server = await createServer("Deleted agent", `del-${randomUUID()}`, owner.id);
  await attachComputer(server.id, "laptop");
  const agent = await createAgent(server.id, "gone", { runtime: "claude" });
  await db.update(servers).set({ onboardingAgentId: agent.id }).where(eq(servers.id, server.id));
  await db.execute(
    // Soft-delete Cindy, then rewind setup — the state a server lands in when someone
    // sets it up, deletes the onboarding agent, and the flag is later rewound by hand.
    // `everHadAgent` must still be true: the Cindy checkpoint is not revocable, or
    // "start over" would come back to life on a server that has been in real use.
    `UPDATE "agents" SET "deleted_at" = now() WHERE "id" = '${agent.id}'`,
  );
  await db.update(serverMembers)
    .set({ setupStatus: "not_started", setupCompletionReason: null })
    .where(eq(serverMembers.serverId, server.id));

  await assert.rejects(
    () => resetServerSetup({ serverId: server.id, actor: { type: "user", id: owner.id } }),
    (error: unknown) => (error as ServerSetupStateError).code === "SERVER_ALREADY_SET_UP",
  );
});

test("a new server is born under v2: it may complete or roll back, but it may not be bypassed", async ({ app }) => {
  const owner = await seedUser("v2-owner");
  const server = await createServer("Fresh", `fresh-${randomUUID()}`, owner.id);

  const [row] = await getDb().select().from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));
  assert.equal(row.setupContractVersion, CURRENT_CONTRACT_VERSION);

  // The two exits, and only those two. `defer` is gone (task #172): the way out of an
  // unfinished server is "start over", not "walk past". An in_progress row therefore blocks
  // chat and offers only reset + return_to_server.
  const projection = projectServerSetup(
    {
      serverId: server.id,
      userId: owner.id,
      status: "in_progress",
      completionReason: null,
      contractVersion: row.setupContractVersion,
    },
    {
      computer: "offline",
      hasConnectedComputer: true,
      offlineComputers: [],
      everHadAgent: false,
      runtime: "unknown",
      officialOnboardingAgent: "missing",
      ownerSurveyPending: false,
      ownerHandoffPending: false,
      ownerUpgradePromptPending: false,
      actorIsOwner: true,
    },
  );
  assert.deepEqual(projection.allowedExits, ["reset", "return_to_server"]);
  assert.equal(projection.blocksChat, true, "an unfinished v2 server still blocks chat — the exit is 'start over', not 'walk past'");
});

test("only the owner may throw a server away", async ({ app }) => {
  const owner = await seedUser("reset-real-owner");
  const other = await seedUser("reset-other");
  const server = await createServer("Not yours", `not-yours-${randomUUID()}`, owner.id);
  await attachComputer(server.id, "laptop");

  await assert.rejects(
    () => resetServerSetup({ serverId: server.id, actor: { type: "user", id: other.id } }),
    (error: unknown) => (error as ServerSetupStateError).code === "INSUFFICIENT_PERMISSION",
  );

  const live = await getDb().select({ id: computers.id }).from(computers)
    .where(and(eq(computers.serverId, server.id), isNull(computers.revokedAt)));
  assert.equal(live.length, 1, "a non-owner cannot revoke someone else's computer");
});

test("a primary owner removed from the Server cannot reset setup through the stale servers.ownerId", async ({ app }) => {
  // Task #91 (steady-state authorization gap, not only a race): `servers.ownerId` is immutable, and another
  // owner may remove the primary owner. The removed human's old session must not revoke the Server's Computers.
  const db = getDb();
  const primaryOwner = await seedUser("reset-removed-primary-owner");
  const secondOwner = await seedUser("reset-second-owner");
  const server = await createServer("Removed owner", `removed-owner-${randomUUID()}`, primaryOwner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: secondOwner.id, role: "owner" });
  await attachComputer(server.id, "laptop");
  await attachComputer(server.id, "desktop");
  await removeMember(server.id, primaryOwner.id, { reason: "removed", actorUserId: secondOwner.id });

  const setupRows = () => db.select({
    userId: serverMembers.userId,
    role: serverMembers.role,
    setupStatus: serverMembers.setupStatus,
    setupCompletionReason: serverMembers.setupCompletionReason,
  }).from(serverMembers).where(eq(serverMembers.serverId, server.id)).orderBy(serverMembers.userId);
  const setupBefore = await setupRows();

  await assert.rejects(
    () => resetServerSetup({ serverId: server.id, actor: { type: "user", id: primaryOwner.id } }),
    (error: unknown) => (error as ServerSetupStateError).code === "INSUFFICIENT_PERMISSION",
  );

  const revoked = await db.select({ id: computers.id }).from(computers)
    .where(and(eq(computers.serverId, server.id), isNotNull(computers.revokedAt)));
  assert.equal(revoked.length, 0, "a removed owner revokes no Computers");
  assert.deepEqual(await setupRows(), setupBefore, "setup rows are unchanged");
});

test("a server that is already complete cannot be un-finished by a rollback", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("reset-complete");
  const coOwner = await seedUser("reset-complete-co-owner");
  const server = await createServer("Done", `done-${randomUUID()}`, owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: coOwner.id, role: "owner" });
  await attachComputer(server.id, "laptop");

  // Grandfathered completion is durable even without the compatibility onboarding-agent pointer.
  // The pointer guard alone would wave this through and write `not_started` over a finished
  // setup. `complete` is terminal (@stdrc), and terminal has to mean terminal on every road
  // that reaches the column, not just the one we happened to be thinking about.
  await db.update(serverMembers)
    .set({ setupStatus: "complete", setupCompletionReason: "grandfathered" })
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));

  const [checkpoint] = await db.select({ onboardingAgentId: servers.onboardingAgentId })
    .from(servers)
    .where(eq(servers.id, server.id));
  assert.equal(checkpoint.onboardingAgentId, null, "the compatibility agent checkpoint is deliberately absent");

  const projection = await resolveServerSetup({
    serverId: server.id,
    actor: { type: "user", id: coOwner.id },
  });
  assert.equal(
    projection.surface,
    "complete",
    "another member's completed row suppresses Create Cindy without an agent pointer",
  );
  assert.equal(projection.currentStep, null);
  assert.equal(projection.blocksChat, false);

  await assert.rejects(
    () => resetServerSetup({ serverId: server.id, actor: { type: "user", id: owner.id } }),
    (error: unknown) => (error as ServerSetupStateError).code === "SERVER_ALREADY_SET_UP",
  );

  const [row] = await db.select().from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));
  assert.equal(row.setupStatus, "complete", "a finished setup stays finished");

  const live = await db.select({ id: computers.id }).from(computers)
    .where(and(eq(computers.serverId, server.id), isNull(computers.revokedAt)));
  assert.equal(live.length, 1, "and its computer is not revoked out from under it");
});

test("another owner's completion blocks destructive reset for the whole server", async ({ app }) => {
  const db = getDb();
  const primaryOwner = await seedUser("reset-primary-incomplete");
  const completedCoOwner = await seedUser("reset-completed-co-owner");
  const server = await createServer("Split predicates", `split-predicates-${randomUUID()}`, primaryOwner.id);
  await db.insert(serverMembers).values({
    serverId: server.id,
    userId: completedCoOwner.id,
    role: "owner",
    setupStatus: "complete",
    setupCompletionReason: "grandfathered",
  });
  await attachComputer(server.id, "protected-laptop");

  const [checkpoint] = await db.select({ onboardingAgentId: servers.onboardingAgentId })
    .from(servers)
    .where(eq(servers.id, server.id));
  assert.equal(checkpoint.onboardingAgentId, null, "the compatibility onboarding-agent pointer is absent");

  const [primaryBefore] = await db.select({ status: serverMembers.setupStatus })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, primaryOwner.id)));
  assert.equal(primaryBefore.status, "not_started", "the primary owner's own row has not completed setup");

  const projection = await resolveServerSetup({
    serverId: server.id,
    actor: { type: "user", id: primaryOwner.id },
  });
  assert.equal(projection.surface, "complete", "one owner's durable completion completes the server projection");
  assert.equal(projection.currentStep, null);
  assert.equal(projection.blocksChat, false);

  const setupRows = () => db.select({
    userId: serverMembers.userId,
    status: serverMembers.setupStatus,
    completionReason: serverMembers.setupCompletionReason,
  }).from(serverMembers).where(eq(serverMembers.serverId, server.id)).orderBy(serverMembers.userId);
  const before = await setupRows();

  await assert.rejects(
    () => resetServerSetup({ serverId: server.id, actor: { type: "user", id: primaryOwner.id } }),
    (error: unknown) => (error as ServerSetupStateError).code === "SERVER_ALREADY_SET_UP",
  );

  const live = await db.select({ id: computers.id }).from(computers)
    .where(and(eq(computers.serverId, server.id), isNull(computers.revokedAt)));
  assert.equal(live.length, 1, "the rejected reset revokes no Computer");
  assert.deepEqual(await setupRows(), before, "the rejected reset rewinds no member setup row");
});

// A managed Computer plus the live daemon identity it runs on. The `computers` row is the
// managed Computer (what setup connects and what reset revokes); the `machines`/daemon row is
// the socket the orchestrator reports online-ness for. They are LINKED by `machineId` — the
// same shape a real `raft-computer setup` leaves behind.
async function attachOnlineComputer(serverId: string, userId: string, name: string, runtimes: string[] = ["claude"]) {
  const [machine] = await getDb().insert(machines).values({
    serverId,
    userId,
    name: `${name}-daemon`,
    apiKeyHash: "argon2-placeholder",
    runtimes,
  }).returning();
  const [computer] = await getDb().insert(computers).values({
    serverId,
    name,
    apiKeyHash: "argon2-placeholder",
    apiKeyPrefix: `sk_computer_${randomUUID().slice(0, 6)}`,
    machineId: machine.id,
  }).returning();
  return { machine, computer };
}

async function readSetupState(serverId: string, userId: string) {
  const [row] = await getDb().select().from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
  return {
    serverId,
    userId,
    status: row.setupStatus,
    completionReason: row.setupCompletionReason,
    contractVersion: row.setupContractVersion,
  };
}

test("Start over returns the surface to Connect Computer even while the revoked computer's daemon socket is still live", async ({ app }) => {
  const owner = await seedUser("reset-surface");
  const server = await createServer("Surface", `surface-${randomUUID()}`, owner.id);
  await getDb().update(serverMembers)
    .set({ setupStatus: "in_progress" })
    .where(eq(serverMembers.serverId, server.id));
  const { machine } = await attachOnlineComputer(server.id, owner.id, "maria");

  // The daemon holds a live socket the whole time — the user has NOT killed their CLI.
  // `getMachineStatus` therefore keeps saying "online" across the reset, exactly as it did
  // on staging when @stdrc watched Start over "do nothing".
  const orchestrator = {
    getMachineStatus: async (id: string) => (id === machine.id ? "online" : "offline") as "online" | "offline",
  };

  // Precondition: a connected, online computer reporting a recommended runtime IS Meet Cindy.
  const before = projectServerSetup(
    await readSetupState(server.id, owner.id),
    await resolveServerSetupLiveFacts(server.id, owner.id, orchestrator),
  );
  assert.equal(before.surface, "create_agent", "precondition: online computer + ready runtime shows Meet Cindy");

  const result = await resetServerSetup({ serverId: server.id, actor: { type: "user", id: owner.id } });
  assert.equal(result.revokedComputers, 1, "Start over revoked the one connected computer");

  // The socket is STILL live. The screen must still go back to the start of setup, because the
  // computer this server had was thrown away — a revoked Computer is not a connected one, no
  // matter what its orphaned daemon socket still reports. This is the state-machine promise:
  // "Start over" lands you back on Connect Computer, not stranded on Meet Cindy until you
  // happen to kill a CLI on your laptop.
  const after = projectServerSetup(
    await readSetupState(server.id, owner.id),
    await resolveServerSetupLiveFacts(server.id, owner.id, orchestrator),
  );
  assert.equal(after.hasConnectedComputer, false, "the revoked computer no longer counts as connected");
  assert.equal(after.surface, "computer_runtime", "reset returns to Connect Computer, not stranded on Meet Cindy behind a live socket");
  assert.equal(after.currentStep, "computer_runtime");
});
