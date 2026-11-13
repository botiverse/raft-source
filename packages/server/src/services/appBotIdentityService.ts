import type { AppInstallationBotChangedData, AppInstallationBotState } from "@botiverse/raft-shared";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { getAppUrl } from "../config/appUrl";
import { agentConfigValues, recordAgentConfigChange } from "./agentConfigChangeEvents";
import {
  agentCredentials,
  agents,
  appBotBindings,
  oauthClientInstalls,
  oauthClients,
  serverMembers,
  servers,
  users,
} from "../db/schema";
import type { DatabaseExecutor } from "../db/index";
import { getDb } from "../db/index";
import {
  MANAGED_APP_BOT_CAPABILITIES,
  mintAgentCredential,
  type AgentCapability,
} from "./agentCredentialService";
import { emitAppInstallationNotificationEvent } from "./appNotificationDeliveryService";
import { type AppSubject, resolveAppSubjectToUserId } from "./appSubjectService";
import { recordIntegrationAuditEvent } from "./integrationAuditService";
import { oauthClientIsUserManagedPredicate } from "./oauthClientManagementPolicy";
import { isAssistantReservedAgentHandle } from "./principalHandleService";

// ─── Design-v3 contract ───────────────────────────────────────────────────────
// One App has at most one live Bot per installation; the binding (not the
// agent name) is the durable authority for identity, permission grants, and
// billing exclusion. Sender stays `sender_type=agent`; attribution is additive
// (agents.managed_by_app_install_id → oauth_client_installs.id).
//
// Handle derivation: the stable client-id-derived short handle of the owning
// App (e.g. "my-slack-app" from OAuth client "my-slack-app"). It is not the
// Raft-visible agent name — that stays display-name-driven and may collide.
// The binding.handle is what lifecycle/reattach uses.
// ────────────────────────────────────────────────────────────────────────────

export type AppBotState = "active" | "disabled" | "uninstalled";

