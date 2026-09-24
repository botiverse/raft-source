import { currentDate, type RuntimeSelectionOption, type ServerRole } from "@botiverse/raft-shared";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agents, computers, machines, serverAgentMembers, serverMembers, servers, users } from "../db/schema.js";
import { getActorServerRoleInServer } from "../lib/actorPermissions.js";
import type { AgentOrchestrator } from "./agentOrchestrator.js";
import { hasOfficialOnboardingAgentIdentity } from "./officialOnboardingAgentIdentity.js";
import { withAgentCreateLock } from "./planService.js";
import {
  projectSetupRuntimeOptions,
  resolveRuntimeAdmissionPolicy,
} from "./runtimeAdmissionService.js";

/**
 * ONBOARDING HAS ONE CHECKPOINT, AND IT IS "CINDY EXISTS". (@stdrc, 2026-07-14)
 *
 * Everything about this flow follows from that sentence, so it is written down here rather
 * than left to be re-derived from the code by the next person.
 *
 *   Phase 1 — SETUP: connect a computer, then create Cindy.
 *     Nothing here is worth keeping. If the computer goes offline, or was the wrong machine,
 *     or the runtime never turns up, the flow rolls back to an empty server and starts again.
 *     Every screen in this phase therefore offers "Start over" — including Create Cindy, where
 *     someone may only then realise they connected the laptop without Claude Code on it.
 *
 *   THE CHECKPOINT — Cindy is created.
 *     Setup is over, permanently. It never runs again: not when the computer goes offline an
 *     hour later, not when the agent is deleted next month. `setup_status` is what records it.
 *
 *   Phase 2 — everything after: survey, then Let's Go, and whatever we add later.
 *     Each is tracked by ITS OWN durable column and answers only its own question. They are
 *     NOT rolled into `setup_status`, and the flow is NOT rolled back for them. Collapsing
 *     several facts into one flag is precisely the disease that left 486 servers configured
 *     but locked out of their own chat.
 *
 * And the one thing that phase 2 must guarantee: Cindy does not start working when she is
 * created. She is cold until "Let's Go", which is the trigger that briefs her. If she is
 * offline at that moment the trigger is not lost — it is delivered when she next wakes (see
 * `onboardingBriefingOnActivation`). Created is not the same as working.
 */
export type ServerSetupStatus = "not_started" | "in_progress" | "deferred" | "complete";

export type ServerSetupCompletionReason =
  | "normal"
  | "grandfathered"
  | "complete_after_defer"
  | "admin_override";

export interface ServerSetupState {
  serverId: string;
  userId: string;
  status: ServerSetupStatus;
  completionReason: ServerSetupCompletionReason | null;
  contractVersion: string;
}

/**
 * The contract a member's setup row was signed under. New rows are born under v2.
 *
 * "Set up later" (defer) is gone: it left half-built servers whose owners could never be
 * told they were done. The ~9,474 legacy servers that only had that door are being cleared
 * in the database directly (task #172 grandfathering backfill), not by keeping a bypass
 * alive here. The runtime no longer produces defer, and the `setup_deferred_at` timestamp is
 * no longer read or written. A legacy `status='deferred'` row (one an older replica may still
 * write during rollout) is still read as non-blocking until Phase 2 sweeps it — see
 * `projectServerSetup`.
 */
export const CURRENT_CONTRACT_VERSION = "onboarding-setup-v2";

export type ServerSetupActor = {
  type: "user" | "agent";
  id: string;
};

export type ServerSetupAction = "start" | "complete";

export type ServerSetupComputerState = "online" | "offline" | "unknown";

export type ServerSetupRuntimeState =
  | "ready_recommended"
  | "ready_other"
  | "not_ready"
  | "checking"
  | "error"
  | "unknown";

export type OfficialOnboardingAgentState = "usable" | "missing" | "unusable" | "unknown";

/** A computer this server has, that is not running right now. Named, because it is theirs. */
export interface ServerSetupOfflineComputer {
  id: string;
  name: string;
  lastHeartbeat: string | null;
  isComputer: boolean;
}

export interface ServerSetupLiveFacts {
  computer: ServerSetupComputerState;
  /**
   * A non-revoked `computers` row exists. NOT "a computer is online" — a closed laptop is
   * still a computer this person connected. `daemons` is the wrong table for this question
   * (a revoked machine identity is a fact that was CANCELLED, not one that happened).
   */
  hasConnectedComputer: boolean;
  /** Their sleeping computers, BY NAME — read from the SAME table as `hasConnectedComputer`. */
  offlineComputers: ServerSetupOfflineComputer[];
  /**
   * The official onboarding agent has been created for this server — deleted ones included.
   *
   * This is the COMMIT POINT of onboarding. Before it, the server holds nothing a user
   * could lose, so the flow can be rolled back to an empty server and started again.
   * After it, the server has been set up, permanently, and onboarding never runs again.
   *
   * Deleted Cindy counts. "Has Cindy right now" would make the commit point revocable —
   * delete the onboarding agent and the flow would offer to wipe the computers she ran on.
   * What happened, happened. Non-onboarding agents are not this checkpoint: dev/bootstrap
   * servers may have seeded agents before Cindy exists, and setup still needs its rollback.
   */
  everHadAgent: boolean;
  runtime: ServerSetupRuntimeState;
  runtimeOptions?: RuntimeSelectionOption[];
  officialOnboardingAgent: OfficialOnboardingAgentState;
  /**
   * The two steps that follow Create Cindy. They are derived from persisted state,
   * not held in the browser, so closing the tab mid-flow and coming back lands you
   * on the same screen instead of dumping you into the app with an unbriefed agent.
   *
   * - `ownerSurveyPending`: the owner has not answered the signup survey.
   * - `ownerBriefingPending`: the onboarding agent has not been briefed yet, which
   *   is what the "Let's Go" click triggers.
   */
  ownerSurveyPending: boolean;
  ownerHandoffPending: boolean;
  /** The person looking. The survey and the handoff are the OWNER's, and nobody else's. */
  actorIsOwner: boolean;
}

