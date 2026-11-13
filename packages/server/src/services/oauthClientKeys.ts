import { eq, sql, type SQL } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { oauthClientKeyAliases, oauthClients, officialAppRegistry } from "../db/schema";
import { RefusalError } from "../lib/refusal";
import { assistantAllowedIntegrationClientId } from "./assistantIntegrations";
import { enforceOAuthClientKeyRenameRate } from "./oauthClientKeyRenameLimits";

// RFC 084 §4: an App's client key resolves to that App, and a key once used is
// never given to another App. Every lookup of an App by its key string goes
// through oauthClientHasKey or resolveOAuthClientByKey, and every registration
// and App deletion through the lock and the check below.

/** Tombstones one Server can reclaim; past this its oldest stay reserved but are no longer its to reuse. */
export const OAUTH_CLIENT_RECLAIMABLE_TOMBSTONES_PER_SERVER = 50;

/** Old ids one App can keep (RFC 084 §5). */
export const OAUTH_CLIENT_MAX_ALIASES = 20;

/** The format of a client key, at registration and at rename. */
export const CLIENT_KEY_REGEX = /^[a-z][a-z0-9-]{2,63}$/;

/** A client id as it is stored (lowercased), or null when it isn't valid. */
export function canonicalClientKey(clientKey: string): string | null {
  const normalized = clientKey.trim().toLowerCase();
  return CLIENT_KEY_REGEX.test(normalized) ? normalized : null;
}

export const LEGACY_OAUTH_SCOPE_ALLOWLIST: Record<string, readonly string[]> = {
  "local-collabdoc-1": ["creator", "owner"],
  "linkerdog-796e47": ["meetings:read"],
  winbox: [
    "winbox:opencli:google",
    "winbox:opencli:nga",
    "winbox:opencli:qixin",
    "winbox:opencli:twitter",
  ],
  "winbox-315c18": [
    "winbox:opencli:nga",
    "winbox:opencli:qixin",
    "winbox:opencli:slock",
    "winbox:opencli:twitter",
    "winbox:opencli:wcl",
    "winbox:python:exec",
  ],
};

/**
 * Keys whose holder is trusted because of the string: LEGACY_OAUTH_SCOPE_ALLOWLIST
 * and REMINDER_APP_CLIENT_ID (RFC 084 §4). Whoever held such a key next would
 * inherit that, so one is always reserved on delete and can't be reused from a
 * tombstone, even by its own Server.
 */
function clientKeyCarriesStringTrust(key: string): boolean {
  return Object.hasOwn(LEGACY_OAUTH_SCOPE_ALLOWLIST, key) || key === assistantAllowedIntegrationClientId();
}

/**
 * The uuid of the App the deployment names as Reminder, or null when it has
 * none. The key resolves through its aliases, so the trust follows the App
 * through a rename while the deployment's setting keeps the old id.
 */
export async function assistantAllowedOAuthClientUuid(env: NodeJS.ProcessEnv = process.env, executor: DatabaseExecutor = getDb()): Promise<string | null> {
  const key = assistantAllowedIntegrationClientId(env);
  if (!key) return null;
  return (await resolveOAuthClientByKey(key, executor))?.id ?? null;
}

/** The App holding `key`: as a current key first, then as an alias. A tombstone holds nothing. */
function keyHolderId(key: string): SQL<string | null> {
  return sql`coalesce(
    (select current_key.id from oauth_clients current_key where current_key.client_id = ${key}),
    (select key_alias.client_id from oauth_client_key_aliases key_alias where key_alias.key = ${key})
  )`;
}

/** The WHERE condition of a lookup by key, for one that needs joins, more conditions or a row lock. */
export function oauthClientHasKey(key: string): SQL {
  return sql`${oauthClients.id} = ${keyHolderId(key)}`;
}

export interface ResolvedOAuthClientKey {
  id: string;
  /** The App's current key, which is `key` unless `matched` is "alias". */
  clientKey: string;
  matched: "current" | "alias";
}