/** Convert an OAuth client ID to a stable Bot handle (lowercase, URL-safe). */
export function deriveAppBotHandle(clientId: string): string {
  return clientId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export class AppBotHandleConflictError extends Error {
  readonly code = "app_bot_handle_conflict";

  constructor(handle: string, conflictingAgentId: string) {
    super(`App Bot handle "${handle}" conflicts with existing agent ${conflictingAgentId}`);
    this.name = "AppBotHandleConflictError";
  }
}

export class AppBotInstallNotGrantedError extends Error {
  readonly code = "app_bot_install_not_granted";

  constructor() {
    super("This installation has not granted the Bot capability");
    this.name = "AppBotInstallNotGrantedError";
  }
}

export class AppBotAlreadyBoundError extends Error {
  readonly code = "app_bot_already_bound";

  constructor(installId: string) {
    super(`Install ${installId} already has a live Bot binding`);
    this.name = "AppBotAlreadyBoundError";
  }
}

export class AppBotAgentDeletedError extends Error {
  readonly code = "app_bot_agent_deleted";

  constructor() {
    super("This App's bot was archived on this Server, so it can't be added back. Uninstall and reinstall the App to get a new bot.");
    this.name = "AppBotAgentDeletedError";
  }
}

/**
 * An App-managed bot's lifecycle belongs to its App installation (added and
 * removed from the installed-app detail, gone on uninstall): archiving or
 * deleting it as an agent is refused, so a re-add can never meet a deleted agent.
 */
export const APP_BOT_LIFECYCLE_MANAGED = {
  code: "app_bot_lifecycle_managed",
  message: "This bot belongs to an App. Remove it from the App's page in Settings > Apps instead.",
} as const;

export interface ManagedAppBotView {
  bindingId: string;
  agentId: string;
  installId: string;
  serverId: string;
  state: AppBotState;
  handle: string;
  generation: number;
}

/**
 * Create the managed Bot agent and its binding for an install. Idempotent at
 * the activation point: concurrent or repeated activation returns the existing
 * live binding. Throws on handle conflict (a non-managed agent owns the
 * handle), missing grant, or already-bound live Bot.
 *
 * Caller must wrap in a transaction covering both the agent insert and the
 * binding insert.
 */
export async function createManagedAppBot(
  executor: DatabaseExecutor,
  input: {
    installId: string;
    serverId: string;
    requestedPermissions?: string[];
    now?: Date;
  },
): Promise<ManagedAppBotView> {
  const now = input.now ?? new Date();

  const [install] = await executor
    .select({
      id: oauthClientInstalls.id,
      serverId: oauthClientInstalls.serverId,
      clientId: oauthClientInstalls.clientId,
      status: oauthClientInstalls.status,
      botGrant: oauthClientInstalls.botGrant,
    })
    .from(oauthClientInstalls)
    .where(eq(oauthClientInstalls.id, input.installId))
    .limit(1);
  if (!install || install.serverId !== input.serverId) {
    throw new AppBotInstallNotGrantedError();
  }
  if (install.botGrant !== "granted") {
    throw new AppBotInstallNotGrantedError();
  }
  if (install.status !== "active") {
    throw new AppBotInstallNotGrantedError();
  }

  const [client] = await executor
    .select({
      id: oauthClients.id,
      clientId: oauthClients.clientId,
      name: oauthClients.name,
      logoUrl: oauthClients.logoUrl,
      enableBot: oauthClients.enableBot,
    })
    .from(oauthClients)
    .where(eq(oauthClients.id, install.clientId))
    .limit(1)
    // The new bot copies logo_url: a concurrent logo change must wait for this
    // transaction, or it would sync every bot but this uncommitted one and then
    // delete the logo this bot points at.
    .for("share");
  if (!client?.enableBot) {
    throw new AppBotInstallNotGrantedError();
  }

  // Idempotent: a live binding on this install already exists.
  const [existing] = await executor
    .select()
    .from(appBotBindings)
    .where(and(
      eq(appBotBindings.installId, install.id),
      sql`${appBotBindings.state} != 'uninstalled'`,
    ))
    .limit(1);
  if (existing) {
    // The binding's agent is the bot's identity. One that was archived is never
    // brought back by a re-add: refuse instead of answering "granted" with a
    // deleted agent (the live-binding index blocks creating a second one).
    const [boundAgent] = await executor
      .select({ deletedAt: agents.deletedAt })
      .from(agents)
      .where(eq(agents.id, existing.agentId))
      .limit(1);
    if (!boundAgent || boundAgent.deletedAt) {
      throw new AppBotAgentDeletedError();
    }
    if (existing.state !== "active") {
      // A disabled tombstone exists — re-activate in place, new generation.
      const nextGen = await nextBotGeneration(executor, install.id);
      const [updated] = await executor
        .update(appBotBindings)
        .set({ state: "active", generation: nextGen, disabledAt: null, updatedAt: now })
        .where(eq(appBotBindings.id, existing.id))
        .returning();
      return toView(updated!);
    }
    return toView(existing);
  }

  const handle = deriveAppBotHandle(client.clientId);
  // A personal assistant's handle is reserved (isAssistantReservedAgentHandle):
  // refused by the name alone, so the conflict never reveals that a member of
  // this server has an assistant by that handle.
  if (isAssistantReservedAgentHandle(handle)) {
    throw new AppBotHandleConflictError(handle, "reserved for personal assistants");
  }

  // Handle conflict: any non-managed agent already holding this handle is a
  // hard failure — the binding handle is the App's stable client-id-derived
  // identity and must not silently adopt or suffix.
  const [conflict] = await executor
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      eq(agents.serverId, input.serverId),
      eq(agents.name, handle),
      isNull(agents.deletedAt),
      isNull(agents.managedByAppInstallId),
    ))
    .limit(1);
  if (conflict) {
    throw new AppBotHandleConflictError(handle, conflict.id);
  }

  const [agent] = await executor
    .insert(agents)
    .values({
      serverId: input.serverId,
      name: handle,
      displayName: client.name,
      // The bot's avatar IS its App's logo (agentService.syncAppBotAvatarsToLogo
      // keeps it so on every logo write); set here at insert time.
      avatarUrl: client.logoUrl,
      status: "active",
      managedByAppInstallId: install.id,
      creatorType: null,
      creatorId: null,
      // External runtime so mintAgentCredential accepts it (sk_agent_* is
      // the App's credential path; a managed_bot is not a hosted-runtime agent).
      runtime: "external",
    })
    .returning({ id: agents.id, runtime: agents.runtime, model: agents.model, reasoningEffort: agents.reasoningEffort, createdAt: agents.createdAt });
  if (!agent) {
    throw new Error("app_bot agent insert failed");
  }
  await recordAgentConfigChange(executor, {
    serverId: input.serverId,
    agentId: agent.id,
    source: "app_bot_create",
    actor: null,
    before: null,
    after: agentConfigValues(agent),
    changedAt: agent.createdAt,
  });

  const generation = await nextBotGeneration(executor, install.id);
  let binding;
  try {
    // In a savepoint: the caller may pass its transaction, and a failed insert
    // aborts it in Postgres, so the race recovery below could not run its
    // select (25P02). Rolling back to the savepoint keeps the transaction usable.
    const [row] = await executor.transaction((savepoint) => savepoint
      .insert(appBotBindings)
      .values({
        installId: install.id,
        serverId: input.serverId,
        agentId: agent.id,
        generation,
        state: "active",
        handle,
        requestedPermissions: input.requestedPermissions ?? [],
      })
      .returning());
    binding = row;
  } catch (err: unknown) {
    // 23505: concurrent activation raced the partial-unique index — return the
    // already-bound live row rather than failing the caller.
    if ((err as { code?: string })?.code === "23505") {
      const [raced] = await executor
        .select()
        .from(appBotBindings)
        .where(and(
          eq(appBotBindings.installId, install.id),
          sql`${appBotBindings.state} != 'uninstalled'`,
        ))
        .limit(1);
      if (raced) return toView(raced);
    }
    throw err;
  }
  if (!binding) {
    throw new Error("app_bot binding insert failed");
  }

  console.log(`[AppBot] activated install=${install.id} agent=${agent.id} server=${input.serverId} gen=${generation}`);
  return toView(binding);
}

