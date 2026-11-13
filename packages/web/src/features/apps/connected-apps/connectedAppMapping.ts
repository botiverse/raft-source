import { OAUTH_CLIENT_CATEGORIES, renderThirdPartyInertText } from "@botiverse/raft-shared";
import type { McpAppListItem } from "@botiverse/raft-shared";
import type { IntlShape } from "react-intl";
import { installEntryPromptText, readPromptTextRevisionId } from "../../../lib/appPromptText";
import { getDomainFromUrl } from "./getDomainFromUrl";
import type { ConnectedAppCategory, ConnectedAppListing, ConnectedAppStatus, InstalledConnectedApp, ServerRegisteredApp } from "./connectedAppTypes";
import type { MarketplaceOAuthClientRecord, OAuthClientRecord } from "./oauthClientRecords";

/**
 * A GET /integrations/marketplace row the Marketplace tab shows. The list also
 * carries Apps installed here that are not publicly listed, for the Installed
 * tab and its Review permissions: private shares, and this Server's own App
 * while it is private, in review, rejected or unlisted (#triage:59b61529).
 */
export function isMarketplaceTabClient(client: MarketplaceOAuthClientRecord, serverId: string | undefined) {
  if (client.privateShared) return false;
  return client.serverId !== serverId
    || (client.humanMarketplaceVisible && (client.publishStatus === "published" || client.publishStatus === "unpublish_requested"));
}

/**
 * An MCP App as an App list row. It is a server-local App: private (MCP Apps cannot be published
 * yet), editable by App managers. Its source line says where it came from: `Maintained by Raft`
 * for one installed from a Raft template (`official`), `Custom` for one connected by its URL. The
 * rows add one MCP tag (the App's type) through their `mcp` prop.
 */
export function mcpAppAsConnectedApp(app: McpAppListItem, formatMessage: IntlShape["formatMessage"]): InstalledConnectedApp & { status: ConnectedAppStatus } {
  const developer = formatMessage({ id: app.source.maintainedByRaft ? "settings.connectedApps.mcp.maintainedByRaft" : "settings.connectedApps.mcp.custom" });
  return {
    id: app.id,
    clientId: app.id,
    name: app.name,
    developer,
    description: app.description,
    homepageUrl: app.homepageUrl ?? null,
    homepageDomain: getDomainFromUrl(app.homepageUrl),
    callbackDomain: null,
    logoUrl: app.logoUrl,
    defaultLogoSeed: app.id,
    origin: "private",
    privateShared: false,
    editable: true,
    official: app.source.maintainedByRaft,
    allowedScopes: null,
    grantedScopes: [],
    category: (OAUTH_CLIENT_CATEGORIES as readonly string[]).includes(app.category ?? "") ? app.category as ConnectedAppCategory : "Other",
    publishStatus: "private",
    status: "private",
  };
}

export function renderMarketplaceText(field: "app_name" | "developer_name" | "description", value: string | null | undefined) {
  return renderThirdPartyInertText({ field, value });
}

export function mapClientToMarketplaceApp(
  client: MarketplaceOAuthClientRecord,
  formatMessage: IntlShape["formatMessage"],
): ConnectedAppListing {
  const notConfigured = formatMessage({ id: "settings.connectedApps.notConfigured" });
  const thirdPartyDeveloper = formatMessage({ id: "settings.connectedApps.thirdPartyDeveloper" });
  return {
    id: client.id,
    clientId: client.clientId,
    name: renderMarketplaceText("app_name", client.name),
    category: client.category,
    developer: renderMarketplaceText("developer_name", client.publisherServerName ?? client.publisherName ?? thirdPartyDeveloper),
    description: renderMarketplaceText("description", client.description),
    homepageUrl: client.homepageUrl,
    homepageDomain: getDomainFromUrl(client.homepageUrl) ?? notConfigured,
    callbackDomain: getDomainFromUrl(client.returnUrl) ?? notConfigured,
    logoUrl: client.logoUrl,
    defaultLogoSeed: client.clientId,
    installed: !!client.installedAt,
    setupUrl: client.setupUrl, setupDescription: client.setupDescription,
    official: client.official,
    marketplaceInstallBadge: client.marketplaceInstallBadge ?? { kind: "none" },
    allowedScopes: client.allowedScopes,
    appNotificationGroups: client.appNotificationGroups ?? [],
    appNotificationEvents: client.appNotificationEvents ?? [],
    appNotificationReviewPending: client.appNotificationReviewPending ?? false,
    appNotificationPendingGroups: client.appNotificationPendingGroups ?? [],
    appNotificationPendingEvents: client.appNotificationPendingEvents ?? [],
    promptTextFields: installEntryPromptText(client),
    promptTextRevisionId: readPromptTextRevisionId(client),
    bot: client.bot,
  };
}

export function mapClientToRegisteredApp(client: OAuthClientRecord): ServerRegisteredApp {
  return {
    ...client,
    status: client.publishStatus,
    logoUrl: client.logoUrl,
    defaultLogoSeed: client.clientId,
  };
}
