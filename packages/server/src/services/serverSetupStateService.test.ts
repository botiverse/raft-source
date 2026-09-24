import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";
import type { ServerRole } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agents, computers, featureFlagRules, machines, serverAgentMembers, serverMembers, servers, users } from "../db/schema.js";
import {
  createServerSetupStateService,
  getServerSetupState,
  projectServerSetup,
  resolveServerSetupLiveFacts,
  ServerSetupStateError,
  transitionServerSetupState,
  type ServerSetupLiveFacts,
  type ServerSetupRepositoryTransition,
  type ServerSetupState,
  type ServerSetupStateRepository,
} from "./serverSetupStateService.js";
import { OFFICIAL_ONBOARDING_AGENT_IDENTITY } from "./officialOnboardingAgentIdentity.js";
import { GROK_RUNTIME_FEATURE_FLAG_KEY } from "./featureFlagService.js";


function cloneState(state: ServerSetupState): ServerSetupState {
  return { ...state };
}

function makeState(overrides: Partial<ServerSetupState> = {}): ServerSetupState {
  return {
    serverId: "server-1",
    userId: "owner-1",
    status: "not_started",
    completionReason: null,
    contractVersion: "phase1-v1",
    ...overrides,
  };
}

class MemoryRepository implements ServerSetupStateRepository {
  public state: ServerSetupState | null;

  constructor(state: ServerSetupState | null) {
    this.state = state ? cloneState(state) : null;
  }

  async get(serverId: string, userId: string): Promise<ServerSetupState | null> {
    if (!this.state || this.state.serverId !== serverId || this.state.userId !== userId) return null;
    return cloneState(this.state);
  }

  async transition(
    serverId: string,
    userId: string,
    mutate: (current: ServerSetupState) => Promise<ServerSetupState> | ServerSetupState,
  ): Promise<ServerSetupRepositoryTransition | null> {
    const previous = await this.get(serverId, userId);
    if (!previous) return null;
    const state = cloneState(await mutate(cloneState(previous)));
    const changed = JSON.stringify(previous) !== JSON.stringify(state);
    this.state = cloneState(state);
    return { previous, state, changed };
  }
}

const LIVE_READY: ServerSetupLiveFacts = {
  computer: "online",
  hasConnectedComputer: true, offlineComputers: [], everHadAgent: false, runtime: "ready_recommended",
  officialOnboardingAgent: "usable",
  ownerSurveyPending: false,
  ownerHandoffPending: false,
  actorIsOwner: true,
};

function makeService(options: {
  state?: ServerSetupState | null;
  role?: ServerRole | null;
  live?: ServerSetupLiveFacts;
  liveError?: Error;
  now?: Date;
} = {}) {
  const repository = new MemoryRepository(options.state === undefined ? makeState() : options.state);
  const events: Array<{ previous: ServerSetupState; state: ServerSetupState; action: string }> = [];
  let liveReads = 0;
  const service = createServerSetupStateService({
    repository,
    resolveActorRole: async () => options.role === undefined ? "owner" : options.role,
    resolveLiveFacts: async () => {
      liveReads += 1;
      if (options.liveError) throw options.liveError;
      return options.live ?? LIVE_READY;
    },
    now: () => options.now ?? new Date("2026-07-10T08:00:00.000Z"),
    onTransitionCommitted: async (event) => {
      events.push({ previous: event.previous, state: event.state, action: event.action });
    },
  });
  return { repository, events, service, getLiveReads: () => liveReads };
}

// task #172 Phase 1: `defer` is retired. There is no `complete_after_defer` determination
// anymore — a fresh completion is always `normal`. The `setup_deferred_at` timestamp is never
// written on the way there, and never read to decide the reason.
test("completion is always `normal`; defer is no longer a transition", async () => {
  const { service, events } = makeService();
  const actor = { type: "user" as const, id: "owner-1" };

  assert.equal((await service.transitionServerSetupState({ serverId: "server-1", userId: "owner-1", actor, action: "start" })).state.status, "in_progress");

  const completed = await service.transitionServerSetupState({ serverId: "server-1", userId: "owner-1", actor, action: "complete" });
  assert.equal(completed.state.status, "complete");
  assert.equal(completed.state.completionReason, "normal");
  assert.deepEqual(events.map((event) => event.action), ["start", "complete"]);
});

