import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { validate as isUuid } from "uuid";
import { currentDate, effectiveAllowedOAuthScopes } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  oauthClientInstalls,
  oauthClients,
  officialAppRegistry,
  officialAppAutoInstallStates,
  officialAppAutoInstallTransitions,
  servers,
} from "../db/schema";
import { currentTextConfirmation } from "./appPromptTextService";
import { announcePermissionUpdatesChanged } from "./listChangedRealtime";
import { oauthClientIsUserManagedPredicate } from "./oauthClientManagementPolicy";
import { oauthClientHasKey } from "./oauthClientKeys";

type DbExecutor = ReturnType<typeof getDb>;
type AutoInstallState = "default_auto" | "auto_suppressed";
type TransitionSource = "auto_install" | "user_install" | "user_uninstall" | "migration";

let autoInstallAttemptObserverForTests: ((serverId: string) => void) | null = null;
let beforeAutoInstallWriteObserverForTests: ((serverId: string, tx: DbExecutor) => void | Promise<void>) | null = null;

/**
 * `RAFT_OFFICIAL_PUBLISHER_SERVER_ID`: the primary trust root, the Raft Server
 * itself (/raft in production). An official publisher, and the only Server
 * whose official Apps are auto-installed.
 */
function parsePrimaryOfficialServerId(): string | null {
  const value = process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID?.trim().toLowerCase();
  return value && isUuid(value) ? value : null;
}

/**
 * `RAFT_OFFICIAL_PUBLISHER_SERVER_IDS`: more official publisher Servers, as
 * comma-separated Server ids. All or nothing: an empty item or one that is
 * not a UUID makes the whole value invalid (null), so a typo never trusts part
 * of a list. Unset or blank is an empty list.
 */
export function parseOfficialPublisherServerIds(raw: string | undefined): string[] | null {
  if (!raw?.trim()) return [];
  // Lower case, as Server ids are stored and compared.
  const ids = raw.split(",").map((item) => item.trim().toLowerCase());
  return ids.every((id) => isUuid(id)) ? ids : null;
}

let extraPublishersMemo: { raw: string | undefined; ids: readonly string[] } | null = null;

/** The extra list, parsed (and an invalid value warned about) once per raw value. */
function extraOfficialPublisherServerIds(): readonly string[] {
  const raw = process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS;
  if (extraPublishersMemo && extraPublishersMemo.raw === raw) return extraPublishersMemo.ids;
  const ids = parseOfficialPublisherServerIds(raw);
  if (!ids) {
    console.warn("[official-apps] RAFT_OFFICIAL_PUBLISHER_SERVER_IDS is not a comma-separated list of Server ids; it adds no official publishers");
  }
  extraPublishersMemo = { raw, ids: ids ?? [] };
  return extraPublishersMemo.ids;
}

/**
 * Servers whose Apps can be official: the primary root (if valid) and the
 * extra list (if valid). Auto-install never reads this; it follows only the
 * primary root.
 */
function officialPublisherServerIds(): ReadonlySet<string> {
  const primary = parsePrimaryOfficialServerId();
  return new Set([...(primary ? [primary] : []), ...extraOfficialPublisherServerIds()]);
}

export async function projectOfficialAppDiscovery(input: {
  clientId: string;
  sourceServerId: string;
  clientKey: string;
}, dbOrTx: DbExecutor = getDb()): Promise<{
  official: boolean;
  purpose: string;
}> {
  return (await projectOfficialAppDiscoveryMany([input], dbOrTx)).get(input.clientId)!;
}

/**
 * projectOfficialAppDiscovery for a list of clients (keyed by clientId) in at
 * most one query: a marketplace list used to read the registry once per app.
 */
export async function projectOfficialAppDiscoveryMany(inputs: ReadonlyArray<{
  clientId: string;
  sourceServerId: string;
  clientKey: string;
}>, dbOrTx: DbExecutor = getDb()): Promise<Map<string, { official: boolean; purpose: string }>> {
  const result = new Map(inputs.map((input) => [input.clientId, { official: false, purpose: "" }]));
  const publishers = officialPublisherServerIds();
  const candidates = inputs.filter((input) => publishers.has(input.sourceServerId));
  if (candidates.length === 0) return result;
  const entries = await dbOrTx.select({
    clientId: officialAppRegistry.oauthClientId,
    clientKey: officialAppRegistry.clientKey,
    publisherServerId: officialAppRegistry.publisherServerId,
    purpose: officialAppRegistry.purpose,
  })
    .from(officialAppRegistry)
    .where(and(
      inArray(officialAppRegistry.oauthClientId, candidates.map((input) => input.clientId)),
      inArray(officialAppRegistry.publisherServerId, [...publishers]),
      eq(officialAppRegistry.status, "approved"),
    ));
  for (const input of candidates) {
    // Published from the App's own Server, not just from some official publisher.
    const entry = entries.find((row) => row.clientId === input.clientId
      && row.clientKey === input.clientKey
      && row.publisherServerId === input.sourceServerId);
    if (entry) result.set(input.clientId, { official: true, purpose: entry.purpose ?? "" });
  }
  return result;
}

