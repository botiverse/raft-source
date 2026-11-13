import { getAppInstallationSetup } from "../services/appSetupService";
import { denyServerGuests } from "../middleware/denyServerGuests";
import { broadcastAgentUpdated } from "./agentUpdatedBroadcast";
import { announceRemovedAppBots } from "./appBotRemovalBroadcast";
import type { Server as SocketServer } from "socket.io";
import * as channelService from "../services/channelService";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { Router, type Request, type Response, type Router as RouterType } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import multer from "multer";
import { type ServerCapability } from "@botiverse/raft-shared";
import { AgentJwtPolicyError, getLegacyAppAgentJwtSettings } from "../services/agentAudienceJwtPolicyService";
import { actorHasServerCapabilityInServer, getActorServerRoleInServer, roleCanInspectAgentPrivateSurfaces, userCanActOnAgentResource } from "../lib/actorPermissions";
import { getDb } from "../db/index";
import { agents, appBotBindings, oauthClientInstalls, oauthClients, officialAppRegistry } from "../db/schema";
import { recordIntegrationAuditEvent } from "../services/integrationAuditService";
import * as oauthService from "../services/oauthService";
import { listMarketplaceListings, parseMarketplaceListingsQuery } from "../services/marketplaceListings";
import * as agentService from "../services/agentService";
import {
  AGENT_APP_EVENTS_MAX_LIMIT,
  decodeAgentAppEventCursor,
  getAgentAppEvent,
  listAgentAppEvents,
  SYSTEM_ASSISTANT_APP,
} from "../services/agentAppEventsService";
import {
  createAvatarUpload,
  PROFILE_AVATAR_BAD_FORMAT_MESSAGE,
  PROFILE_AVATAR_TOO_LARGE_MESSAGE,
} from "../services/avatarService";
import { getCdnStorage, getStorage } from "../services/storageService";
import { streamStorageResponse } from "../services/storageResponseStream";
import {
  AppOutboundPermissionError,
  createAppOutboundPermissionRevision,
  groupGatedSubscriptions,
  updateAppInstallationGrant,
} from "../services/appOutboundPermissionService";
import {
  countAppPermissionUpdates,
  getAppNotificationDeveloperState,
  getAppNotificationInstallationState,
} from "../services/appNotificationManagementService";
import {
  AppWebhookConfigError,
  configureAppWebhook,
  disableAppWebhook,
  rotateAppWebhookSecret,
} from "../services/appWebhookConfigService";
import { oauthClientIsUserManagedPredicate } from "../services/oauthClientManagementPolicy";
import {
  APP_PERMISSIONS_CHANGED,
  AppPermissionsChangedError,
  EXPECTED_PERMISSIONS_REQUIRED,
  ExpectedPermissionsRequiredError,
  parseExpectedAppPermissions,
} from "../services/appPermissionExpectation";
import {
  PROMPT_TEXT_REVIEW_STALE,
  confirmPromptTextForSource,
  getAppPromptTextState,
  promptTextRevisionView,
  reviewPendingPromptText,
  type AppPromptText,
} from "../services/appPromptTextService";
import {
  appsOnLinkPreviewVersion1, confirmOwnServerLinkCardActions, getActionEndpointReviewState, withdrawOwnServerLinkCardActions,
  type OwnServerLinkCardActionsResult,
} from "../services/appLinkPreviewService";
import {
  allowLinkPreviews,
  declineLinkPreviews,
  LINK_PREVIEW_APP_NOT_FOUND,
  LINK_PREVIEW_SCOPES_NOT_ALLOWED,
  listLinkPreviewChoices,
} from "../services/appLinkPreviewConsentService";
import { sendJsonServerError } from "./errorResponse";
import { refuseUnverifiedApprover, refuseWithoutRecentSecondFactor } from "./secondFactor";
import { webSessionFamilyOf } from "../services/sessionService";
import { guardUuidPathParams } from "../lib/uuidPathParams";
import { hideUnfindableAgentsByParam } from "./unfindableAgentGate";
import { OAuthClientKeyTakenError } from "../services/oauthClientKeys";
import { refuse, RefusalError } from "../lib/refusal";
import { enforceOAuthAppRegistrationRate } from "../services/oauthClientRegistrationLimits";

export const integrationRouter: RouterType = Router();
export const integrationInviteRouter: RouterType = Router();
export const integrationLogoPublicRouter: RouterType = Router();
// Uniform 404 for non-UUID path params (task #12); every id below is a uuid column.
guardUuidPathParams(integrationRouter, {
  clientId: "App",
  linkId: "Share link",
  agentId: "Agent",
  eventId: "Event",
  requestId: "Access request",
  grantId: "Grant",
});
// Another person's personal assistant reads as an unknown agent (agentFindableBy).
hideUnfindableAgentsByParam(integrationRouter, "agentId");
const logoUpload = createAvatarUpload();

/**
 * Raft's prompt-text reviewers: prompt text is the one review still decided
 * here, until the app_prompt_text_consent flag retires. Every other review
 * (publish and offline, card URL, permission update) is decided in App Admin
 * (#proj-apps task #19).
 */
function isMarketplaceReviewer(userId: string) {
  const reviewers = (process.env.SLOCK_MARKETPLACE_REVIEWER_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return reviewers.includes(userId);
}

function currentUserHasServerCapability(req: Request, capability: ServerCapability) {
  return actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, capability);
}

/**
 * `needsAdminReview` for each App row (#proj-apps task #24): only for a caller
 * who can handle what waits (manageIntegrations); everyone else gets no field.
 */
async function needsAdminReviewFields(req: Request): Promise<(clientId: string) => { needsAdminReview?: boolean }> {
  if (!await currentUserHasServerCapability(req, "manageIntegrations")) return () => ({});
  const ids = await oauthService.appsNeedingAdminReview(req.serverId!);
  return (clientId) => ({ needsAdminReview: ids.has(clientId) });
}

/** For the App's page under My Apps (#proj-apps:#55): App managers only, like needsAdminReview. */
async function linkPreviewReadOnlyFields(req: Request): Promise<(clientId: string) => { linkPreviewReadOnly?: true }> {
  if (!await currentUserHasServerCapability(req, "manageIntegrations")) return () => ({});
  const ids = await appsOnLinkPreviewVersion1(req.serverId!);
  return (clientId) => (ids.has(clientId) ? { linkPreviewReadOnly: true } : {});
}

/** For the App's edit page: an official App's client ID goes through review, so the field isn't offered (RFC 084 §3). */
async function officialAppFields(req: Request): Promise<(clientId: string) => { official?: true }> {
  const rows = await getDb().select({ id: officialAppRegistry.oauthClientId }).from(officialAppRegistry)
    .innerJoin(oauthClients, eq(oauthClients.id, officialAppRegistry.oauthClientId))
    .where(eq(oauthClients.serverId, req.serverId!));
  const ids = new Set(rows.map((row) => row.id));
  return (clientId) => (ids.has(clientId) ? { official: true } : {});
}

async function currentServerOwnsOAuthClient(req: Request, clientId: string) {
  const [client] = await getDb().select({ id: oauthClients.id }).from(oauthClients)
    .where(and(
      eq(oauthClients.id, clientId),
      eq(oauthClients.serverId, req.serverId!),
      oauthClientIsUserManagedPredicate(),
    ))
    .limit(1);
  return !!client;
}

/** Shared with the MCP App logo route, so both answer a bad upload the same way. */
export function handleLogoUploadError(err: unknown, res: Response) {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    res.status(400).json({ error: PROFILE_AVATAR_TOO_LARGE_MESSAGE });
    return true;
  }
  if (err instanceof Error && err.message.includes(PROFILE_AVATAR_BAD_FORMAT_MESSAGE)) {
    res.status(400).json({ error: err.message });
    return true;
  }
  return false;
}

export function runSingleLogoUpload(req: Request): Promise<Express.Multer.File | null> {
  return new Promise((resolve, reject) => {
    logoUpload.single("logo")(req, {} as never, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(req.file ?? null);
    });
  });
}

