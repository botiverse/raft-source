import { and, eq, inArray, sql } from "drizzle-orm";
import { currentDate, type ActionCardAction, type ActionCardMetadata } from "@botiverse/raft-shared";
import { type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import { assertActionCardNotExpired, type ActionCardPreparedFacts } from "./actionCardExpiry";
import { withStoredActionCardSpec } from "./actionCardPresentation";
import {
  actionCards,
  channels,
  channelConversionJobs,
  messages,
} from "../db/schema";
import {
  assertChannelConversionWritable,
  getActiveChannelConversionFence,
  lockActionCardScope,
  resolveChannelConversionLockTarget,
} from "./channelConversionFenceService";

/** The schema arms are intentionally closed. Unknown future cards must
 * fail closed at the execution boundary until they get a conversion policy. */
export const ACTION_CARD_CONVERSION_SCHEMA_POLICY: {
  [K in ActionCardAction["type"]]: "live" | "legacy_disabled";
} = {
  "channel:create": "live",
  "agent:create": "live",
  // As agent:create: the migration dialog's own route runs it, after a reconfirm like any other card.
  "agent:migrate": "live",
  "channel:add_member": "live",
  "integration:approve_agent_login": "live",
  "integration:install_marketplace_app": "live",
  "integration:register_app": "live",
  "integration:update_app_registration": "legacy_disabled",
  "integration:recover_app_owner": "live",
  // Fail-closed until someone decides what channel conversion should do with a pending connection
  // card. This file's own rule: "Unknown future cards must fail closed at the execution boundary
  // until they get a conversion policy." Marking it live to make a typecheck pass would be exactly
  // the silent widening that rule exists to prevent.
  "integration:connect_mcp": "legacy_disabled",
  "feedback:submit": "live",
  // No execution boundary to fail closed: the card only opens the upgrade
  // dialog. It freezes and asks for reconfirmation like any other card.
  "plan:upgrade": "live",
  // Nothing leaves Raft when it is answered (its form handler records the
  // answers): it freezes and asks for reconfirmation like any other card.
  "question:ask": "live",
};

export const ACTION_CARD_CONVERSION_SCHEMA_TYPES = Object.freeze(
  Object.keys(ACTION_CARD_CONVERSION_SCHEMA_POLICY) as ActionCardAction["type"][],
);

/** Test-only production-path mutation switches used by the conversion
 * contract. They are intentionally injected at the service boundary so the
 * witness exercises route/service/transaction behavior rather than a source
 * string assertion. */
export type ActionCardConversionMutationForTest =
  | "execute_fence_bypass"
  | "regular_writer_fence_bypass"
  | "failed_retry_unfreeze"
  | "confirmation_gate_bypass"
  | "execute_audit_lock_split"
  | "execute_source_lock_bypass"
  | "register_app_pre_guard";

let actionCardConversionMutationForTest: ActionCardConversionMutationForTest | null = null;
let beforeLockedConfirmationReadForTest:
  | ((tx: DatabaseExecutor, messageId: string) => Promise<void>)
  | null = null;
let betweenActionCardFreezeReadAndWriteForTest: (() => Promise<void>) | null = null;

const actionCardSourceLockAuthorityBrand: unique symbol = Symbol("action-card-source-lock-authority");

export type ActionCardSourceLockAuthority = {
  readonly [actionCardSourceLockAuthorityBrand]: true;
  readonly serverId: string;
  readonly sourceChannelId: string;
};

function sourceLockAuthorityCovers(
  authority: ActionCardSourceLockAuthority | undefined,
  target: { serverId: string; sourceChannelId: string },
): boolean {
  return authority?.serverId === target.serverId
    && authority.sourceChannelId === target.sourceChannelId;
}

function sourceLockAuthorityForTarget(target: {
  serverId: string;
  sourceChannelId: string;
}): ActionCardSourceLockAuthority {
  return {
    [actionCardSourceLockAuthorityBrand]: true,
    serverId: target.serverId,
    sourceChannelId: target.sourceChannelId,
  };
}

export function setActionCardConversionMutationForTest(
  mutation: ActionCardConversionMutationForTest | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("action-card conversion mutation hooks are test-only");
  }
  actionCardConversionMutationForTest = mutation;
}

