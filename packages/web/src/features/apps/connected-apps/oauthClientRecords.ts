import type { MarketplaceInstallBadge, OAuthClientCategory } from "@botiverse/raft-shared";
import type { AppBotOffer } from "../../../components/settings/ConnectedAppBot";
import type { AppNotificationSelection } from "../../../components/settings/AppNotificationsControls";

export interface OAuthClientRecord {
  setupUrl?: string | null;
  setupDescription?: string | null;
  id: string;
  serverId: string;
  clientId: string;
  appType: "server_local" | "third_party_global";
  publishStatus: "private" | "publish_requested" | "in_review" | "published" | "rejected" | "unpublish_requested";
  category: OAuthClientCategory;
  dataAccessSummary: string | null;
  publishRejectionReason: string | null;
  name: string;
  description: string | null;
  whenToUse: string | null;
  homepageUrl: string | null;
  returnUrl: string | null;
  agentManifestUrl: string | null;
  allowedScopes: string[] | null;
  logoUrl: string | null;
  humanMarketplaceVisible: boolean;
  /**
   * Marketplace rows (app_prompt_text_consent): the text revision this row's
   * name / description / whenToUse are; Install confirms it.
   */
  promptTextRevisionId?: string | null;
  enableBot: boolean;
  installationId?: string | null;
  installStatus?: "active" | "paused" | "uninstalled" | null;
  botGrant?: "pending" | "granted" | "revoked" | null;
  /** The App's bot on this Server (install-joined rows); absent when it ships none, or on an older server. */
  bot?: AppBotOffer;
  /**
   * Something on this App waits for an owner or admin (a permission update,
   * or agent prompt text to confirm; #proj-apps task #24). Sent only to App
   * managers: absent reads as false.
   */
  needsAdminReview?: boolean;
  /**
   * Registered for link previews without version 2, so its previews are
   * read-only version 1 cards (#proj-apps:#55). From GET /integrations/clients
   * to App managers only: absent reads as false.
   */
  linkPreviewReadOnly?: boolean;
  /** In the official registry: its client ID goes through review (RFC 084 §3). */
  official?: boolean;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceOAuthClientRecord extends OAuthClientRecord {
  official: boolean;
  purpose: string;
  installationId: string | null;
  installStatus: "active" | "paused" | "uninstalled" | null;
  botGrant: "pending" | "granted" | "revoked" | null;
  installedAt: string | null;
  marketplaceInstallBadge: MarketplaceInstallBadge;
  publisherName: string | null;
  publisherServerName: string | null;
  privateShared: boolean;
  appNotificationGroups: AppNotificationSelection["groups"];
  appNotificationEvents: AppNotificationSelection["events"];
  appNotificationReviewPending: boolean;
  appNotificationPendingRevisionId: string | null;
  appNotificationPendingGroups: AppNotificationSelection["groups"];
  appNotificationPendingEvents: AppNotificationSelection["events"];
  /**
   * app_prompt_text_consent: installed here, and this Server hasn't confirmed
   * the app's current agent prompt text. Absent from an older server.
   */
  promptTextConfirmationRequired?: boolean;
  /** Added login/data permissions awaiting this Server's approval; absent on older servers. */
  permissionApprovalRequired?: boolean;
}

export interface IntegrationOverviewItem {
  id: string;
  type: "pending" | "active";
  clientId: string;
  clientKey: string;
  clientName: string;
  agentName: string;
  agentDisplayName: string | null;
  scopes: string[];
  revokedAt: string | null;
}