integrationLogoPublicRouter.get("/:clientId/:filename", async (req, res) => {
  try {
    const { clientId, filename } = req.params;
    if (!/^[0-9a-f]{32}\.webp$/.test(filename)) {
      res.status(400).json({ error: "Invalid filename" });
      return;
    }
    const contentHash = filename.slice(0, -".webp".length);
    const storageKey = await oauthService.getOAuthClientLogoStorageKey({ clientId, contentHash });
    if (!storageKey) {
      res.status(404).json({ error: "Logo not found" });
      return;
    }

    const storage = getCdnStorage() || getStorage();
    if (!storage) {
      res.status(500).json({ error: "Storage not configured" });
      return;
    }

    const stream = await storage.get(storageKey);
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    await streamStorageResponse(stream, res);
  } catch {
    if (res.destroyed || res.headersSent) return;
    res.status(404).json({ error: "Logo not found" });
  }
});

integrationRouter.get("/overview", denyServerGuests, async (req, res) => {
  try {
    const items = await oauthService.getServerIntegrationsOverview(req.serverId!);
    res.json(items);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to load integrations overview", logPrefix: "List integrations overview error:", err });
  }
});

integrationRouter.get("/built-in", (_req, res) => {
  // Compatibility-only endpoint for cached Web clients. The retired class is
  // never queried; new clients do not call this route.
  res.json([]);
});

integrationRouter.get("/permission-updates", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    // `count` drives the permission-update notice; `needsAdminReview` the
    // Apps rail dot, which also covers prompt text awaiting confirmation.
    const [count, needsAdminReview] = await Promise.all([
      countAppPermissionUpdates(req.serverId!),
      oauthService.appsNeedingAdminReview(req.serverId!),
    ]);
    res.json({ count, needsAdminReview: needsAdminReview.size > 0 });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to read App permission updates", logPrefix: "App permission updates error:", err });
  }
});

integrationRouter.get("/marketplace", denyServerGuests, async (req, res) => {
  try {
    const [clients, adminReview] = await Promise.all([
      oauthService.listMarketplaceOAuthClients(req.serverId!),
      needsAdminReviewFields(req),
    ]);
    res.json(clients.map((client) => ({ ...client, ...adminReview(client.id) })));
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to list marketplace OAuth clients", logPrefix: "List marketplace OAuth clients error:", err });
  }
});

// The Marketplace as pages, with Raft-recommended MCP App templates (contract:
// marketplaceListingsContract.ts in shared). Same audience as GET /marketplace,
// any member of this server; installing an App or adding an MCP App from a
// template stays gated on manageIntegrations where it is done.
integrationRouter.get("/marketplace/listings", denyServerGuests, async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const parsed = parseMarketplaceListingsQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error, code: parsed.code });
      return;
    }
    res.json(await listMarketplaceListings({
      serverId: req.serverId!,
      request: parsed.request,
    }));
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to list the Marketplace", logPrefix: "List Marketplace listings error:", err });
  }
});

integrationRouter.get("/clients/:clientId/setup", denyServerGuests, async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    if (!UUID_RE.test(req.params.clientId)) { res.status(400).json({ error: "clientId must be an App ID" }); return; }
    const setup = await getAppInstallationSetup({ clientId: req.params.clientId, serverId: req.serverId! });
    if (!setup) { res.status(404).json({ error: "Active installation not found" }); return; }
    const canConfigure = await currentUserHasServerCapability(req, "manageIntegrations");
    res.json({ ...setup, canConfigure, url: canConfigure ? setup.url : null });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to read App setup", logPrefix: "Read App setup error:", err });
  }
});

integrationRouter.get("/clients", denyServerGuests, async (req, res) => {
  try {
    // This Server's own Apps: the Installed tab lists its server-local ones from here.
    const [clients, adminReview, linkPreviewReadOnly, official] = await Promise.all([
      oauthService.listOAuthClientsWithInstallState(req.serverId!),
      needsAdminReviewFields(req),
      linkPreviewReadOnlyFields(req),
      officialAppFields(req),
    ]);
    res.json(clients.map((client) => ({ ...client, ...adminReview(client.id), ...linkPreviewReadOnly(client.id), ...official(client.id) })));
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to list OAuth clients", logPrefix: "List OAuth clients error:", err });
  }
});

integrationRouter.post("/clients", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const { name, description, whenToUse, homepageUrl, returnUrl, agentManifestUrl, setupUrl, setupDescription, clientId, allowedScopes, category } = req.body ?? {};
    // Creating an app answers with its first client secret: as regenerating one.
    if (await refuseWithoutRecentSecondFactor(res, req.userId!, webSessionFamilyOf(req), "integration_app_register")) return;
    await enforceOAuthAppRegistrationRate(req.serverId!);
    const created = await oauthService.createOAuthClient({
      serverId: req.serverId!,
      createdByUserId: req.userId!,
      name,
      description,
      whenToUse,
      homepageUrl,
      returnUrl,
      agentManifestUrl, setupUrl, setupDescription,
      clientId,
      allowedScopes,
      category,
    });
    res.json(created);
  } catch (err: any) {
    const message = err?.message || "Failed to create OAuth client";
    if (err instanceof OAuthClientKeyTakenError) {
      res.status(409).json({ error: "Client ID is already taken" });
      return;
    }
    if (
      message.includes("required") ||
      message.includes("clientId") ||
      message.includes("agentManifestUrl") || message.includes("setup") ||
      message.includes("scope") ||
      message.includes("category") ||
      message.includes("returnUrl") ||
      message.includes("whenToUse")
    ) {
      res.status(400).json({ error: message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to create OAuth client", logPrefix: "Create OAuth client error:", err });
  }
});

/**
 * Removing or re-adding a Bot keeps its membership rows, so no membership event
 * fires. Tell open clients to re-read the agent directory (its `inMemberLists`
 * decides the members tab and pickers) and each channel member list that shows
 * the Bot. Runs after commit; a failure is logged, not returned.
 */
async function broadcastManagedBotListingChanged(req: Request, bot: { serverId: string; agentId: string }): Promise<void> {
  try {
    broadcastAgentUpdated(req, bot.serverId, bot.agentId);
    const io = req.app.get("io") as SocketServer | undefined;
    if (!io) return;
    for (const channel of await channelService.getListableChannelsListingAgent(bot.serverId, bot.agentId)) {
      io.to(channel.type === "channel" ? `server:${bot.serverId}` : `channel:${channel.id}`)
        .emit("channel:members-updated", { channelId: channel.id });
    }
  } catch (error) {
    console.warn("Failed to broadcast App Bot member listing change:", serializeErrorForLog(error));
  }
}

/** P4b: managed bots read identity through the install→client join, so any
 * app identity edit (name/description/logo) must push agent:updated to every
 * live bound bot, or open profile panels keep showing the pre-edit app. */
async function broadcastManagedBotProfileUpdates(req: Request, clientDbId: string): Promise<void> {
  // Installations live on whichever server installed the app — a third-party
  // app's bots span servers, and each bound bot's own server must get the
  // event, not only the server where the developer saved the edit.
  const botRows = await getDb()
    .select({ agentId: appBotBindings.agentId, serverId: oauthClientInstalls.serverId })
    .from(appBotBindings)
    .innerJoin(oauthClientInstalls, eq(oauthClientInstalls.id, appBotBindings.installId))
    .where(and(
      eq(oauthClientInstalls.clientId, clientDbId),
      sql`${appBotBindings.state} != 'uninstalled'`,
    ));
  for (const row of botRows) {
    broadcastAgentUpdated(req, row.serverId, row.agentId);
  }
}

integrationRouter.patch("/clients/:clientId", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const { name, description, whenToUse, homepageUrl, returnUrl, agentManifestUrl, setupUrl, setupDescription, allowedScopes, category, enableBot, clientId: newClientKey } = req.body ?? {};
    const removedBots: Array<{ serverId: string; agentId: string }> = [];
    const updated = await getDb().transaction(async (tx) => {
      const row = await oauthService.updateOAuthClient({
        serverId: req.serverId!,
        clientId: req.params.clientId,
        actorUserId: req.userId!,
        name,
        description,
        whenToUse,
        homepageUrl,
        returnUrl,
        agentManifestUrl, setupUrl, setupDescription,
        allowedScopes,
        category,
        enableBot,
        // The App's own Server changing its client id (RFC 084); a form sends it unchanged, which is no change.
        ...(typeof newClientKey === "string" ? { newClientKey } : {}),
      }, tx);
      // Turning the capability off must cascade: disable every granted bot
      // (binding disabled, keys revoked), otherwise a live bot outlives the
      // flag. Those installs go back to "pending" (audited, and each App
      // installation told with installation.bot_changed).
      if (row && enableBot === false) {
        const { resetBotGrantsForAppWithoutBot } = await import("../services/appBotIdentityService");
        removedBots.push(...await resetBotGrantsForAppWithoutBot(tx, {
          clientId: row.id,
          actor: { type: "human", id: req.userId! },
        }));
      }
      return row;
    });
    if (!updated) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    for (const bot of removedBots) await broadcastManagedBotListingChanged(req, bot);
    if (name !== undefined || description !== undefined) {
      await broadcastManagedBotProfileUpdates(req, updated.id);
    }
    // Respond with the install-joined editor row (same shape as GET /clients):
    // the bare update result drops botGrant/installationId, and the editor
    // replaces its row with the response — it would lose the grant state on
    // every unrelated save, and show a stale grant after a disable cascade.
    const editorRow = await oauthService.getOAuthClientWithInstallState(req.serverId!, updated.id);
    res.json(editorRow ?? updated);
  } catch (err: any) {
    // Before the message checks below: a refusal's sentence can name an id that contains "scope".
    if (err instanceof RefusalError) {
      refuse(res, err.status, err.refusal);
      return;
    }
    const message = err?.message || "Failed to update OAuth client";
    if (message.includes("required") || message.includes("agentManifestUrl") || message.includes("setup") || message.includes("scope") || message.includes("category") || message.includes("returnUrl") || message.includes("whenToUse")) {
      res.status(400).json({ error: message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to update OAuth client", logPrefix: "Update OAuth client error:", err });
  }
});


// Agent JWT is built in (no per-App or per-installation switch). These two
// routes only answer web bundles from the previous release; remove both next release.
integrationRouter.get("/clients/:clientId/agent-jwt", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can read Agent JWT access" });
      return;
    }
    res.json(await getLegacyAppAgentJwtSettings(req.serverId!, req.params.clientId));
  } catch (error) {
    if (error instanceof AgentJwtPolicyError) { res.status(error.status).json({ error: error.message }); return; }
    sendJsonServerError(req, res, { error: "Failed to load Agent JWT settings", logPrefix: "Agent JWT settings error:", err: error });
  }
});