/**
 * Whether an OAuth client is an approved official (first-party) app: an
 * approved official app registry entry with the client's identity, published
 * from the client's own Server, and that Server is an official publisher
 * (officialPublisherServerIds). Authority for official-only grants such as
 * `agent_reminder_write`.
 *
 * `forShare` (inside a transaction): also takes FOR SHARE on the registry row,
 * so a registry update (Feature Flag Admin takes FOR UPDATE on the same row)
 * waits for the caller's commit, or the caller sees its result. The
 * interactive link card execute decides eligibility this way at commit (RFC
 * 076 §3.3).
 */
export async function isApprovedOfficialAppClient(
  clientId: string,
  dbOrTx: DbExecutor = getDb(),
  options: { forShare?: boolean } = {},
): Promise<boolean> {
  const publishers = officialPublisherServerIds();
  if (publishers.size === 0) return false;
  const query = dbOrTx.select({ id: officialAppRegistry.oauthClientId })
    .from(officialAppRegistry)
    .innerJoin(oauthClients, and(
      eq(oauthClients.id, officialAppRegistry.oauthClientId),
      eq(oauthClients.clientId, officialAppRegistry.clientKey),
      eq(oauthClients.serverId, officialAppRegistry.publisherServerId),
    ))
    .where(and(
      eq(officialAppRegistry.oauthClientId, clientId),
      inArray(officialAppRegistry.publisherServerId, [...publishers]),
      eq(officialAppRegistry.status, "approved"),
    ))
    .limit(1);
  const [entry] = options.forShare ? await query.for("share", { of: officialAppRegistry }) : await query;
  return Boolean(entry);
}

export function __setOfficialAppAutoInstallAttemptObserverForTests(observer: ((serverId: string) => void) | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Official app auto-install observers are test-only");
  autoInstallAttemptObserverForTests = observer;
}

export function __setBeforeOfficialAppAutoInstallWriteObserverForTests(
  observer: ((serverId: string, tx: DbExecutor) => void | Promise<void>) | null,
): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Official app auto-install observers are test-only");
  beforeAutoInstallWriteObserverForTests = observer;
}

async function lockState(tx: DbExecutor, serverId: string, clientId: string) {
  const [state] = await tx.select()
    .from(officialAppAutoInstallStates)
    .where(and(
      eq(officialAppAutoInstallStates.serverId, serverId),
      eq(officialAppAutoInstallStates.clientId, clientId),
    ))
    .for("update")
    .limit(1);
  return state ?? null;
}

async function createStateIfAbsent(
  tx: DbExecutor,
  input: { serverId: string; clientId: string; state: AutoInstallState },
) {
  await tx.insert(officialAppAutoInstallStates).values({
    serverId: input.serverId,
    clientId: input.clientId,
    state: input.state,
  }).onConflictDoNothing();
  return lockState(tx, input.serverId, input.clientId);
}

async function writeTransition(tx: DbExecutor, input: {
  serverId: string;
  clientId: string;
  previousRevision: number;
  state: AutoInstallState;
  source: TransitionSource;
  actor: { type: "human"; userId: string } | { type: "system" };
  installationId?: string | null;
}) {
  const revision = input.previousRevision + 1;
  const now = currentDate();
  const [updated] = await tx.update(officialAppAutoInstallStates).set({
    state: input.state,
    revision,
    updatedAt: now,
  }).where(and(
    eq(officialAppAutoInstallStates.serverId, input.serverId),
    eq(officialAppAutoInstallStates.clientId, input.clientId),
    eq(officialAppAutoInstallStates.revision, input.previousRevision),
  )).returning({ revision: officialAppAutoInstallStates.revision });
  if (!updated) return false;
  await tx.insert(officialAppAutoInstallTransitions).values({
    serverId: input.serverId,
    clientId: input.clientId,
    revision,
    state: input.state,
    transitionSource: input.source,
    actorType: input.actor.type,
    actorUserId: input.actor.type === "human" ? input.actor.userId : null,
    installationId: input.installationId ?? null,
    createdAt: now,
  });
  return true;
}

