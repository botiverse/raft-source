// The public key an App registers for card SecretInputs (RFC 086 §5.2). It
// lives on the App's link-preview registration (oauth_app_link_previews), next
// to the action endpoint the sealed values travel to, and only the App's own
// Basic client credentials set or remove it (routes/oauth.ts): no session,
// Server admin or agent route reaches these functions. Raft never fetches it
// again by itself. Setting a new key replaces the previous one (rotation);
// deleting or losing the registration removes it. Every change is audited
// with the `kid`, never anything else of the key.
//
// A `kid` names one key for the App's lifetime (Tenny): a new key under any
// `kid` the App has set before is refused, not only under the one in force
// (oauth_app_card_encryption_kids, which outlives the registration). A press
// reads the key twice (the handle read's answer, then the live check's and
// execute lock's `kid`); a reused `kid` would let the two name different keys.
//
// The handle read gives the key to a client beside a SecretInput button's
// handle, which binds its `kid` (messageCardActionRead.ts); prepare, execute
// admission and execute's lock refuse a handle whose `kid` is no longer the
// App's (messageCardLiveState.ts, linkCardLiveState.ts).
import { createPublicKey } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { appCardEncryptionKeyRegistrationSchema, type AppCardEncryptionKey } from "@botiverse/raft-shared/src/appLinkPreview";
import { currentDate } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db";
import { oauthAppCardEncryptionKids, oauthAppLinkPreviews, type oauthClients } from "../db/schema";
import { recordIntegrationAuditEvent } from "./integrationAuditService";

type KeyClient = Pick<typeof oauthClients.$inferSelect, "id" | "clientId" | "serverId">;

export type AppCardEncryptionKeyErrorCode = "INVALID_ENCRYPTION_KEY" | "LINK_PREVIEW_NOT_REGISTERED" | "KID_IN_USE";

export class AppCardEncryptionKeyError extends Error {
  constructor(message: string, readonly status: number, readonly code: AppCardEncryptionKeyErrorCode) { super(message); }
}

export type AppCardEncryptionKeyState = { jwk: AppCardEncryptionKey; kid: string; setAt: Date };

/** Why a key stopped being the App's: the App removed it, deleted its registration, or another App took the origin over. */
export type AppCardEncryptionKeyRemovedReason = "removed" | "registration_deleted" | "taken_over";

/**
 * The JWK as a P-256 public point Node accepts: `createPublicKey` refuses a
 * point that is not on the curve (ERR_CRYPTO_INVALID_JWK). The schema already
 * pinned kty, crv, use, alg, the coordinate lengths and the absence of `d`.
 */
function isP256PublicPoint(jwk: AppCardEncryptionKey): boolean {
  try {
    const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: "jwk" });
    return key.type === "public" && key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch {
    return false;
  }
}

function sameKey(a: AppCardEncryptionKey, b: AppCardEncryptionKey): boolean {
  return a.kid === b.kid && a.x === b.x && a.y === b.y && a.kty === b.kty && a.crv === b.crv && a.use === b.use && a.alg === b.alg;
}

/**
 * Sets the App's card encryption key, replacing any previous one. Needs the
 * App's link-preview registration (409 LINK_PREVIEW_NOT_REGISTERED without
 * one). Repeating the key in force changes nothing and writes no audit event,
 * so a deploy script may PUT it on every start; any other key under a `kid`
 * the App has ever set (the one in force, a rotated or removed one) is refused
 * (409 KID_IN_USE): a rotation names a new `kid`, which is what execute
 * compares. The `kid` is recorded in the same transaction.
 */