integrationRouter.put("/clients/:clientId/agent-jwt", (_req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.status(410).json({ error: "Agent JWT is built in for every App; there is no setting to change" });
});

integrationRouter.get("/clients/:clientId/app-notifications", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only an owner or admin of the app source server can read App Notifications settings" });
      return;
    }
    const state = await getAppNotificationDeveloperState({
      clientId: req.params.clientId,
      sourceServerId: req.serverId!,
    });
    if (!state) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      source_installation: state.sourceInstallation ? {
        installation_id: state.sourceInstallation.id,
        status: state.sourceInstallation.status,
        enabled: state.sourceInstallation.enabled,
        approved_request_revision_id: state.sourceInstallation.approvedRequestRevisionId,
        approved_groups: state.sourceInstallation.approvedGroups,
      } : null,
      request_revision: state.requestRevision,
      current_revision_id: state.currentRevisionId,
      current_groups: state.currentGroups,
      current_events: state.currentEvents,
      pending_revision: state.pendingRevision ? {
        id: state.pendingRevision.id,
        revision: state.pendingRevision.revision,
        groups: state.pendingRevision.groups,
        events: state.pendingRevision.events,
        created_at: state.pendingRevision.createdAt,
      } : null,
      webhook: state.webhook ? {
        endpoint_url: state.webhook.endpointUrl,
        config_revision: state.webhook.revision,
        enabled: state.webhook.enabled,
        previous_valid_until: state.webhook.previousValidUntil,
        updated_at: state.webhook.updatedAt,
      } : null,
    });
  } catch (error) {
    sendJsonServerError(req, res, { error: "Failed to load App Notifications settings", logPrefix: "Read App Notifications developer state error:", err: error });
  }
});

integrationRouter.put("/clients/:clientId/app-notifications/permissions", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")
      || !await currentServerOwnsOAuthClient(req, req.params.clientId)) {
      res.status(403).json({ error: "Only an owner or admin of the app source server can update App Notifications permissions" });
      return;
    }
    const result = await createAppOutboundPermissionRevision({
      clientId: req.params.clientId,
      actor: { type: "human", id: req.userId! },
      groups: req.body?.groups,
      events: req.body?.events,
    });
    if (!result) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json({
      request_revision_id: result.revision.id,
      revision: result.revision.revision,
      state: result.revision.state,
      current_groups: result.currentGroups,
      current_events: result.currentEvents,
      requires_marketplace_review: result.requiresReview,
      invalidated_installation_count: result.invalidatedInstallationCount,
    });
  } catch (error) {
    if (error instanceof AppOutboundPermissionError) {
      res.status(400).json({ error: error.message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to update App Notifications permission request", logPrefix: "Update App Notifications permission request error:", err: error });
  }
});

// Prompt text (task #4, #proj-apps): the app's own Server's admins and the
// marketplace reviewers read its current, pending and rejected revisions.
integrationRouter.get("/clients/:clientId/prompt-text", async (req, res) => {
  try {
    const state = await getAppPromptTextState(req.params.clientId);
    const canReview = isMarketplaceReviewer(req.userId!);
    const isSourceAdmin = Boolean(state)
      && state!.serverId === req.serverId
      && await currentUserHasServerCapability(req, "manageIntegrations");
    if (!state || (!isSourceAdmin && !canReview)) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      current: state.current ? promptTextRevisionView(state.current) : null,
      pending: state.pending ? promptTextRevisionView(state.pending) : null,
      rejected: state.rejected ? promptTextRevisionView(state.rejected) : null,
      local_confirmed_revision_id: state.localConfirmedRevisionId,
      can_review: canReview,
    });
  } catch (error) {
    sendJsonServerError(req, res, { error: "Failed to load app prompt text", logPrefix: "Read app prompt text error:", err: error });
  }
});

const PROMPT_TEXT_REVISION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

integrationRouter.post("/clients/:clientId/prompt-text/review", async (req, res) => {
  try {
    if (!isMarketplaceReviewer(req.userId!)) {
      res.status(403).json({ error: "Only marketplace reviewers can review an app's prompt text" });
      return;
    }
    const decision = req.body?.decision;
    const expectedRevisionId = typeof req.body?.expected_revision_id === "string" ? req.body.expected_revision_id.trim() : "";
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 2_000) : null;
    if ((decision !== "approve" && decision !== "reject") || !PROMPT_TEXT_REVISION_ID.test(expectedRevisionId)) {
      res.status(400).json({ error: "Send decision (approve or reject) and expected_revision_id, the pending revision shown to the reviewer" });
      return;
    }
    if (decision === "reject" && !reason) {
      res.status(400).json({ error: "A rejection needs a reason the developer can act on" });
      return;
    }
    const result = await reviewPendingPromptText({
      clientId: req.params.clientId,
      reviewerUserId: req.userId!,
      decision,
      expectedRevisionId,
      reason,
    });
    if (result.kind === "not_found") {
      res.status(404).json({ error: "No prompt text is waiting for review" });
      return;
    }
    if (result.kind === "stale") {
      res.status(409).json({
        error: "The developer replaced the text you reviewed. Reload and review the latest version.",
        code: PROMPT_TEXT_REVIEW_STALE,
        pending_revision_id: result.pendingRevisionId,
      });
      return;
    }
    res.json({ revision_id: result.revisionId, state: result.kind === "approved" ? "active" : "rejected" });
  } catch (error) {
    sendJsonServerError(req, res, { error: "Failed to review app prompt text", logPrefix: "Review app prompt text error:", err: error });
  }
});

// Interactive link cards (RFC 076 §4): the App's own Server admins read its
// action endpoint, the one in force and an added or changed one waiting for
// marketplace review (decided in App Admin), with the last reject reason.
integrationRouter.get("/clients/:clientId/action-endpoint", async (req, res) => {
  try {
    const state = await getActionEndpointReviewState(req.params.clientId);
    const isSourceAdmin = Boolean(state)
      && state!.serverId === req.serverId
      && await currentUserHasServerCapability(req, "manageIntegrations");
    if (!state || !isSourceAdmin) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      origin: state.origin,
      action_endpoint: state.live,
      pending_action_endpoint: state.pending,
      requested_at: state.requestedAt?.toISOString() ?? null,
      reject_reason: state.rejectReason,
      own_server_actions: ownServerActionsView(state),
    });
  } catch (error) {
    sendJsonServerError(req, res, { error: "Failed to load the app's action endpoint", logPrefix: "Read app action endpoint error:", err: error });
  }
});

