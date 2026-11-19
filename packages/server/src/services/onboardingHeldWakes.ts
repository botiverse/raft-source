/**
 * Server-built onboarding wakes for runtime drivers that exit after every turn.
 *
 * The owner opener ledger and the #all greeting (onboardingService.ts) are
 * synthetic messages: `seq: 0`, an id like `opener-v2-ledger-<serverId>`, no
 * database row. Sent the ordinary way, a daemon keeps such a message in the
 * agent's inbox and wakes the agent with a notice that tells it to run
 * `raft message read --target <t> --unread`. That read goes to the Server,
 * which only returns rows, so it never returns this message and the daemon never
 * marks it read. Claude, Codex and the other runtimes whose process stays up
 * just leave it there. But the legacy Cursor, Antigravity, Gemini and Copilot
 * drivers end their process after every turn (`cursor-agent --print`), and at that
 * clean exit the daemon (1.22.0, 1.25.0, ...) restarts the agent right away for
 * any message still pending: the same message, the same notice, a new paid turn
 * every ~15 s, for hours (633 turns on one agent).
 *
 * The Server can stop that on Computers already shipped: a `transient` delivery
 * never becomes a pending message, so it is never the wake of a restart. The
 * turn it starts gets the whole body. But a daemon drops a transient delivery
 * it cannot hand over at once (the agent is starting, mid-turn or stopping),
 * and these wakes are sent right after an agent is created or started, which is
 * exactly when it is busy. So for these runtimes the Server sends them
 * `transient` only when the agent's process has exited idle (the daemon's
 * "Process idle"): a delivery then starts the agent with this message as its
 * start input. Until then the message waits in `onboarding_held_wakes`. The
 * agent's next "Process idle" takes it, and the delete is the claim, so it goes
 * once, from whichever replica sees that.
 *
 * Every other runtime (and these runtimes on the daemon's OAR host, which keeps
 * one live session and has no per-turn exit) keeps the delivery it had,
 * byte for byte.
 */
import { and, eq, lt } from "drizzle-orm";
import type { AgentMessage } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, onboardingHeldWakes, serverMembers, servers } from "../db/schema";
import { recordTraceEvent } from "../tracing/semanticTrace";
import type { AgentMessageDeliveryResult, DeliverMessageOptions } from "./agentOrchestrator";

/**
 * The runtime ids whose legacy daemon driver exits after every turn and does
 * not mark its exit as a turn end (`terminateProcessOnTurnEnd`): the daemon
 * restarts such an agent for any message still pending. OpenCode also runs a
 * process per turn, but its driver marks the exit as a turn end, so a message
 * it was already told about does not restart it (Task #389).
 */
export const PER_TURN_EXIT_RUNTIMES: ReadonlySet<string> = new Set(["cursor", "antigravity", "gemini", "copilot"]);

export function isPerTurnExitRuntime(runtime: string | null | undefined): boolean {
  return typeof runtime === "string" && PER_TURN_EXIT_RUNTIMES.has(runtime);
}

/**
 * The legacy daemon's status once a runtime process has ended cleanly and
 * nothing restarted it (`broadcastIdleOrCredentialInvalid`, every Computer
 * since before 1.22.0). Its "Idle" at the turn end comes while the process is
 * still exiting, and a transient delivery then is dropped as busy. The OAR
 * host never sends this text.
 */
export const LEGACY_PROCESS_IDLE_DETAIL = "Process idle";

export function isLegacyProcessIdleActivity(activity: { activity: string; detailKind?: string | null; detail?: string | null } | null | undefined): boolean {
  return activity?.activity === "online" && activity.detailKind === "idle" && activity.detail === LEGACY_PROCESS_IDLE_DETAIL;
}

/**
 * How long a wake may wait for its agent to go idle. A briefing that arrives
 * this late is about a conversation that has moved on; losing it is better
 * than an unbounded hold.
 */
export const ONBOARDING_HELD_WAKE_MAX_HOLD_MS = 30 * 60_000;

export type OnboardingWakeKind = (typeof onboardingHeldWakes.$inferSelect)["kind"];

/**
 * How an onboarding wake goes to an agent (AgentOrchestrator.onboardingWakeRoute):
 * - `unchanged`: as before, an ordinary delivery;
 * - `transient_now`: the agent's process has exited idle, send it transient now;
 * - `hold`: a per-turn runtime that is starting or working; wait for its "Process idle".
 */
export type OnboardingWakeRoute = "unchanged" | "transient_now" | "hold";

export type OnboardingWakeOutcome =
  | { kind: "delivered"; result: AgentMessageDeliveryResult }
  | { kind: "held" };

export interface HeldOnboardingWake {
  kind: OnboardingWakeKind;
  message: AgentMessage;
  heldAt: Date;
}