export async function setAppCardEncryptionKey(client: KeyClient, raw: unknown): Promise<AppCardEncryptionKeyState> {
  const parsed = appCardEncryptionKeyRegistrationSchema.safeParse(raw);
  // A fixed sentence: never echo what was sent (it may be a private key).
  if (!parsed.success || !isP256PublicPoint(parsed.data.jwk)) {
    throw new AppCardEncryptionKeyError("Invalid card encryption key: expected { jwk } with a P-256 ECDH-ES public key (kty EC, crv P-256, use enc, alg ECDH-ES, kid, x, y) and no other member", 400, "INVALID_ENCRYPTION_KEY");
  }
  const jwk: AppCardEncryptionKey = { kty: "EC", crv: "P-256", use: "enc", alg: "ECDH-ES", kid: parsed.data.jwk.kid, x: parsed.data.jwk.x, y: parsed.data.jwk.y };
  return getDb().transaction(async (tx) => {
    const [row] = await tx.select({ key: oauthAppLinkPreviews.cardEncryptionKey, kid: oauthAppLinkPreviews.cardEncryptionKid, setAt: oauthAppLinkPreviews.cardEncryptionKeySetAt })
      .from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, client.id)).for("update");
    if (!row) {
      throw new AppCardEncryptionKeyError("Register link previews with PUT /api/oauth/link-preview before setting a card encryption key", 409, "LINK_PREVIEW_NOT_REGISTERED");
    }
    if (row.key && row.kid && row.setAt && sameKey(row.key, jwk)) return { jwk: row.key, kid: row.kid, setAt: row.setAt };
    // Under the registration row's lock (FOR UPDATE above), so two sets of the App are ordered; the primary key refuses a duplicate anyway.
    const [used] = await tx.select({ kid: oauthAppCardEncryptionKids.kid }).from(oauthAppCardEncryptionKids)
      .where(and(eq(oauthAppCardEncryptionKids.clientId, client.id), eq(oauthAppCardEncryptionKids.kid, jwk.kid))).limit(1);
    // The kid in force counts too: a key set before the history existed (0712) has no row there.
    if (used || row.kid === jwk.kid) throw new AppCardEncryptionKeyError("A new card encryption key needs a kid this App has never used", 409, "KID_IN_USE");
    const setAt = currentDate();
    // The outgoing kid joins the history too, in case it predates the table (0712): no backfill needed (Tenny).
    if (row.kid) await rememberCardEncryptionKid(tx, client.id, row.kid, row.setAt ?? setAt);
    await tx.insert(oauthAppCardEncryptionKids).values({ clientId: client.id, kid: jwk.kid, firstSetAt: setAt });
    await tx.update(oauthAppLinkPreviews).set({ cardEncryptionKey: jwk, cardEncryptionKid: jwk.kid, cardEncryptionKeySetAt: setAt })
      .where(eq(oauthAppLinkPreviews.clientId, client.id));
    await recordIntegrationAuditEvent({ serverId: client.serverId, clientId: client.id, eventType: "app.card_encryption_key_set", outcome: "success", source: "api",
      actor: { type: "system" }, requester: { type: "app", id: client.id }, target: { type: "app", id: client.id },
      metadata: { clientKey: client.clientId, kid: jwk.kid, ...(row.kid ? { previousKid: row.kid } : {}) } }, tx);
    return { jwk, kid: jwk.kid, setAt };
  });
}

/** Removes the App's card encryption key. True when there was one; removing none (or with no registration) changes nothing. */
export async function removeAppCardEncryptionKey(client: KeyClient): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx.select({ kid: oauthAppLinkPreviews.cardEncryptionKid })
      .from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, client.id)).for("update");
    if (!row?.kid) return false;
    await tx.update(oauthAppLinkPreviews).set({ cardEncryptionKey: null, cardEncryptionKid: null, cardEncryptionKeySetAt: null })
      .where(eq(oauthAppLinkPreviews.clientId, client.id));
    await auditCardEncryptionKeyRemoved(tx, { client, kid: row.kid, reason: "removed", byApp: true });
    return true;
  });
}

/** Records a kid in the App's history if it isn't there yet (a key set before the history table existed). */
async function rememberCardEncryptionKid(tx: DatabaseExecutor, clientId: string, kid: string, at: Date) {
  await tx.insert(oauthAppCardEncryptionKids).values({ clientId, kid, firstSetAt: at }).onConflictDoNothing();
}

/**
 * `app.card_encryption_key_removed`, in the caller's transaction. `byApp`:
 * the App's own credential removed it (itself or with its registration);
 * otherwise the system did (another App took the origin over).
 */
export async function auditCardEncryptionKeyRemoved(
  tx: DatabaseExecutor,
  input: { client: KeyClient; kid: string; reason: AppCardEncryptionKeyRemovedReason; byApp: boolean; correlationId?: string | null },
) {
  const { client } = input;
  // Every removal path comes through here, so a removed kid is remembered even if it predates the history.
  await rememberCardEncryptionKid(tx, client.id, input.kid, currentDate());
  await recordIntegrationAuditEvent({ serverId: client.serverId, clientId: client.id, eventType: "app.card_encryption_key_removed", outcome: "success",
    source: input.byApp ? "api" : "system", actor: { type: "system" }, ...(input.byApp ? { requester: { type: "app" as const, id: client.id } } : {}),
    target: { type: "app", id: client.id }, correlationId: input.correlationId ?? null,
    metadata: { clientKey: client.clientId, kid: input.kid, reason: input.reason } }, tx);
}
