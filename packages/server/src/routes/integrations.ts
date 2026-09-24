import { Router, type Request, type Response, type Router as RouterType } from "express";
import { and, eq } from "drizzle-orm";
import multer from "multer";
import type { ServerCapability } from "@botiverse/raft-shared";
import { actorHasServerCapabilityInServer } from "../lib/actorPermissions.js";
import { getDb } from "../db/index.js";
import { agents, oauthClientInstalls, oauthClients } from "../db/schema.js";
import * as oauthService from "../services/oauthService.js";
import {
  createAvatarUpload,
  PROFILE_AVATAR_BAD_FORMAT_MESSAGE,
  PROFILE_AVATAR_TOO_LARGE_MESSAGE,
} from "../services/avatarService.js";
import { getCdnStorage, getStorage } from "../services/storageService.js";
import { streamStorageResponse } from "../services/storageResponseStream.js";
import {
  approvePendingAppOutboundPermissionRevision,
  AppOutboundPermissionError,
  createAppOutboundPermissionRevision,
  updateAppInstallationGrant,
} from "../services/appOutboundPermissionService.js";
import {
  getAppNotificationDeveloperState,
  getAppNotificationInstallationState,
} from "../services/appNotificationManagementService.js";
import {
  AppWebhookConfigError,
  configureAppWebhook,
  disableAppWebhook,
  rotateAppWebhookSecret,
} from "../services/appWebhookConfigService.js";
import { oauthClientIsUserManagedPredicate } from "../services/oauthClientManagementPolicy.js";

export const integrationRouter: RouterType = Router();
export const integrationInviteRouter: RouterType = Router();
export const integrationLogoPublicRouter: RouterType = Router();
const logoUpload = createAvatarUpload();

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

function handleLogoUploadError(err: unknown, res: Response) {
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

function runSingleLogoUpload(req: Request): Promise<Express.Multer.File | null> {
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

integrationRouter.get("/overview", async (req, res) => {
  try {
    const items = await oauthService.getServerIntegrationsOverview(req.serverId!);
    res.json(items);
  } catch (err) {
    console.error("List integrations overview error:", err);
    res.status(500).json({ error: "Failed to load integrations overview" });
  }
});

integrationRouter.get("/built-in", async (req, res) => {
  try {
    const clients = await oauthService.listBuiltInOAuthClients();
    res.json(clients);
  } catch (err) {
    console.error("List built-in OAuth clients error:", err);
    res.status(500).json({ error: "Failed to list built-in OAuth clients" });
  }
});

integrationRouter.get("/marketplace", async (req, res) => {
  try {
    const clients = await oauthService.listMarketplaceOAuthClients(req.serverId!);
    res.json(clients);
  } catch (err) {
    console.error("List marketplace OAuth clients error:", err);
    res.status(500).json({ error: "Failed to list marketplace OAuth clients" });
  }
});

integrationRouter.get("/clients", async (req, res) => {
  try {
    const clients = await oauthService.listOAuthClients(req.serverId!);
    res.json(clients);
  } catch (err) {
    console.error("List OAuth clients error:", err);
    res.status(500).json({ error: "Failed to list OAuth clients" });
  }
});

integrationRouter.post("/clients", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const { name, description, homepageUrl, returnUrl, agentManifestUrl, clientId, allowedScopes, category } = req.body ?? {};
    const created = await oauthService.createOAuthClient({
      serverId: req.serverId!,
      createdByUserId: req.userId!,
      name,
      description,
      homepageUrl,
      returnUrl,
      agentManifestUrl,
      clientId,
      allowedScopes,
      category,
    });
    res.json(created);
  } catch (err: any) {
    const message = err?.message || "Failed to create OAuth client";
    if (
      message.includes("required") ||
      message.includes("clientId") ||
      message.includes("agentManifestUrl") ||
      message.includes("scope") ||
      message.includes("category") ||
      message.includes("returnUrl")
    ) {
      res.status(400).json({ error: message });
      return;
    }
    if (message.includes("duplicate key value")) {
      res.status(409).json({ error: "Client ID is already taken" });
      return;
    }
    console.error("Create OAuth client error:", err);
    res.status(500).json({ error: "Failed to create OAuth client" });
  }
});

integrationRouter.patch("/clients/:clientId", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const { name, description, homepageUrl, returnUrl, agentManifestUrl, allowedScopes, category } = req.body ?? {};
    const updated = await oauthService.updateOAuthClient({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      actorUserId: req.userId!,
      name,
      description,
      homepageUrl,
      returnUrl,
      agentManifestUrl,
      allowedScopes,
      category,
    });
    if (!updated) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json(updated);
  } catch (err: any) {
    const message = err?.message || "Failed to update OAuth client";
    if (message.includes("required") || message.includes("agentManifestUrl") || message.includes("scope") || message.includes("category") || message.includes("returnUrl")) {
      res.status(400).json({ error: message });
      return;
    }
    console.error("Update OAuth client error:", err);
    res.status(500).json({ error: "Failed to update OAuth client" });
  }
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
    console.error("Read App Notifications developer state error:", error);
    res.status(500).json({ error: "Failed to load App Notifications settings" });
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
    console.error("Update App Notifications permission request error:", error);
    res.status(500).json({ error: "Failed to update App Notifications permission request" });
  }
});