export type ServerSetupSurface = "none" | "computer_runtime" | "create_agent" | "complete" | "retry";
export type ServerSetupStep = "computer_runtime" | "create_agent" | null;
/**
 * `reset` is a ROLLBACK: throw this half-built server away and start again. It is the only
 * escape from an unfinished server now that the `defer` bypass is gone — a rollback leaves
 * nothing behind at all, and it is offered only while the state it would destroy is worthless
 * by construction (never had an agent — see `everHadAgent`).
 */
export type ServerSetupAllowedExit = "reset" | "return_to_server" | "retry";

export type ServerSetupGateReason =
  | "actor_not_human"
  | "insufficient_permission"
  | "state_not_found"
  | "computer_offline"
  | "computer_status_unknown"
  | "runtime_not_ready"
  | "runtime_checking"
  | "runtime_error"
  | "runtime_status_unknown"
  | "official_onboarding_agent_missing"
  | "official_onboarding_agent_unusable"
  | "official_onboarding_agent_status_unknown"
  | "completion_pending"
  | "setup_complete"
  | "resolver_error"
  | null;

export interface ServerSetupProjection {
  surface: ServerSetupSurface;
  phase: ServerSetupStatus | null;
  currentStep: ServerSetupStep;
  blocksChat: boolean;
  allowedExits: ServerSetupAllowedExit[];
  sideEffectState: {
    transitions: "enabled" | "disabled";
    completion: "enabled" | "disabled";
  };
  gateReason: ServerSetupGateReason;
  /**
   * The two facts Screen B renders. They live here because the browser used to
   * derive them a SECOND time from the socket-fed machine store — so the card and
   * the Next button each had their own answer to "is the runtime ready?", and the
   * two could disagree (a refetch that failed, a stale tab, a replica that had not
   * caught up). One question, one answer: the server decides, the browser draws.
   */
  computerStatus: ServerSetupComputerState;
  runtimeStatus: ServerSetupRuntimeState;
  runtimeOptions: RuntimeSelectionOption[];
  /**
   * A non-revoked computer exists on this server. DURABLE — it does not go false when the
   * laptop sleeps. "You have a computer, it is off" and "you have never connected one" are
   * different sentences, and Screen B must not say the second to someone who did the first.
   */
  hasConnectedComputer: boolean;
  /**
   * Their sleeping computers, BY NAME. Same table as `hasConnectedComputer`, deliberately:
   * these used to come from the browser's machine store, and a server with two named
   * computers rendered "This computer" — anonymous — because the two sources disagreed.
   * The recovery screen exists to say "I remember you". One question, one source.
   */
  offlineComputers: ServerSetupOfflineComputer[];
  /** Post-setup steps still owed: survey, then handoff. Persisted, not client state. */
  postSetup: {
    surveyPending: boolean;
    handoffPending: boolean;
  };
}

export interface ServerSetupRepositoryTransition {
  previous: ServerSetupState;
  state: ServerSetupState;
  changed: boolean;
}

export interface ServerSetupStateRepository {
  get(serverId: string, userId: string): Promise<ServerSetupState | null>;
  transition(
    serverId: string,
    userId: string,
    mutate: (current: ServerSetupState) => Promise<ServerSetupState> | ServerSetupState,
  ): Promise<ServerSetupRepositoryTransition | null>;
}

export interface ServerSetupTransitionCommittedEvent {
  action: ServerSetupAction;
  actor: ServerSetupActor;
  previous: ServerSetupState;
  state: ServerSetupState;
}

export interface ServerSetupStateServiceDeps {
  repository: ServerSetupStateRepository;
  resolveActorRole(serverId: string, actor: ServerSetupActor): Promise<ServerRole | null>;
  resolveLiveFacts(serverId: string, userId: string): Promise<ServerSetupLiveFacts>;
  now?: () => Date;
  onTransitionCommitted?: (event: ServerSetupTransitionCommittedEvent) => Promise<void> | void;
  onObserverError?: (error: unknown, event: ServerSetupTransitionCommittedEvent) => void;
}

export interface TransitionServerSetupStateInput {
  serverId: string;
  userId: string;
  action: ServerSetupAction;
  actor: ServerSetupActor;
}