type BotGrantActor = { type: "human"; id: string } | { type: "system" };

/**
 * Every change to an installation's `bot_grant` ends here, in the writer's
 * transaction: the `installation.bot_grant_updated` audit row, and the
 * `installation.bot_changed` App Notification to that installation only
 * (#proj-apps #35). The two writers are setInstallationBotGrant and
 * resetBotGrantsForAppWithoutBot.
 */
async function recordInstallationBotGrantChange(
  executor: DatabaseExecutor,
  input: {
    install: { id: string; clientId: string; serverId: string };
    botGrant: "granted" | "revoked" | "pending";
    actor: BotGrantActor;
  },
): Promise<void> {
  const { install } = input;
  const [client] = await executor.select({ clientKey: oauthClients.clientId })
    .from(oauthClients).where(eq(oauthClients.id, install.clientId)).limit(1);
  await recordIntegrationAuditEvent({
    serverId: install.serverId,
    clientId: install.clientId,
    eventType: "installation.bot_grant_updated",
    outcome: "success",
    source: input.actor.type === "system" ? "system" : "api",
    actor: input.actor,
    subject: { type: "app", id: install.clientId },
    target: { type: "installation", id: install.id },
    metadata: { clientKey: client?.clientKey, installationId: install.id, botGrant: input.botGrant },
  }, executor);
  await emitAppInstallationNotificationEvent({
    eventType: "installation.bot_changed",
    installation: { id: install.id, serverId: install.serverId },
    provenance: { source: "app_bot_service", actor_type: input.actor.type },
  }, executor);
}

export type InstallationBotGrantResult =
  | { installationId: string; botGrant: "granted"; bot: ManagedAppBotView; listingChanged: { serverId: string; agentId: string } }
  | { installationId: string; botGrant: "revoked"; bot: null; listingChanged: { serverId: string; agentId: string } | null };

/**
 * The one write path for an installation's Bot grant, shared by
 * POST /clients/:clientId/install/bot and the installs that decide the bot in
 * their own transaction: a marketplace install and a share-link install with
 * `bot`, and an official App's auto-install. The caller has already checked
 * manageIntegrations (or is that auto-install), holds the installation row in
 * `executor`'s transaction, and owns that transaction: a grant that throws
 * (handle conflict) is the caller's to roll back.
 *
 * Revoke on an installation that never had a bot ("Don't add") only records
 * "revoked": there is no binding to disable and nothing is created.
 *
 * The actor is the person who chose, or the system for an official App's
 * auto-install on a new Server (which adds the bot as it installs the App).
 */
export async function setInstallationBotGrant(
  executor: DatabaseExecutor,
  input: {
    install: { id: string; clientId: string; serverId: string };
    action: "grant" | "revoke";
    actor: BotGrantActor;
    requestedPermissions?: string[];
  },
): Promise<InstallationBotGrantResult> {
  const { install } = input;
  const recordBotGrant = (botGrant: "granted" | "revoked") =>
    recordInstallationBotGrantChange(executor, { install, botGrant, actor: input.actor });

  if (input.action === "revoke") {
    await executor.update(oauthClientInstalls)
      .set({ botGrant: "revoked", updatedAt: new Date() })
      .where(eq(oauthClientInstalls.id, install.id));
    // Read before disabling: only a bot that was live leaves member lists (#11295).
    const removed = await getManagedAppBot(executor, install.id);
    await disableManagedAppBot(executor, { installId: install.id });
    await recordBotGrant("revoked");
    return {
      installationId: install.id,
      botGrant: "revoked",
      bot: null,
      listingChanged: removed?.state === "active" ? { serverId: removed.serverId, agentId: removed.agentId } : null,
    };
  }

  await executor.update(oauthClientInstalls)
    .set({ botGrant: "granted", updatedAt: new Date() })
    .where(eq(oauthClientInstalls.id, install.id));
  const bot = await createManagedAppBot(executor, {
    installId: install.id,
    serverId: install.serverId,
    requestedPermissions: input.requestedPermissions,
  });
  await recordBotGrant("granted");
  return { installationId: install.id, botGrant: "granted", bot, listingChanged: { serverId: bot.serverId, agentId: bot.agentId } };
}