export function isActionCardConversionMutationForTest(
  mutation: ActionCardConversionMutationForTest,
): boolean {
  return actionCardConversionMutationForTest === mutation;
}

export function setBeforeLockedActionCardConfirmationReadForTest(
  hook: ((tx: DatabaseExecutor, messageId: string) => Promise<void>) | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("action-card confirmation hooks are test-only");
  }
  beforeLockedConfirmationReadForTest = hook;
}

/**
 * Runs inside a conversion's freeze, after it read the cards it freezes and
 * before it writes them: where a withdraw or an expiry would land if it did
 * not wait for the source lock (actionCardFormSubmit.realPg.test.ts).
 */
export function setBetweenActionCardFreezeReadAndWriteForTest(hook: (() => Promise<void>) | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("action-card conversion hooks are test-only");
  }
  betweenActionCardFreezeReadAndWriteForTest = hook;
}

export class ActionCardConversionFrozenError extends Error {
  readonly status = 409 as const;
  readonly code = "action_card_conversion_frozen" as const;

  constructor(public readonly conversionEpoch: string | null = null) {
    super("This action card is frozen while channel conversion is active; retry after conversion completes.");
    this.name = "ActionCardConversionFrozenError";
  }
}

export class ActionCardReconfirmationRequiredError extends Error {
  readonly status = 409 as const;
  readonly code = "action_card_reconfirmation_required" as const;

  constructor() {
    super("Confirm this action card again before it runs. Other servers connected to this channel after it was created.");
    this.name = "ActionCardReconfirmationRequiredError";
  }
}

/**
 * Converted cards carry a durable confirmation credential.  A caller that
 * omits that credential is not allowed to fall back to the pre-conversion
 * execution contract; this is deliberately distinct from a stale credential
 * so clients can refresh/reconfirm instead of retrying blindly.
 */
export class ActionCardConfirmationRequiredError extends Error {
  readonly status = 409 as const;
  readonly code = "CONFIRMATION_VERSION_REQUIRED" as const;

  constructor() {
    super("This action card requires its current confirmation version after channel conversion; reconfirm the card and retry.");
    this.name = "ActionCardConfirmationRequiredError";
  }
}

export class ActionCardConfirmationVersionMismatchError extends Error {
  readonly status = 409 as const;
  readonly code = "CONFIRMATION_VERSION_MISMATCH" as const;

  constructor() {
    super("This action card confirmation is stale; reconfirm the card and retry.");
    this.name = "ActionCardConfirmationVersionMismatchError";
  }
}

/** A card-writability refusal from assertActionCardWritable*: an expected 409, not a server fault. */
export type ActionCardConversionError =
  | ActionCardConversionFrozenError
  | ActionCardReconfirmationRequiredError
  | ActionCardConfirmationRequiredError
  | ActionCardConfirmationVersionMismatchError;

export function isActionCardConversionError(err: unknown): err is ActionCardConversionError {
  return err instanceof ActionCardConversionFrozenError
    || err instanceof ActionCardReconfirmationRequiredError
    || err instanceof ActionCardConfirmationRequiredError
    || err instanceof ActionCardConfirmationVersionMismatchError;
}

export type ConversionActionCardJob = {
  id: string;
  serverId: string;
  sourceChannelId: string;
  conversionEpoch: string;
};

export type ActionCardConversionContext = {
  sourceChannelId: string;
  serverId: string;
  conversionJobId: string | null;
  conversionEpoch: string | null;
  freezeState: "ready" | "frozen" | "reconfirm_required";
  confirmationVersion: number;
};