export interface TransitionServerSetupStateResult {
  state: ServerSetupState;
  changed: boolean;
}

export interface ResolveServerSetupInput {
  serverId: string;
  actor: ServerSetupActor;
}

export class ServerSetupStateError extends Error {
  constructor(
    public readonly code:
      | "ACTOR_NOT_HUMAN"
      | "CROSS_USER_TRANSITION"
      | "INSUFFICIENT_PERMISSION"
      | "STATE_NOT_FOUND"
      | "LIVE_FACTS_UNAVAILABLE"
      | "OFFICIAL_ONBOARDING_AGENT_NOT_USABLE"
      // The reset refused: this server has had an agent, so it is past the commit point and
      // there is nothing here that may be thrown away.
      | "SERVER_ALREADY_SET_UP",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ServerSetupStateError";
  }
}

function unchangedState(state: ServerSetupState): ServerSetupState {
  return { ...state };
}

function isRuntimeReady(runtime: ServerSetupRuntimeState): boolean {
  return runtime === "ready_recommended" || runtime === "ready_other";
}

function runtimeGateReason(runtime: ServerSetupRuntimeState): ServerSetupGateReason {
  switch (runtime) {
    case "not_ready": return "runtime_not_ready";
    case "checking": return "runtime_checking";
    case "error": return "runtime_error";
    case "unknown": return "runtime_status_unknown";
    case "ready_recommended":
    case "ready_other":
      return null;
  }
}

function onboardingAgentGateReason(agent: OfficialOnboardingAgentState): ServerSetupGateReason {
  switch (agent) {
    case "missing": return "official_onboarding_agent_missing";
    case "unusable": return "official_onboarding_agent_unusable";
    case "unknown": return "official_onboarding_agent_status_unknown";
    case "usable": return "completion_pending";
  }
}

function noSetupProjection(reason: Exclude<ServerSetupGateReason, null>): ServerSetupProjection {
  return {
    surface: "none",
    phase: null,
    currentStep: null,
    blocksChat: false,
    allowedExits: ["return_to_server"],
    sideEffectState: { transitions: "disabled", completion: "disabled" },
    gateReason: reason,
    // No live facts were resolved on this path, so we say "unknown" rather than
    // inventing "offline"/"not_ready". Absence of a reading is not a reading.
    computerStatus: "unknown",
    runtimeStatus: "unknown",
    runtimeOptions: [],
    hasConnectedComputer: false,
    offlineComputers: [],
    postSetup: { surveyPending: false, handoffPending: false },
  };
}

function retryProjection(phase: ServerSetupStatus | null, reason: ServerSetupGateReason): ServerSetupProjection {
  return {
    surface: "retry",
    phase,
    currentStep: null,
    blocksChat: false,
    allowedExits: ["retry", "return_to_server"],
    sideEffectState: { transitions: "disabled", completion: "disabled" },
    gateReason: reason,
    computerStatus: "unknown",
    runtimeStatus: "unknown",
    runtimeOptions: [],
    hasConnectedComputer: false,
    offlineComputers: [],
    postSetup: { surveyPending: false, handoffPending: false },
  };
}