/**
 * A developer turned the App's bot off (`enable_bot` false): every granted
 * installation goes back to `pending` and its bot is disabled (binding
 * disabled, keys revoked). Not `revoked`: that is a Server admin's own "Don't
 * add", and turning the bot on again must ask the Servers that had it. Each
 * change is recorded like a grant (audit row, `installation.bot_changed`).
 * Returns the bots that were live, for the caller's member-list broadcast.
 */
export async function resetBotGrantsForAppWithoutBot(
  executor: DatabaseExecutor,
  input: { clientId: string; actor: { type: "human"; id: string } },
): Promise<Array<{ serverId: string; agentId: string }>> {
  const installs = await executor.update(oauthClientInstalls)
    .set({ botGrant: "pending", updatedAt: new Date() })
    .where(and(
      eq(oauthClientInstalls.clientId, input.clientId),
      eq(oauthClientInstalls.botGrant, "granted"),
    ))
    .returning({ id: oauthClientInstalls.id, clientId: oauthClientInstalls.clientId, serverId: oauthClientInstalls.serverId });
  const removed: Array<{ serverId: string; agentId: string }> = [];
  for (const install of installs) {
    const bot = await getManagedAppBot(executor, install.id);
    if (bot?.state === "active") removed.push({ serverId: bot.serverId, agentId: bot.agentId });
    await disableManagedAppBot(executor, { installId: install.id });
    await recordInstallationBotGrantChange(executor, { install, botGrant: "pending", actor: input.actor });
  }
  return removed;
}

/**
 * What a Server's App lists say about an App's bot, for that Server: whether
 * the App ships one, this installation's grant (an install that never chose
 * reads as "pending"), the handle it joins as, and the live bot's agent id.
 * Absent when the App ships no bot.
 */
export type AppBotOffer = {
  offered: true;
  grant: "pending" | "granted" | "revoked";
  handle: string;
  /** The bot agent, while the grant is live and its binding active. */
  agentId?: string;
};

type AppBotOfferSource = {
  enableBot: boolean;
  /** The App's client key, which the bot handle is derived from. */
  clientId: string;
  installationId: string | null;
  installStatus: "active" | "suspended" | null;
  botGrant: "pending" | "granted" | "revoked" | null;
};

/** Add `bot` (AppBotOffer) to each row of an App list read for one Server. */
export async function withAppBotOffers<T extends AppBotOfferSource>(
  executor: DatabaseExecutor,
  rows: T[],
): Promise<Array<T & { bot?: AppBotOffer }>> {
  const installIds = rows.flatMap((row) => (row.enableBot && row.installationId ? [row.installationId] : []));
  const bindings = installIds.length > 0
    ? await executor
      .select({
        installId: appBotBindings.installId,
        state: appBotBindings.state,
        agentId: appBotBindings.agentId,
        agentName: agents.name,
        agentDeletedAt: agents.deletedAt,
      })
      .from(appBotBindings)
      .leftJoin(agents, eq(agents.id, appBotBindings.agentId))
      .where(and(
        inArray(appBotBindings.installId, installIds),
        sql`${appBotBindings.state} != 'uninstalled'`,
      ))
    : [];
  // idx_app_bot_install_live: at most one live binding per installation.
  const bindingByInstall = new Map(bindings.map((binding) => [binding.installId, binding]));
  return rows.map((row) => {
    if (!row.enableBot) return row;
    const binding = row.installationId ? bindingByInstall.get(row.installationId) : undefined;
    // "granted" only while the bot is really in the Server: the installation
    // active, the binding active and its agent not archived. A recorded grant
    // that is not live reads as "pending": the bot is absent, and adding it is
    // the way back (or the clear error when it can't be).
    const live = row.installStatus === "active"
      && binding?.state === "active"
      && !binding.agentDeletedAt;
    const recorded = row.botGrant ?? "pending";
    const grant = recorded === "granted" && !live ? "pending" : recorded;
    const bot: AppBotOffer = {
      offered: true,
      grant,
      handle: binding?.agentName ?? deriveAppBotHandle(row.clientId),
      ...(grant === "granted" && binding ? { agentId: binding.agentId } : {}),
    };
    return { ...row, bot };
  });
}

// ─── What the App itself is told about its bot (#proj-apps #35) ─────────────
// The installation lookup's `bot`, the refusals of bot-token and bot-status,
// and `installation.bot_changed` all map the same derived grant (AppBotOffer)
// onto the App-facing states, so the App and the Server's App lists agree.

/** granted (live) -> added; null or pending, or granted but not live -> not_added; revoked -> declined. */
export function appFacingBotState(grant: AppBotOffer["grant"]): AppInstallationBotState {
  if (grant === "granted") return "added";
  return grant === "revoked" ? "declined" : "not_added";
}

/**
 * The page where a Server admin adds the App's bot:
 * `<web origin>/s/<server slug>/apps?app_bot=<client_id>`, with the public
 * OAuth `client_id` the App authenticates with. The web matches it against the
 * installed App row's `clientId`. A slug can change and be reused by another
 * Server, so the link is for a person to click now, read fresh from lookup.
 */