integrationRouter.post("/clients/:clientId/app-notifications/permissions/review", async (req, res) => {
  try {
    if (!isMarketplaceReviewer(req.userId!)) {
      res.status(403).json({ error: "Only marketplace reviewers can approve App Notifications permission expansions" });
      return;
    }
    const revision = await approvePendingAppOutboundPermissionRevision({
      clientId: req.params.clientId,
      reviewerUserId: req.userId!,
    });
    if (!revision) {
      res.status(404).json({ error: "Pending App Notifications permission revision not found" });
      return;
    }
    res.json({
      request_revision_id: revision.id,
      revision: revision.revision,
      state: revision.state,
      requested_groups: revision.requestedGroups,
      requested_events: revision.requestedEvents,
    });
  } catch (error) {
    console.error("Review App Notifications permission request error:", error);
    res.status(500).json({ error: "Failed to review App Notifications permission request" });
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
    console.error("Configure app webhook error:", error);
    res.status(500).json({ error: "Failed to configure app webhook" });
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
    console.error("Rotate app webhook secret error:", error);
    res.status(500).json({ error: "Failed to rotate app webhook secret" });
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
    console.error("Disable app webhook error:", error);
    res.status(500).json({ error: "Failed to disable app webhook" });
  }
});

integrationRouter.post("/clients/:clientId/regenerate-secret", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "rotateServerSecrets")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
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
    console.error("Regenerate OAuth client secret error:", err);
    res.status(500).json({ error: "Failed to regenerate client secret" });
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
    res.json(updated);
  } catch (err: any) {
    const message = err?.message || "Failed to request marketplace publish";
    if (message.includes("description")) {
      res.status(400).json({ error: message });
      return;
    }
    console.error("Request OAuth client publish error:", err);
    res.status(500).json({ error: "Failed to request marketplace publish" });
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
    console.error("Request OAuth client unpublish error:", err);
    res.status(500).json({ error: "Failed to request marketplace offline review" });
  }
});

integrationRouter.get("/clients/:clientId/share-link", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const link = await oauthService.getOAuthClientShareLink({
      serverId: req.serverId!,
      clientId: req.params.clientId,
    });
    if (!link) {
      res.status(404).json({ error: "OAuth client share link not found" });
      return;
    }
    res.json(link);
  } catch (err) {
    console.error("Get OAuth client share link error:", err);
    res.status(500).json({ error: "Failed to load private share link" });
  }
});

integrationRouter.post("/clients/:clientId/share-link", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const created = await oauthService.createOAuthClientShareLink({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      createdByUserId: req.userId!,
      expiresInDays: typeof req.body?.expiresInDays === "number" ? req.body.expiresInDays : undefined,
    });
    if (!created) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json(created);
  } catch (err) {
    console.error("Create OAuth client share link error:", err);
    res.status(500).json({ error: "Failed to create private share link" });
  }
});

integrationRouter.delete("/clients/:clientId/share-link", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const link = await oauthService.revokeOAuthClientShareLink({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      revokedByUserId: req.userId!,
    });
    if (!link) {
      res.status(404).json({ error: "OAuth client share link not found" });
      return;
    }
    res.json(link);
  } catch (err) {
    console.error("Revoke OAuth client share link error:", err);
    res.status(500).json({ error: "Failed to revoke private share link" });
  }
});

integrationRouter.post("/clients/:clientId/review-publish", async (req, res) => {
  try {
    if (!isMarketplaceReviewer(req.userId!)) {
      res.status(403).json({ error: "Only Raft marketplace reviewers can review listings" });
      return;
    }
    const updated = await oauthService.reviewOAuthClientPublish({
      reviewerUserId: req.userId!,
      clientId: req.params.clientId,
      status: req.body?.status,
      rejectionReason: req.body?.rejectionReason,
    });
    if (!updated) {
      res.status(404).json({ error: "OAuth client publish request not found" });
      return;
    }
    res.json(updated);
  } catch (err: any) {
    const message = err?.message || "Failed to review marketplace publish request";
    if (message.includes("review status") || message.includes("description")) {
      res.status(400).json({ error: message });
      return;
    }
    console.error("Review OAuth client publish error:", err);
    res.status(500).json({ error: "Failed to review marketplace publish request" });
  }
});

integrationInviteRouter.get("/:token", async (req, res) => {
  try {
    const invite = await oauthService.getOAuthClientShareInvite({
      token: req.params.token,
      userId: req.userId!,
    });
    if (!invite) {
      res.status(404).json({ error: "Private app invite not found" });
      return;
    }
    res.json(invite);
  } catch (err) {
    console.error("Get OAuth client share invite error:", err);
    res.status(500).json({ error: "Failed to load private app invite" });
  }
});

