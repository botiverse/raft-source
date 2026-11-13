// Row-lock rule for every Slack Bridge / external-app transaction:
//
// 0. When proving or mutating conversation-pair existence, acquire the stable
//    registration/workspace/conversation advisory locks first, in sorted order.
//    Do not hold ingress partition, install, or binding rows while acquiring them.
//    This rule is effective only after all writers honor it or a database fence
//    enforces it; old instances cannot participate by convention alone.
//    OAuth/provisioning first fence the requesting manager consistently, before
//    any install or shared authority row. OAuth's server SHARE fence blocks
//    soft deletion while remaining compatible with concurrent FK KEY SHARE.
// 1. Lock the install row first. It guards the rows that belong to it
//    (bindings, credentials, install server grants, grant receipts): two
//    transactions on one install queue on the install row before either holds
//    anything else, so the order of the rows after it cannot deadlock. New
//    binding/credential rows remain install-scoped; shared rows follow rule 2.
// 2. The registration row is shared by every install of one Slack app: lock
//    it only after an install, never before one; it must precede every server
//    grant row. Different installs can share one server grant, so an install
//    lock alone cannot prevent a registration/server-grant lock cycle.
// 3. One table per `select ... for update`. A join `FOR UPDATE` locks its
//    tables in whatever order the plan produces rows, and the planner may
//    change that order.
// 4. Several rows of one table: `ORDER BY id`.
// 5. One install per transaction. Rule 1 only holds while a transaction locks
//    a single install. A `db.transaction` opened inside an ambient one joins it
//    as a SAVEPOINT, so a credential claim or provider call made from inside
//    another transaction adds that install to the outer one. Make provider
//    calls outside transactions (the drain does: audience refresh, privacy
//    refresh and grant renewal resolve credentials before or after theirs);
//    work that must touch several installs at once locks them `ORDER BY id`.
//
// Prod 2026-10-18/20 (#proj-o11y:058cb07b): the lifecycle drain on 12 tasks
// claimed a credential lease with `credentials JOIN installs FOR UPDATE`
// (credential, then install) while another task's install-grant renewal held
// the install and waited for the credential: 40P01 every few drains.
import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

import type { DatabaseTransaction } from "../db/index";
import { externalAppCredentials, externalAppInstalls, externalChannelBindings } from "../db/schema";

export interface SlackConversationLockKey {
  registrationId: string;
  providerAuthorityId: string;
  providerConversationId: string;
}

/** Stable and domain-separated across install generations; exported for the real-PG concurrency test. */
export function slackConversationAdvisoryKey(key: SlackConversationLockKey): bigint {
  const fields = [key.registrationId, key.providerAuthorityId, key.providerConversationId];
  if (fields.some((value) => typeof value !== "string" || !value.trim()
    || Buffer.byteLength(value, "utf8") > 320 || /[\r\n\0]/u.test(value))) {
    throw new Error("Invalid Slack conversation lock coordinates");
  }
  const digest = createHash("sha256").update("slack-conversation-existence-v1\0", "utf8");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    digest.update(length).update(bytes);
  }
  return digest.digest().readBigInt64BE(0);
}