export function projectServerSetup(
  state: ServerSetupState,
  live: ServerSetupLiveFacts,
): ServerSetupProjection {
  // ONE eligibility for BOTH post-setup screens.
  //
  // They are owed only to an OWNER who reached the end of the real flow
  // (`normal` / `complete_after_defer`). A server grandfathered by migration, or forced
  // complete by an admin, never went through onboarding: its owner has no survey answer
  // and no handoff on record, so reading those absences as "still owed" showed existing
  // users the completion celebration on every page that mounts the gate (#154). And an
  // admin is not the owner: they can help set the server up, but they cannot answer
  // someone else's personal survey or accept someone else's handoff.
  const flowCompleted =
    state.completionReason === "normal" || state.completionReason === "complete_after_defer";
  const postSetupEligible = flowCompleted && live.actorIsOwner;
  const postSetup = {
    surveyPending: postSetupEligible && live.ownerSurveyPending,
    handoffPending: postSetupEligible && live.ownerHandoffPending,
  };

  if (state.status === "complete") {
    return {
      surface: "complete",
      phase: "complete",
      currentStep: null,
      blocksChat: false,
      allowedExits: ["return_to_server"],
      sideEffectState: { transitions: "disabled", completion: "disabled" },
      gateReason: "setup_complete",
      computerStatus: live.computer,
      runtimeStatus: live.runtime,
      runtimeOptions: live.runtimeOptions ?? [],
      hasConnectedComputer: live.hasConnectedComputer,
      offlineComputers: live.offlineComputers,
      postSetup,
    };
  }

  // Complete, or roll back and start again. Those are the two ways out of an unfinished
  // server, and which ones this user gets is decided HERE, from facts, not by the browser.
  //
  // `reset` is offered while the server has never had Cindy — the commit point. Up to
  // there it holds nothing anyone could lose, so "throw it away and start again" is a
  // promise we can actually keep. Past it, a reset would destroy real work, so it is not
  // offered at all. (The endpoint re-checks this for itself. A projected field must never
  // be the thing that authorises a demolition — that is how a stale `setup_status` came to
  // gate 486 servers in the first place.)
  //
  // `defer` — the old "Set up later" bypass — is gone. It stranded people in a half-built
  // server that could never say "you are done", and the ~9,474 legacy servers that only had
  // that door are being cleared in the database directly (task #172 grandfathering backfill)
  // rather than by keeping a second exit alive here. The runtime no longer offers or writes
  // defer. What remains is: finish, or roll back and start again.
  //
  // But a legacy `status='deferred'` row is still read as NON-BLOCKING below. Removing defer is
  // expand-contract: this phase stops PRODUCING defer, while an older replica may still write a
  // `deferred` row during a rollout window. Treating such a straggler as blocking would re-lock
  // an owner who had already bypassed — so tolerance stays until Phase 2 sweeps deferred to
  // zero and drops the value. The check reads `status`, never the (now unread) timestamp.
  const canReset = !live.everHadAgent;
  const exits: ServerSetupAllowedExit[] = [
    ...(canReset ? ["reset" as const] : []),
    "return_to_server" as const,
  ];

  const base = {
    phase: state.status,
    blocksChat: state.status !== "deferred",
    allowedExits: exits,
    sideEffectState: { transitions: "enabled" as const, completion: "disabled" as const },
    computerStatus: live.computer,
    runtimeStatus: live.runtime,
    runtimeOptions: live.runtimeOptions ?? [],
    hasConnectedComputer: live.hasConnectedComputer,
    offlineComputers: live.offlineComputers,
    // Only meaningful once setup completes; carried on every branch so the shape is
    // uniform and callers never have to null-check it.
    postSetup,
  };

  if (live.computer !== "online") {
    return {
      ...base,
      surface: "computer_runtime",
      currentStep: "computer_runtime",
      gateReason: live.computer === "offline" ? "computer_offline" : "computer_status_unknown",
    };
  }

  if (!isRuntimeReady(live.runtime)) {
    return {
      ...base,
      surface: "computer_runtime",
      currentStep: "computer_runtime",
      gateReason: runtimeGateReason(live.runtime),
    };
  }

  const completionReady = live.officialOnboardingAgent === "usable";
  return {
    ...base,
    surface: "create_agent",
    currentStep: "create_agent",
    sideEffectState: {
      transitions: "enabled",
      completion: completionReady ? "enabled" : "disabled",
    },
    gateReason: onboardingAgentGateReason(live.officialOnboardingAgent),
  };
}

function nextStateForAction(current: ServerSetupState): ServerSetupState {
  if (current.status === "complete") return unchangedState(current);

  // `start` is the only non-terminal action left now that `defer` is gone.
  if (current.status === "in_progress") return unchangedState(current);
  return {
    ...current,
    status: "in_progress",
    completionReason: null,
  };
}

function statesEqual(left: ServerSetupState, right: ServerSetupState): boolean {
  return left.serverId === right.serverId
    && left.userId === right.userId
    && left.status === right.status
    && left.completionReason === right.completionReason
    && left.contractVersion === right.contractVersion;
}