function cardMetadataWithState(
  raw: unknown,
  state: "prepared" | "executed" | "frozen" | "reconfirm_required",
  extra: Record<string, unknown> = {},
): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const metadata = raw as Record<string, unknown>;
  if (metadata.kind !== "action-card") return raw;
  const next: Record<string, unknown> = { ...metadata, state, ...extra };
  // Cancellation restores the pre-conversion card contract.  Do not leave
  // stale job/epoch credentials in the carrier metadata: a subsequent
  // conversion must bind a fresh epoch and an old receipt must not look like
  // the card is still attached to a canceled job.
  if (state === "prepared") {
    delete next.conversionJobId;
    delete next.conversionEpoch;
  }
  return next;
}

async function actionCardScopeRows(tx: DatabaseExecutor, sourceChannelId: string) {
  const rows = await tx.execute(sql`
    SELECT
      card.id::text AS "cardId",
      card.message_id::text AS "messageId",
      card.action_type::text AS "actionType",
      card.freeze_state::text AS "freezeState",
      card.state::text AS "state",
      message.action_metadata AS "actionMetadata"
    FROM action_cards card
    JOIN messages message ON message.id = card.message_id
    LEFT JOIN channels carrier ON carrier.id = message.channel_id
    LEFT JOIN messages parent_message ON parent_message.id = carrier.parent_message_id
    WHERE card.state = 'prepared'
      AND (
        message.channel_id = ${sourceChannelId}
        OR (carrier.type = 'thread' AND parent_message.channel_id = ${sourceChannelId})
        OR (card.action_type = 'channel:add_member' AND message.action_metadata->'action'->>'channel' = ${sourceChannelId})
      )
    ORDER BY card.created_at, card.id
  `);
  return rows.rows as Array<{
    cardId: string;
    messageId: string;
    actionType: string;
    freezeState: string;
    state: string;
    actionMetadata: unknown;
  }>;
}

/** Freeze all prepared executable cards before the first conversion phase. */
export async function freezeActionCardsForConversion(
  tx: DatabaseExecutor,
  job: ConversionActionCardJob,
): Promise<number> {
  const rows = await actionCardScopeRows(tx, job.sourceChannelId);
  await betweenActionCardFreezeReadAndWriteForTest?.();
  let changed = 0;
  for (const row of rows) {
    if (row.freezeState !== "ready" && row.freezeState !== "frozen") continue;
    await tx.update(actionCards).set({
      conversionJobId: job.id,
      conversionSourceChannelId: job.sourceChannelId,
      conversionEpoch: job.conversionEpoch,
      freezeState: "frozen",
      updatedAt: currentDate(),
    }).where(and(eq(actionCards.id, row.cardId), eq(actionCards.state, "prepared")));
    await tx.update(messages).set({
      actionMetadata: cardMetadataWithState(row.actionMetadata, "frozen", {
        conversionJobId: job.id,
        conversionEpoch: job.conversionEpoch,
      }),
      updatedAt: currentDate(),
    }).where(eq(messages.id, row.messageId));
    changed += 1;
  }
  return changed;
}

/** Successful cutover retires the old confirmation/idempotency credential. */
export async function requireActionCardReconfirmationAfterCutover(
  tx: DatabaseExecutor,
  job: ConversionActionCardJob,
): Promise<number> {
  const rows = await tx.select({
    id: actionCards.id,
    messageId: actionCards.messageId,
    actionMetadata: messages.actionMetadata,
  }).from(actionCards).innerJoin(messages, eq(messages.id, actionCards.messageId)).where(and(
    eq(actionCards.conversionJobId, job.id),
    eq(actionCards.conversionEpoch, job.conversionEpoch),
    eq(actionCards.state, "prepared"),
    inArray(actionCards.freezeState, ["frozen", "ready"]),
  ));
  for (const row of rows) {
    await tx.update(actionCards).set({
      freezeState: "reconfirm_required",
      confirmationVersion: sql`${actionCards.confirmationVersion} + 1`,
      updatedAt: currentDate(),
    }).where(and(eq(actionCards.id, row.id), eq(actionCards.state, "prepared")));
    await tx.update(messages).set({
      actionMetadata: cardMetadataWithState(row.actionMetadata, "reconfirm_required", {
        conversionJobId: job.id,
        conversionEpoch: job.conversionEpoch,
      }),
      updatedAt: currentDate(),
    }).where(eq(messages.id, row.messageId));
  }
  return rows.length;
}