// Auto-install follows only the primary root: an approved App from an extra
// official publisher (RAFT_OFFICIAL_PUBLISHER_SERVER_IDS) is never installed
// by default.
async function loadInstallableOfficialClient(tx: DbExecutor, clientKey: string, options?: { requireAutoInstall?: boolean }) {
  const trustRoot = parsePrimaryOfficialServerId();
  if (!trustRoot) return null;
  const [client] = await tx.select({
    id: oauthClients.id,
    clientKey: oauthClients.clientId,
    sourceServerId: oauthClients.serverId,
    outboundCurrentRevisionId: oauthClients.outboundCurrentRevisionId,
    outboundCurrentGroups: oauthClients.outboundCurrentGroups,
    allowedScopes: oauthClients.allowedScopes,
    enableBot: oauthClients.enableBot,
    registryRevision: officialAppRegistry.revision,
    registryAutoInstall: officialAppRegistry.autoInstall,
  }).from(oauthClients).innerJoin(
    officialAppRegistry,
    and(
      eq(officialAppRegistry.oauthClientId, oauthClients.id),
      eq(officialAppRegistry.clientKey, oauthClients.clientId),
      eq(officialAppRegistry.publisherServerId, oauthClients.serverId),
    ),
  ).where(and(
    oauthClientHasKey(clientKey),
    eq(oauthClients.serverId, trustRoot),
    eq(oauthClients.appType, "third_party_global"),
    oauthClientIsUserManagedPredicate(),
    inArray(oauthClients.publishStatus, ["published", "unpublish_requested"]),
    eq(oauthClients.enabled, true),
    eq(oauthClients.humanMarketplaceVisible, true),
    eq(officialAppRegistry.status, "approved"),
    ...(options?.requireAutoInstall ? [eq(officialAppRegistry.autoInstall, true)] : []),
  )).limit(1);
  return client ?? null;
}

export type OfficialAutoInstallResult =
  | { status: "installed"; clientId: string; installationId: string }
  | { status: "already_installed" | "suppressed" | "not_configured" | "not_official"; clientId?: string };