test("normal completion requires a usable official onboarding agent", async () => {
  const blocked = makeService({
    state: makeState({ status: "in_progress" }),
    live: { ...LIVE_READY, officialOnboardingAgent: "missing" },
  });
  const input = {
    serverId: "server-1",
    userId: "owner-1",
    actor: { type: "user" as const, id: "owner-1" },
    action: "complete" as const,
  };

  await assert.rejects(
    blocked.service.transitionServerSetupState(input),
    (error: unknown) => error instanceof ServerSetupStateError
      && error.code === "OFFICIAL_ONBOARDING_AGENT_NOT_USABLE",
  );
  assert.equal(blocked.repository.state?.status, "in_progress");
  assert.equal(blocked.events.length, 0);

  const ready = makeService({ state: makeState({ status: "in_progress" }) });
  const completed = await ready.service.transitionServerSetupState(input);
  assert.equal(completed.state.completionReason, "normal");
});

test("complete is terminal and idempotent even when live facts later fail", async () => {
  const complete = makeState({ status: "complete", completionReason: "grandfathered" });
  const { service, events, getLiveReads } = makeService({ state: complete, liveError: new Error("offline") });

  for (const action of ["start", "complete"] as const) {
    const result = await service.transitionServerSetupState({
      serverId: "server-1",
      userId: "owner-1",
      actor: { type: "user", id: "owner-1" },
      action,
    });
    assert.equal(result.changed, false);
    assert.equal(result.state.status, "complete");
    assert.equal(result.state.completionReason, "grandfathered");
  }

  assert.equal(getLiveReads(), 0);
  assert.equal(events.length, 0);
});

test("completion validation and post-commit observers cannot corrupt durable state", async () => {
  const unavailable = makeService({
    state: makeState({ status: "in_progress" }),
    liveError: new Error("live store unavailable"),
  });
  const input = {
    serverId: "server-1",
    userId: "owner-1",
    actor: { type: "user" as const, id: "owner-1" },
    action: "complete" as const,
  };
  await assert.rejects(
    unavailable.service.transitionServerSetupState(input),
    (error: unknown) => error instanceof ServerSetupStateError && error.code === "LIVE_FACTS_UNAVAILABLE",
  );
  assert.equal(unavailable.repository.state?.status, "in_progress");

  const repository = new MemoryRepository(makeState({ status: "in_progress" }));
  const observerErrors: unknown[] = [];
  const service = createServerSetupStateService({
    repository,
    resolveActorRole: async () => "owner",
    resolveLiveFacts: async () => LIVE_READY,
    onTransitionCommitted: async () => {
      throw new Error("analytics unavailable");
    },
    onObserverError: (error) => observerErrors.push(error),
  });
  const completed = await service.transitionServerSetupState(input);
  assert.equal(completed.state.status, "complete");
  assert.equal(repository.state?.status, "complete");
  assert.equal(observerErrors.length, 1);
});

test("setup mutations fail closed for non-human, cross-user, and non-manager actors", async () => {
  const agent = makeService();
  await assert.rejects(
    agent.service.transitionServerSetupState({
      serverId: "server-1",
      userId: "owner-1",
      actor: { type: "agent", id: "agent-1" },
      action: "start",
    }),
    (error: unknown) => error instanceof ServerSetupStateError && error.code === "ACTOR_NOT_HUMAN",
  );

  const crossUser = makeService();
  await assert.rejects(
    crossUser.service.transitionServerSetupState({
      serverId: "server-1",
      userId: "owner-1",
      actor: { type: "user", id: "admin-2" },
      action: "start",
    }),
    (error: unknown) => error instanceof ServerSetupStateError && error.code === "CROSS_USER_TRANSITION",
  );

  const member = makeService({ role: "member" });
  await assert.rejects(
    member.service.transitionServerSetupState({
      serverId: "server-1",
      userId: "owner-1",
      actor: { type: "user", id: "owner-1" },
      action: "start",
    }),
    (error: unknown) => error instanceof ServerSetupStateError && error.code === "INSUFFICIENT_PERMISSION",
  );
});

