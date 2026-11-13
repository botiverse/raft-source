import { readSlackIngressRollout } from "./slackVerifiedIngressRollout";
import { clearClockInterval, setClockInterval } from "@botiverse/raft-shared";
import { SlackIngressRolloutUnavailable } from "./slackVerifiedIngressRolloutContracts";
import type { Database, DatabaseTransaction } from "../db/index";
import type { ExternalInboundRuntimeAuthority } from "./externalInboundWorkerService";
import type { SlackBotProfileHint } from "./slackBotProfileRefresh";
import { serializeSlackVerifiedEvent, SLACK_VERIFIED_INGRESS_MAX_BYTES,
  type SlackVerifiedIngressAad, type SlackVerifiedIngressPayloadCrypto } from "./slackVerifiedIngressContracts";
import { proveSlackVerifiedIngressDiscard } from "./slackVerifiedIngressPairProof";
import { compactTerminalSlackIngress, expireQuarantinedSlackIngress, expireSlackIngressDedupe, expireSlackAuthorWakeSignals } from "./slackVerifiedIngressRetention";
import { claimSlackVerifiedIngressHead, claimSlackVerifiedIngressHeads, deferSlackVerifiedIngressClaim, discardSlackVerifiedIngressClaim, discardClassifiedSlackIngressClaim,
  materializeSlackVerifiedIngressClaim, deferUnrecognizedSlackIngressClaim, requeueDueSlackActor,
  type SlackUnrecognizedEventReason } from "./slackVerifiedIngressWorker";

export type PreparedVerifiedSlackEvent =
  | { kind: "wait"; reason: string }
  | { kind: "author_grace"; holdUntil: Date; pendingAuthor: { installId: string; workspaceId: string; bindingId: string; actorId: string };
      validatePendingAuthor: (tx: DatabaseTransaction, at: Date) => Promise<boolean> }
  | { kind: "discard"; reason: "no_recoverable_pair" | "destination_deleted" }
  | { kind: "skip"; reason: "provider_loop_suppressed" | "provider_self_echo" | "provider_bot_sync_disabled" | "unsupported_message_subtype" | "unsupported_event" | "reaction_author_unavailable" | "edit_author_unavailable";
      validate?: (tx: DatabaseTransaction, receivedAt: Date, at: Date) => Promise<boolean> }
  | { kind: "unrecognized"; reason: SlackUnrecognizedEventReason; immediate?: boolean;
      pendingAuthor?: { installId: string; workspaceId: string; bindingId: string; actorId: string };
      validatePendingAuthor?: (tx: DatabaseTransaction, at: Date) => Promise<boolean> }
  | { kind: "materialize"; authority: ExternalInboundRuntimeAuthority; normalizedPayloadDigest: string;
      encryptedPayload: string; envelopeKeyId: string; payloadSchemaVersion: 1 | 2 | 3 | 4;
      orderedActorId?: string;
      botProfileHint?: SlackBotProfileHint;
      payloadExpiresAt: Date; validateCurrentAuthority: (tx: DatabaseTransaction,
        authority: ExternalInboundRuntimeAuthority, at: Date) => Promise<boolean>;
      finalizeCurrentAuthority?: (tx: DatabaseTransaction, receivedAt: Date, at: Date) => Promise<boolean> };

/** Non-secret custody metadata; the preparer must revalidate it at settlement. */
export type SlackIngressPreparationContext = {
  lastIsolationReason: string | null;
  lastIsolatedAt: Date | null;
};