export function appBotAddUrl(input: { serverSlug: string; clientKey: string }): string {
  return `${getAppUrl()}/s/${encodeURIComponent(input.serverSlug)}/apps?app_bot=${encodeURIComponent(input.clientKey)}`;
}

/** The installation lookup's `bot`. */
export type AppFacingInstallationBot = {
  handle: string;
  state: AppInstallationBotState;
  /** Only while `added`. */
  agent_id?: string;
  add_url: string;
};

/**
 * Why bot-token or bot-status refused for the bot: `not_added` or `declined`
 * with the add link, or `installation_suspended` without one (adding the bot
 * would not help, so an App must not send people the link).
 */
export type AppBotRefusalDetail =
  | { state: "not_added" | "declined"; add_url?: string }
  | { state: "installation_suspended" };

/**
 * The refusal detail for an installation whose bot is not live. `add_url` is
 * left out where the bot can't be added: a suspended installation, or an App
 * that ships no bot.
 */
export function appBotRefusalDetail(input: {
  installStatus: "active" | "suspended";
  botGrant: "pending" | "granted" | "revoked" | null;
  enableBot: boolean;
  serverSlug: string;
  clientKey: string;
}): AppBotRefusalDetail {
  if (input.installStatus !== "active") return { state: "installation_suspended" };
  // Refused means not live: a recorded grant here reads as not added, as in the App lists.
  const state = input.botGrant === "revoked" ? "declined" : "not_added";
  return input.enableBot
    ? { state, add_url: appBotAddUrl({ serverSlug: input.serverSlug, clientKey: input.clientKey }) }
    : { state };
}

async function readInstallationBot(
  executor: DatabaseExecutor,
  input: { installationId: string; clientId?: string },
) {
  const [row] = await executor.select({
    installationId: oauthClientInstalls.id,
    installStatus: oauthClientInstalls.status,
    botGrant: oauthClientInstalls.botGrant,
    enableBot: oauthClients.enableBot,
    clientKey: oauthClients.clientId,
    serverSlug: servers.slug,
  }).from(oauthClientInstalls)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
    .innerJoin(servers, eq(servers.id, oauthClientInstalls.serverId))
    .where(and(
      eq(oauthClientInstalls.id, input.installationId),
      input.clientId ? eq(oauthClientInstalls.clientId, input.clientId) : undefined,
    ))
    .limit(1);
  if (!row) return null;
  // The offer as if the App ships a bot, so an App that turned its bot off
  // still reads a state (not_added after the reset) for its event.
  const [{ bot }] = await withAppBotOffers(executor, [{
    enableBot: true,
    clientId: row.clientKey,
    installationId: row.installationId,
    installStatus: row.installStatus,
    botGrant: row.botGrant,
  }]);
  return { ...row, offer: bot! };
}

/**
 * The lookup's `bot` for the App's installation (`clientId` is the App's row
 * id, which the caller authenticated); null when the App ships no bot.
 */
export async function readAppFacingInstallationBot(
  input: { installationId: string; clientId: string },
  executor: DatabaseExecutor = getDb(),
): Promise<AppFacingInstallationBot | null> {
  const row = await readInstallationBot(executor, input);
  if (!row?.enableBot) return null;
  const state = appFacingBotState(row.offer.grant);
  return {
    handle: row.offer.handle,
    state,
    ...(state === "added" && row.offer.agentId ? { agent_id: row.offer.agentId } : {}),
    add_url: appBotAddUrl({ serverSlug: row.serverSlug, clientKey: row.clientKey }),
  };
}

/** `installation.bot_changed` data, read when the delivery is sent; null when the installation is gone. */
export async function readInstallationBotChangedData(
  executor: DatabaseExecutor,
  installationId: string,
): Promise<AppInstallationBotChangedData | null> {
  const row = await readInstallationBot(executor, { installationId });
  if (!row) return null;
  const state = appFacingBotState(row.offer.grant);
  return {
    state,
    handle: row.offer.handle,
    ...(state === "added" && row.offer.agentId ? { agent_id: row.offer.agentId } : {}),
  };
}

async function nextBotGeneration(
  executor: DatabaseExecutor,
  installId: string,
): Promise<number> {
  const [row] = await executor
    .select({ max: sql<number>`coalesce(max(${appBotBindings.generation}), 0)` })
    .from(appBotBindings)
    .where(eq(appBotBindings.installId, installId));
  return (row?.max ?? 0) + 1;
}