/**
 * RFC 076 §17, for a server_local App only (null otherwise): what its own
 * Server's admins confirmed, when and by whom, whether its card buttons may act
 * on this Server now, and `state`, so a screen draws one case without
 * inferring it:
 * - `no_endpoint`: the App has no action endpoint in force;
 * - `not_allowed`: nothing confirmed;
 * - `endpoint_changed`: the confirmed endpoint is not the one in force (allow again);
 * - `suspended`: confirmed and in force, but the link-preview registration is
 *   suspended (its domain proof failed or names another App); it acts again
 *   once the registration is resumed;
 * - `allowed`: in force.
 */
function ownServerActionsView(state: NonNullable<Awaited<ReturnType<typeof getActionEndpointReviewState>>>) {
  if (state.appType !== "server_local") return null;
  const confirmed = state.ownServerActionEndpoint;
  const view = state.live === null ? "no_endpoint"
    : confirmed === null ? "not_allowed"
      : confirmed !== state.live ? "endpoint_changed"
        : state.suspended ? "suspended" : "allowed";
  return {
    state: view,
    confirmed_action_endpoint: confirmed,
    confirmed_at: state.ownServerActionsConfirmedAt?.toISOString() ?? null,
    confirmed_by: state.ownServerActionsConfirmedBy,
    in_force: view === "allowed",
  };
}

const OWN_SERVER_ACTIONS_INVALID = "OWN_SERVER_ACTIONS_INVALID";
const OWN_SERVER_ACTIONS_NOT_SERVER_LOCAL = "OWN_SERVER_ACTIONS_NOT_SERVER_LOCAL";
const OWN_SERVER_ACTIONS_NO_ENDPOINT = "OWN_SERVER_ACTIONS_NO_ENDPOINT";
const OWN_SERVER_ACTIONS_ENDPOINT_CHANGED = "OWN_SERVER_ACTIONS_ENDPOINT_CHANGED";
/** The same answer as GET .../action-endpoint for anyone who isn't the App's own Server's admin. */
const OWN_SERVER_APP_NOT_FOUND = { code: "APP_NOT_FOUND", error: "No App with this id belongs to this Server." };

// RFC 076 §17: the App's own Server's admins (a person with manageIntegrations
// there; this router takes no agent credential) let a server_local App's card
// buttons call its action endpoint on this Server, or withdraw that. The body
// names the endpoint exactly as shown: if the App changed it meanwhile, 409
// with the one in force, and nothing is confirmed. Anyone else, another
// Server, an unknown App: 404, the same as the read above.
integrationRouter.put("/clients/:clientId/action-endpoint/own-server-actions", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const actionEndpoint = typeof req.body?.action_endpoint === "string" ? req.body.action_endpoint : null;
    if (!actionEndpoint || Object.keys(req.body ?? {}).some((key) => key !== "action_endpoint")) {
      refuse(res, 400, { code: OWN_SERVER_ACTIONS_INVALID, error: "Send only action_endpoint, with the action endpoint exactly as you were shown it." });
      return;
    }
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      refuse(res, 404, OWN_SERVER_APP_NOT_FOUND);
      return;
    }
    const result = await confirmOwnServerLinkCardActions({ clientId: req.params.clientId, serverId: req.serverId!, userId: req.userId!, actionEndpoint });
    sendOwnServerActionsResult(res, result);
  } catch (error) {
    sendJsonServerError(req, res, { error: "Failed to allow the app's card actions", logPrefix: "Confirm own-server card actions error:", err: error });
  }
});

integrationRouter.delete("/clients/:clientId/action-endpoint/own-server-actions", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      refuse(res, 404, OWN_SERVER_APP_NOT_FOUND);
      return;
    }
    const result = await withdrawOwnServerLinkCardActions({ clientId: req.params.clientId, serverId: req.serverId!, userId: req.userId! });
    sendOwnServerActionsResult(res, result);
  } catch (error) {
    sendJsonServerError(req, res, { error: "Failed to withdraw the app's card actions", logPrefix: "Withdraw own-server card actions error:", err: error });
  }
});

function sendOwnServerActionsResult(res: Response, result: OwnServerLinkCardActionsResult) {
  switch (result.kind) {
    case "not_found":
      refuse(res, 404, OWN_SERVER_APP_NOT_FOUND);
      return;
    case "not_server_local":
      refuse(res, 409, { code: OWN_SERVER_ACTIONS_NOT_SERVER_LOCAL, error: "Only an App made on this Server and not published can have its card actions allowed here." });
      return;
    case "no_action_endpoint":
      refuse(res, 409, { code: OWN_SERVER_ACTIONS_NO_ENDPOINT, error: "This App has no action endpoint to allow yet." });
      return;
    case "endpoint_changed":
      // The one in force is in the GET above; the person reads it again before allowing it.
      refuse(res, 409, { code: OWN_SERVER_ACTIONS_ENDPOINT_CHANGED, error: "The App changed its action endpoint, so check the new one and allow it again." });
      return;
    case "confirmed":
      res.json({ confirmed_action_endpoint: result.actionEndpoint, confirmed_at: result.confirmedAt.toISOString() });
      return;
    case "withdrawn":
      res.json({ confirmed_action_endpoint: null, confirmed_at: null });
      return;
  }
}

// First-view link-preview prompt (docs/development/app-link-previews.md). A
// member answers for themselves on the current Server; the App must be
// enabled, installed here and registered for link previews, or the answer is
// a uniform 404. Declining is also how previews are turned off later.
function sendLinkPreviewAppNotFound(res: Response) {
  res.status(404).json({ error: "App not found", code: LINK_PREVIEW_APP_NOT_FOUND });
}

integrationRouter.post("/clients/:clientId/link-preview-consent", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const result = await allowLinkPreviews({ serverId: req.serverId!, userId: req.userId!, clientId: req.params.clientId });
    if (result.kind === "not_found") {
      sendLinkPreviewAppNotFound(res);
      return;
    }
    if (result.kind === "scopes_not_allowed") {
      res.status(409).json({ error: "This App is not allowed to receive your Raft profile", code: LINK_PREVIEW_SCOPES_NOT_ALLOWED });
      return;
    }
    res.json({ app: result.app, scopes: result.scopes, source: result.source, granted_at: result.grantedAt.toISOString() });
  } catch (error) {
    sendJsonServerError(req, res, { error: "Failed to allow link previews", logPrefix: "Allow link previews error:", err: error });
  }
});

integrationRouter.post("/clients/:clientId/link-preview-decline", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const result = await declineLinkPreviews({ serverId: req.serverId!, userId: req.userId!, clientId: req.params.clientId });
    if (result.kind === "not_found") {
      sendLinkPreviewAppNotFound(res);
      return;
    }
    res.json({ app: result.app, declined_at: result.declinedAt.toISOString() });
  } catch (error) {
    sendJsonServerError(req, res, { error: "Failed to decline link previews", logPrefix: "Decline link previews error:", err: error });
  }
});

integrationRouter.get("/link-preview-consents", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const { allowed, declined } = await listLinkPreviewChoices({ serverId: req.serverId!, userId: req.userId! });
    res.json({
      allowed: allowed.map((row) => ({ app: row.app, scopes: row.scopes, source: row.source, granted_at: row.grantedAt.toISOString() })),
      declined: declined.map((row) => ({ app: row.app, declined_at: row.declinedAt.toISOString() })),
    });
  } catch (error) {
    sendJsonServerError(req, res, { error: "Failed to load link preview choices", logPrefix: "List link preview choices error:", err: error });
  }
});

