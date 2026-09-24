import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import {
  clearClockInterval,
  currentDate,
  setClockInterval,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS,
} from "@botiverse/raft-shared";

import type { Database } from "../db/index.js";
import {
  externalAppInstalls,
  externalChannelBindings,
  externalMessageLinks,
  externalReactionCommandAttempts,
  externalReactionCommands,
} from "../db/schema.js";
import { evaluateFeatureFlag } from "./featureFlagService.js";
import type { SlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime.js";
import type { SlackProviderAuthorityFence, SlackWebApiTransportResult } from "./slackProviderAdapter.js";

const LEASE_MS = 60_000;
const RETRY_MS = 30_000;

type Command = typeof externalReactionCommands.$inferSelect;
type AttemptOutcome = typeof externalReactionCommandAttempts.$inferInsert["outcome"];

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeError(result: SlackWebApiTransportResult): string | null {
  if (result.kind !== "response") return null;
  return typeof result.body.error === "string" && result.body.error.length <= 160
    ? result.body.error
    : null;
}

function retryAfter(result: SlackWebApiTransportResult): number {
  if (result.kind !== "response") return RETRY_MS;
  const raw = result.headers["retry-after"];
  const seconds = raw && /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds * 1_000 : RETRY_MS;
}

function botPresence(result: SlackWebApiTransportResult, botUserId: string, key: string): boolean | null {
  if (result.kind !== "response" || result.status < 200 || result.status >= 300 || result.body.ok !== true) {
    return null;
  }
  const message = record(result.body.message) ? result.body.message : null;
  if (!message || !Array.isArray(message.reactions)) return false;
  const reaction = message.reactions.find((item) => record(item) && item.name === key);
  return record(reaction) && Array.isArray(reaction.users)
    ? reaction.users.includes(botUserId)
    : false;
}

export type ExternalReactionWorkerResult =
  | { kind: "empty" }
  | { kind: "blocked"; commandId: string; reason: string }
  | { kind: "attempted"; commandId: string; state: Command["state"]; outcome: AttemptOutcome };

export async function processExternalReactionCommandOnce(input: {
  db: Database;
  provider: SlackBridgeProviderRuntime;
  leaseOwner: string;
  now?: () => Date;
}): Promise<ExternalReactionWorkerResult> {
  const now = input.now ?? currentDate;
  const claimAt = now();
  const claim = await input.db.transaction(async (tx) => {
    const [candidate] = await tx.select().from(externalReactionCommands).where(or(
      and(
        inArray(externalReactionCommands.state, ["queued", "retry_wait", "outcome_unknown"]),
        lte(externalReactionCommands.nextAttemptAt, claimAt),
      ),
      and(
        eq(externalReactionCommands.state, "dispatching"),
        lte(externalReactionCommands.leaseExpiresAt, claimAt),
      ),
    )).orderBy(asc(externalReactionCommands.nextAttemptAt), asc(externalReactionCommands.createdAt))
      .for("update", { skipLocked: true }).limit(1);
    if (!candidate) return null;
    const [newer] = await tx.select({ id: externalReactionCommands.id })
      .from(externalReactionCommands).where(and(
        eq(externalReactionCommands.messageLinkId, candidate.messageLinkId),
        eq(externalReactionCommands.providerReactionKey, candidate.providerReactionKey),
      )).orderBy(desc(externalReactionCommands.desiredRevision)).limit(1);
    if (newer?.id !== candidate.id) {
      await tx.update(externalReactionCommands).set({
        state: "superseded",
        leaseOwner: null,
        leaseExpiresAt: null,
        terminalAt: claimAt,
        updatedAt: claimAt,
      }).where(eq(externalReactionCommands.id, candidate.id));
      return { superseded: candidate.id } as const;
    }
    const originState = candidate.state === "dispatching" ? "outcome_unknown" : candidate.state;
    const [claimed] = await tx.update(externalReactionCommands).set({
      state: "dispatching",
      attempts: candidate.attempts + 1,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: new Date(claimAt.getTime() + LEASE_MS),
      leaseGeneration: candidate.leaseGeneration + 1,
      updatedAt: claimAt,
    }).where(and(
      eq(externalReactionCommands.id, candidate.id),
      eq(externalReactionCommands.leaseGeneration, candidate.leaseGeneration),
    )).returning();
    return claimed ? { command: claimed, originState } as const : null;
  });
  if (!claim) return { kind: "empty" };
  if ("superseded" in claim) return { kind: "blocked", commandId: claim.superseded!, reason: "superseded" };
  const command = claim.command;

  const authority = await input.db.transaction(async (tx) => {
    const [install] = await tx.select().from(externalAppInstalls).where(and(
      sql`${externalAppInstalls.id}::text = ${command.installId}`,
      eq(externalAppInstalls.registrationId, command.appRegistrationId),
      eq(externalAppInstalls.providerAuthorityId, command.providerAuthorityId),
      eq(externalAppInstalls.connectionEpoch, command.connectionEpoch),
      eq(externalAppInstalls.state, "active"),
    )).limit(1);
    const [binding] = await tx.select().from(externalChannelBindings).where(and(
      sql`${externalChannelBindings.id}::text = ${command.bindingId}`,
      sql`${externalChannelBindings.installId}::text = ${command.installId}`,
      eq(externalChannelBindings.bindingEpoch, command.bindingEpoch),
      eq(externalChannelBindings.connectionEpoch, command.connectionEpoch),
      eq(externalChannelBindings.providerConversationId, command.providerConversationId),
      eq(externalChannelBindings.state, "active"),
    )).limit(1);
    const [link] = await tx.select().from(externalMessageLinks).where(and(
      eq(externalMessageLinks.id, command.messageLinkId),
      eq(externalMessageLinks.raftMessageId, command.raftMessageId),
      eq(externalMessageLinks.providerMessageId, command.providerMessageId),
      eq(externalMessageLinks.authorityState, "active"),
      eq(externalMessageLinks.outcomeState, "accepted"),
    )).limit(1);
    if (!install?.botUserId || !binding || !link) return null;
    const master = await evaluateFeatureFlag({
      key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
      serverId: binding.serverId,
    }, tx as unknown as Database);
    const enabled = await evaluateFeatureFlag({
      key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync,
      serverId: binding.serverId,
    }, tx as unknown as Database);
    return master.enabled && enabled.enabled ? { install, binding } : null;
  });
  if (!authority) {
    await input.db.update(externalReactionCommands).set({
      state: "revoked",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorClass: "reaction_authority_revoked",
      terminalAt: claimAt,
      updatedAt: claimAt,
    }).where(and(
      eq(externalReactionCommands.id, command.id),
      eq(externalReactionCommands.leaseGeneration, command.leaseGeneration),
      eq(externalReactionCommands.state, "dispatching"),
    ));
    return { kind: "blocked", commandId: command.id, reason: "reaction_authority_revoked" };
  }
  const fence: SlackProviderAuthorityFence = {
    installId: command.installId,
    providerAppId: authority.install.providerAppId,
    providerAuthorityId: command.providerAuthorityId,
    providerConversationId: command.providerConversationId,
    connectionEpoch: command.connectionEpoch,
    credentialRevision: authority.install.credentialRevision,
    bindingId: command.bindingId,
    bindingEpoch: command.bindingEpoch,
  };
  const credential = await input.provider.credentialResolver.resolve({ authority: fence, now: claimAt });
  if (!credential) {
    await input.db.update(externalReactionCommands).set({
      state: "retry_wait",
      nextAttemptAt: new Date(claimAt.getTime() + RETRY_MS),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorClass: "reaction_credential_unavailable",
      updatedAt: claimAt,
    }).where(eq(externalReactionCommands.id, command.id));
    return { kind: "blocked", commandId: command.id, reason: "reaction_credential_unavailable" };
  }

  const reconcile = claim.originState === "outcome_unknown";
  let result: SlackWebApiTransportResult;
  try {
    result = await input.provider.transport.call({
      method: reconcile
        ? "reactions.get"
        : command.desiredPresent
          ? "reactions.add"
          : "reactions.remove",
      credentialHandle: credential,
      authority: fence,
      body: reconcile
        ? { channel: command.providerConversationId, timestamp: command.providerMessageId, full: true }
        : {
          channel: command.providerConversationId,
          timestamp: command.providerMessageId,
          name: command.providerReactionKey,
        },
    });
  } catch {
    await input.provider.releaseCredential(credential);
    result = { kind: "transport_failure", phase: "after_send", code: "unavailable" };
  }
  const completedAt = now();
  let nextState: Command["state"];
  let outcome: AttemptOutcome;
  let reason: string;
  let ioPhase: "before_send" | "after_send" | "unknown";
  let retryAfterMs: number | null = null;
  let observedBotPresence: boolean | null = null;
  if (reconcile) {
    const error = safeError(result);
    observedBotPresence = botPresence(result, authority.install.botUserId!, command.providerReactionKey);
    if (observedBotPresence === command.desiredPresent) {
      nextState = "accepted";
      outcome = command.desiredPresent ? "reconciled_present" : "reconciled_absent";
      reason = "reaction_state_reconciled";
      ioPhase = "after_send";
    } else if (observedBotPresence !== null) {
      nextState = "retry_wait";
      outcome = command.desiredPresent ? "reconciled_absent" : "reconciled_present";
      reason = "reaction_state_reconciled_mismatch";
      ioPhase = "after_send";
    } else if (result.kind === "response" && result.status === 429) {
      nextState = "outcome_unknown";
      outcome = "rate_limited";
      reason = "reaction_reconcile_rate_limited";
      ioPhase = "before_send";
      retryAfterMs = retryAfter(result);
    } else if (error === "invalid_auth" || error === "token_revoked") {
      nextState = "revoked";
      outcome = "revoked";
      reason = "reaction_provider_authority_revoked";
      ioPhase = "after_send";
    } else if (error === "missing_scope" || error === "channel_not_found") {
      nextState = "deterministic_failure";
      outcome = "deterministic_failure";
      reason = "reaction_reconcile_rejected";
      ioPhase = "after_send";
    } else {
      nextState = "outcome_unknown";
      outcome = "outcome_unknown";
      reason = "reaction_reconcile_unavailable";
      ioPhase = "unknown";
    }
  } else if (result.kind === "transport_failure") {
    const before = result.phase === "before_send";
    nextState = before ? "retry_wait" : "outcome_unknown";
    outcome = before ? "transient_failure" : "outcome_unknown";
    reason = before ? "reaction_request_not_sent" : "reaction_request_outcome_unknown";
    ioPhase = result.phase;
  } else {
    const error = safeError(result);
    if (result.status === 429) {
      nextState = "retry_wait";
      outcome = "rate_limited";
      reason = "reaction_rate_limited";
      ioPhase = "before_send";
      retryAfterMs = retryAfter(result);
    } else if (result.status >= 200 && result.status < 300 && result.body.ok === true) {
      nextState = "accepted";
      outcome = "accepted";
      reason = "reaction_provider_accepted";
      ioPhase = "after_send";
    } else if (
      (command.desiredPresent && error === "already_reacted")
      || (!command.desiredPresent && error === "no_reaction")
    ) {
      nextState = "accepted";
      outcome = "already_satisfied";
      reason = "reaction_already_satisfied";
      ioPhase = "after_send";
    } else if (error === "fatal_error" || error === "internal_error" || result.status >= 500) {
      nextState = "outcome_unknown";
      outcome = "outcome_unknown";
      reason = "reaction_provider_outcome_unknown";
      ioPhase = "unknown";
    } else {
      nextState = error === "invalid_auth" || error === "token_revoked" ? "revoked" : "deterministic_failure";
      outcome = nextState === "revoked" ? "revoked" : "deterministic_failure";
      reason = nextState === "revoked" ? "reaction_provider_authority_revoked" : "reaction_provider_rejected";
      ioPhase = "after_send";
    }
  }
  const terminal = ["accepted", "deterministic_failure", "revoked", "quarantined", "superseded"].includes(nextState);
  await input.db.transaction(async (tx) => {
    const [current] = await tx.select().from(externalReactionCommands)
      .where(eq(externalReactionCommands.id, command.id)).for("update").limit(1);
    if (!current) return;
    if (current.state === "accepted" && current.terminalAt) return;
    await tx.insert(externalReactionCommandAttempts).values({
      commandId: command.id,
      desiredRevision: command.desiredRevision,
      attemptNumber: command.attempts,
      ioPhase,
      outcome,
      safeReasonCode: reason,
      retryAfterMs,
      observedBotPresence,
      observedAt: observedBotPresence === null ? null : completedAt,
      terminalAt: completedAt,
      createdAt: claimAt,
    }).onConflictDoNothing();
    await tx.update(externalReactionCommands).set({
      state: nextState,
      nextAttemptAt: terminal
        ? completedAt
        : new Date(completedAt.getTime() + (retryAfterMs ?? RETRY_MS)),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorClass: nextState === "accepted" ? null : reason,
      terminalAt: terminal ? completedAt : null,
      updatedAt: completedAt,
    }).where(and(
      eq(externalReactionCommands.id, command.id),
      eq(externalReactionCommands.state, "dispatching"),
      eq(externalReactionCommands.leaseOwner, input.leaseOwner),
      eq(externalReactionCommands.leaseGeneration, command.leaseGeneration),
    ));
  });
  return { kind: "attempted", commandId: command.id, state: nextState, outcome };
}

export function createExternalReactionWorkerRuntime(input: {
  db: Database;
  provider: SlackBridgeProviderRuntime;
  leaseOwner: string;
  intervalMs?: number;
  now?: () => Date;
  onError?(error: unknown): void;
}) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processExternalReactionCommandOnce(input);
    } catch (error) {
      input.onError?.(error);
    } finally {
      running = false;
    }
  };
  return {
    start() {
      if (timer) return;
      timer = setClockInterval(() => { void tick(); }, input.intervalMs ?? 1_000) as ReturnType<typeof setInterval>;
      void tick();
    },
    async stop() {
      if (timer) clearClockInterval(timer);
      timer = null;
      while (running) await new Promise((resolve) => setTimeout(resolve, 5));
    },
    tick,
  };
}