test("projection names live blockers without changing the durable phase", () => {
  const deferred = makeState({ status: "deferred" });
  assert.deepEqual(projectServerSetup(deferred, {
    computer: "offline",
    hasConnectedComputer: true, offlineComputers: [], everHadAgent: false, runtime: "ready_recommended",
    officialOnboardingAgent: "missing",
    ownerSurveyPending: false,
    ownerHandoffPending: false,
    actorIsOwner: true,
  }), {
    surface: "computer_runtime",
    phase: "deferred",
    currentStep: "computer_runtime",
    blocksChat: false,
    // No bypass, for anyone. An unfinished server is finished, or it is thrown away.
    allowedExits: ["reset", "return_to_server"],
    sideEffectState: { transitions: "enabled", completion: "disabled" },
    gateReason: "computer_offline",
    // task #159: the projection now CARRIES the two facts Screen B renders, so the
    // browser stops deriving them a second time from the socket-fed machine store.
    computerStatus: "offline",
    runtimeStatus: "ready_recommended",
    runtimeOptions: [],
    hasConnectedComputer: true,
    offlineComputers: [],
    postSetup: { surveyPending: false, handoffPending: false },
  });

  assert.equal(projectServerSetup(deferred, {
    computer: "online",
    hasConnectedComputer: true, offlineComputers: [], everHadAgent: false, runtime: "not_ready",
    officialOnboardingAgent: "missing",
    ownerSurveyPending: false,
    ownerHandoffPending: false,
    actorIsOwner: true,
  }).gateReason, "runtime_not_ready");

  const ready = projectServerSetup(deferred, LIVE_READY);
  assert.equal(ready.surface, "create_agent");
  assert.equal(ready.gateReason, "completion_pending");
  assert.equal(ready.sideEffectState.completion, "enabled");

  assert.equal(projectServerSetup(makeState({ status: "in_progress" }), {
    computer: "offline",
    hasConnectedComputer: true, offlineComputers: [], everHadAgent: false, runtime: "not_ready",
    officialOnboardingAgent: "missing",
    ownerSurveyPending: false,
    ownerHandoffPending: false,
    actorIsOwner: true,
  }).blocksChat, true);
});

// task #172 Phase 1 tolerance tooth (Vivian): removing defer is expand-contract. This phase stops
// PRODUCING deferred rows, but an older replica may still write one during a rollout window, and
// the `setup_deferred_at` timestamp is no longer read. Reading such a legacy `status='deferred'`
// row must stay NON-BLOCKING purely from the status — treating it as blocking would re-lock an
// owner who had already bypassed into chat. The `deferred` value and this special-case are
// removed in Phase 2, after a catch-up sweep asserts deferred = 0.
test("a legacy deferred row reads non-blocking from status alone, with no timestamp", () => {
  // No timestamp on the state at all (the field is gone). blocksChat must still be false.
  const projection = projectServerSetup(makeState({ status: "deferred" }), {
    computer: "offline",
    hasConnectedComputer: true, offlineComputers: [], everHadAgent: false, runtime: "unknown",
    officialOnboardingAgent: "missing",
    ownerSurveyPending: false,
    ownerHandoffPending: false,
    actorIsOwner: true,
  });
  assert.equal(projection.blocksChat, false, "a legacy deferred owner must not be re-locked during rollout");
  assert.equal(projection.phase, "deferred");
});

// task #159 — the server is the only reader of "is the runtime usable?". Screen B used to
// answer it a SECOND time from the socket-fed machine store, so the runtime card and the
// Next button could disagree (dropped event, failed refetch, stale tab, replica lag).
// The projection now carries the answer; the browser draws it.
test("the projection carries the runtime verdict, so the browser never has to guess it", () => {
  const inProgress: ServerSetupState = {
    serverId: "server-1",
    userId: "user-1",
    status: "in_progress",
    completionReason: null,
    contractVersion: "v1",
  };
  const facts = {
    officialOnboardingAgent: "missing" as const,
    ownerSurveyPending: false,
    ownerHandoffPending: false,
    actorIsOwner: true,
  };

  // Checking is NOT "not ready" — it is "we have not been told yet", and it must not be
  // rendered as a verdict. Same disease as reading a NULL as a debt.
  const checking = projectServerSetup(inProgress, { computer: "online", hasConnectedComputer: true, offlineComputers: [], everHadAgent: false, runtime: "checking", ...facts });
  assert.equal(checking.runtimeStatus, "checking");
  assert.equal(checking.gateReason, "runtime_checking");

  // A usable runtime is the server's call, and it says so out loud.
  const ready = projectServerSetup(inProgress, { computer: "online", hasConnectedComputer: true, offlineComputers: [], everHadAgent: false, runtime: "ready_recommended", ...facts });
  assert.equal(ready.runtimeStatus, "ready_recommended");
  assert.equal(ready.computerStatus, "online");
  assert.equal(ready.surface, "create_agent");

  // Offline computer: the runtime reading still travels, so the card never has to invent one.
  const offline = projectServerSetup(inProgress, { computer: "offline", hasConnectedComputer: true, offlineComputers: [], everHadAgent: false, runtime: "unknown", ...facts });
  assert.equal(offline.computerStatus, "offline");
  assert.equal(offline.runtimeStatus, "unknown");
});