// The app's own Server confirms its current text: a server_local app, or the
// source installation of a shared or published one.
integrationRouter.put("/clients/:clientId/prompt-text/confirm", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can confirm an app's prompt text" });
      return;
    }
    const expectedRevisionId = typeof req.body?.expected_revision_id === "string" ? req.body.expected_revision_id.trim() : "";
    if (!PROMPT_TEXT_REVISION_ID.test(expectedRevisionId)) {
      sendExpectedPermissionsRequired(res);
      return;
    }
    const result = await confirmPromptTextForSource({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      userId: req.userId!,
      expectedRevisionId,
    });
    if (result.kind === "not_found") {
      res.status(404).json({ error: "App not found" });
      return;
    }
    if (result.kind === "changed") {
      res.status(409).json({
        error: "The app's text changed after it was shown. Review the current text and confirm again.",
        code: APP_PERMISSIONS_CHANGED,
        current_text_revision_id: result.current.revisionId,
        current_text: promptTextBody(result.current.text),
      });
      return;
    }
    res.json({ local_confirmed_revision_id: result.revisionId });
  } catch (error) {
    sendJsonServerError(req, res, { error: "Failed to confirm app prompt text", logPrefix: "Confirm app prompt text error:", err: error });
  }
});

integrationRouter.put("/clients/:clientId/app-notifications/webhook", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")
      || !await currentServerOwnsOAuthClient(req, req.params.clientId)) {
      res.status(403).json({ error: "Only an owner or admin of the app source server can configure its webhook" });
      return;
    }
    const configured = await configureAppWebhook({
      clientId: req.params.clientId,
      actorUserId: req.userId!,
      endpointUrl: req.body?.endpointUrl ?? req.body?.endpoint_url,
    });
    if (!configured) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json({
      endpoint_url: configured.endpointUrl,
      config_revision: configured.revision,
      enabled: configured.enabled,
      ...(configured.secret ? { signing_secret: configured.secret } : {}),
    });
  } catch (error) {
    if (error instanceof AppWebhookConfigError) {
      res.status(400).json({ error: error.message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to configure app webhook", logPrefix: "Configure app webhook error:", err: error });
  }
});

integrationRouter.post("/clients/:clientId/app-notifications/webhook/rotate-secret", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    if (!await currentUserHasServerCapability(req, "rotateServerSecrets")
      || !await currentServerOwnsOAuthClient(req, req.params.clientId)) {
      res.status(403).json({ error: "Only an owner or admin of the app source server can rotate its webhook secret" });
      return;
    }
    if (await refuseWithoutRecentSecondFactor(res, req.userId!, webSessionFamilyOf(req), "integration_webhook_secret_rotate")) return;
    const rotated = await rotateAppWebhookSecret({
      clientId: req.params.clientId,
      actorUserId: req.userId!,
      emergency: req.body?.emergency === true,
    });
    if (!rotated) {
      res.status(404).json({ error: "Active webhook configuration not found" });
      return;
    }
    res.json({
      signing_secret: rotated.secret,
      config_revision: rotated.revision,
      previous_valid_until: rotated.previousValidUntil,
      emergency: rotated.emergency,
    });
  } catch (error) {
    if (error instanceof AppWebhookConfigError) {
      res.status(400).json({ error: error.message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to rotate app webhook secret", logPrefix: "Rotate app webhook secret error:", err: error });
  }
});

integrationRouter.delete("/clients/:clientId/app-notifications/webhook", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")
      || !await currentServerOwnsOAuthClient(req, req.params.clientId)) {
      res.status(403).json({ error: "Only an owner or admin of the app source server can disable its webhook" });
      return;
    }
    const disabled = await disableAppWebhook({ clientId: req.params.clientId, actorUserId: req.userId! });
    if (!disabled) {
      res.status(404).json({ error: "Webhook configuration not found" });
      return;
    }
    res.json({ config_revision: disabled.revision, enabled: disabled.enabled });
  } catch (error) {
    sendJsonServerError(req, res, { error: "Failed to disable app webhook", logPrefix: "Disable app webhook error:", err: error });
  }
});

integrationRouter.post("/clients/:clientId/regenerate-secret", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "rotateServerSecrets")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    if (await refuseWithoutRecentSecondFactor(res, req.userId!, webSessionFamilyOf(req), "integration_client_secret_regenerate")) return;
    const regenerated = await oauthService.regenerateClientSecretForUser({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      actorUserId: req.userId!,
    });
    if (!regenerated) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json(regenerated);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to regenerate client secret", logPrefix: "Regenerate OAuth client secret error:", err });
  }
});

integrationRouter.post("/clients/:clientId/request-publish", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const updated = await oauthService.requestOAuthClientPublish({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      requestedByUserId: req.userId!,
    });
    if (!updated) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    // Respond with the install-joined editor row (same shape as GET /clients):
    // the bare update result drops botGrant/installationId, and the editor
    // replaces its row with the response — it would lose the grant state on
    // every unrelated save, and show a stale grant after a disable cascade.
    const editorRow = await oauthService.getOAuthClientWithInstallState(req.serverId!, updated.id);
    res.json(editorRow ?? updated);
  } catch (err: any) {
    const message = err?.message || "Failed to request marketplace publish";
    if (message.includes("description")) {
      res.status(400).json({ error: message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to request marketplace publish", logPrefix: "Request OAuth client publish error:", err });
  }
});

// Withdraw a marketplace publish request that is still waiting for review:
// the app goes back to private and keeps everything else.
integrationRouter.post("/clients/:clientId/withdraw-publish", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const updated = await oauthService.withdrawOAuthClientPublishRequest({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      requestedByUserId: req.userId!,
    });
    if (!updated) {
      res.status(404).json({ error: "No marketplace publish request is waiting for review" });
      return;
    }
    res.json(updated);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to withdraw marketplace publish request", logPrefix: "Withdraw OAuth client publish request error:", err });
  }
});

integrationRouter.post("/clients/:clientId/request-unpublish", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const updated = await oauthService.requestOAuthClientUnpublish({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      requestedByUserId: req.userId!,
    });
    if (!updated) {
      res.status(404).json({ error: "Published marketplace app not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to request marketplace offline review", logPrefix: "Request OAuth client unpublish error:", err });
  }
});

// Private share links: each installs the App once, on the one Server the
// creator names by slug (#proj-apps:769a57d4). Creation answers the same shape
// whether or not the slug names a Server, and never echoes a resolved name or
// id. /api/integrations has no write limiter; these routes add none.
integrationRouter.get("/clients/:clientId/share-links", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const links = await oauthService.listOAuthClientShareLinks({
      serverId: req.serverId!,
      clientId: req.params.clientId,
    });
    if (!links) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json({ links });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to load private share links", logPrefix: "List OAuth client share links error:", err });
  }
});

integrationRouter.post("/clients/:clientId/share-links", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const targetServerSlug = oauthService.normalizeShareLinkTargetServerSlug(req.body?.targetServerSlug);
    if (!targetServerSlug) {
      res.status(400).json({
        error: "targetServerSlug is required: the slug of the one server this link installs the app on",
        code: "share_link_target_required",
      });
      return;
    }
    const created = await oauthService.createOAuthClientShareLink({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      targetServerSlug,
      createdByUserId: req.userId!,
      expiresInDays: typeof req.body?.expiresInDays === "number" ? req.body.expiresInDays : undefined,
    });
    if (!created) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json(created);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to create private share link", logPrefix: "Create OAuth client share link error:", err });
  }
});

integrationRouter.delete("/clients/:clientId/share-links/:linkId", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const [link] = await oauthService.revokeOAuthClientShareLinks({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      linkId: req.params.linkId,
      revokedByUserId: req.userId!,
    }) ?? [];
    if (!link) {
      res.status(404).json({ error: "OAuth client share link not found" });
      return;
    }
    res.json(link);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to revoke private share link", logPrefix: "Revoke OAuth client share link error:", err });
  }
});

/**
 * One answer for every invite that can't install for this caller and isn't
 * theirs to ask about: unknown token, revoked, used or expired link, a link to
 * an unknown slug, a link for a Server they aren't in, an install on another
 * Server. The same status and body on both routes, so none can be told apart.
 */
function sendPrivateAppInviteInvalid(res: Response) {
  res.status(404).json({ error: "This private app invite is invalid or has expired", code: "private_app_invite_invalid" });
}

/**
 * A member of the link's target Server without owner/admin: they are in that
 * Server, so naming it tells them nothing new, only whom to ask.
 */
function sendPrivateAppInviteAdminRequired(res: Response, targetServer: { name: string; slug: string }) {
  res.status(403).json({
    error: `An owner or admin of ${targetServer.name} needs to install this app`,
    code: "private_app_invite_admin_required",
    targetServer,
  });
}