export function createServerSetupStateService(deps: ServerSetupStateServiceDeps) {
  const now = deps.now ?? currentDate;

  async function getServerSetupState(serverId: string, userId: string): Promise<ServerSetupState | null> {
    return deps.repository.get(serverId, userId);
  }

  async function assertMutationAuthority(input: TransitionServerSetupStateInput): Promise<void> {
    if (input.actor.type !== "user") {
      throw new ServerSetupStateError("ACTOR_NOT_HUMAN", "Only human setup managers may change server setup state");
    }
    if (input.actor.id !== input.userId) {
      throw new ServerSetupStateError("CROSS_USER_TRANSITION", "Setup managers may only change their own setup state row");
    }

    let role: ServerRole | null;
    try {
      role = await deps.resolveActorRole(input.serverId, input.actor);
    } catch (error) {
      throw new ServerSetupStateError("INSUFFICIENT_PERMISSION", "Could not verify server setup authority", { cause: error });
    }
    // Setting up a server is the OWNER's business, not "anyone who can manage the server".
    // An admin arriving at a half-set-up server was being handed the wizard — and with it
    // the owner's survey and the owner's handoff, which are personal and not theirs to
    // answer (stdrc, 2026-07-13: "只有 owner 才能看到").
    if (role !== "owner") {
      throw new ServerSetupStateError("INSUFFICIENT_PERMISSION", "Server setup belongs to the server owner");
    }
  }

  async function transitionServerSetupState(
    input: TransitionServerSetupStateInput,
  ): Promise<TransitionServerSetupStateResult> {
    await assertMutationAuthority(input);

    if (input.action === "complete") {
      const current = await deps.repository.get(input.serverId, input.userId);
      if (!current) {
        throw new ServerSetupStateError("STATE_NOT_FOUND", "Server setup state was not found");
      }
      if (current.status === "complete") return { state: current, changed: false };

      let live: ServerSetupLiveFacts;
      try {
        live = await deps.resolveLiveFacts(input.serverId, input.userId);
      } catch (error) {
        throw new ServerSetupStateError("LIVE_FACTS_UNAVAILABLE", "Could not verify official onboarding agent state", { cause: error });
      }
      if (live.officialOnboardingAgent !== "usable") {
        throw new ServerSetupStateError(
          "OFFICIAL_ONBOARDING_AGENT_NOT_USABLE",
          "Server setup cannot complete until the official onboarding agent is usable",
        );
      }
    }

    const transition = await deps.repository.transition(input.serverId, input.userId, (current) => {
      if (current.status === "complete") return unchangedState(current);

      if (input.action !== "complete") {
        return nextStateForAction(current);
      }

      // Every fresh completion is `normal`. `complete_after_defer` is no longer determined —
      // defer is gone and the timestamp that distinguished it is no longer read. Existing
      // `complete_after_defer` rows keep their reason; they are already complete and never
      // re-enter this path.
      return {
        ...current,
        status: "complete",
        completionReason: "normal",
      };
    });

    if (!transition) {
      throw new ServerSetupStateError("STATE_NOT_FOUND", "Server setup state was not found");
    }

    const changed = transition.changed && !statesEqual(transition.previous, transition.state);
    if (changed && deps.onTransitionCommitted) {
      const event: ServerSetupTransitionCommittedEvent = {
        action: input.action,
        actor: input.actor,
        previous: transition.previous,
        state: transition.state,
      };
      try {
        await deps.onTransitionCommitted(event);
      } catch (error) {
        deps.onObserverError?.(error, event);
      }
    }

    return { state: transition.state, changed };
  }

  async function resolveServerSetup(input: ResolveServerSetupInput): Promise<ServerSetupProjection> {
    if (input.actor.type !== "user") return noSetupProjection("actor_not_human");

    let role: ServerRole | null;
    try {
      role = await deps.resolveActorRole(input.serverId, input.actor);
    } catch {
      return retryProjection(null, "resolver_error");
    }
    // Owner-only, for the same reason the transition above is: the setup flow, and the two
    // post-setup screens that follow it, belong to the person whose server it is.
    if (role !== "owner") {
      return noSetupProjection("insufficient_permission");
    }

    let state: ServerSetupState | null;
    try {
      state = await getServerSetupState(input.serverId, input.actor.id);
    } catch {
      return retryProjection(null, "resolver_error");
    }
    if (!state) return retryProjection(null, "state_not_found");

    if (state.status === "complete") {
      // Setup is done, but the survey/handoff may still be owed — read them.
      return projectServerSetup(state, {
        ...(await resolveOwnerPostSetupFacts(input.serverId, input.actor.id)),
        computer: "unknown",
        hasConnectedComputer: false,
        offlineComputers: [],
        everHadAgent: true, // fail closed: never offer a demolition we did not check for
        runtime: "unknown",
        officialOnboardingAgent: "unknown",
      });
    }

    try {
      return projectServerSetup(state, await deps.resolveLiveFacts(input.serverId, input.actor.id));
    } catch {
      return retryProjection(state.status, "resolver_error");
    }
  }

  return {
    getServerSetupState,
    transitionServerSetupState,
    resolveServerSetup,
  };
}

export type ServerSetupStateService = ReturnType<typeof createServerSetupStateService>;

type PersistedServerSetupState = {
  serverId: string;
  userId: string;
  status: ServerSetupStatus;
  completionReason: ServerSetupCompletionReason | null;
  contractVersion: string;
};

// `setup_deferred_at` is intentionally NOT selected or written here: the runtime no longer
// reads or writes that column (task #172 Phase 1). It is dropped in Phase 2.
function persistedStateSelection() {
  return {
    serverId: serverMembers.serverId,
    userId: serverMembers.userId,
    status: serverMembers.setupStatus,
    completionReason: serverMembers.setupCompletionReason,
    contractVersion: serverMembers.setupContractVersion,
  };
}

function toServerSetupState(row: PersistedServerSetupState): ServerSetupState {
  return {
    serverId: row.serverId,
    userId: row.userId,
    status: row.status,
    completionReason: row.completionReason ?? null,
    contractVersion: row.contractVersion,
  };
}

export class DrizzleServerSetupStateRepository implements ServerSetupStateRepository {
  async get(serverId: string, userId: string): Promise<ServerSetupState | null> {
    const [row] = await getDb()
      .select(persistedStateSelection())
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
    return row ? toServerSetupState(row) : null;
  }

  async transition(
    serverId: string,
    userId: string,
    mutate: (current: ServerSetupState) => Promise<ServerSetupState> | ServerSetupState,
  ): Promise<ServerSetupRepositoryTransition | null> {
    return getDb().transaction(async (tx) => {
      const [row] = await tx
        .select(persistedStateSelection())
        .from(serverMembers)
        .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
        .for("update");
      if (!row) return null;

      const previous = toServerSetupState(row);
      const requested = await mutate(unchangedState(previous));
      if (statesEqual(previous, requested)) {
        return { previous, state: previous, changed: false };
      }

      const [updated] = await tx
        .update(serverMembers)
        .set({
          setupStatus: requested.status,
          setupCompletionReason: requested.completionReason,
        })
        .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
        .returning(persistedStateSelection());
      if (!updated) return null;
      return { previous, state: toServerSetupState(updated), changed: true };
    });
  }
}