test("handoff is owed only to flow completions, never grandfathered/admin_override (task #154)", () => {
  const briefingPending = {
    computer: "online" as const,
    hasConnectedComputer: true, offlineComputers: [], everHadAgent: false,
    runtime: "ready_recommended" as const,
    officialOnboardingAgent: "usable" as const,
    ownerSurveyPending: false,
    ownerHandoffPending: true,
    actorIsOwner: true,
  };

  // A genuine onboarding-flow completion still owes the handoff while briefing is pending.
  const normal = projectServerSetup(makeState({ status: "complete", completionReason: "normal" }), briefingPending);
  assert.equal(normal.surface, "complete");
  assert.equal(normal.postSetup.handoffPending, true);
  assert.equal(
    projectServerSetup(makeState({ status: "complete", completionReason: "complete_after_defer" }), briefingPending)
      .postSetup.handoffPending,
    true,
  );

  // Grandfathered (migrated existing server) never went through onboarding, so it must
  // NEVER show the handoff celebration — even though its owner has no briefing timestamps
  // (ownerBriefingPending=true). This is the #154 regression: without the gate the modal
  // fires forever on every gate-mounting page (e.g. Settings) for existing users.
  assert.equal(
    projectServerSetup(makeState({ status: "complete", completionReason: "grandfathered" }), briefingPending)
      .postSetup.handoffPending,
    false,
  );
  assert.equal(
    projectServerSetup(makeState({ status: "complete", completionReason: "admin_override" }), briefingPending)
      .postSetup.handoffPending,
    false,
  );
});

test("a legacy row the backfill missed fails OPEN: nobody is locked out by a NULL", () => {
  // @Jianwei, 2026-07-13: a passing backfill proves the backfill worked. It does NOT prove
  // what happens when the backfill PARTIALLY fails — and that is the case that would lock
  // people out of their own product behind an undismissable modal.
  //
  // The two post-setup screens are only ever owed to an owner whose server completed
  // through the real flow. A legacy row the migration missed has no completion reason at
  // all, so nothing is owed, no matter how many NULLs it carries. Absence of evidence is
  // never read as "this person owes us something".
  const legacyMissedByBackfill = makeState({ status: "complete", completionReason: null });
  const everythingNull = {
    ...LIVE_READY,
    ownerSurveyPending: true,   // signup_survey_completed_at IS NULL (pre-migration user)
    ownerHandoffPending: true,  // setup_handoff_acknowledged_at IS NULL (column is new)
    actorIsOwner: true,
  };

  const projection = projectServerSetup(legacyMissedByBackfill, everythingNull);
  assert.deepEqual(projection.postSetup, { surveyPending: false, handoffPending: false });
  assert.equal(projection.blocksChat, false, "a NULL must never block someone out of their own server");
});

test("setting up a server is the owner's business — an admin is not shown the flow at all", async () => {
  // stdrc, 2026-07-13: "admin 可能不应该看到 setup server 流程 / 只有 owner 才能看到".
  // An admin arriving at a half-set-up server used to be handed the wizard, and with it the
  // owner's survey and the owner's handoff — personal screens that are not theirs to answer.
  const admin = makeService({ role: "admin" });
  const projection = await admin.service.resolveServerSetup({
    serverId: "server-1",
    actor: { type: "user", id: "admin-2" },
  });
  assert.equal(projection.surface, "none");
  assert.equal(projection.gateReason, "insufficient_permission");
  assert.deepEqual(projection.postSetup, { surveyPending: false, handoffPending: false });
  assert.equal(projection.blocksChat, false, "an admin must never be blocked out of chat by someone else's setup");

  await assert.rejects(
    makeService({ role: "admin" }).service.transitionServerSetupState({
      serverId: "server-1",
      userId: "admin-2",
      actor: { type: "user", id: "admin-2" },
      action: "start",
    }),
    (error: unknown) => error instanceof ServerSetupStateError && error.code === "INSUFFICIENT_PERMISSION",
  );
});

