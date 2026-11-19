/**
 * The two onboarding instructions the Server writes for an agent, the owner
 * briefing (the opener-v2 ledger) and the #all greeting, as AGENT INBOX ITEMS
 * of the system app `system.onboarding` (Tenny, #proj-runtime:#60), for an
 * agent whose Computer is 1.0.68 or newer.
 *
 * Before, both were synthetic `seq: 0` messages no read can return: the daemon
 * kept them pending forever, and a runtime that exits after every turn
 * (Cursor, ...) was restarted for them after every turn. An inbox item is a
 * row: `raft inbox read` (CLI 1.0.68) and `message read --target
 * agent-event:<id>` (daemon 1.0.38) return it and the daemon consumes it by
 * its id, so it ends like any message the agent read.
 *
 * A runtime that exits after every turn (the agents #14955 holds wakes for:
 * Cursor and the legacy Antigravity/Gemini/Copilot drivers, not on the OAR
 * host) needs Computer 1.25.3: an item it leaves unread would still restart
 * it at its clean exit on a daemon without #14982, the first Computer with
 * which is 1.25.3 (Tenny, #15001).
 *
 * Older Computers (and an agent with no Computer or no reported version, such
 * as a hosted Cindy) keep the synthetic message, and for per-turn runtimes the
 * hold of onboardingHeldWakes.ts.
 *
 * One item per instruction: each has a fixed `object_ref`, and a replay
 * (another activation, a retried trigger) that finds the agent's event for
 * that ref writes nothing and wakes no one. Two at once see each other
 * through an advisory lock.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { compareComputerVersions, currentDate, isComputerSemver } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { thirdPartyAgentEvents, type SystemAppKey } from "../db/schema";
import { agentComputerVersion } from "./machineService";
import { createSystemAppAgentEvent, deliverSystemAppAgentEvent, type SystemAppAgentEventDeliverer } from "./systemAppAgentEvents";
import { recordTraceEvent } from "../tracing/semanticTrace";

export const ONBOARDING_SYSTEM_APP = "system.onboarding" satisfies SystemAppKey;

/**
 * The first Computer whose CLI has `raft inbox read`; its daemon consumes an
 * app event read by id (since 1.0.38). Older and unknown versions keep the
 * synthetic message.
 */
export const ONBOARDING_INBOX_ITEMS_MIN_COMPUTER_VERSION = "1.0.68";

/**
 * The first Computer with #14982 (a per-turn runtime's clean exit is a turn
 * end, so an item it was told about and left unread does not restart it):
 * the gate for per-turn runtimes.
 */
export const ONBOARDING_INBOX_ITEMS_PER_TURN_MIN_COMPUTER_VERSION = "1.25.3";

/**
 * The owner briefing lives 7 days: it is what Cindy needs to answer the
 * owner's first reply, and the owner may not open Raft again the same day.
 * Once it expires unread, nothing tells her who the owner is (the opener is
 * stamped sent when the item is written), so it outlives a long weekend.
 */
export const ONBOARDING_OWNER_BRIEFING_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * The #all greeting lives 1 day: a "hello, I just joined" posted days after
 * the agent joined is noise, and the greeting is never retried anyway.
 */
export const ONBOARDING_ALL_CHANNEL_GREETING_TTL_MS = 24 * 60 * 60_000;

/** The briefing's item: one per server (the server's onboarding agent is its reader). */
export function ownerBriefingObjectRef(serverId: string): string {
  return `opener:${serverId}`;
}

/** The greeting's item: one per agent and server. */
export function allChannelGreetingObjectRef(serverId: string, agentId: string): string {
  return `greeting:${serverId}:${agentId}`;
}

/**
 * Whether a Computer of this version gets the onboarding instructions as
 * inbox items. Any runtime: 1.0.68 or newer by SemVer precedence (a 1.0.68
 * prerelease is older). A per-turn runtime: 1.25.3 or newer by release, so a
 * 1.25.3 prerelease (1.25.3-rc.1 already carries #14982) counts. Unknown or
 * non-SemVer: never.
 */