/** One snapshot distinguishes an unknown key from a deleted App's reserved key. */
async function lookupOAuthClientKey(key: string, executor: DatabaseExecutor) {
  const [match] = await executor.select({
    id: sql<string | null>`${oauthClients.id}`,
    clientKey: sql<string | null>`${oauthClients.clientId}`,
  }).from(oauthClients).where(eq(oauthClients.clientId, key))
    .unionAll(executor.select({ id: oauthClientKeyAliases.clientId, clientKey: oauthClients.clientId })
      .from(oauthClientKeyAliases)
      .leftJoin(oauthClients, eq(oauthClients.id, oauthClientKeyAliases.clientId))
      .where(eq(oauthClientKeyAliases.key, key)))
    .limit(1);
  return match;
}

/** The App a client key names, or null: unknown, or a tombstone. */
export async function resolveOAuthClientByKey(key: string, executor: DatabaseExecutor = getDb()): Promise<ResolvedOAuthClientKey | null> {
  const client = await lookupOAuthClientKey(key, executor);
  if (!client?.id || !client.clientKey) return null;
  return { id: client.id, clientKey: client.clientKey, matched: client.clientKey === key ? "current" : "alias" };
}

/** Every id the App answers to: its current key, then its aliases. */
export async function listOAuthClientKeys(client: { id: string; clientId: string }, executor: DatabaseExecutor = getDb()): Promise<string[]> {
  const aliases = await executor.select({ key: oauthClientKeyAliases.key }).from(oauthClientKeyAliases).where(eq(oauthClientKeyAliases.clientId, client.id));
  return [client.clientId, ...aliases.map((alias) => alias.key)];
}

type AgentLoginCandidate = { id: string; clientId: string; name: string };

/**
 * Which of `clients` an agent's `--service` names: its id or current key, then
 * an alias, then its exact name. Keys use their lowercase registration form,
 * as the CLI/SDK's listed-key lookup does. A known key (including a deleted
 * App's tombstone) never falls through to another App's display name.
 */
export async function resolveAgentLoginClient<T extends AgentLoginCandidate>(
  clients: readonly T[],
  rawService: unknown,
): Promise<{ ok: true; client: T } | { ok: false; status: 400 | 404 | 409; error: string; clientKeyMatched?: true }> {
  if (typeof rawService !== "string" || !rawService.trim()) {
    return { ok: false, status: 400, error: "service is required" };
  }

  const service = rawService.trim();
  // Canonicalize only Agent service selection, not OAuth client authentication
  // or the key presented as a token audience.
  const clientKey = canonicalClientKey(service) ?? service;
  const exact = clients.find((client) => client.id === service || client.clientId === service || client.clientId === clientKey);
  if (exact) return { ok: true, client: exact };

  // One statement sees current keys, live aliases and tombstones together.
  // A missing candidate is not permission to reinterpret a key as a name.
  const keyMatch = await lookupOAuthClientKey(clientKey, getDb());
  if (keyMatch) {
    const client = clients.find((candidate) => candidate.id === keyMatch.id);
    return client ? { ok: true, client } : {
      ok: false, status: 404, error: "Registered service not found",
      // Internal only: callers may try other OAuth inventories for the same
      // key, but must not fall back to an unrelated MCP App's display name.
      clientKeyMatched: true,
    };
  }

  const normalized = service.toLowerCase();
  const nameMatches = clients.filter((client) => client.name.toLowerCase() === normalized);
  if (nameMatches.length === 1) return { ok: true, client: nameMatches[0] };
  if (nameMatches.length > 1) {
    return { ok: false, status: 409, error: "Service name is ambiguous; use the service id or client id" };
  }

  return { ok: false, status: 404, error: "Registered service not found" };
}

/** Registration asked for a key that is taken (RFC 084 §4). Routes answer it as `CLIENT_KEY_TAKEN`. */
export class OAuthClientKeyTakenError extends Error {
  constructor() {
    super("Client ID is already taken");
    this.name = "OAuthClientKeyTakenError";
  }
}