/** Mark a binding disabled (e.g. install suspended or bot capability revoked). */
export async function disableManagedAppBot(
  executor: DatabaseExecutor,
  input: { installId: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  // All managed-bot lifecycle paths lock the installation before its binding.
  // Posting holds the same rows through message commit.
  await executor.select({ id: oauthClientInstalls.id }).from(oauthClientInstalls)
    .where(eq(oauthClientInstalls.id, input.installId)).limit(1).for("update");
  await executor
    .update(appBotBindings)
    .set({ state: "disabled", disabledAt: now, updatedAt: now })
    .where(and(
      eq(appBotBindings.installId, input.installId),
      eq(appBotBindings.state, "active"),
    ));
  // A status published before the revoke must not resurrect on a later
  // re-grant: the app re-publishes when it has something to say.
  await executor
    .update(oauthClientInstalls)
    .set({ botStatusText: null, updatedAt: now })
    .where(eq(oauthClientInstalls.id, input.installId));
  await revokeManagedAppBotCredentials(executor, input.installId, "bot_disabled", now);
}

/** Permanently unbind the Bot (install deleted / explicit uninstall). */
export async function uninstallManagedAppBot(
  executor: DatabaseExecutor,
  input: { installId: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  // Some callers tombstone the binding before deleting the install. Lock the
  // install first so that order agrees with concurrent joint-channel posting.
  await executor.select({ id: oauthClientInstalls.id }).from(oauthClientInstalls)
    .where(eq(oauthClientInstalls.id, input.installId)).limit(1).for("update");
  const [row] = await executor
    .update(appBotBindings)
    .set({ state: "uninstalled", uninstalledAt: now, updatedAt: now })
    .where(and(
      eq(appBotBindings.installId, input.installId),
      sql`${appBotBindings.state} != 'uninstalled'`,
    ))
    .returning({ agentId: appBotBindings.agentId });
  if (row) {
    // Keep the agent row for history/attribution; mark it deleted so it no
    // longer counts or is usable.
    await executor
      .update(agents)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(agents.id, row.agentId));
    await revokeManagedAppBotCredentials(executor, input.installId, "bot_uninstalled", now);
  }
}

/** Revoke all live credentials for a managed bot's agent(s). */
async function revokeManagedAppBotCredentials(
  executor: DatabaseExecutor,
  installId: string,
  reason: string,
  now: Date,
): Promise<void> {
  const bindings = await executor
    .select({ agentId: appBotBindings.agentId })
    .from(appBotBindings)
    .where(eq(appBotBindings.installId, installId));
  if (bindings.length === 0) return;
  const agentIds = bindings.map((b) => b.agentId);
  await executor
    .update(agentCredentials)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(
      inArray(agentCredentials.agentId, agentIds),
      isNull(agentCredentials.revokedAt),
    ));
}

/** Read the live binding for an install, if any. */
export async function getManagedAppBot(
  executor: DatabaseExecutor,
  installId: string,
): Promise<ManagedAppBotView | null> {
  const [row] = await executor
    .select()
    .from(appBotBindings)
    .where(and(
      eq(appBotBindings.installId, installId),
      sql`${appBotBindings.state} != 'uninstalled'`,
    ))
    .limit(1);
  return row ? toView(row) : null;
}

export type ManagedAppBotStatusResult =
  | { ok: true; serverId: string; agentId: string }
  | { ok: false; reason: "installation_not_found" }
  | { ok: false; reason: "bot_not_granted" | "bot_not_active"; bot: AppBotRefusalDetail };

/** App-publishes its managed Bot's status line (P4b). Returns the owning
 * server + bot agent so the route can broadcast a profile update; the card
 * re-renders with the new line. */
export async function setManagedAppBotStatus(params: {
  clientId: string;
  installationId: string;
  text: string | null;
}): Promise<ManagedAppBotStatusResult> {
  // One atomic write: the grant, install liveness, and the live binding are
  // all conditions of the UPDATE itself, so a revoke or uninstall that lands
  // between a check and the write cannot leave a stale status behind (the
  // read-then-write race a separate UPDATE would have).
  const [updated] = await getDb()
    .update(oauthClientInstalls)
    .set({ botStatusText: params.text, updatedAt: new Date() })
    .where(and(
      eq(oauthClientInstalls.id, params.installationId),
      eq(oauthClientInstalls.clientId, params.clientId),
      eq(oauthClientInstalls.status, "active"),
      eq(oauthClientInstalls.botGrant, "granted"),
      sql`exists (
        select 1 from ${appBotBindings}
        where ${appBotBindings.installId} = ${params.installationId}
          and ${appBotBindings.state} = 'active'
      )`,
    ))
    .returning({ serverId: oauthClientInstalls.serverId });
  if (updated) {
    const bot = await getManagedAppBot(getDb(), params.installationId);
    if (bot) return { ok: true, serverId: updated.serverId, agentId: bot.agentId };
  }
  // Refused — classify for the caller by reading the row after the fact.
  const [install] = await getDb()
    .select({
      id: oauthClientInstalls.id,
      clientId: oauthClientInstalls.clientId,
      status: oauthClientInstalls.status,
      botGrant: oauthClientInstalls.botGrant,
      enableBot: oauthClients.enableBot,
      clientKey: oauthClients.clientId,
      serverSlug: servers.slug,
    })
    .from(oauthClientInstalls)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
    .innerJoin(servers, eq(servers.id, oauthClientInstalls.serverId))
    .where(eq(oauthClientInstalls.id, params.installationId));
  if (!install || install.status !== "active" || install.clientId !== params.clientId) {
    return { ok: false, reason: "installation_not_found" };
  }
  const bot = appBotRefusalDetail({
    installStatus: install.status,
    botGrant: install.botGrant,
    enableBot: install.enableBot,
    serverSlug: install.serverSlug,
    clientKey: install.clientKey,
  });
  // A write that landed as its binding vanished is inert on a dead binding,
  // but refuse so the caller sees the truth.
  const reason = !updated && install.botGrant !== "granted" ? "bot_not_granted" : "bot_not_active";
  return { ok: false, reason, bot };
}