export interface OnboardingHeldWakeStore {
  /** Keeps the first hold time, so the bound counts from the first hold. */
  hold(agentId: string, kind: OnboardingWakeKind, message: AgentMessage, now: Date): Promise<void>;
  /** Deletes and returns the agent's held wakes: the caller that gets a row is the only one that sends it. */
  take(agentId: string): Promise<HeldOnboardingWake[]>;
  /** Deletes and returns every wake held since before `heldBefore`, whatever its agent (the expiry sweep). */
  takeExpired(heldBefore: Date): Promise<Array<HeldOnboardingWake & { agentId: string }>>;
}

export const onboardingHeldWakeStore: OnboardingHeldWakeStore = {
  async hold(agentId, kind, message, now) {
    await getDb().insert(onboardingHeldWakes)
      .values({ agentId, kind, message, heldAt: now })
      .onConflictDoUpdate({ target: [onboardingHeldWakes.agentId, onboardingHeldWakes.kind], set: { message } });
  },
  async take(agentId) {
    return getDb().delete(onboardingHeldWakes)
      .where(eq(onboardingHeldWakes.agentId, agentId))
      .returning({ kind: onboardingHeldWakes.kind, message: onboardingHeldWakes.message, heldAt: onboardingHeldWakes.heldAt });
  },
  async takeExpired(heldBefore) {
    return getDb().delete(onboardingHeldWakes)
      .where(lt(onboardingHeldWakes.heldAt, heldBefore))
      .returning({ agentId: onboardingHeldWakes.agentId, kind: onboardingHeldWakes.kind, message: onboardingHeldWakes.message, heldAt: onboardingHeldWakes.heldAt });
  },
};

/**
 * A held wake that will not be delivered (expired, or dropped when sent).
 * The owner briefing goes back to unsent, so the next activation of the
 * onboarding agent runs the opener trigger again, as a dropped ledger always
 * did. The #all greeting keeps its claim: it is only ever triggered when the
 * agent is created, so there is nothing to retry it, the same as a greeting a
 * daemon drops today; a greeting half an hour late would be noise anyway.
 */
export type HeldWakeLostHandler = (agentId: string, kind: OnboardingWakeKind) => Promise<void>;

/**
 * The owner briefing stamped as sent for a ledger held for this agent was
 * never delivered: clear the stamp (only one this agent's opener set), so the
 * next activation runs the opener trigger again, as for a dropped ledger. The
 * visible opener messages are keyed by `agentSendKey` and the D2 reminder by a
 * stable id, so that replay posts nothing twice. (Here rather than in
 * serverService: this module is loaded by the orchestrator.)
 */
export async function releaseOwnerOpenerSentForAgent(agentId: string): Promise<boolean> {
  const db = getDb();
  const [owner] = await db.select({ serverId: servers.id, ownerId: servers.ownerId })
    .from(agents)
    .innerJoin(servers, eq(servers.id, agents.serverId))
    .where(eq(agents.id, agentId));
  if (!owner?.ownerId) return false;
  const rows = await db.update(serverMembers)
    .set({
      onboardingDmSentAt: null,
      onboardingDmSentByAgentId: null,
      onboardingOwnerOpenerV2SentAt: null,
      onboardingOwnerOpenerV2SentByAgentId: null,
      onboardingOwnerOpenerClaimedAt: null,
    })
    .where(and(
      eq(serverMembers.serverId, owner.serverId),
      eq(serverMembers.userId, owner.ownerId),
      eq(serverMembers.onboardingOwnerOpenerV2SentByAgentId, agentId),
    ))
    .returning({ userId: serverMembers.userId });
  return rows.length > 0;
}

export const defaultHeldWakeLostHandler: HeldWakeLostHandler = async (agentId, kind) => {
  if (kind !== "owner_opener_ledger") return;
  const released = await releaseOwnerOpenerSentForAgent(agentId);
  recordTraceEvent("onboarding.held_wake.ledger_unstamped", { released });
};

type WakeDeliverer = {
  deliverMessage(agentId: string, message: AgentMessage, options?: DeliverMessageOptions): Promise<AgentMessageDeliveryResult>;
};

/**
 * Send one onboarding wake by its route. `unchanged` makes exactly the call
 * the caller made before (no options argument).
 */