integrationInviteRouter.post("/:token/install", async (req, res) => {
  try {
    const serverId = typeof req.body?.serverId === "string" ? req.body.serverId.trim() : "";
    if (!serverId) {
      res.status(400).json({ error: "serverId is required" });
      return;
    }
    const invite = await oauthService.installOAuthClientShareInvite({
      token: req.params.token,
      userId: req.userId!,
      serverId,
    });
    if (!invite) {
      res.status(403).json({ error: "You can only install this app to a server you own or administer" });
      return;
    }
    res.json(invite);
  } catch (err) {
    console.error("Install OAuth client share invite error:", err);
    res.status(500).json({ error: "Failed to install private app invite" });
  }
});

integrationRouter.post("/marketplace/:clientId/install", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can install marketplace apps" });
      return;
    }
    const installed = await oauthService.installMarketplaceOAuthClient({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      installedByUserId: req.userId!,
    });
    if (!installed) {
      res.status(404).json({ error: "Marketplace app not found" });
      return;
    }
    res.json(installed);
  } catch (err) {
    console.error("Install marketplace OAuth client error:", err);
    res.status(500).json({ error: "Failed to install marketplace app" });
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
      subscribed_events: state.subscribedEvents,
      effective_groups: state.effective.groups,
      effective_events: state.effective.events,
      grant_revision: state.grantRevision,
      subscription_revision: state.subscriptionRevision,
      app_review_pending: !!state.pendingRevisionId,
      approval_required: state.approvalRequired,
    });
  } catch (error) {
    console.error("Read installed App Notifications state error:", error);
    res.status(500).json({ error: "Failed to load installed App Notifications settings" });
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
    const updated = await updateAppInstallationGrant({
      installationId: install.id,
      actorUserId: req.userId!,
    });
    if (!updated) {
      res.status(404).json({ error: "Active app installation not found" });
      return;
    }
    res.json({
      installation_id: updated.id,
      approved_request_revision_id: updated.approvedRequestRevisionId,
      approved_groups: updated.approvedGroups,
      subscribed_events: updated.subscribedEvents,
      grant_revision: updated.grantRevision,
      subscription_revision: updated.subscriptionRevision,
    });
  } catch (error) {
    if (error instanceof AppOutboundPermissionError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error("Update installed App Notifications permissions error:", error);
    res.status(500).json({ error: "Failed to update installed App Notifications permissions" });
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
    console.error("Uninstall marketplace OAuth client error:", err);
    res.status(500).json({ error: "Failed to uninstall marketplace app" });
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
    const updated = await oauthService.updateOAuthClientLogo({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      fileBuffer: file.buffer,
      actorUserId: req.userId!,
    });
    if (!updated) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    if (handleLogoUploadError(err, res)) return;
    console.error("Upload OAuth client logo error:", err);
    res.status(500).json({ error: "Failed to upload OAuth client logo" });
  }
});

integrationRouter.delete("/clients/:clientId/logo", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const updated = await oauthService.clearOAuthClientLogo({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      actorUserId: req.userId!,
    });
    if (!updated) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    console.error("Clear OAuth client logo error:", err);
    res.status(500).json({ error: "Failed to clear OAuth client logo" });
  }
});

integrationRouter.delete("/clients/:clientId", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageIntegrations")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const deleted = await oauthService.deleteOAuthClient({
      serverId: req.serverId!,
      clientId: req.params.clientId,
      deletedByUserId: req.userId!,
    });
    if (!deleted) {
      res.status(404).json({ error: "OAuth client not found" });
      return;
    }
    res.json(deleted);
  } catch (err) {
    console.error("Delete OAuth client error:", err);
    res.status(500).json({ error: "Failed to delete OAuth client" });
  }
});

integrationRouter.post("/requests/:requestId/approve", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageExternalAuth")) {
      res.status(403).json({ error: "Only server owners and admins can manage integrations" });
      return;
    }
    const remember = !!req.body?.remember;
    const result = await oauthService.approveAccessRequest({
      serverId: req.serverId!,
      requestId: req.params.requestId,
      resolvedByUserId: req.userId!,
      remember,
    });
    res.json(result);
  } catch (err: any) {
    const message = err?.message || "Failed to approve request";
    if (message.includes("not found")) {
      res.status(404).json({ error: message });
      return;
    }
    console.error("Approve integration request error:", err);
    res.status(500).json({ error: "Failed to approve integration request" });
  }
});

integrationRouter.post("/requests/:requestId/deny", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageExternalAuth")) {
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
    console.error("Deny integration request error:", err);
    res.status(500).json({ error: "Failed to deny integration request" });
  }
});

integrationRouter.post("/grants/:grantId/revoke", async (req, res) => {
  try {
    if (!await currentUserHasServerCapability(req, "manageExternalAuth")) {
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
    console.error("Revoke integration grant error:", err);
    res.status(500).json({ error: "Failed to revoke integration grant" });
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
    console.error("List agent integrations error:", err);
    res.status(500).json({ error: "Failed to load agent integrations" });
  }
});