function sendPrivateAppInviteLookup(res: Response, found: oauthService.ShareInviteLookup | null) {
  if (!found) {
    sendPrivateAppInviteInvalid(res);
    return;
  }
  if (found.status === "admin_required") {
    sendPrivateAppInviteAdminRequired(res, found.targetServer);
    return;
  }
  res.json(found.invite);
}

integrationInviteRouter.get("/:token", async (req, res) => {
  try {
    sendPrivateAppInviteLookup(res, await oauthService.getOAuthClientShareInvite({
      token: req.params.token,
      userId: req.userId!,
    }));
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to load private app invite", logPrefix: "Get OAuth client share invite error:", err });
  }
});

/** An install's refusal without the second step (the install card's, actionCardSecondFactor.ts, says the same). */
const INSTALL_APP_SECOND_FACTOR_ERROR = "Confirm it's you with your second step before installing this app.";

integrationInviteRouter.post("/:token/install", async (req, res) => {
  try {
    const serverId = typeof req.body?.serverId === "string" ? req.body.serverId.trim() : "";
    if (!serverId) {
      res.status(400).json({ error: "serverId is required" });
      return;
    }
    const expected = parseExpectedAppPermissions(req.body);
    if (!expected) {
      sendExpectedPermissionsRequired(res);
      return;
    }
    // Optional, as the marketplace install: also add the App's bot (true) or
    // decline it (false); absent leaves the choice for later ("pending").
    const bot: unknown = req.body?.bot;
    if (bot !== undefined && typeof bot !== "boolean") {
      res.status(400).json({ error: "bot must be a boolean" });
      return;
    }
    // Installing grants the app access to the server: as the marketplace install.
    if (await refuseUnverifiedApprover(res, req.userId!, webSessionFamilyOf(req), INSTALL_APP_SECOND_FACTOR_ERROR)) return;
    const found = await oauthService.installOAuthClientShareInvite({
      token: req.params.token,
      userId: req.userId!,
      serverId,
      expected,
      bot,
    });
    // The install added the App's bot: member lists show it now (#11295).
    const addedBot = found?.status === "ok" && bot === true ? found.invite.client.bot : undefined;
    if (addedBot?.grant === "granted" && addedBot.agentId) {
      await broadcastManagedBotListingChanged(req, { serverId, agentId: addedBot.agentId });
    }
    sendPrivateAppInviteLookup(res, found);
  } catch (err) {
    if (sendInstallExpectationError(res, err)) return;
    sendJsonServerError(req, res, { error: "Failed to install private app invite", logPrefix: "Install OAuth client share invite error:", err });
  }
});

// Install and approve-update record the scopes and groups the admin was shown,
// and the prompt-text revision they read (task #4): the client
// sends them back, and only an exact match with the app's current declaration
// passes.
function sendExpectedPermissionsRequired(res: Response) {
  res.status(400).json({
    error: "Send expected_scopes, expected_groups and expected_text_revision_id as shown to the admin. Reload the page and try again.",
    code: EXPECTED_PERMISSIONS_REQUIRED,
  });
}

function promptTextBody(text: AppPromptText) {
  return { name: text.name, description: text.description, when_to_use: text.whenToUse };
}

function sendAppPermissionsChanged(res: Response, error: AppPermissionsChangedError) {
  res.status(409).json({
    error: error.message,
    code: APP_PERMISSIONS_CHANGED,
    current_scopes: error.current.scopes,
    current_groups: error.current.groups,
    current_text_revision_id: error.current.textRevisionId ?? null,
    current_text: error.current.text ? promptTextBody(error.current.text) : null,
  });
}

/** 409 / 400 for a request that didn't confirm what is current; false for anything else. */
function sendInstallExpectationError(res: Response, error: unknown): boolean {
  if (error instanceof AppPermissionsChangedError) {
    sendAppPermissionsChanged(res, error);
    return true;
  }
  if (error instanceof ExpectedPermissionsRequiredError) {
    sendExpectedPermissionsRequired(res);
    return true;
  }
  return false;
}

integrationRouter.post("/marketplace/:clientId/install", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can install marketplace apps" });
      return;
    }
    const expected = parseExpectedAppPermissions(req.body);
    if (!expected) {
      sendExpectedPermissionsRequired(res);
      return;
    }
    // Optional: also add the App's bot (true) or decline it (false) in the
    // same transaction; absent leaves the choice for later ("pending").
    const bot: unknown = req.body?.bot;
    if (bot !== undefined && typeof bot !== "boolean") {
      res.status(400).json({ error: "bot must be a boolean" });
      return;
    }
    // Installing grants the app access to the server, as the install card
    // (services/actionCardSecondFactor.ts integration:install_marketplace_app).
    if (await refuseUnverifiedApprover(res, req.userId!, webSessionFamilyOf(req), INSTALL_APP_SECOND_FACTOR_ERROR)) return;
    const installed = await oauthService.installMarketplaceOAuthClient({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      installedByUserId: req.userId!,
      expected,
      bot,
    });
    if (!installed) {
      res.status(404).json({ error: "Marketplace app not found" });
      return;
    }
    // The install added the App's bot (bot: true): member lists show it now (#11295).
    const addedBot = (installed as { bot?: { grant?: string; agentId?: string } }).bot;
    if (addedBot?.grant === "granted" && addedBot.agentId) {
      await broadcastManagedBotListingChanged(req, { serverId: req.serverId!, agentId: addedBot.agentId });
    }
    res.json(installed);
  } catch (err) {
    if (sendInstallExpectationError(res, err)) return;
    sendJsonServerError(req, res, { error: "Failed to install marketplace app", logPrefix: "Install marketplace OAuth client error:", err });
  }
});

integrationRouter.get("/marketplace/:clientId/install/app-notifications", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can read installed App Notifications settings" });
      return;
    }
    const state = await getAppNotificationInstallationState({
      clientId: req.params.clientId,
      serverId: req.serverId!,
    });
    if (!state) {
      res.status(404).json({ error: "Active app installation not found" });
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      installation_id: state.installationId,
      status: state.status,
      approved_request_revision_id: state.approvedRequestRevisionId,
      requested_groups: state.requestedGroups,
      requested_events: state.requestedEvents,
      approved_groups: state.approvedGroups,
      // The installer approves groups; the App's own installation events
      // (installation.bot_changed) need none and are not listed here.
      subscribed_events: groupGatedSubscriptions(state.subscribedEvents),
      effective_groups: state.effective.groups,
      effective_events: state.effective.events,
      grant_revision: state.grantRevision,
      subscription_revision: state.subscriptionRevision,
      app_review_pending: !!state.pendingRevisionId,
      approval_required: state.approvalRequired,
      requested_scopes: state.requestedScopes,
      approved_scopes: state.approvedScopes,
      new_scopes: state.newScopes,
      // Task #4: approving with expected_text_revision_id = current.id also
      // confirms the text this Server's agents read.
      prompt_text: {
        confirmed: state.promptText.confirmed ? promptTextRevisionView(state.promptText.confirmed) : null,
        current: state.promptText.current ? promptTextRevisionView(state.promptText.current) : null,
        confirmation_required: state.promptText.confirmationRequired,
      },
    });
  } catch (error) {
    sendJsonServerError(req, res, { error: "Failed to load installed App Notifications settings", logPrefix: "Read installed App Notifications state error:", err: error });
  }
});