/** Acquire all stable keys in one deterministic order before any related row lock. */
export async function lockSlackConversations(tx: DatabaseTransaction, keys: readonly SlackConversationLockKey[]): Promise<void> {
  const sorted = [...new Set(keys.map((key) => slackConversationAdvisoryKey(key).toString()))]
    .map((value) => BigInt(value)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  for (const key of sorted) await tx.execute(sql`SELECT pg_advisory_xact_lock(${key.toString()}::bigint)`);
}

/** A discovered conversation set changed before the install lock was obtained. */
export class SlackInstallLockSetChanged extends Error {
  constructor() { super("Slack install conversation lock set changed"); }
}

/**
 * Administrative operations may change every live binding of an install.
 * Discover without locks, lock stable conversations before the install, then
 * re-read under its row lock. A new/moved binding requires a fresh transaction,
 * never another conversation lock acquired while holding the install.
 */
export async function lockSlackInstallConversations(tx: DatabaseTransaction, installId: string) {
  const [candidate] = await tx.select().from(externalAppInstalls)
    .where(eq(externalAppInstalls.id, installId)).limit(1);
  if (!candidate) throw new SlackInstallLockSetChanged();
  const liveBindings = and(eq(externalChannelBindings.installId, installId),
    inArray(externalChannelBindings.state, ["active", "paused", "quarantined"]));
  const discovered = await tx.select().from(externalChannelBindings).where(liveBindings)
    .orderBy(externalChannelBindings.id);
  await lockSlackConversations(tx, discovered.map(binding => ({ registrationId: candidate.registrationId,
    providerAuthorityId: candidate.providerAuthorityId, providerConversationId: binding.providerConversationId })));
  const [install] = await tx.select().from(externalAppInstalls)
    .where(eq(externalAppInstalls.id, installId)).limit(1).for("update");
  if (!install || install.registrationId !== candidate.registrationId
    || install.providerAuthorityId !== candidate.providerAuthorityId) throw new SlackInstallLockSetChanged();
  const bindings = await tx.select().from(externalChannelBindings).where(liveBindings)
    .orderBy(externalChannelBindings.id).for("update");
  if (bindings.length !== discovered.length || bindings.some((binding, index) =>
    binding.id !== discovered[index]!.id || binding.providerConversationId !== discovered[index]!.providerConversationId)) {
    throw new SlackInstallLockSetChanged();
  }
  return { install, bindings };
}

export interface SlackCredentialLockRequest {
  installId: string;
  providerAppId: string;
  providerAuthorityId: string;
  connectionEpoch: number;
  credentialRevision: number;
  binding?: { bindingId: string; bindingEpoch: number; providerConversationId: string };
}

export interface LockedSlackCredential {
  install: typeof externalAppInstalls.$inferSelect;
  binding: typeof externalChannelBindings.$inferSelect | null;
  credential: typeof externalAppCredentials.$inferSelect;
}

/**
 * Lock the install, the binding (when asked) and the one claimable credential,
 * in that order. Null unless each matches exactly once: the same rows the old
 * `credentials JOIN installs [JOIN bindings]` select accepted.
 */
export async function lockSlackInstallCredential(
  tx: DatabaseTransaction,
  request: SlackCredentialLockRequest,
  requestedAt: Date,
): Promise<LockedSlackCredential | null> {
  const [install, extraInstall] = await tx.select().from(externalAppInstalls).where(and(
    eq(externalAppInstalls.id, request.installId),
    eq(externalAppInstalls.state, "active"),
    eq(externalAppInstalls.providerAppId, request.providerAppId),
    eq(externalAppInstalls.providerAuthorityId, request.providerAuthorityId),
    eq(externalAppInstalls.connectionEpoch, request.connectionEpoch),
    eq(externalAppInstalls.credentialRevision, request.credentialRevision),
  )).limit(2).for("update");
  if (!install || extraInstall) return null;

  let binding: LockedSlackCredential["binding"] = null;
  if (request.binding) {
    const [row, extraBinding] = await tx.select().from(externalChannelBindings).where(and(
      eq(externalChannelBindings.id, request.binding.bindingId),
      eq(externalChannelBindings.installId, install.id),
      eq(externalChannelBindings.state, "active"),
      eq(externalChannelBindings.providerConversationId, request.binding.providerConversationId),
      eq(externalChannelBindings.connectionEpoch, request.connectionEpoch),
      eq(externalChannelBindings.bindingEpoch, request.binding.bindingEpoch),
    )).limit(2).for("update");
    if (!row || extraBinding) return null;
    binding = row;
  }

  const [credential, extraCredential] = await tx.select().from(externalAppCredentials).where(and(
    eq(externalAppCredentials.installId, install.id),
    eq(externalAppCredentials.state, "active"),
    eq(externalAppCredentials.credentialRevision, request.credentialRevision),
    or(isNull(externalAppCredentials.expiresAt), gt(externalAppCredentials.expiresAt, requestedAt)),
    or(isNull(externalAppCredentials.leaseExpiresAt), lte(externalAppCredentials.leaseExpiresAt, requestedAt)),
  )).orderBy(externalAppCredentials.id).limit(2).for("update");
  if (!credential || extraCredential) return null;
  return { install, binding, credential };
}