export function onboardingInboxItemsAllowedFor(computerVersion: string | null, input: { perTurnRuntime: boolean }): boolean {
  const version = computerVersion?.trim() ?? "";
  if (!version || !isComputerSemver(version)) return false;
  if (compareComputerVersions(version, ONBOARDING_INBOX_ITEMS_MIN_COMPUTER_VERSION) < 0) return false;
  if (!input.perTurnRuntime) return true;
  const release = version.split("+", 1)[0]!.split("-", 1)[0]!;
  return compareComputerVersions(release, ONBOARDING_INBOX_ITEMS_PER_TURN_MIN_COMPUTER_VERSION) >= 0;
}

/**
 * Whether this agent's onboarding instructions go as inbox items, from the
 * version its Computer last reported. `perTurnRuntime`: the agent is one
 * #14955 holds wakes for (AgentOrchestrator.onboardingWakeRoute is not
 * `unchanged`).
 */
export async function onboardingInstructionsAsInboxItems(agentId: string, input: { perTurnRuntime: boolean }): Promise<boolean> {
  return onboardingInboxItemsAllowedFor(await agentComputerVersion(agentId), input);
}

export type OnboardingInboxItemInput = {
  serverId: string;
  agentId: string;
  objectRef: string;
  /** One line: what `raft inbox read` shows of the event (the first line of its content). */
  summary: string;
  payload: Record<string, unknown>;
  ttlMs: number;
  relatedChannelId: string | null;
};

/**
 * `created`: the event was written (and pushed, or left queued for the sweep
 * when the push failed). `exists`: the agent already has an event for this
 * item; nothing was written or pushed.
 */
export type OnboardingInboxItemOutcome = { kind: "created" | "exists"; eventId: string };

/** Writes the item's event unless the agent already has one for it, then pushes it once. */
export async function sendOnboardingInboxItem(
  deliverer: SystemAppAgentEventDeliverer,
  input: OnboardingInboxItemInput,
): Promise<OnboardingInboxItemOutcome> {
  const now = currentDate();
  const written = await getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ONBOARDING_SYSTEM_APP}:${input.agentId}:${input.objectRef}`}, 0))`);
    const [earlier] = await tx.select({ id: thirdPartyAgentEvents.id }).from(thirdPartyAgentEvents).where(and(
      eq(thirdPartyAgentEvents.agentId, input.agentId),
      isNull(thirdPartyAgentEvents.clientId),
      eq(thirdPartyAgentEvents.systemApp, ONBOARDING_SYSTEM_APP),
      eq(thirdPartyAgentEvents.objectRef, input.objectRef),
    )).limit(1);
    if (earlier) return { kind: "exists" as const, eventId: earlier.id };
    const event = await createSystemAppAgentEvent({
      executor: tx,
      serverId: input.serverId,
      agentId: input.agentId,
      systemApp: ONBOARDING_SYSTEM_APP,
      kind: "event",
      summary: input.summary,
      payload: input.payload,
      ttlMs: input.ttlMs,
      now,
      objectRef: input.objectRef,
      relatedChannelId: input.relatedChannelId,
    });
    return { kind: "created" as const, eventId: event.id, event };
  });
  recordTraceEvent("onboarding.inbox_item", { kind: written.kind, object: input.objectRef.split(":", 1)[0] });
  if (written.kind === "exists") return written;
  // A failed push leaves the event queued: the push sweep and the agent's
  // next /events hand it over. The item exists either way.
  await deliverSystemAppAgentEvent({
    event: written.event,
    deliverer,
    onDeliveryError: (err) => {
      console.warn(`[Onboarding] push of ${input.objectRef} to agent ${input.agentId} failed; it stays queued: ${err instanceof Error ? err.message : String(err)}`);
    },
  });
  return { kind: "created", eventId: written.eventId };
}
