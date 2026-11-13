import { createHash } from "node:crypto";
import { renderThirdPartyInertText } from "@botiverse/raft-shared";
import type { ActionCardMetadata } from "@botiverse/raft-shared";
import type { MarketplaceOAuthClientRecord } from "../../src/features/apps/connected-apps/oauthClientRecords";

/**
 * An App's name as an install card binds it (the server's
 * bindMarketplaceAppName): `clientName` escaped for display (inert), and
 * `clientNameSha256` the SHA-256 of the raw name, which is what the dialog
 * compares with the App's record.
 */
export function boundAppName(rawName: string): { clientName: string; clientNameSha256: string } {
  return {
    clientName: renderThirdPartyInertText({ field: "app_name", value: rawName }),
    clientNameSha256: createHash("sha256").update(rawName, "utf8").digest("hex"),
  };
}

type InstallCardAction = Extract<ActionCardMetadata["action"], { type: "integration:install_marketplace_app" }>;

/**
 * The GET /integrations/marketplace row of an install card's App, as the
 * server lists it while the App still matches the card's binding: its id is
 * the card's `clientId`, its name, permission set and prompt text the ones the
 * card bound (the name as the card shows it: pass the raw `name` for one the
 * binding escapes). Overrides model the App as it is now (InstallAppCardDialog
 * shows the row, never the card).
 */
export function installCardRecord(action: InstallCardAction, overrides: Partial<MarketplaceOAuthClientRecord> = {}): MarketplaceOAuthClientRecord {
  return {
    id: action.clientId,
    serverId: "publisher-server",
    clientId: action.clientKey,
    appType: "third_party_global",
    publishStatus: "published",
    humanMarketplaceVisible: true,
    category: "Other",
    dataAccessSummary: null,
    publishRejectionReason: null,
    name: action.clientName,
    description: action.installText?.description ?? null,
    whenToUse: action.installText?.whenToUse ?? null,
    homepageUrl: null,
    returnUrl: null,
    agentManifestUrl: null,
    allowedScopes: action.installScopes ?? [],
    logoUrl: null,
    promptTextRevisionId: action.installTextRevisionId ?? null,
    enableBot: false,
    createdByUserId: "publisher",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    official: false,
    purpose: "",
    installationId: null,
    installStatus: null,
    botGrant: null,
    installedAt: null,
    marketplaceInstallBadge: { kind: "none" },
    publisherName: "Publisher",
    publisherServerName: "Publisher HQ",
    privateShared: false,
    appNotificationGroups: (action.installGroups ?? []) as MarketplaceOAuthClientRecord["appNotificationGroups"],
    appNotificationEvents: [],
    appNotificationReviewPending: false,
    appNotificationPendingRevisionId: null,
    appNotificationPendingGroups: [],
    appNotificationPendingEvents: [],
    canReviewAppNotifications: false,
    ...overrides,
  };
}