/** Explicit cancellation is the only path that reopens the old card. */
export async function unfreezeActionCardsAfterCancellation(
  tx: DatabaseExecutor,
  job: ConversionActionCardJob,
): Promise<number> {
  const rows = await tx.select({
    id: actionCards.id,
    messageId: actionCards.messageId,
    actionMetadata: messages.actionMetadata,
  }).from(actionCards).innerJoin(messages, eq(messages.id, actionCards.messageId)).where(and(
    eq(actionCards.conversionJobId, job.id),
    eq(actionCards.conversionEpoch, job.conversionEpoch),
    eq(actionCards.state, "prepared"),
    eq(actionCards.freezeState, "frozen"),
  ));
  for (const row of rows) {
    await tx.update(actionCards).set({
      conversionJobId: null,
      conversionSourceChannelId: null,
      conversionEpoch: null,
      freezeState: "ready",
      updatedAt: currentDate(),
    }).where(eq(actionCards.id, row.id));
    await tx.update(messages).set({
      actionMetadata: cardMetadataWithState(row.actionMetadata, "prepared"),
      updatedAt: currentDate(),
    }).where(eq(messages.id, row.messageId));
  }
  return rows.length;
}

/** Resolve the source channel for a card before conversion starts. */
export async function resolveActionCardSourceChannelId(
  tx: DatabaseExecutor,
  carrierChannelId: string,
): Promise<string | null> {
  const result = await tx.execute(sql`
    SELECT CASE
      WHEN carrier.type = 'thread' THEN parent_message.channel_id::text
      ELSE carrier.id::text
    END AS "sourceChannelId"
    FROM channels carrier
    LEFT JOIN messages parent_message ON parent_message.id = carrier.parent_message_id
    WHERE carrier.id = ${carrierChannelId}
    LIMIT 1
  `);
  const row = result.rows[0] as { sourceChannelId?: unknown } | undefined;
  return typeof row?.sourceChannelId === "string" ? row.sourceChannelId : null;
}

/**
 * Same-transaction execution/dialog/regular-writer gate. `serverId` is the
 * request's server: a card that acts on another server (action_cards.server_id)
 * is refused exactly like a missing card, so a caller cannot probe the state of
 * another server's card by its message id.
 */