test("post-setup screens: one eligibility, owner-only, and driven by the ACK, not by delivery", () => {
  // The matrix stdrc asked for. Every row is a screen someone can be standing on, and each
  // must be answerable by the server alone — otherwise reopening in another browser cannot
  // restore it (stdrc, 2026-07-13: "onboarding 流程的每个页面必然是对应一个 db 字段状态,
  // 不然怎么可靠恢复?").
  const owed = { ...LIVE_READY, ownerSurveyPending: true, ownerHandoffPending: true, actorIsOwner: true };

  // 1. Owner who finished the real flow and has not answered/acknowledged: both are owed.
  const normal = projectServerSetup(makeState({ status: "complete", completionReason: "normal" }), owed);
  assert.deepEqual(normal.postSetup, { surveyPending: true, handoffPending: true });

  // 2. Same, having deferred and come back: still the real flow.
  assert.deepEqual(
    projectServerSetup(makeState({ status: "complete", completionReason: "complete_after_defer" }), owed).postSetup,
    { surveyPending: true, handoffPending: true },
  );

  // 3. Existing servers never went through onboarding. They owe NOTHING — and that must
  // include the SURVEY, not just the handoff: gating only the handoff still showed them the
  // screen before it. Both screens, one eligibility.
  for (const reason of ["grandfathered", "admin_override"] as const) {
    assert.deepEqual(
      projectServerSetup(makeState({ status: "complete", completionReason: reason }), owed).postSetup,
      { surveyPending: false, handoffPending: false },
      `${reason} must owe neither screen`,
    );
  }

  // 4. An admin is not the owner. They can help set the server up; they cannot answer
  // someone else's personal survey or accept someone else's handoff.
  assert.deepEqual(
    projectServerSetup(
      makeState({ status: "complete", completionReason: "normal" }),
      { ...owed, actorIsOwner: false },
    ).postSetup,
    { surveyPending: false, handoffPending: false },
  );

  // 5. The handoff follows the ACKNOWLEDGMENT, never the briefing's delivery. An owner who
  // pressed "Let's Go" while Cindy was still booting (briefing dropped, no delivery stamp)
  // has finished onboarding: reopening anywhere must NOT put them back on that screen.
  assert.equal(
    projectServerSetup(
      makeState({ status: "complete", completionReason: "normal" }),
      { ...owed, ownerHandoffPending: false },
    ).postSetup.handoffPending,
    false,
  );
});

test("actor-aware resolver hides setup from agents and non-managers", async () => {
  const agent = makeService();
  assert.deepEqual(await agent.service.resolveServerSetup({
    serverId: "server-1",
    actor: { type: "agent", id: "agent-1" },
  }), {
    surface: "none",
    phase: null,
    currentStep: null,
    blocksChat: false,
    allowedExits: ["return_to_server"],
    sideEffectState: { transitions: "disabled", completion: "disabled" },
    gateReason: "actor_not_human",
    // No live facts were read on this path (that is the point of the assertion below),
    // so the projection says "unknown" rather than inventing a reading.
    computerStatus: "unknown",
    runtimeStatus: "unknown",
    runtimeOptions: [],
    hasConnectedComputer: false,
    offlineComputers: [],
    postSetup: { surveyPending: false, handoffPending: false },
  });
  assert.equal(agent.getLiveReads(), 0);

  const member = makeService({ role: "member" });
  const memberProjection = await member.service.resolveServerSetup({
    serverId: "server-1",
    actor: { type: "user", id: "owner-1" },
  });
  assert.equal(memberProjection.surface, "none");
  assert.equal(memberProjection.gateReason, "insufficient_permission");
  assert.equal(member.getLiveReads(), 0);
});