async function resolveOfficialOnboardingAgentState(serverId: string): Promise<OfficialOnboardingAgentState> {
  const [server] = await getDb()
    .select({ onboardingAgentId: servers.onboardingAgentId })
    .from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));

  let officialOnboardingAgent: OfficialOnboardingAgentState = "unknown";
  if (server) {
    if (!server.onboardingAgentId) {
      officialOnboardingAgent = "missing";
    } else {
      const [agent] = await getDb()
        .select({
          name: agents.name,
          displayName: agents.displayName,
          description: agents.description,
          avatarUrl: agents.avatarUrl,
          machineId: agents.machineId,
          runtime: agents.runtime,
          serverRole: serverAgentMembers.role,
        })
        .from(agents)
        .leftJoin(
          serverAgentMembers,
          and(
            eq(serverAgentMembers.serverId, agents.serverId),
            eq(serverAgentMembers.agentId, agents.id),
          ),
        )
        .where(and(
          eq(agents.id, server.onboardingAgentId),
          eq(agents.serverId, serverId),
          isNull(agents.deletedAt),
        ));

      officialOnboardingAgent = agent
        && agent.machineId
        && agent.runtime.trim()
        && hasOfficialOnboardingAgentIdentity(agent, agent.serverRole)
        ? "usable"
        : "unusable";
    }
  }

  return officialOnboardingAgent;
}

/**
 * The two post-setup facts, read from persisted state.
 *
 * These decide whether the survey / handoff screens still owe the owner a visit, so
 * they must NOT live in the browser: someone who closes the tab on the handoff and
 * comes back should land right back on it, with Cindy still waiting to be briefed.
 */
async function resolveOwnerPostSetupFacts(serverId: string, actorUserId: string): Promise<{
  ownerSurveyPending: boolean;
  ownerHandoffPending: boolean;
  /** The person looking. The survey and the handoff are the OWNER's, and nobody else's. */
  actorIsOwner: boolean;
}> {
  // Fail open, like every other fact here: if this cannot be read, owe nothing. A
  // survey we failed to look up must never be the reason someone is locked out of
  // their own server.
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return { ownerSurveyPending: false, ownerHandoffPending: false, actorIsOwner: false };
  }

  const [server] = await db.select({ ownerId: servers.ownerId }).from(servers).where(eq(servers.id, serverId));
  if (!server) return { ownerSurveyPending: false, ownerHandoffPending: false, actorIsOwner: false };

  const [owner] = await db
    .select({ signupSurveyCompletedAt: users.signupSurveyCompletedAt })
    .from(users)
    .where(eq(users.id, server.ownerId));

  const [prefs] = await db
    .select({ setupHandoffAcknowledgedAt: serverMembers.setupHandoffAcknowledgedAt })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, server.ownerId)));

  return {
    ownerSurveyPending: !!owner && owner.signupSurveyCompletedAt === null,
    // The handoff is owed until the owner PRESSES "Let's Go" — a fact with a column of
    // its own. It used to be inferred from the briefing DELIVERY timestamps, which answer
    // a different question, and the two diverge in both directions: a briefing dropped
    // because the agent was still booting left an owner who HAD pressed it stuck on
    // "Starting…", and an old server that never had a briefing read as "still owes a
    // handoff" — which is how existing users were shown the completion celebration.
    // Delivery is delivery. It never speaks for the user.
    ownerHandoffPending: !prefs?.setupHandoffAcknowledgedAt,
    actorIsOwner: actorUserId === server.ownerId,
  };
}

async function resolvePersistedCompletionFacts(serverId: string, actorUserId: string): Promise<ServerSetupLiveFacts> {
  return {
    ...(await resolveOwnerPostSetupFacts(serverId, actorUserId)),
    computer: "unknown",
    hasConnectedComputer: false,
    offlineComputers: [],
    // Fail CLOSED. This path does not read the agents table, and `everHadAgent: false` is
    // what makes a reset available — so claiming it here would offer to demolish a server on
    // the strength of a question we never asked. Every other unknown in this file degrades
    // to "we were not told"; this one degrades to "do not touch anything".
    everHadAgent: true,
    runtime: "unknown",
    runtimeOptions: [],
    officialOnboardingAgent: await resolveOfficialOnboardingAgentState(serverId),
  };
}

const RECOMMENDED_SETUP_RUNTIMES = new Set(["claude", "codex"]);