/** Held until the transaction ends: registering a key and deleting the App that holds it are ordered on this. */
async function lockOAuthClientKey(tx: DatabaseExecutor, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`oauth-client-key:${key}`}, 0))`);
}

/** What the key's alias row, if any, means for a registration on `serverId`. */
async function aliasRowState(executor: DatabaseExecutor, input: { key: string; serverId: string }): Promise<"none" | "own_tombstone" | "taken"> {
  const [row] = await executor.select({
    clientId: oauthClientKeyAliases.clientId,
    sourceServerId: oauthClientKeyAliases.sourceServerId,
    reclaimable: oauthClientKeyAliases.reclaimable,
  }).from(oauthClientKeyAliases).where(eq(oauthClientKeyAliases.key, input.key)).limit(1);
  if (!row) return "none";
  const ownTombstone = row.clientId === null && row.sourceServerId === input.serverId && row.reclaimable;
  return ownTombstone && !clientKeyCarriesStringTrust(input.key) ? "own_tombstone" : "taken";
}

/**
 * The card prepare's early answer: whether an alias row refuses this key (a
 * current key is the prepare route's isClientKeyTaken). Prepare reserves
 * nothing; the check that holds is claimOAuthClientKey at execute.
 */
export async function clientKeyRefusedByAliasRow(input: { key: string; serverId: string }, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  return (await aliasRowState(executor, input)) === "taken";
}

/**
 * Registration, in the transaction that inserts the App: lock the key, refuse
 * one that is taken, and take back the Server's own tombstone. The new App gets
 * a new uuid, so it inherits no grant, token or trust.
 */
export async function claimOAuthClientKey(tx: DatabaseExecutor, input: { key: string; serverId: string }): Promise<void> {
  await lockOAuthClientKey(tx, input.key);
  const [current] = await tx.select({ id: oauthClients.id }).from(oauthClients).where(eq(oauthClients.clientId, input.key)).limit(1);
  if (current) throw new OAuthClientKeyTakenError();
  const state = await aliasRowState(tx, input);
  if (state === "taken") throw new OAuthClientKeyTakenError();
  if (state === "own_tombstone") {
    await tx.delete(oauthClientKeyAliases).where(eq(oauthClientKeyAliases.key, input.key));
  }
}

/**
 * App deletion, before the delete: lock the key and answer whether it has to
 * stay reserved. Used means `first_used_at` is set (a token, a grant, a login
 * request or a link-preview registration, ever: migration 0642's trigger keeps
 * it after those rows go, since an origin's domain file can still name the key).
 */
export async function lockDeletedOAuthClientKey(tx: DatabaseExecutor, client: { id: string; clientId: string }): Promise<{ reserve: boolean }> {
  await lockOAuthClientKey(tx, client.clientId);
  const [row] = await tx.select({ firstUsedAt: oauthClients.firstUsedAt }).from(oauthClients).where(eq(oauthClients.id, client.id)).limit(1);
  return { reserve: Boolean(row?.firstUsedAt) || clientKeyCarriesStringTrust(client.clientId) };
}

/**
 * App deletion, after the delete (ON DELETE SET NULL has turned the App's
 * aliases into tombstones): reserve its current key and keep the Server to its
 * cap of reclaimable tombstones. Serialized per Server, so two deletes can't
 * each see room for one more.
 */
export async function reserveDeletedOAuthClientKey(tx: DatabaseExecutor, client: { clientId: string; serverId: string }, keepKey: boolean): Promise<void> {
  if (keepKey) {
    await tx.insert(oauthClientKeyAliases)
      .values({ key: client.clientId, clientId: null, sourceServerId: client.serverId })
      .onConflictDoNothing({ target: oauthClientKeyAliases.key });
  }
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`oauth-client-tombstones:${client.serverId}`}, 0))`);
  await tx.execute(sql`UPDATE oauth_client_key_aliases SET reclaimable = false WHERE key IN (
    SELECT key FROM oauth_client_key_aliases
    WHERE source_server_id = ${client.serverId} AND client_id IS NULL AND reclaimable
    ORDER BY created_at DESC, key DESC OFFSET ${OAUTH_CLIENT_RECLAIMABLE_TOMBSTONES_PER_SERVER}
  )`);
}

// A listed App's id is an identity everyone sees, so changing it needs review
// (RFC 084 §3.4, step 3). `unpublish_requested` is still listed until decided.
const PUBLISH_STATES_NEEDING_REVIEW = new Set(["publish_requested", "in_review", "published", "unpublish_requested"]);

export type OAuthClientKeyRenameActor = { type: "human" | "agent"; id: string };

const CLIENT_KEY_CARRIES_TRUST_MESSAGE = "This client ID carries access that is still tied to the ID itself, so it can't be changed yet.";

function renameRefusal(status: 400 | 404 | 409, code: string, error: string): RefusalError {
  return new RefusalError(status, { code, error });
}

/**
 * Change an unpublished App's client id, in the caller's transaction, once the
 * caller has checked authority (RFC 084 §4). The App's row is locked first and
 * the key locks after it, as a delete does, so a rename and a delete can't
 * deadlock. An unchanged id changes nothing and isn't refused, so a form that
 * always sends the id can save a listed App.
 */