integrationRouter.put("/marketplace/:clientId/install/app-notifications/grant", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can approve App Notifications permissions" });
      return;
    }
    const [install] = await getDb().select({ id: oauthClientInstalls.id })
      .from(oauthClientInstalls)
      .where(and(
        eq(oauthClientInstalls.serverId, req.serverId!),
        eq(oauthClientInstalls.clientId, req.params.clientId),
        eq(oauthClientInstalls.status, "active"),
      )).limit(1);
    if (!install) {
      res.status(404).json({ error: "Active app installation not found" });
      return;
    }
    const expected = parseExpectedAppPermissions(req.body);
    if (!expected) {
      sendExpectedPermissionsRequired(res);
      return;
    }
    // Approving an installed app's new scopes and data groups grants it more access.
    if (await refuseUnverifiedApprover(res, req.userId!, webSessionFamilyOf(req), "Confirm it's you with your second step before approving this app's new permissions.")) return;
    const updated = await updateAppInstallationGrant({
      installationId: install.id,
      actorUserId: req.userId!,
      expected,
    });
    if (!updated) {
      res.status(404).json({ error: "Active app installation not found" });
      return;
    }
    res.json({
      installation_id: updated.id,
      approved_request_revision_id: updated.approvedRequestRevisionId,
      approved_groups: updated.approvedGroups,
      subscribed_events: groupGatedSubscriptions(updated.subscribedEvents),
      grant_revision: updated.grantRevision,
      subscription_revision: updated.subscriptionRevision,
      approved_scopes: updated.approvedScopes,
      confirmed_text_revision_id: updated.confirmedTextRevisionId,
    });
  } catch (error) {
    if (sendInstallExpectationError(res, error)) return;
    if (error instanceof AppOutboundPermissionError) {
      res.status(400).json({ error: error.message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to update installed App Notifications permissions", logPrefix: "Update installed App Notifications permissions error:", err: error });
  }
});

integrationRouter.delete("/marketplace/:clientId/install", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can uninstall marketplace apps" });
      return;
    }
    const result = await oauthService.uninstallMarketplaceOAuthClient({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      revokedByUserId: req.userId!,
    });
    if (!result) {
      res.status(404).json({ error: "Marketplace app not found" });
      return;
    }
    res.json(result);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to uninstall marketplace app", logPrefix: "Uninstall marketplace OAuth client error:", err });
  }
});

// ── App-owned Bot grant / revoke (design-v3 §identity) ────────────────────────
// Granting the bot capability to an installation creates the managed bot agent
// + binding atomically; revoking disables it. The Bot itself is created lazily
// at grant-time, not install-time, so existing installs can be retrofitted.
integrationRouter.post("/clients/:clientId/install/bot", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage the app bot" });
      return;
    }
    const action = typeof req.body?.action === "string" ? req.body.action : "grant";
    if (action !== "grant" && action !== "revoke") {
      res.status(400).json({ error: "action must be 'grant' or 'revoke'" });
      return;
    }
    // Adding the app's bot gives the app a bot identity here (its bot key);
    // removing it is never gated.
    const granting = action === "grant";
    if (granting && await refuseUnverifiedApprover(res, req.userId!, webSessionFamilyOf(req), "Confirm it's you with your second step before adding this app's bot.")) return;
    const result = await getDb().transaction(async (tx) => {
      // Source-owned apps are usable on their own server without a
      // marketplace-style install; materialize the source installation lazily
      // so the bot grant has a row to bind to.
      const { ensureLocalAppSourceInstallation } = await import("../services/appSourceInstallationService");
      await ensureLocalAppSourceInstallation(req.params.clientId, tx, { expectedServerId: req.serverId! });
      const [install] = await tx.select({
        id: oauthClientInstalls.id,
        clientId: oauthClientInstalls.clientId,
        serverId: oauthClientInstalls.serverId,
        status: oauthClientInstalls.status,
        botGrant: oauthClientInstalls.botGrant,
      }).from(oauthClientInstalls).where(and(
        eq(oauthClientInstalls.serverId, req.serverId!),
        eq(oauthClientInstalls.clientId, req.params.clientId),
        eq(oauthClientInstalls.status, "active"),
      )).limit(1).for("update");
      if (!install) return null;
      // Revoke on an install that never had a bot ("Don't add") only records
      // "revoked"; the marketplace install's `bot` option uses this same path.
      const { setInstallationBotGrant } = await import("../services/appBotIdentityService");
      return setInstallationBotGrant(tx, {
        install,
        action,
        actor: { type: "human", id: req.userId! },
        requestedPermissions: Array.isArray(req.body?.permissions) ? req.body.permissions : undefined,
      });
    });
    if (!result) {
      res.status(404).json({ error: "Active app installation not found" });
      return;
    }
    const { listingChanged, ...body } = result;
    if (listingChanged) await broadcastManagedBotListingChanged(req, listingChanged);
    res.json(body);
  } catch (err: unknown) {
    const errName = err instanceof Error ? err.name : String(err);
    const errCode = (err as { code?: string })?.code;
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errCode === "app_bot_handle_conflict" || errName === "AppBotHandleConflictError") {
      res.status(409).json({ error: errMsg, code: "app_bot_handle_conflict" });
      return;
    }
    if (errCode === "app_bot_agent_deleted" || errName === "AppBotAgentDeletedError") {
      res.status(409).json({ error: errMsg, code: "app_bot_agent_deleted" });
      return;
    }
    if (errCode === "app_bot_install_not_granted" || errName === "AppBotInstallNotGrantedError") {
      res.status(403).json({ error: errMsg });
      return;
    }
    if (errCode === "app_bot_already_bound" || errName === "AppBotAlreadyBoundError") {
      res.status(409).json({ error: errMsg });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to manage app bot", logPrefix: "App bot grant error:", err });
  }
});

integrationRouter.post("/clients/:clientId/logo", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const file = await runSingleLogoUpload(req);
    if (!file) {
      res.status(400).json({ error: "No logo file provided" });
      return;
    }
    // The logo IS every bound bot's avatar (all servers): one transaction, so
    // the logo and the bots never disagree; the bots re-read after commit.
    const written = await getDb().transaction(async (tx) => {
      const logo = await oauthService.updateOAuthClientLogo({
        serverId: req.serverId!,
        clientId: req.params.clientId,
        fileBuffer: file.buffer,
        actorUserId: req.userId!,
      }, { executor: tx });
      if (!logo) return null;
      const bots = await agentService.syncAppBotAvatarsToLogo(tx, { clientId: logo.client.id, logoUrl: logo.client.logoUrl });
      return { ...logo, bots };
    });
    if (!written) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    // Committed: only now is the replaced logo object unreferenced.
    oauthService.deleteStaleIntegrationLogo(written.staleLogoStorageKey);
    const updated = written.client;
    for (const bot of written.bots) broadcastAgentUpdated(req, bot.serverId, bot.agentId);
    // Respond with the install-joined editor row (same shape as GET /clients):
    // the bare update result drops botGrant/installationId, and the editor
    // replaces its row with the response — it would lose the grant state on
    // every unrelated save, and show a stale grant after a disable cascade.
    const editorRow = await oauthService.getOAuthClientWithInstallState(req.serverId!, updated.id);
    res.json(editorRow ?? updated);
  } catch (err) {
    if (handleLogoUploadError(err, res)) return;
    sendJsonServerError(req, res, { error: "Failed to upload OAuth client logo", logPrefix: "Upload OAuth client logo error:", err });
  }
});

integrationRouter.delete("/clients/:clientId/logo", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    // Clearing the logo clears every bound bot's avatar: same transaction and
    // refresh rule as the upload above.
    const written = await getDb().transaction(async (tx) => {
      const logo = await oauthService.clearOAuthClientLogo({
        serverId: req.serverId!,
        clientId: req.params.clientId,
        actorUserId: req.userId!,
      }, { executor: tx });
      if (!logo) return null;
      const bots = await agentService.syncAppBotAvatarsToLogo(tx, { clientId: logo.client.id, logoUrl: null });
      return { ...logo, bots };
    });
    if (!written) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    // Committed: only now is the removed logo object unreferenced.
    oauthService.deleteStaleIntegrationLogo(written.staleLogoStorageKey);
    const updated = written.client;
    for (const bot of written.bots) broadcastAgentUpdated(req, bot.serverId, bot.agentId);
    // Respond with the install-joined editor row (same shape as GET /clients):
    // the bare update result drops botGrant/installationId, and the editor
    // replaces its row with the response — it would lose the grant state on
    // every unrelated save, and show a stale grant after a disable cascade.
    const editorRow = await oauthService.getOAuthClientWithInstallState(req.serverId!, updated.id);
    res.json(editorRow ?? updated);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to clear OAuth client logo", logPrefix: "Clear OAuth client logo error:", err });
  }
});

integrationRouter.delete("/clients/:clientId", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    // The App's bots (all servers) fall back to the generated avatar in the
    // same transaction, before the delete (the installation cascade unlinks
    // them), and re-read after commit; its logo object is deleted after commit.
    const written = await getDb().transaction(async (tx) => {
      const client = await oauthService.lockDeletableOAuthClient(tx, {
        serverId: req.serverId!,
        clientId: req.params.clientId,
      });
      if (!client) return null;
      const bots = await agentService.syncAppBotAvatarsToLogo(tx, { clientId: client.id, logoUrl: null });
      const deleted = await oauthService.deleteLockedOAuthClient(tx, client, {
        serverId: req.serverId!,
        deletedByUserId: req.userId!,
      });
      return { ...deleted, bots };
    });
    if (!written) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    oauthService.deleteStaleIntegrationLogo(written.staleLogoStorageKey);
    for (const bot of written.bots) broadcastAgentUpdated(req, bot.serverId, bot.agentId);
    await announceRemovedAppBots(req, written.removedBots);
    res.json(written.client);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to delete OAuth client", logPrefix: "Delete OAuth client error:", err });
  }
});