export async function deliverOnboardingWake(
  orchestrator: WakeDeliverer,
  input: { agentId: string; kind: OnboardingWakeKind; message: AgentMessage; route: OnboardingWakeRoute },
  deps: { store?: Pick<OnboardingHeldWakeStore, "hold">; now?: () => Date } = {},
): Promise<OnboardingWakeOutcome> {
  if (input.route === "unchanged") {
    return { kind: "delivered", result: await orchestrator.deliverMessage(input.agentId, input.message) };
  }
  if (input.route === "transient_now") {
    recordTraceEvent("onboarding.held_wake.sent", { kind: input.kind, path: "at_send" });
    return { kind: "delivered", result: await orchestrator.deliverMessage(input.agentId, input.message, { transient: true }) };
  }
  await (deps.store ?? onboardingHeldWakeStore).hold(input.agentId, input.kind, input.message, (deps.now ?? (() => new Date()))());
  recordTraceEvent("onboarding.held_wake.held", { kind: input.kind });
  console.info(`[Onboarding] ${input.kind} for agent ${input.agentId} held until its per-turn runtime is idle`);
  return { kind: "held" };
}

async function expire(agentId: string, wake: HeldOnboardingWake, heldMs: number, onLost: HeldWakeLostHandler): Promise<void> {
  recordTraceEvent("onboarding.held_wake.expired", { kind: wake.kind, held_ms: heldMs });
  console.warn(`[Onboarding] ${wake.kind} for agent ${agentId} expired after ${Math.round(heldMs / 60_000)}m waiting for an idle runtime; not sent`);
  await onLost(agentId, wake.kind);
}

/**
 * The agent's per-turn runtime process exited idle: send what is held for it,
 * transient, once. A wake held longer than the bound is not sent; it and a
 * send the Server drops are handed to `onLost`.
 */
export async function releaseHeldOnboardingWakes(
  orchestrator: WakeDeliverer,
  agentId: string,
  deps: { store?: Pick<OnboardingHeldWakeStore, "take">; now?: () => Date; onLost?: HeldWakeLostHandler } = {},
): Promise<void> {
  const onLost = deps.onLost ?? defaultHeldWakeLostHandler;
  const held = await (deps.store ?? onboardingHeldWakeStore).take(agentId);
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  for (const wake of held) {
    const heldMs = nowMs - wake.heldAt.getTime();
    if (heldMs > ONBOARDING_HELD_WAKE_MAX_HOLD_MS) {
      await expire(agentId, wake, heldMs, onLost);
      continue;
    }
    const result = await orchestrator.deliverMessage(agentId, wake.message, { transient: true }).catch((err: unknown) => {
      console.warn(`[Onboarding] held ${wake.kind} for agent ${agentId} failed to send: ${err instanceof Error ? err.message : String(err)}`);
      return { status: "dropped", reason: "delivery_threw" } as const;
    });
    recordTraceEvent("onboarding.held_wake.sent", { kind: wake.kind, path: "process_idle", held_ms: heldMs, status: result.status });
    if (result.status === "dropped") {
      console.warn(`[Onboarding] held ${wake.kind} for agent ${agentId} was dropped on release (${result.reason})`);
      await onLost(agentId, wake.kind);
    }
  }
}

/**
 * Expire what has waited past the bound, whether or not its agent ever goes
 * idle (a start that failed, a Computer that went away). Run from the
 * orchestrator's existing 30 s sweep on every replica; the delete is the
 * claim, so each wake expires once.
 */
export async function expireHeldOnboardingWakes(
  deps: { store?: Pick<OnboardingHeldWakeStore, "takeExpired">; now?: () => Date; onLost?: HeldWakeLostHandler } = {},
): Promise<void> {
  const onLost = deps.onLost ?? defaultHeldWakeLostHandler;
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const expired = await (deps.store ?? onboardingHeldWakeStore).takeExpired(new Date(nowMs - ONBOARDING_HELD_WAKE_MAX_HOLD_MS));
  for (const wake of expired) {
    await expire(wake.agentId, wake, nowMs - wake.heldAt.getTime(), onLost);
  }
}

type HeldWakeEvents = {
  on(event: "agent:per-turn-process-idle", listener: (event: { agentId: string }) => void): unknown;
  on(event: "onboarding:held-wakes:sweep", listener: () => void): unknown;
};

/**
 * Wire the release to the orchestrator's "agent:per-turn-process-idle" (an
 * accepted daemon frame, on the replica that holds the agent's machine) and
 * the expiry to its periodic sweep. The wakes are read from the table, so
 * nothing here holds state.
 */
export function startOnboardingHeldWakeRelease(deps: { orchestrator: WakeDeliverer & HeldWakeEvents }): void {
  deps.orchestrator.on("agent:per-turn-process-idle", ({ agentId }) => {
    void releaseHeldOnboardingWakes(deps.orchestrator, agentId).catch((err: unknown) => {
      console.warn(`[Onboarding] Releasing held onboarding wakes for agent ${agentId} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  deps.orchestrator.on("onboarding:held-wakes:sweep", () => {
    void expireHeldOnboardingWakes().catch((err: unknown) => {
      console.warn(`[Onboarding] Expiring held onboarding wakes failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
}