async function autoInstallOneInTransaction(input: {
  serverId: string;
  clientKey: string;
  unknownState: "default_auto" | "suppress_unknown";
}, tx: DbExecutor): Promise<OfficialAutoInstallResult> {
  // Both protected inputs and the source-server identity are evaluated here,
  // at the write point. No listing/display result can authorize this action.
  const client = await loadInstallableOfficialClient(tx, input.clientKey, { requireAutoInstall: true });
  if (!client) return { status: "not_configured" };
  autoInstallAttemptObserverForTests?.(input.serverId);

  let state = await lockState(tx, input.serverId, client.id);
  if (!state) {
    state = await createStateIfAbsent(tx, {
      serverId: input.serverId,
      clientId: client.id,
      state: input.unknownState === "suppress_unknown" ? "auto_suppressed" : "default_auto",
    });
    if (!state) throw new Error("Official app auto-install state could not be created");
    if (input.unknownState === "suppress_unknown") {
      await writeTransition(tx, {
        serverId: input.serverId,
        clientId: client.id,
        previousRevision: state.revision,
        state: "auto_suppressed",
        source: "migration",
        actor: { type: "system" },
      });
      return { status: "suppressed", clientId: client.id };
    }
  }
  if (state.state === "auto_suppressed") return { status: "suppressed", clientId: client.id };

  const [existing] = await tx.select({ id: oauthClientInstalls.id })
    .from(oauthClientInstalls)
    .where(and(
      eq(oauthClientInstalls.serverId, input.serverId),
      eq(oauthClientInstalls.clientId, client.id),
    )).limit(1);
  if (existing) return { status: "already_installed", clientId: client.id };

  // Re-read the trust root and app row immediately before the write. This is
  // intentionally redundant with the first read: it closes stale approval.
  await beforeAutoInstallWriteObserverForTests?.(input.serverId, tx);
  const writePointClient = await loadInstallableOfficialClient(tx, input.clientKey, { requireAutoInstall: true });
  if (!writePointClient || writePointClient.id !== client.id || writePointClient.registryRevision !== client.registryRevision) {
    return { status: "not_official", clientId: client.id };
  }
  const [installation] = await tx.insert(oauthClientInstalls).values({
    serverId: input.serverId,
    clientId: client.id,
    installedBySystem: true,
    approvedRequestRevisionId: writePointClient.outboundCurrentRevisionId,
    approvedGroups: writePointClient.outboundCurrentGroups,
    grantRevision: writePointClient.outboundCurrentRevisionId ? 1 : 0,
    approvedScopes: effectiveAllowedOAuthScopes(writePointClient.allowedScopes),
    ...await currentTextConfirmation(tx, client.id),
  }).onConflictDoNothing().returning({ id: oauthClientInstalls.id });
  if (!installation) return { status: "already_installed", clientId: client.id };
  const transitioned = await writeTransition(tx, {
    serverId: input.serverId,
    clientId: client.id,
    previousRevision: state.revision,
    state: "default_auto",
    source: "auto_install",
    actor: { type: "system" },
    installationId: installation.id,
  });
  if (!transitioned) {
    // A lost state CAS is always suppression-winning. Compensate the row made
    // in this transaction before returning so no caller can observe a
    // half-installed default. Tombstone any bot binding + agent first so the
    // cascade can't leave a managed agent orphaned.
    const { uninstallManagedAppBot } = await import("./appBotIdentityService");
    await uninstallManagedAppBot(tx, { installId: installation.id });
    await tx.delete(oauthClientInstalls).where(eq(oauthClientInstalls.id, installation.id));
    return { status: "suppressed", clientId: client.id };
  }
  // Installed by the system: its server's admins may have it to review.
  announcePermissionUpdatesChanged([input.serverId]);
  // An official App that ships a bot comes with it (artin, #proj-apps
  // 793ee49f): the system adds the bot as it installs the App. In a
  // savepoint, as a person's install: a taken handle rolls back only the
  // grant, and the App stays installed with its bot undecided, for an admin
  // to add later from Settings > Apps.
  if (writePointClient.enableBot) {
    const { AppBotHandleConflictError, setInstallationBotGrant } = await import("./appBotIdentityService");
    try {
      await tx.transaction((savepoint) => setInstallationBotGrant(savepoint, {
        install: { id: installation.id, clientId: client.id, serverId: input.serverId },
        action: "grant",
        actor: { type: "system" },
      }));
    } catch (err) {
      if (!(err instanceof AppBotHandleConflictError)) throw err;
      console.warn("[official-app-auto-install] bot handle taken; installed with the bot undecided", { serverId: input.serverId, clientId: client.id });
    }
  }
  return { status: "installed", clientId: client.id, installationId: installation.id };
}

export async function autoInstallOfficialAppsForProvisionedServer(
  serverId: string,
  tx: DbExecutor,
): Promise<OfficialAutoInstallResult[]> {
  const trustRoot = parsePrimaryOfficialServerId();
  if (!trustRoot) return [];
  const defaults = await tx.select({ clientKey: officialAppRegistry.clientKey })
    .from(officialAppRegistry)
    .where(and(
      eq(officialAppRegistry.publisherServerId, trustRoot),
      eq(officialAppRegistry.status, "approved"),
      eq(officialAppRegistry.autoInstall, true),
    )).orderBy(asc(officialAppRegistry.clientKey));
  const results: OfficialAutoInstallResult[] = [];
  for (const { clientKey } of defaults) {
    results.push(await autoInstallOneInTransaction({ serverId, clientKey, unknownState: "default_auto" }, tx));
  }
  return results;
}

export async function reconcileOfficialDefaultAppForExistingServers(input: {
  clientKey: string;
  // First rollout must use suppress_unknown. A later product-approved G5
  // expansion may explicitly choose default_auto for a genuinely new default.
  unknownState: "default_auto" | "suppress_unknown";
}): Promise<OfficialAutoInstallResult[]> {
  const db = getDb();
  const rows = await db.select({ id: servers.id }).from(servers)
    .where(and(isNull(servers.deletedAt), ne(servers.kind, "joint_storage"))).orderBy(asc(servers.id));
  const results: OfficialAutoInstallResult[] = [];
  for (const server of rows) {
    results.push(await db.transaction((tx) => autoInstallOneInTransaction({
      serverId: server.id,
      clientKey: input.clientKey,
      unknownState: input.unknownState,
    }, tx as DbExecutor)));
  }
  return results;
}