export async function assertActionCardWritableInTransaction(
  tx: DatabaseExecutor,
  serverId: string,
  messageId: string,
  expectedConfirmationVersion?: number,
  options: {
    activeFenceError?: "action_card" | "conversion";
    sourceLockAuthority?: ActionCardSourceLockAuthority;
  } = {},
): Promise<{ cardId: string; confirmationVersion: number }> {
  const [initial] = await tx.select({
    id: actionCards.id,
    sourceChannelId: actionCards.conversionSourceChannelId,
    conversionEpoch: actionCards.conversionEpoch,
    serverId: actionCards.serverId,
    carrierChannelId: messages.channelId,
  }).from(actionCards).innerJoin(messages, eq(messages.id, actionCards.messageId)).where(and(eq(actionCards.messageId, messageId), eq(actionCards.serverId, serverId))).limit(1);
  if (!initial) throw new ActionCardConversionFrozenError();
  const target = initial.sourceChannelId
    ? { serverId: initial.serverId, sourceChannelId: initial.sourceChannelId }
    : await resolveChannelConversionLockTarget(tx, initial.carrierChannelId);
  if (target && !sourceLockAuthorityCovers(options.sourceLockAuthority, target)) {
    await lockActionCardScope(tx, target.serverId, target.sourceChannelId);
  }

  // Re-read every card field after the canonical lock.  In particular,
  // conversion start can bind/freeze a previously unbound card while this
  // request is waiting on the advisory lock.
  const [row] = await tx.select({
    id: actionCards.id,
    state: actionCards.state,
    freezeState: actionCards.freezeState,
    confirmationVersion: actionCards.confirmationVersion,
    sourceChannelId: actionCards.conversionSourceChannelId,
    conversionEpoch: actionCards.conversionEpoch,
    conversionJobId: actionCards.conversionJobId,
    serverId: actionCards.serverId,
    carrierChannelId: messages.channelId,
  }).from(actionCards).innerJoin(messages, eq(messages.id, actionCards.messageId)).where(and(eq(actionCards.messageId, messageId), eq(actionCards.serverId, serverId))).limit(1);
  if (!row) throw new ActionCardConversionFrozenError();
  if (target && row.sourceChannelId && row.sourceChannelId !== target.sourceChannelId) {
    throw new ActionCardConversionFrozenError(row.conversionEpoch);
  }
  const fenceBypass = (actionCardConversionMutationForTest === "execute_fence_bypass" && options.activeFenceError === "conversion")
    || (actionCardConversionMutationForTest === "regular_writer_fence_bypass" && options.activeFenceError === undefined);
  if (row.freezeState === "frozen" && !fenceBypass) {
    throw new ActionCardConversionFrozenError(row.conversionEpoch);
  }
  if (row.freezeState === "reconfirm_required") throw new ActionCardReconfirmationRequiredError();
  if (row.state !== "prepared") throw new ActionCardConversionFrozenError(row.conversionEpoch);
  const requiresConfirmation = row.conversionJobId !== null && row.confirmationVersion > 1;
  if (requiresConfirmation && expectedConfirmationVersion === undefined && actionCardConversionMutationForTest !== "confirmation_gate_bypass") {
    throw new ActionCardConfirmationRequiredError();
  }
  if (expectedConfirmationVersion !== undefined && row.confirmationVersion !== expectedConfirmationVersion && actionCardConversionMutationForTest !== "confirmation_gate_bypass") {
    throw new ActionCardConfirmationVersionMismatchError();
  }
  if (target) {
    const fence = await getActiveChannelConversionFence(tx, target.sourceChannelId);
    if (fence) {
      if (options.activeFenceError === "conversion" && !fenceBypass) {
        await assertChannelConversionWritable(target.sourceChannelId, tx);
      }
      // Action-card callers need the card-specific typed boundary.  The
      // underlying conversion fence is intentionally not surfaced as the
      // generic channel-write error here: regular dialog writers and direct
      // card execution share this gate and must both report a frozen card.
      if (!fenceBypass) {
        throw new ActionCardConversionFrozenError(fence.conversionEpoch);
      }
    }
    // Retained active jobs without a fence are a migration/repair fault.  The
    // foundation writer guard still fails closed instead of allowing a card
    // side effect through that ambiguous window.
    if (!fenceBypass) {
      await assertChannelConversionWritable(target.sourceChannelId, tx);
    }
  }
  return { cardId: row.id, confirmationVersion: row.confirmationVersion };
}

/**
 * Validate only the confirmation credential under the canonical conversion
 * lock.  This is used by idempotent execute/mark paths too, so an old client
 * cannot turn a converted card into an unguarded no-op that hides a missing or
 * stale credential from the route/service contract.
 */