/**
 * Agent access by an app is managed by server owners/admins and by the
 * agent's own creator.
 */
async function canManageAgentAccess(
  req: Request,
  agent: { creatorType: string | null; creatorId: string | null; assistantOwnerUserId: string | null } | null,
): Promise<boolean> {
  // Role read fresh (not the request's cached one): a removed or demoted member
  // loses this at once, the same as for the capability path.
  const role = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
  if (!role) return false;
  return userCanActOnAgentResource(role, req.userId!, agent ?? { creatorType: null, creatorId: null, assistantOwnerUserId: null }, "manageExternalAuth");
}

integrationRouter.post("/requests/:requestId/approve", async (req, res) => {
  try {
    if (!await canManageAgentAccess(req, await oauthService.getAgentForAccessRequest(req.serverId!, req.params.requestId))) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    if (await refuseUnverifiedApprover(res, req.userId!, webSessionFamilyOf(req), "Confirm it's you with your second step before approving this app's access.")) return;
    const remember = !!req.body?.remember;
    const result = await oauthService.approveAccessRequest({
      serverId: req.serverId!,
      requestId: req.params.requestId,
      resolvedByUserId: req.userId!,
      remember,
    });
    res.json(result);
  } catch (err: any) {
    if (err instanceof oauthService.AgentScopeNotApprovedError) {
      res.status(409).json({ error: err.message, code: "scope_not_approved", unapprovedScopes: err.unapprovedScopes });
      return;
    }
    const message = err?.message || "Failed to approve request";
    if (message.includes("not found")) {
      res.status(404).json({ error: message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to approve integration request", logPrefix: "Approve integration request error:", err });
  }
});

integrationRouter.post("/requests/:requestId/deny", async (req, res) => {
  try {
    if (!await canManageAgentAccess(req, await oauthService.getAgentForAccessRequest(req.serverId!, req.params.requestId))) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const updated = await oauthService.denyAccessRequest({
      serverId: req.serverId!,
      requestId: req.params.requestId,
      resolvedByUserId: req.userId!,
    });
    if (!updated) {
      res.status(404).json({ error: "Access request not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to deny integration request", logPrefix: "Deny integration request error:", err });
  }
});

integrationRouter.post("/grants/:grantId/revoke", async (req, res) => {
  try {
    if (!await canManageAgentAccess(req, await oauthService.getAgentForGrant(req.serverId!, req.params.grantId))) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const updated = await oauthService.revokeGrant({
      serverId: req.serverId!,
      grantId: req.params.grantId,
      revokedByUserId: req.userId!,
    });
    if (!updated) {
      res.status(404).json({ error: "Grant not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to revoke integration grant", logPrefix: "Revoke integration grant error:", err });
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The agent in the active server, or null after answering 404. */
async function loadAgentInServer(req: Request, res: Response) {
  const agentId = String(req.params.agentId);
  if (!UUID_RE.test(agentId)) {
    res.status(404).json({ error: "Agent not found" });
    return null;
  }
  const [agent] = await getDb().select({
    id: agents.id,
    serverId: agents.serverId,
    creatorType: agents.creatorType,
    creatorId: agents.creatorId,
    assistantOwnerUserId: agents.assistantOwnerUserId,
  }).from(agents).where(and(eq(agents.id, agentId), isNull(agents.deletedAt))).limit(1);
  if (!agent || agent.serverId !== req.serverId) {
    res.status(404).json({ error: "Agent not found" });
    return null;
  }
  return agent;
}

/**
 * The agent when the caller may see its private surfaces (its creator, or a
 * server owner/admin), else null after answering 404/403.
 */
async function loadInspectableAgent(req: Request, res: Response): Promise<{ id: string } | null> {
  const agent = await loadAgentInServer(req, res);
  if (!agent) return null;
  const role = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
  if (!role || !roleCanInspectAgentPrivateSurfaces(role, req.userId!, agent)) {
    res.status(403).json({ error: "Only the agent's creator and server owners and admins can view its app events" });
    return null;
  }
  return agent;
}

// Events connected apps sent to this agent, newest first (Agent panel).
integrationRouter.get("/agents/:agentId/events", async (req, res) => {
  try {
    const agent = await loadInspectableAgent(req, res);
    if (!agent) return;
    const { clientId, before, limit } = req.query;
    if (clientId !== undefined && (typeof clientId !== "string" || !(UUID_RE.test(clientId) || clientId === SYSTEM_ASSISTANT_APP))) {
      res.status(400).json({ error: "clientId must be an app id" });
      return;
    }
    let cursor: { createdAt: Date; id: string } | undefined;
    if (before !== undefined) {
      cursor = typeof before === "string" ? decodeAgentAppEventCursor(before) ?? undefined : undefined;
      if (!cursor) {
        res.status(400).json({ error: "before must be a cursor returned by this endpoint" });
        return;
      }
    }
    let pageSize: number | undefined;
    if (limit !== undefined) {
      pageSize = typeof limit === "string" && /^\d+$/.test(limit) ? Number(limit) : Number.NaN;
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > AGENT_APP_EVENTS_MAX_LIMIT) {
        res.status(400).json({ error: `limit must be an integer from 1 to ${AGENT_APP_EVENTS_MAX_LIMIT}` });
        return;
      }
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json(await listAgentAppEvents({ agentId: agent.id, clientId, before: cursor, limit: pageSize }));
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to load agent app events", logPrefix: "List agent app events error:", err });
  }
});

integrationRouter.get("/agents/:agentId/events/:eventId", async (req, res) => {
  try {
    const agent = await loadInspectableAgent(req, res);
    if (!agent) return;
    const event = await getAgentAppEvent({ agentId: agent.id, eventId: req.params.eventId });
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json(event);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to load agent app event", logPrefix: "Read agent app event error:", err });
  }
});

// Apps the caller may grant to this agent (picker for the on-behalf grant).
integrationRouter.get("/agents/:agentId/grantable-apps", async (req, res) => {
  try {
    const agent = await loadAgentInServer(req, res);
    if (!agent) return;
    if (!await canManageAgentAccess(req, agent)) {
      res.status(403).json({ error: "Only the agent's creator and server owners and admins can grant app access" });
      return;
    }
    res.json({ apps: await oauthService.listGrantableAgentApps(req.serverId!) });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to load grantable apps", logPrefix: "List grantable agent apps error:", err });
  }
});

// A person grants an app access to this agent without the agent asking.
integrationRouter.post("/agents/:agentId/grants", async (req, res) => {
  try {
    const agent = await loadAgentInServer(req, res);
    if (!agent) return;
    if (!await canManageAgentAccess(req, agent)) {
      res.status(403).json({ error: "Only the agent's creator and server owners and admins can grant app access" });
      return;
    }
    const { clientId, scopes } = req.body ?? {};
    if (typeof clientId !== "string" || !UUID_RE.test(clientId)) {
      res.status(400).json({ error: "clientId must be an app id" });
      return;
    }
    const result = await oauthService.grantAgentAccessOnBehalf({
      serverId: req.serverId!,
      agentId: agent.id,
      clientId,
      scopes,
      grantedByUserId: req.userId!,
    });
    res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    if (err instanceof oauthService.AgentAccessGrantError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to grant app access", logPrefix: "Grant agent app access error:", err });
  }
});

integrationRouter.get("/agents/:agentId", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "viewAgents")) {
      res.status(403).json({ error: "Only server owners and admins can view agent integrations" });
      return;
    }

    const db = getDb();
    const [agent] = await db.select({ id: agents.id, serverId: agents.serverId }).from(agents).where(eq(agents.id, req.params.agentId)).limit(1);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const items = await oauthService.getAgentIntegrationsOverview(req.params.agentId);
    res.json(items);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to load agent integrations", logPrefix: "List agent integrations error:", err });
  }
});