export type ManagedAppBotCredentialRefusal =
  | "installation_not_found"
  | "bot_not_granted"
  | "bot_not_active"
  | "credential_exists";

export type ManagedAppBotCredentialIssue =
  | {
    ok: true;
    rotated: boolean;
    credentialId: string;
    apiKey: string;
    agentId: string;
    scopes: AgentCapability[];
  }
  | { ok: false; reason: "bot_not_granted"; bot: AppBotRefusalDetail }
  | { ok: false; reason: Exclude<ManagedAppBotCredentialRefusal, "bot_not_granted"> };

/**
 * Issue the managed Bot's `sk_agent_*` key to its own App. `clientId` is the row id of the App whose client credentials the
 * caller has already verified, so an App never reaches another App's
 * installation; a miss does not say whether the installation exists.
 *
 * A Bot keeps at most one live key. With one live and `rotate` unset the call
 * is refused, so App replicas cannot silently log each other out; `rotate`
 * revokes every live key and mints the replacement in the same transaction.
 * Every outcome is written to the integration audit log.
 */
export async function issueManagedAppBotCredential(
  input: { clientId: string; installationId: string; rotate: boolean; now?: Date },
  dbOrTx: ReturnType<typeof getDb> = getDb(),
): Promise<ManagedAppBotCredentialIssue> {
  return dbOrTx.transaction(async (executor) => {
    const now = input.now ?? new Date();
    // Same client-first lock order as declaration updates and install lifecycle.
    const [client] = await executor
      .select({ id: oauthClients.id, clientKey: oauthClients.clientId, enableBot: oauthClients.enableBot })
      .from(oauthClients)
      .where(and(
        eq(oauthClients.id, input.clientId),
        eq(oauthClients.enabled, true),
        oauthClientIsUserManagedPredicate(),
      ))
      .limit(1)
      .for("update");
    const [install] = client
      ? await executor
        .select({
          id: oauthClientInstalls.id,
          serverId: oauthClientInstalls.serverId,
          status: oauthClientInstalls.status,
          botGrant: oauthClientInstalls.botGrant,
          serverSlug: servers.slug,
        })
        .from(oauthClientInstalls)
        .innerJoin(servers, eq(servers.id, oauthClientInstalls.serverId))
        .where(and(
          eq(oauthClientInstalls.id, input.installationId),
          eq(oauthClientInstalls.clientId, client.id),
          isNull(servers.deletedAt),
        ))
        .limit(1)
        .for("update", { of: oauthClientInstalls })
      : [];

    const audit = (result: ManagedAppBotCredentialRefusal | "issued" | "rotated", extra: {
      agentId?: string;
      revokedCount?: number;
    } = {}) => recordIntegrationAuditEvent({
      serverId: install?.serverId ?? null,
      clientId: client?.id ?? null,
      eventType: "app_bot.credential",
      outcome: result === "issued" || result === "rotated" ? "success" : "failure",
      source: "api",
      actor: { type: "system" },
      requester: { type: "app", id: input.clientId },
      subject: { type: "app", id: input.clientId },
      target: extra.agentId
        ? { type: "agent", id: extra.agentId }
        : { type: "installation", id: install?.id ?? null },
      metadata: {
        clientKey: client?.clientKey,
        installationId: install?.id,
        result,
        revokedCount: extra.revokedCount,
      },
    }, executor);

    if (!client || !install) {
      // A disabled or platform-managed client has no App row to audit against.
      if (client) await audit("installation_not_found");
      return { ok: false, reason: "installation_not_found" };
    }
    if (install.status !== "active" || install.botGrant !== "granted") {
      await audit("bot_not_granted");
      return {
        ok: false,
        reason: "bot_not_granted",
        // A suspended installation is its own state, never not_added: the
        // App would keep sending people an add link that can't help.
        bot: appBotRefusalDetail({
          installStatus: install.status,
          botGrant: install.botGrant,
          enableBot: client.enableBot,
          serverSlug: install.serverSlug,
          clientKey: client.clientKey,
        }),
      };
    }
    const bot = await getManagedAppBot(executor, install.id);
    if (!bot || bot.state !== "active") {
      await audit("bot_not_active");
      return { ok: false, reason: "bot_not_active" };
    }

    const live = await executor
      .select({ id: agentCredentials.id })
      .from(agentCredentials)
      .where(and(eq(agentCredentials.agentId, bot.agentId), isNull(agentCredentials.revokedAt)));
    if (live.length > 0 && !input.rotate) {
      await audit("credential_exists", { agentId: bot.agentId });
      return { ok: false, reason: "credential_exists" };
    }
    if (live.length > 0) {
      await executor
        .update(agentCredentials)
        .set({ revokedAt: now, revokedReason: "rotated_by_app" })
        .where(and(eq(agentCredentials.agentId, bot.agentId), isNull(agentCredentials.revokedAt)));
    }

    const minted = await mintAgentCredential({
      agentId: bot.agentId,
      scopes: MANAGED_APP_BOT_CAPABILITIES,
      name: `app-bot:${client.id}`,
      issuedVia: "app",
      createdByUserId: null,
    }, { executor });
    const rotated = live.length > 0;
    await audit(rotated ? "rotated" : "issued", { agentId: bot.agentId, revokedCount: live.length });
    return {
      ok: true,
      rotated,
      credentialId: minted.credentialId,
      apiKey: minted.apiKey,
      agentId: minted.agentId,
      scopes: minted.scopes,
    };
  });
}