export async function resolveServerSetupLiveFacts(
  serverId: string,
  actorUserId: string,
  orchestrator: Pick<AgentOrchestrator, "getMachineStatus">,
): Promise<ServerSetupLiveFacts> {
  const serverMachines = await getDb()
    .select({ id: machines.id, runtimes: machines.runtimes })
    .from(machines)
    .where(eq(machines.serverId, serverId));

  const statuses = await Promise.all(serverMachines.map(async (machine) => {
    try {
      return { machine, status: await orchestrator.getMachineStatus(machine.id) as "online" | "offline" };
    } catch {
      return { machine, status: "unknown" as const };
    }
  }));

  const online = statuses.filter((entry) => entry.status === "online");

  // The names come from the SAME table as the fact.
  //
  // They used to come from the browser's machine store while `hasConnectedComputer` came from
  // `computers`, and a screenshot caught what that costs: a server with two named computers
  // rendering "This computer" — anonymous, singular — because the two sources disagreed. The
  // recovery screen exists to say "I remember you", and we had built the remembering on one
  // table and the knowing on another. One question, one source.
  //
  // `machines` is joined only for the heartbeat, which is the one thing `computers` genuinely
  // does not know. A machine we have never heard from has no `lastHeartbeat`, and the screen
  // says "Offline" and nothing more rather than inventing a last-seen time.
  const connectedComputers = await getDb()
    .select({
      id: computers.id,
      name: computers.name,
      machineId: computers.machineId,
      lastHeartbeat: machines.lastHeartbeat,
    })
    .from(computers)
    .leftJoin(machines, eq(machines.id, computers.machineId))
    .where(and(eq(computers.serverId, serverId), isNull(computers.revokedAt)));
  const hasConnectedComputer = connectedComputers.length > 0;
  const onlineMachineIds = new Set(online.map(({ machine }) => machine.id));
  const offlineComputers: ServerSetupOfflineComputer[] = connectedComputers
    .filter((entry) => !entry.machineId || !onlineMachineIds.has(entry.machineId))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      lastHeartbeat: entry.lastHeartbeat ? entry.lastHeartbeat.toISOString() : null,
      // A Computer, not a legacy daemon machine: `raft-computer start` only exists on the
      // former. A computers row IS the managed Computer, so this is true by construction.
      isComputer: true,
    }));
  // Online-ness for the SETUP surface must be revocation-aware, exactly as `hasConnectedComputer`
  // above already is. A machine whose only `computers` row was revoked by "Start over" is NOT a
  // connected computer any more, even while its orphaned daemon still holds a live socket — and
  // `getMachineStatus` keeps reporting that socket "online". Reading it as online here left the
  // surface on `create_agent` (Meet Cindy) after a reset until the owner happened to kill the CLI
  // on their laptop: the DB was rewound but the screen never moved. Key off the NON-REVOKED
  // computers' machineIds (not "has any computers row"): a same-machine re-setup mints a fresh row
  // and legitimately comes back online, so a stale revoked row must not filter the new one out.
  // See serverSetupReset.test.ts "Start over returns the surface to Connect Computer".
  const connectedMachineIds = new Set(
    connectedComputers.map((entry) => entry.machineId).filter((id): id is string => id != null),
  );
  const connectedStatuses = statuses.filter((entry) => connectedMachineIds.has(entry.machine.id));
  const onlineConnected = connectedStatuses.filter((entry) => entry.status === "online");
  const computer: ServerSetupComputerState = onlineConnected.length > 0
    ? "online"
    : connectedStatuses.some((entry) => entry.status === "unknown")
      ? "unknown"
      : "offline";

  let runtime: ServerSetupRuntimeState = "unknown";
  let runtimeOptions: RuntimeSelectionOption[] = [];
  if (computer === "online") {
    // Read runtimes from the persisted `machines.runtimes` column — the single
    // cross-replica source of truth, mirroring how `getMachineStatus` resolves
    // online-ness across replicas. The daemon holds one socket on one replica, so
    // in-memory `conn.runtimes` is null on every OTHER replica; a load-balanced
    // setup-projection request landing on a non-owner replica would read
    // runtime="unknown" and never advance to create_agent (Next stays dead while
    // the client card, reading the machine list, ticks "runtimes detected"). The
    // `ready` handler AWAITS the DB persist BEFORE it sets in-memory and emits to
    // the client, so the column is never staler than the card — there is no "DB
    // lag" to avoid (that was the mistaken premise of #142's in-memory read).
    // `null` = not reported yet → "unknown" (self-heals on `ready`). See task
    // #154 / Screen B Next readiness (multi-replica).
    const perMachineRuntimes = onlineConnected.map(({ machine }) => machine.runtimes);
    const runtimeIds = perMachineRuntimes.flatMap((runtimes) => runtimes ?? []);
    const policy = await resolveRuntimeAdmissionPolicy({ serverId, userId: actorUserId });
    runtimeOptions = projectSetupRuntimeOptions(runtimeIds, policy);
    const availableRuntimeIds = runtimeOptions
      .filter((option) => option.canSelectInThisContext)
      .map((option) => option.runtimeId);
    runtime = availableRuntimeIds.some((runtimeId) => RECOMMENDED_SETUP_RUNTIMES.has(runtimeId))
      ? "ready_recommended"
      : availableRuntimeIds.length > 0
        ? "ready_other"
        : perMachineRuntimes.some((runtimes) => runtimes == null)
          ? "unknown"
          : "not_ready";
  }

  // The commit point. Deleted Cindy counts because `servers.onboarding_agent_id` remains
  // populated; non-onboarding agents do not. This mirrors the top-level invariant:
  // onboarding crosses the checkpoint when the official onboarding agent is created, not
  // when a dev/bootstrap server happens to contain some other agent row.
  const [server] = await getDb()
    .select({ onboardingAgentId: servers.onboardingAgentId })
    .from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));

  return {
    ...(await resolveOwnerPostSetupFacts(serverId, actorUserId)),
    computer,
    hasConnectedComputer,
    offlineComputers,
    everHadAgent: !!server?.onboardingAgentId,
    runtime,
    runtimeOptions,
    officialOnboardingAgent: await resolveOfficialOnboardingAgentState(serverId),
  };
}