test("complete projection ignores live flaps and resolver failures fail open for chat", async () => {
  const complete = makeService({
    state: makeState({ status: "complete", completionReason: "normal" }),
    liveError: new Error("live store unavailable"),
  });
  const completeProjection = await complete.service.resolveServerSetup({
    serverId: "server-1",
    actor: { type: "user", id: "owner-1" },
  });
  assert.equal(completeProjection.surface, "complete");
  assert.equal(completeProjection.gateReason, "setup_complete");
  assert.equal(completeProjection.blocksChat, false);
  assert.equal(complete.getLiveReads(), 0);

  const failed = makeService({
    state: makeState({ status: "in_progress" }),
    liveError: new Error("live store unavailable"),
  });
  const failedProjection = await failed.service.resolveServerSetup({
    serverId: "server-1",
    actor: { type: "user", id: "owner-1" },
  });
  assert.equal(failedProjection.surface, "retry");
  assert.equal(failedProjection.gateReason, "resolver_error");
  assert.equal(failedProjection.blocksChat, false);
  assert.deepEqual(failedProjection.sideEffectState, { transitions: "disabled", completion: "disabled" });
});

test("Drizzle adapter persists transitions and rejects arbitrary onboarding agents", async ({ onTestFinished }) => {
  await openTestDatabase("pglite://");
  onTestFinished(async () => closeTestDatabase());
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "setup-state-owner@slock.test",
    name: "setup-state-owner",
    passwordHash: "test-password-hash",
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Setup State",
    slug: "setup-state",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });

  assert.deepEqual(await getServerSetupState(server.id, owner.id), {
    serverId: server.id,
    userId: owner.id,
    status: "not_started",
    completionReason: null,
    contractVersion: "onboarding-setup-v1",
  });
  const actor = { type: "user" as const, id: owner.id };
  await transitionServerSetupState({ serverId: server.id, userId: owner.id, actor, action: "start" });

  const [machine] = await db.insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: "setup-state-machine",
    apiKeyHash: "setup-state-machine-hash",
    runtimes: ["codex"],
  }).returning();
  const [arbitraryAgent] = await db.insert(agents).values({
    serverId: server.id,
    name: "ordinary-agent",
    displayName: "Ordinary Agent",
    description: "Not the official onboarding agent",
    avatarUrl: "pixel:robot",
    runtime: "codex",
    machineId: machine.id,
  }).returning();
  await db.insert(serverAgentMembers).values({ serverId: server.id, agentId: arbitraryAgent.id, role: "admin" });
  await db.update(servers).set({ onboardingAgentId: arbitraryAgent.id }).where(eq(servers.id, server.id));

  await assert.rejects(
    transitionServerSetupState({ serverId: server.id, userId: owner.id, actor, action: "complete" }),
    (error: unknown) => error instanceof ServerSetupStateError
      && error.code === "OFFICIAL_ONBOARDING_AGENT_NOT_USABLE",
  );
  assert.equal((await getServerSetupState(server.id, owner.id))?.status, "in_progress");

  const [officialAgent] = await db.insert(agents).values({
    serverId: server.id,
    name: OFFICIAL_ONBOARDING_AGENT_IDENTITY.name,
    displayName: OFFICIAL_ONBOARDING_AGENT_IDENTITY.displayName,
    description: OFFICIAL_ONBOARDING_AGENT_IDENTITY.description,
    avatarUrl: OFFICIAL_ONBOARDING_AGENT_IDENTITY.avatarUrl,
    runtime: "codex",
    machineId: machine.id,
  }).returning();
  await db.insert(serverAgentMembers).values({ serverId: server.id, agentId: officialAgent.id, role: "admin" });
  await db.update(servers).set({ onboardingAgentId: officialAgent.id }).where(eq(servers.id, server.id));

  const completed = await transitionServerSetupState({
    serverId: server.id,
    userId: owner.id,
    actor,
    action: "complete",
  });
  assert.equal(completed.state.status, "complete");
  assert.equal(completed.state.completionReason, "normal");
  const [persisted] = await db.select({
    status: serverMembers.setupStatus,
    completionReason: serverMembers.setupCompletionReason,
  }).from(serverMembers).where(eq(serverMembers.serverId, server.id));
  assert.deepEqual(persisted, { status: "complete", completionReason: "normal" });
});