export async function assertActionCardConfirmationInTransaction(
  tx: DatabaseExecutor,
  messageId: string,
  expectedConfirmationVersion?: number,
  options: { sourceLockAuthority?: ActionCardSourceLockAuthority } = {},
): Promise<number> {
  const [initial] = await tx.select({
    sourceChannelId: actionCards.conversionSourceChannelId,
    serverId: actionCards.serverId,
    carrierChannelId: messages.channelId,
  }).from(actionCards).innerJoin(messages, eq(messages.id, actionCards.messageId)).where(eq(actionCards.messageId, messageId)).limit(1);
  if (!initial) throw new ActionCardConversionFrozenError();
  const target = initial.sourceChannelId
    ? { serverId: initial.serverId, sourceChannelId: initial.sourceChannelId }
    : await resolveChannelConversionLockTarget(tx, initial.carrierChannelId);
  if (target && !sourceLockAuthorityCovers(options.sourceLockAuthority, target)) {
    await lockActionCardScope(tx, target.serverId, target.sourceChannelId);
  }
  await beforeLockedConfirmationReadForTest?.(tx, messageId);
  const [row] = await tx.select({
    sourceChannelId: actionCards.conversionSourceChannelId,
    conversionJobId: actionCards.conversionJobId,
    confirmationVersion: actionCards.confirmationVersion,
  }).from(actionCards).where(eq(actionCards.messageId, messageId)).limit(1);
  if (!row) throw new ActionCardConversionFrozenError();
  const requiresConfirmation = row.conversionJobId !== null && row.confirmationVersion > 1;
  if (requiresConfirmation && expectedConfirmationVersion === undefined && actionCardConversionMutationForTest !== "confirmation_gate_bypass") {
    throw new ActionCardConfirmationRequiredError();
  }
  if (expectedConfirmationVersion !== undefined && row.confirmationVersion !== expectedConfirmationVersion && actionCardConversionMutationForTest !== "confirmation_gate_bypass") {
    throw new ActionCardConfirmationVersionMismatchError();
  }
  return row.confirmationVersion;
}

/** Acquire the one canonical source lock for direct action-card execution. */
export async function lockActionCardSourceInTransaction(
  tx: DatabaseExecutor,
  messageId: string,
): Promise<ActionCardSourceLockAuthority | undefined> {
  const [initial] = await tx.select({
    sourceChannelId: actionCards.conversionSourceChannelId,
    serverId: actionCards.serverId,
    carrierChannelId: messages.channelId,
  }).from(actionCards).innerJoin(messages, eq(messages.id, actionCards.messageId)).where(eq(actionCards.messageId, messageId)).limit(1);
  if (!initial) throw new ActionCardConversionFrozenError();
  const target = initial.sourceChannelId
    ? { serverId: initial.serverId, sourceChannelId: initial.sourceChannelId }
    : await resolveChannelConversionLockTarget(tx, initial.carrierChannelId);
  if (!target) return undefined;
  if (isActionCardConversionMutationForTest("execute_source_lock_bypass")) {
    return sourceLockAuthorityForTarget(target);
  }
  await lockActionCardScope(tx, target.serverId, target.sourceChannelId);
  return sourceLockAuthorityForTarget(target);
}

export async function assertActionCardWritable(serverId: string, messageId: string, confirmationVersion?: number): Promise<void> {
  const { getDb } = await import("../db/index");
  await getDb().transaction(async (tx) => {
    await assertActionCardWritableInTransaction(tx, serverId, messageId, confirmationVersion);
  });
}

export async function getActionCardConversionContext(
  tx: DatabaseExecutor,
  messageId: string,
): Promise<ActionCardConversionContext | null> {
  const [row] = await tx.select({
    sourceChannelId: actionCards.conversionSourceChannelId,
    serverId: actionCards.serverId,
    conversionJobId: actionCards.conversionJobId,
    conversionEpoch: actionCards.conversionEpoch,
    freezeState: actionCards.freezeState,
    confirmationVersion: actionCards.confirmationVersion,
  }).from(actionCards).where(eq(actionCards.messageId, messageId)).limit(1);
  if (!row || !row.sourceChannelId) return null;
  return row as ActionCardConversionContext;
}