/**
 * Roll the server back to empty and let the owner start again.
 *
 * The exit for anyone stuck before the commit point: a computer that went offline and won't
 * come back, a runtime that never reports ready, a laptop that was sold. It revokes the
 * server's computers and rewinds setup to `not_started`. Nothing else is touched, because
 * before the commit point there IS nothing else — that is what makes this promise keepable.
 *
 * Two things this deliberately does NOT do.
 *
 * It does not read `setup_status` to decide whether the reset is safe. It counts the agents
 * itself, right here, in the same breath as the destruction. A projected column that was
 * written by someone else, earlier, for another purpose, is not a licence to destroy data —
 * and this codebase has already watched `setup_status` drift from reality on 486 servers.
 * The projection offers the button; only this function may pull the trigger.
 *
 * It does not uninstall anything. Revoking a computer permanently dead-keys the daemon still
 * installed on that machine (`computerCredentialService`: a revoked credential is rejected
 * forever, and never self-heals). Our transaction ends at the edge of our database; the
 * user's laptop is outside it. So the UI must SAY that old machines need connecting again —
 * a rollback the user cannot see is just a machine that mysteriously stopped working.
 */
export async function resetServerSetup(input: {
  serverId: string;
  actor: ServerSetupActor;
}): Promise<{ revokedComputers: number }> {
  if (input.actor.type !== "user") {
    throw new ServerSetupStateError("ACTOR_NOT_HUMAN", "Only a human may reset setup");
  }

  // Namespace 1 is the agent-create lock. Reset and create are two competing answers to the
  // same question ("did this server cross the first-agent checkpoint?") and therefore must
  // serialize on the same lock. Every guard and both destructive writes live in this one
  // transaction: either create commits first and reset refuses without touching a computer,
  // or reset commits first and a queued create observes the changed setup state and retries.
  return withAgentCreateLock(input.serverId, async (tx) => {
    const [server] = await tx
      .select({ ownerId: servers.ownerId, onboardingAgentId: servers.onboardingAgentId })
      .from(servers)
      .where(and(eq(servers.id, input.serverId), isNull(servers.deletedAt)));
    if (!server) {
      throw new ServerSetupStateError("STATE_NOT_FOUND", "Server not found");
    }
    // The owner's flow, and the owner's server. An admin may help someone set a server up;
    // they may not throw someone else's away.
    if (server.ownerId !== input.actor.id) {
      throw new ServerSetupStateError("INSUFFICIENT_PERMISSION", "Only the owner may reset setup");
    }

    // `complete` is TERMINAL, and that includes here. (@stdrc: the setup-state API should only
    // ever be able to move a server TO complete, never back out of it.)
    const [member] = await tx
      .select({ status: serverMembers.setupStatus })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, input.serverId), eq(serverMembers.userId, server.ownerId)));
    if (member?.status === "complete") {
      throw new ServerSetupStateError(
        "SERVER_ALREADY_SET_UP",
        "Setup is complete; it cannot be rolled back",
      );
    }

    // The guard. Ask the server's official onboarding-agent pointer, not the flag that
    // claims to summarise setup and not unrelated/bootstrap agents that are not Cindy.
    if (server.onboardingAgentId) {
      throw new ServerSetupStateError(
        "SERVER_ALREADY_SET_UP",
        "This server has had an onboarding agent; setup cannot be rolled back",
      );
    }

    const revoked = await tx
      .update(computers)
      .set({ revokedAt: currentDate() })
      .where(and(eq(computers.serverId, input.serverId), isNull(computers.revokedAt)))
      .returning({ id: computers.id });

    await tx
      .update(serverMembers)
      .set({ setupStatus: "not_started", setupCompletionReason: null })
      .where(and(
        eq(serverMembers.serverId, input.serverId),
        eq(serverMembers.userId, server.ownerId),
      ));

    return { revokedComputers: revoked.length };
  });
}

const defaultServerSetupStateService = createServerSetupStateService({
  repository: new DrizzleServerSetupStateRepository(),
  resolveActorRole: (serverId, actor) => getActorServerRoleInServer(serverId, actor.type, actor.id),
  resolveLiveFacts: (serverId, userId) => resolvePersistedCompletionFacts(serverId, userId),
});

export const getServerSetupState = defaultServerSetupStateService.getServerSetupState;
export const transitionServerSetupState = defaultServerSetupStateService.transitionServerSetupState;
export const resolveServerSetup = defaultServerSetupStateService.resolveServerSetup;