test("resolveServerSetupLiveFacts reads runtime from the persisted machines.runtimes column (single cross-replica source)", async ({ onTestFinished }) => {
  await openTestDatabase("pglite://");
  onTestFinished(async () => closeTestDatabase());
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "live-facts-owner@slock.test",
    name: "live-facts-owner",
    passwordHash: "test-password-hash",
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Live Facts", slug: "live-facts", ownerId: owner.id,
  }).returning();
  // DB column empty here so this test exercises the live-connection PREFERENCE in
  // isolation (the cross-replica DB fallback is covered by the two tests below).
  const [machine] = await db.insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: "live-facts-machine",
    apiKeyHash: "live-facts-machine-hash",
    runtimes: null,
  }).returning();
  // The managed Computer this daemon runs as. A v2-onboarding computer is always attached as a
  // `computers` row linked to its daemon `machines` row; online-ness for setup keys off the
  // non-revoked computers row (same source as `hasConnectedComputer`), so the test connects one.
  await db.insert(computers).values({
    serverId: server.id, name: "live-facts-computer", apiKeyHash: "x", apiKeyPrefix: "sk_computer_lf",
    machineId: machine.id,
  });
  const inProgress = makeState({ serverId: server.id, userId: owner.id, status: "in_progress" });

  // Pre-"Ready" transient: machine online but the DB column has no runtimes yet
  // (null) → runtime "unknown". Correct transient (banner may show), self-heals
  // once the `ready` handler persists the runtimes.
  const preReady = await resolveServerSetupLiveFacts(server.id, owner.id, {
    getMachineStatus: async () => "online",
  });
  assert.equal(preReady.computer, "online");
  assert.equal(preReady.runtime, "unknown");
  const preReadyProjection = projectServerSetup(inProgress, preReady);
  assert.equal(preReadyProjection.surface, "computer_runtime");
  assert.equal(preReadyProjection.gateReason, "runtime_status_unknown");

  // Post-"Ready": the handler persisted runtimes to the DB column (before it emits
  // to the client) → runtime ready → gate ADVANCES past computer_runtime to
  // create_agent. Read from the persisted column, the single cross-replica source.
  await db.update(machines).set({ runtimes: ["claude"] }).where(eq(machines.id, machine.id));
  const ready = await resolveServerSetupLiveFacts(server.id, owner.id, {
    getMachineStatus: async () => "online",
  });
  assert.equal(ready.computer, "online");
  assert.equal(ready.runtime, "ready_recommended");
  const readyProjection = projectServerSetup(inProgress, ready);
  assert.equal(readyProjection.surface, "create_agent");
  assert.notEqual(readyProjection.gateReason, "runtime_status_unknown");
});

test("resolveServerSetupLiveFacts reads persisted runtimes cross-replica, so Next advances on a non-owner replica (Screen B / multi-replica)", async ({ onTestFinished }) => {
  await openTestDatabase("pglite://");
  onTestFinished(async () => closeTestDatabase());
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "replica-owner@slock.test", name: "replica-owner", passwordHash: "test-password-hash",
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Replica", slug: "replica", ownerId: owner.id,
  }).returning();
  // The daemon reported "Ready" → the handler persisted runtimes to the DB column.
  // This request lands on a DIFFERENT replica (no in-memory conn.runtimes here);
  // the persisted column is the single cross-replica source that keeps it working.
  const [machine] = await db.insert(machines).values({
    serverId: server.id, userId: owner.id, name: "replica-machine",
    apiKeyHash: "replica-machine-hash", runtimes: ["codex"],
  }).returning();
  // The managed Computer this daemon runs as (see the note in the sibling test): setup online-ness
  // keys off the non-revoked `computers` row linked by `machineId`, so connect one.
  await db.insert(computers).values({
    serverId: server.id, name: "replica-computer", apiKeyHash: "x", apiKeyPrefix: "sk_computer_rp",
    machineId: machine.id,
  });
  const inProgress = makeState({ serverId: server.id, userId: owner.id, status: "in_progress" });

  // No live connection on this replica, but DB has a recommended runtime → gate
  // must still ADVANCE to create_agent (otherwise Next stays dead cross-replica).
  const facts = await resolveServerSetupLiveFacts(server.id, owner.id, {
    getMachineStatus: async () => "online",
  });
  assert.equal(facts.computer, "online");
  assert.equal(facts.runtime, "ready_recommended");
  assert.equal(projectServerSetup(inProgress, facts).surface, "create_agent");

  // Fallback must NOT be a lax pass-through: online + no live conn + empty
  // persisted runtimes → still not ready → stays on computer_runtime.
  await db.update(machines).set({ runtimes: [] }).where(eq(machines.id, machine.id));
  const empty = await resolveServerSetupLiveFacts(server.id, owner.id, {
    getMachineStatus: async () => "online",
  });
  assert.equal(empty.runtime, "not_ready");
  assert.equal(projectServerSetup(inProgress, empty).surface, "computer_runtime");

  await db.update(machines).set({ runtimes: ["gemini"] }).where(eq(machines.id, machine.id));
  const deprecatedOnly = await resolveServerSetupLiveFacts(server.id, owner.id, {
    getMachineStatus: async () => "online",
  });
  assert.equal(deprecatedOnly.runtime, "not_ready");
  assert.equal(projectServerSetup(inProgress, deprecatedOnly).surface, "computer_runtime");
});