/**
 * The person an App Bot names as `dm:sub:<sub>` (agentWritableTarget), or
 * null. Null for every miss, and the callers answer every null alike, so a
 * miss never says which check failed:
 *
 * - the caller is not a live App Bot speaking with its App's own key: an
 *   `issued_via = 'app'` credential (`/api/oauth/installations/:id/bot-token`)
 *   of an agent managed by an active, Bot-granted installation of an
 *   enabled App, with an active binding, on this Server;
 * - the subject names no one (`resolveAppSubjectToUserId`, the only place a
 *   `sub` becomes a user id);
 * - the person is not a member of the Bot's Server, is a guest (guests do not
 *   use Apps), or their account is retired.
 *
 * Resolving grants nothing: the send then runs the same DM access and
 * find-or-create path as `dm:@name~human`.
 */
export async function resolveAppBotDmPeerUserId(input: {
  serverId: string;
  agentId: string;
  credentialId: string | undefined;
  sub: AppSubject;
}): Promise<string | null> {
  if (!input.credentialId) return null;
  const db = getDb();
  const [bot] = await db
    .select({ clientId: oauthClients.id })
    .from(agentCredentials)
    .innerJoin(agents, eq(agents.id, agentCredentials.agentId))
    .innerJoin(appBotBindings, and(
      eq(appBotBindings.agentId, agents.id),
      eq(appBotBindings.installId, agents.managedByAppInstallId),
    ))
    .innerJoin(oauthClientInstalls, eq(oauthClientInstalls.id, appBotBindings.installId))
    .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
    .where(and(
      eq(agentCredentials.id, input.credentialId),
      eq(agentCredentials.agentId, input.agentId),
      isNull(agentCredentials.revokedAt),
      eq(agentCredentials.issuedVia, "app"),
      eq(agents.serverId, input.serverId),
      isNull(agents.deletedAt),
      eq(appBotBindings.state, "active"),
      eq(appBotBindings.serverId, input.serverId),
      eq(oauthClientInstalls.serverId, input.serverId),
      eq(oauthClientInstalls.status, "active"),
      eq(oauthClientInstalls.botGrant, "granted"),
      eq(oauthClients.enabled, true),
      oauthClientIsUserManagedPredicate(),
    ))
    .limit(1);
  if (!bot) return null;

  const userId = await resolveAppSubjectToUserId({ clientId: bot.clientId, sub: input.sub });
  if (!userId) return null;

  const [member] = await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .where(and(
      eq(serverMembers.serverId, input.serverId),
      eq(serverMembers.userId, userId),
      ne(serverMembers.role, "guest"),
      isNull(users.retiredAt),
    ))
    .limit(1);
  return member?.userId ?? null;
}

/** Whether this agent is a managed App Bot. */
export async function isAppBotAgent(
  executor: DatabaseExecutor,
  agentId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ managedByAppInstallId: agents.managedByAppInstallId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return Boolean(row?.managedByAppInstallId);
}

function toView(row: typeof appBotBindings.$inferSelect): ManagedAppBotView {
  return {
    bindingId: row.id,
    agentId: row.agentId,
    installId: row.installId,
    serverId: row.serverId,
    state: row.state as AppBotState,
    handle: row.handle,
    generation: row.generation,
  };
}