/** Re-open a card only after a human explicitly confirms it in Joint view. */
export async function reconfirmActionCard(
  tx: DatabaseTransaction,
  args: { messageId: string; userId: string },
): Promise<{ metadata: ActionCardMetadata; confirmationVersion: number; card: ActionCardPreparedFacts }> {
  const [row] = await tx.select({
    id: actionCards.id,
    state: actionCards.state,
    freezeState: actionCards.freezeState,
    sourceChannelId: actionCards.conversionSourceChannelId,
    serverId: actionCards.serverId,
    actionMetadata: messages.actionMetadata,
  }).from(actionCards).innerJoin(messages, eq(messages.id, actionCards.messageId)).where(eq(actionCards.messageId, args.messageId)).limit(1);
  if (!row) throw new ActionCardConversionFrozenError();
  if (!row.sourceChannelId) throw new ActionCardConversionFrozenError();

  // Reconfirmation is a writer, so the conversion lock must be acquired
  // before any authority/fence decision is trusted.  A conversion can release
  // its fence between an unlocked read and the update otherwise, reviving a
  // stale confirmation in the old transaction window.
  await lockActionCardScope(tx, row.serverId, row.sourceChannelId);

  const [fresh] = await tx.select({
    id: actionCards.id,
    state: actionCards.state,
    freezeState: actionCards.freezeState,
    sourceChannelId: actionCards.conversionSourceChannelId,
    conversionEpoch: actionCards.conversionEpoch,
    actionType: actionCards.actionType,
    requesterUserId: actionCards.requesterUserId,
    createdAt: actionCards.createdAt,
    actionMetadata: messages.actionMetadata,
  }).from(actionCards).innerJoin(messages, eq(messages.id, actionCards.messageId)).where(eq(actionCards.messageId, args.messageId)).limit(1);
  if (!fresh || fresh.sourceChannelId !== row.sourceChannelId) throw new ActionCardConversionFrozenError();
  if (fresh.freezeState !== "reconfirm_required") throw new ActionCardConversionFrozenError();
  // Confirming again would only re-open a card no path may complete any more.
  if (fresh.state === "prepared") assertActionCardNotExpired(fresh);
  const [source] = await tx.select({ type: channels.type }).from(channels).where(eq(channels.id, fresh.sourceChannelId)).limit(1);
  if (!source || source.type !== "joint") throw new ActionCardConversionFrozenError();
  const fence = await getActiveChannelConversionFence(tx, fresh.sourceChannelId);
  if (fence) throw new ActionCardConversionFrozenError(fence.conversionEpoch);
  const [updated] = await tx.update(actionCards).set({
    freezeState: "ready",
    confirmationVersion: sql`${actionCards.confirmationVersion} + 1`,
    reconfirmedAt: currentDate(),
    reconfirmedByUserId: args.userId,
    updatedAt: currentDate(),
  }).where(and(eq(actionCards.id, row.id), eq(actionCards.freezeState, "reconfirm_required"))).returning({ confirmationVersion: actionCards.confirmationVersion });
  if (!updated) throw new ActionCardReconfirmationRequiredError();
  // A card stored before cards carried `presentation.card` gets one here, like any read of it.
  const metadata = withStoredActionCardSpec(cardMetadataWithState(fresh.actionMetadata, "prepared", {
    reconfirmedAt: currentDate().toISOString(),
    confirmationVersion: updated.confirmationVersion,
  })) as ActionCardMetadata;
  await tx.update(messages).set({ actionMetadata: metadata, updatedAt: currentDate() }).where(eq(messages.id, args.messageId));
  // What the route serves the card with (servedActionCardMetadata); never stored.
  return { metadata, confirmationVersion: updated.confirmationVersion, card: { createdAt: fresh.createdAt, requesterUserId: fresh.requesterUserId } };
}