test("setup readiness uses new-admission policy instead of raw Grok capability", async ({ onTestFinished }) => {
  await openTestDatabase("pglite://");
  onTestFinished(async () => closeTestDatabase());
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "grok-setup-owner@slock.test", name: "grok-setup-owner", passwordHash: "test-password-hash",
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Grok Setup", slug: "grok-setup", ownerId: owner.id,
  }).returning();
  const [machine] = await db.insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: "grok-setup-machine",
    apiKeyHash: "grok-setup-machine-hash",
    runtimes: ["grok"],
  }).returning();
  await db.insert(computers).values({
    serverId: server.id,
    name: "grok-setup-computer",
    apiKeyHash: "x",
    apiKeyPrefix: "sk_computer_gs",
    machineId: machine.id,
  });

  const orchestrator = { getMachineStatus: async () => "online" as const };
  const disabled = await resolveServerSetupLiveFacts(server.id, owner.id, orchestrator);
  assert.equal(disabled.runtime, "not_ready");
  assert.equal(disabled.runtimeOptions?.some((option) => option.runtimeId === "grok"), false);

  await db.insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: GROK_RUNTIME_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [server.id],
  });

  const enabled = await resolveServerSetupLiveFacts(server.id, owner.id, orchestrator);
  assert.equal(enabled.runtime, "ready_other");
  assert.equal(
    enabled.runtimeOptions?.find((option) => option.runtimeId === "grok")?.canSelectInThisContext,
    true,
  );
});

test("a bare legacy daemon (online machine, no managed computers row) does NOT count as connected in setup", async ({ onTestFinished }) => {
  // Explicit counter-tooth for the online-source unification. `hasConnectedComputer` has counted
  // only non-revoked `computers` rows since #4816; `computer` online-ness now agrees. A legacy
  // `sk_machine_` daemon is a `machines` row with NO `computers` row — however online it is and
  // however many runtimes it reports, it is not a managed Computer, so v2 setup must keep it on
  // Connect Computer, not advance to Meet Cindy. This pins that the legacy shape stays covered
  // after the three sibling tests were moved onto the realistic managed-Computer state.
  await openTestDatabase("pglite://");
  onTestFinished(async () => closeTestDatabase());
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "legacy-daemon-owner@slock.test", name: "legacy-daemon-owner", passwordHash: "test-password-hash",
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Legacy", slug: "legacy-daemon", ownerId: owner.id,
  }).returning();
  const [machine] = await db.insert(machines).values({
    serverId: server.id, userId: owner.id, name: "legacy-daemon", apiKeyHash: "legacy-hash", runtimes: ["claude"],
  }).returning();

  const facts = await resolveServerSetupLiveFacts(server.id, owner.id, {
    getMachineStatus: async (id) => (id === machine.id ? "online" : "offline"),
  });
  assert.equal(facts.hasConnectedComputer, false, "a bare daemon is not a managed Computer");
  assert.equal(facts.computer, "offline", "an online legacy daemon socket is not a connected computer for setup");

  const inProgress = makeState({ serverId: server.id, userId: owner.id, status: "in_progress" });
  assert.equal(
    projectServerSetup(inProgress, facts).surface,
    "computer_runtime",
    "setup stays on Connect Computer for a legacy-only daemon, never advancing to Meet Cindy",
  );
});