export async function recordExplicitUserInstallState(input: {
  serverId: string;
  clientId: string;
  clientKey: string;
  sourceServerId: string;
  installationId: string;
  actorUserId: string;
}, tx: DbExecutor): Promise<void> {
  let state = await lockState(tx, input.serverId, input.clientId);
  const policyApplies = state !== null
    || (await loadInstallableOfficialClient(tx, input.clientKey, { requireAutoInstall: true }))?.id === input.clientId;
  if (!policyApplies) return;
  state ??= await createStateIfAbsent(tx, {
    serverId: input.serverId,
    clientId: input.clientId,
    state: "default_auto",
  });
  if (!state) throw new Error("Official app user-install state could not be created");
  if (state.state === "default_auto" && state.revision > 0) return;
  const transitioned = await writeTransition(tx, {
    serverId: input.serverId,
    clientId: input.clientId,
    previousRevision: state.revision,
    state: "default_auto",
    source: "user_install",
    actor: { type: "human", userId: input.actorUserId },
    installationId: input.installationId,
  });
  if (!transitioned) throw new Error("Official app user-install state changed concurrently");
}

/**
 * Establish the state-row lock before the installation unique key is touched.
 * Auto-install and uninstall use the same state -> installation lock order, so
 * a concurrent explicit reinstall cannot deadlock or clear suppression late.
 */
export async function prepareExplicitUserInstallState(input: {
  serverId: string;
  clientId: string;
  clientKey: string;
  sourceServerId: string;
}, tx: DbExecutor): Promise<void> {
  let state = await lockState(tx, input.serverId, input.clientId);
  if (state) return;
  if ((await loadInstallableOfficialClient(tx, input.clientKey, { requireAutoInstall: true }))?.id !== input.clientId) return;
  state = await createStateIfAbsent(tx, {
    serverId: input.serverId,
    clientId: input.clientId,
    state: "default_auto",
  });
  if (!state) throw new Error("Official app user-install state could not be prepared");
}

export async function recordExplicitUserUninstallState(input: {
  serverId: string;
  clientId: string;
  clientKey: string;
  sourceServerId: string;
  actorUserId: string;
}, tx: DbExecutor): Promise<void> {
  let state = await lockState(tx, input.serverId, input.clientId);
  const policyApplies = state !== null
    || (await loadInstallableOfficialClient(tx, input.clientKey, { requireAutoInstall: true }))?.id === input.clientId;
  if (!policyApplies) return;
  state ??= await createStateIfAbsent(tx, {
    serverId: input.serverId,
    clientId: input.clientId,
    state: "default_auto",
  });
  if (!state) throw new Error("Official app user-uninstall state could not be created");
  if (state.state === "auto_suppressed") return;
  const transitioned = await writeTransition(tx, {
    serverId: input.serverId,
    clientId: input.clientId,
    previousRevision: state.revision,
    state: "auto_suppressed",
    source: "user_uninstall",
    actor: { type: "human", userId: input.actorUserId },
  });
  if (!transitioned) throw new Error("Official app user-uninstall state changed concurrently");
}

export async function getOfficialAppInstallationProvenance(serverId: string, clientId: string) {
  const db = getDb();
  const [row] = await db.select({
    installationId: oauthClientInstalls.id,
    installationStatus: oauthClientInstalls.status,
    state: officialAppAutoInstallStates.state,
    revision: officialAppAutoInstallTransitions.revision,
    transitionSource: officialAppAutoInstallTransitions.transitionSource,
    actorType: officialAppAutoInstallTransitions.actorType,
    actorUserId: officialAppAutoInstallTransitions.actorUserId,
    transitionedAt: officialAppAutoInstallTransitions.createdAt,
  }).from(oauthClientInstalls)
    .innerJoin(officialAppAutoInstallStates, and(
      eq(officialAppAutoInstallStates.serverId, oauthClientInstalls.serverId),
      eq(officialAppAutoInstallStates.clientId, oauthClientInstalls.clientId),
    ))
    .innerJoin(officialAppAutoInstallTransitions, and(
      eq(officialAppAutoInstallTransitions.serverId, officialAppAutoInstallStates.serverId),
      eq(officialAppAutoInstallTransitions.clientId, officialAppAutoInstallStates.clientId),
      eq(officialAppAutoInstallTransitions.revision, officialAppAutoInstallStates.revision),
    ))
    .where(and(
      eq(oauthClientInstalls.serverId, serverId),
      eq(oauthClientInstalls.clientId, clientId),
      eq(oauthClientInstalls.status, "active"),
    ))
    .orderBy(desc(officialAppAutoInstallTransitions.revision))
    .limit(1);
  return row ?? null;
}