export async function renameOAuthClientKey(tx: DatabaseExecutor, input: {
  clientId: string;
  newKey: string;
  actor: OAuthClientKeyRenameActor;
}): Promise<{ changed: boolean; oldKey: string; newKey: string }> {
  const [client] = await tx.select({
    clientKey: oauthClients.clientId,
    serverId: oauthClients.serverId,
    publishStatus: oauthClients.publishStatus,
    firstUsedAt: oauthClients.firstUsedAt,
  }).from(oauthClients).where(eq(oauthClients.id, input.clientId)).for("update");
  if (!client) throw renameRefusal(404, "APP_NOT_FOUND", "This App no longer exists.");
  const newKey = canonicalClientKey(input.newKey);
  if (!newKey) throw renameRefusal(400, "INVALID_CLIENT_KEY", "A client ID must start with a letter and use only lowercase letters, numbers and hyphens, 3 to 64 characters.");
  const oldKey = client.clientKey;
  if (newKey === oldKey) return { changed: false, oldKey, newKey };

  const [official] = await tx.select({ id: officialAppRegistry.oauthClientId }).from(officialAppRegistry).where(eq(officialAppRegistry.oauthClientId, input.clientId)).limit(1);
  if (official || PUBLISH_STATES_NEEDING_REVIEW.has(client.publishStatus)) {
    throw renameRefusal(409, "CLIENT_KEY_CHANGE_NEEDS_REVIEW", "Only the Raft team can change the client ID of a listed or official App: contact them to ask. An App in review has to be decided first.");
  }
  // The legacy scope list is keyed by the string: the App would lose its scopes,
  // and whoever took such a key would gain them.
  if (Object.hasOwn(LEGACY_OAUTH_SCOPE_ALLOWLIST, oldKey) || Object.hasOwn(LEGACY_OAUTH_SCOPE_ALLOWLIST, newKey)) {
    throw renameRefusal(409, "CLIENT_KEY_CARRIES_TRUST", CLIENT_KEY_CARRIES_TRUST_MESSAGE);
  }

  // The key the deployment names Reminder by: only the App it names may hold it,
  // and that App always keeps it as an alias, or the deployment would lose its Reminder.
  const assistantKey = assistantAllowedIntegrationClientId();
  if (newKey === assistantKey) {
    const [alias] = await tx.select({ clientId: oauthClientKeyAliases.clientId }).from(oauthClientKeyAliases).where(eq(oauthClientKeyAliases.key, newKey)).limit(1);
    if (alias?.clientId !== input.clientId) throw renameRefusal(409, "CLIENT_KEY_CARRIES_TRUST", CLIENT_KEY_CARRIES_TRUST_MESSAGE);
  }

  const keepsOldKey = client.firstUsedAt !== null || oldKey === assistantKey;
  try {
    await tx.execute(sql`SELECT public.oauth_client_change_key(
      ${input.clientId}::uuid, ${newKey}, ${keepsOldKey}, ${input.actor.type}, ${input.actor.id}::uuid, 'api', NULL
    )`);
  } catch (err) {
    throw renameBodyRefusal(err, newKey) ?? err;
  }
  // Last: a refused rename doesn't use up one of the day's five. Past the limit this undoes the rename.
  await enforceOAuthClientKeyRenameRate(input.clientId);
  return { changed: true, oldKey, newKey };
}

/** What a refusal of oauth_client_change_key (migration 0645) answers. Its SQLSTATE is on the error or, through the ORM, on its cause. */
function renameBodyRefusal(err: unknown, newKey: string): RefusalError | null {
  const failure = err as { code?: unknown; cause?: { code?: unknown } };
  switch (failure.cause?.code ?? failure.code) {
    case "CKY01": return renameRefusal(404, "APP_NOT_FOUND", "This App no longer exists.");
    case "CKY03": return renameRefusal(409, "CLIENT_KEY_TAKEN", `The client ID "${newKey}" is already taken.`);
    case "CKY04": return renameRefusal(409, "CLIENT_KEY_ALIAS_LIMIT", `An App can keep at most ${OAUTH_CLIENT_MAX_ALIASES} old client IDs, and this one has reached that limit.`);
    default: return null;
  }
}