/** Process one claimed durable raw receipt. */
export async function processVerifiedSlackIngressOnce(input: {
  db: Database;
  crypto: SlackVerifiedIngressPayloadCrypto;
  leaseOwner: string;
  leaseMs: number;
  now: () => Date;
  scope?: { registrationId: string; environment: "test" | "production" };
  claim?: NonNullable<Awaited<ReturnType<typeof claimSlackVerifiedIngressHead>>>;
  prepare: (event: unknown, aad: SlackVerifiedIngressAad, receivedAt: Date, custody: SlackIngressPreparationContext) => Promise<PreparedVerifiedSlackEvent>;
  requestAuthorRefresh?: () => Promise<unknown>;
  requestBotProfileRefresh?: (hint: SlackBotProfileHint) => void;
  onAuthorRefreshError?: (error: unknown) => void;
}): Promise<{ kind: "disabled" | "empty" | "deferred" | "held" | "quarantined" | "materialized" | "discarded" | "lease_lost" }> {
  if ((await readSlackIngressRollout(input.db)).mode !== "verified_active") return { kind: "disabled" };
  let claim: Awaited<ReturnType<typeof claimSlackVerifiedIngressHead>>;
  try {
    claim = input.claim ?? await claimSlackVerifiedIngressHead({ db: input.db, leaseOwner: input.leaseOwner,
      leaseMs: input.leaseMs, now: input.now, ...(input.scope ? { scope: input.scope } : {}) });
  } catch (error) {
    if (error instanceof SlackIngressRolloutUnavailable && (error.reason === "paused" || error.reason === "not_enabled")) {
      return { kind: "disabled" };
    }
    throw error;
  }
  if (!claim) return { kind: "empty" };
  const { partition, event } = claim;
  if (event.leaseOwner !== input.leaseOwner || event.partitionId !== partition.id
    || (input.scope && (event.appRegistrationId !== input.scope.registrationId || partition.environment !== input.scope.environment))) {
    throw new Error("Slack ingress claim scope mismatch");
  }
  // Authority-wide callbacks have no channel to deliver to. Keep the signed
  // receipt and reason, but do not retain their payload indefinitely.
  if (partition.partitionKind === "authority") {
    const discarded = await discardClassifiedSlackIngressClaim({ db: input.db, partitionId: partition.id,
      eventId: event.id, rawDigest: event.rawDigest, leaseOwner: input.leaseOwner,
      leaseGeneration: event.leaseGeneration, now: input.now, reason: "unsupported_event" });
    return { kind: discarded ? "discarded" : "lease_lost" };
  }
  const aad: SlackVerifiedIngressAad = { purpose: "slack-verified-ingress", version: 1,
    registrationId: event.appRegistrationId, environment: partition.environment,
    providerAppId: event.providerAppId, providerAuthorityId: partition.providerAuthorityId,
    providerEventId: event.providerEventId,
    providerConversationId: partition.partitionKind === "conversation" ? partition.providerConversationId : null };
  const defer = async (reason: string) => {
    const now = input.now();
    const retryAt = new Date(now.getTime() + 60_000);
    return deferSlackVerifiedIngressClaim({ db: input.db, partitionId: partition.id, eventId: event.id,
      leaseOwner: input.leaseOwner, leaseGeneration: event.leaseGeneration, now: input.now, retryAt, reason });
  };
  if (!event.encryptedPayload || !event.envelopeKeyId) return { kind: await defer("payload_unavailable") ? "deferred" : "lease_lost" };
  let bytes: Buffer | undefined;
  try {
    bytes = await input.crypto.open({ encryptedPayload: event.encryptedPayload, envelopeKeyId: event.envelopeKeyId, aad });
  } catch {
    // A key service outage is not evidence that this individual event is bad.
    return { kind: await defer("verified_event_processing_failed") ? "deferred" : "lease_lost" };
  }
  let verifiedEnvelope: unknown;
  try {
    if (!Buffer.isBuffer(bytes)) { bytes = undefined; throw new Error("Invalid persisted Slack event bytes"); }
    if (bytes.length === 0 || bytes.length > SLACK_VERIFIED_INGRESS_MAX_BYTES) throw new Error("Invalid persisted Slack event bytes");
    const envelope: unknown = JSON.parse(bytes.toString("utf8"));
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || "token" in envelope) {
      throw new Error("Invalid persisted Slack event");
    }
    const verified = serializeSlackVerifiedEvent(envelope, aad);
    verified.fill(0);
    verifiedEnvelope = envelope;
  } catch {
    // Authenticated plaintext that cannot be parsed or does not match its
    // custody identity is isolated after bounded retries, with ciphertext kept.
  } finally {
    bytes?.fill(0);
  }
  if (!verifiedEnvelope) {
    // A malformed receipt for a provably never-paired conversation has no
    // recoverable destination. The proof is repeated under the pair lock;
    // inactive or historical pairs remain in custody.
    if (partition.partitionKind === "conversation" && await discardSlackVerifiedIngressClaim({
      db: input.db, partitionId: partition.id, eventId: event.id, leaseOwner: input.leaseOwner,
      leaseGeneration: event.leaseGeneration, now: input.now, reason: "no_recoverable_pair",
      proveDefinitiveAbsence: proveSlackVerifiedIngressDiscard,
    })) return { kind: "discarded" };
    const result = await deferUnrecognizedSlackIngressClaim({ db: input.db, partitionId: partition.id,
      eventId: event.id, leaseOwner: input.leaseOwner, leaseGeneration: event.leaseGeneration,
      now: input.now, retryAt: new Date(input.now().getTime() + 1_000), reason: "verified_payload_invalid" });
    return { kind: result === "retry" ? "deferred" : result };
  }
  // In particular, don't turn database/authority failures into a successful
  // tick. The lease expires for retry, and the supervisor can report them.
  const prepared = await input.prepare(verifiedEnvelope, aad, event.receivedAt, {
    lastIsolationReason: event.lastIsolationReason, lastIsolatedAt: event.lastIsolatedAt,
  });
  if (input.requestAuthorRefresh && event.parseFailureCount === 0 && event.lastIsolationReason !== "actor_identity_pending"
    && event.outcomeReason !== "actor_fallback_grace"
    && ((prepared.kind === "unrecognized" && prepared.reason === "actor_identity_pending")
      || prepared.kind === "author_grace")) {
    // The lifecycle owns its distributed claim/coalescing and provider retry;
    // don't hold this receipt's lease across provider I/O. A process crash may
    // repeat a hint, which is safe and preferable to losing the refresh.
    const report = (error: unknown) => { try { input.onAuthorRefreshError?.(error); } catch { /* reporting cannot strand custody */ } };
    try { void input.requestAuthorRefresh().catch(report); }
    catch (error) { report(error); }
  }
  // Keep DB mutations outside the processing catch: a failed defer, discard,
  // or materialization must surface to supervision, not trigger a second
  // transition that hides the failure or changes the recorded reason.
  if (prepared.kind === "wait") {
    const reason = /^[a-z][a-z0-9_]{0,159}$/u.test(prepared.reason) ? prepared.reason : "normalization_unavailable";
    return { kind: await defer(reason) ? "deferred" : "lease_lost" };
  }
  if (prepared.kind === "author_grace") {
    const result = await deferUnrecognizedSlackIngressClaim({ db: input.db, partitionId: partition.id,
      eventId: event.id, leaseOwner: input.leaseOwner, leaseGeneration: event.leaseGeneration,
      now: input.now, retryAt: new Date(input.now().getTime() + 60_000), reason: "actor_identity_pending", immediate: true,
      authorHoldUntil: prepared.holdUntil, pendingAuthor: prepared.pendingAuthor, validatePendingAuthor: prepared.validatePendingAuthor });
    return { kind: result === "retry" ? "deferred" : result };
  }
  if (prepared.kind === "unrecognized") {
    const retryAt = new Date(input.now().getTime() + 1_000);
    const result = await deferUnrecognizedSlackIngressClaim({ db: input.db, partitionId: partition.id,
      eventId: event.id, leaseOwner: input.leaseOwner, leaseGeneration: event.leaseGeneration,
      now: input.now, retryAt, reason: prepared.reason, immediate: prepared.immediate,
      pendingAuthor: prepared.pendingAuthor, validatePendingAuthor: prepared.validatePendingAuthor });
    return { kind: result === "retry" ? "deferred" : result };
  }
  if (prepared.kind === "skip") {
    const discarded = await discardClassifiedSlackIngressClaim({ db: input.db, partitionId: partition.id,
      eventId: event.id, rawDigest: event.rawDigest, leaseOwner: input.leaseOwner,
      leaseGeneration: event.leaseGeneration, now: input.now, reason: prepared.reason, validate: prepared.validate });
    return { kind: discarded ? "discarded" : await defer("discard_evidence_unavailable") ? "deferred" : "lease_lost" };
  }
  if (prepared.kind === "discard") {
    const discarded = await discardSlackVerifiedIngressClaim({ db: input.db, partitionId: partition.id, eventId: event.id,
      leaseOwner: input.leaseOwner, leaseGeneration: event.leaseGeneration, now: input.now,
      reason: prepared.reason, proveDefinitiveAbsence: proveSlackVerifiedIngressDiscard });
    if (discarded) return { kind: "discarded" };
    return { kind: await defer("discard_evidence_unavailable") ? "deferred" : "lease_lost" };
  }
  const materialized = await materializeSlackVerifiedIngressClaim({ db: input.db, partitionId: partition.id,
    eventId: event.id, leaseOwner: input.leaseOwner, leaseGeneration: event.leaseGeneration, now: input.now,
    authority: prepared.authority, normalizedPayloadDigest: prepared.normalizedPayloadDigest,
    encryptedPayload: prepared.encryptedPayload, envelopeKeyId: prepared.envelopeKeyId,
    payloadSchemaVersion: prepared.payloadSchemaVersion, payloadExpiresAt: prepared.payloadExpiresAt,
    validateCurrentAuthority: prepared.validateCurrentAuthority, finalizeCurrentAuthority: prepared.finalizeCurrentAuthority,
    orderedActorId: prepared.orderedActorId });
  if (materialized === "author_wait") return { kind: "held" };
  if (materialized) {
    if (prepared.botProfileHint && input.requestBotProfileRefresh) {
      try { input.requestBotProfileRefresh(prepared.botProfileHint); }
      catch { /* display refresh cannot affect custody */ }
    }
    return { kind: "materialized" };
  }
  return { kind: await defer("normalization_authority_unavailable") ? "deferred" : "lease_lost" };
}

/** Bounded single-flight scheduler. No work is claimed outside its key scope. */
export function createSlackVerifiedIngressWorkerRuntime(input: {
  db: Database;
  crypto: SlackVerifiedIngressPayloadCrypto;
  scope: { registrationId: string; environment: "test" | "production" };
  leaseOwner: string;
  leaseMs: number;
  now: () => Date;
  prepare: (event: unknown, aad: SlackVerifiedIngressAad, receivedAt: Date, custody: SlackIngressPreparationContext) => Promise<PreparedVerifiedSlackEvent>;
  requestAuthorRefresh?: () => Promise<unknown>;
  requestBotProfileRefresh?: (hint: SlackBotProfileHint) => void;
  onAuthorRefreshError?: (error: unknown) => void;
  intervalMs?: number;
  batchSize?: number;
  onError: (error: unknown) => void;
}) {
  const intervalMs = input.intervalMs ?? 250;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error("Invalid Slack ingress interval");
  const batchSize = input.batchSize ?? 16;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 16) throw new Error("Invalid Slack ingress batch size");
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;
  let stopping = false;
  let nextRetentionAt = 0;
  let nextActorRetryAt = 0;
  const tick = () => {
    if (running || stopping) return;
    running = (async () => {
      if ((await readSlackIngressRollout(input.db)).mode !== "verified_active") return;
      const retryAt = input.now();
      if (retryAt.getTime() >= nextActorRetryAt) {
        const requeued = await requeueDueSlackActor({ db: input.db, registrationId: input.scope.registrationId,
          environment: input.scope.environment, now: retryAt });
        // Drain due authors promptly, but do not scan the held queue at every
        // 250ms ingress tick when there is nothing to retry.
        nextActorRetryAt = retryAt.getTime() + (requeued ? 1_000 : 30_000);
      }
      let claims: Awaited<ReturnType<typeof claimSlackVerifiedIngressHeads>>;
      try {
        claims = await claimSlackVerifiedIngressHeads({ db: input.db, leaseOwner: input.leaseOwner,
          leaseMs: input.leaseMs, now: input.now, scope: input.scope, limit: batchSize });
      } catch (error) {
        if (error instanceof SlackIngressRolloutUnavailable && (error.reason === "paused" || error.reason === "not_enabled")) return;
        throw error;
      }
      // fanout-ok: claimSlackVerifiedIngressHeads enforces the validated batchSize maximum of 16.
      const results = await Promise.allSettled(claims.map(claim => processVerifiedSlackIngressOnce({ ...input, claim })));
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      const at = input.now();
      if (at.getTime() >= nextRetentionAt) {
        const count = await compactTerminalSlackIngress({ db: input.db, now: at,
          registrationId: input.scope.registrationId, environment: input.scope.environment });
        const erased = await expireQuarantinedSlackIngress({ db: input.db, now: at,
          registrationId: input.scope.registrationId, environment: input.scope.environment });
        const expiredDedupe = await expireSlackIngressDedupe({ db: input.db, now: at,
          registrationId: input.scope.registrationId, environment: input.scope.environment });
        const expiredSignals = await expireSlackAuthorWakeSignals({ db: input.db, now: at, registrationId: input.scope.registrationId });
        nextRetentionAt = at.getTime() + (count === 50 || erased === 50 || expiredDedupe === 50 || expiredSignals === 50 ? 1_000 : 60 * 60_000);
      }
      if (errors.length) throw new AggregateError(errors, "Slack verified ingress batch failed");
    })().then(() => undefined, (error: unknown) => {
      if (!stopping) {
        try { input.onError(error); }
        catch (reportingError) { console.error("Slack verified ingress error reporter failed", reportingError); }
      }
    }).finally(() => { running = null; });
  };
  return {
    start() {
      if (timer) return;
      stopping = false;
      tick();
      timer = setClockInterval(tick, intervalMs) as ReturnType<typeof setInterval>;
      timer.unref?.();
    },
    async stop() {
      stopping = true;
      if (timer) clearClockInterval(timer);
      timer = null;
      await running;
    },
    tick,
  };
}
