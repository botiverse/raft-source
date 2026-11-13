import type { MarketplaceInstallBadge, OAuthClientCategory } from "@botiverse/raft-shared";
import type { AppBotOffer } from "../../../components/settings/ConnectedAppBot";
import type { AppNotificationSelection } from "../../../components/settings/AppNotificationsControls";
import type { AppPromptTextFields } from "../../../lib/appPromptText";
import type { OAuthClientRecord } from "./oauthClientRecords";

export type ConnectedAppStatus = "private" | "publish_requested" | "in_review" | "published" | "rejected" | "unpublish_requested";
export type ConnectedAppsViewMode = "grid" | "list";

const CONNECTED_APP_EDITOR_SECTION_IDS = ["profile", "login", "setup", "permissions", "notifications", "distribution", "danger"] as const;
export type ConnectedAppEditorSectionId = typeof CONNECTED_APP_EDITOR_SECTION_IDS[number];

export type ConnectedAppCategory = OAuthClientCategory;

export type ConnectedAppListing = {
  setupUrl?: string | null;
  setupDescription?: string | null;
  id: string;
  clientId: string;
  name: string;
  category: ConnectedAppCategory;
  developer: string;
  description: string;
  homepageUrl: string | null;
  homepageDomain: string;
  callbackDomain: string;
  logoUrl: string | null;
  defaultLogoSeed: string;
  installed: boolean;
  official: boolean;
  marketplaceInstallBadge: MarketplaceInstallBadge;
  allowedScopes: string[] | null;
  appNotificationGroups: AppNotificationSelection["groups"];
  appNotificationEvents: AppNotificationSelection["events"];
  appNotificationReviewPending: boolean;
  appNotificationPendingGroups: AppNotificationSelection["groups"];
  appNotificationPendingEvents: AppNotificationSelection["events"];
  /** The raw text agents would get, and its revision (null: the server sent none). */
  promptTextFields: AppPromptTextFields;
  promptTextRevisionId: string | null;
  /** The App's bot, named before the install; absent when it ships none. */
  bot?: AppBotOffer;
};

export type InstalledConnectedApp = {
  setupUrl?: string | null;
  setupDescription?: string | null;
  id: string;
  clientId: string;
  name: string;
  developer: string;
  description: string | null;
  homepageUrl: string | null;
  homepageDomain: string | null;
  callbackDomain: string | null;
  logoUrl: string | null;
  defaultLogoSeed: string;
  origin: "marketplace" | "private";
  privateShared: boolean;
  editable: boolean;
  official: boolean;
  allowedScopes: string[] | null;
  grantedScopes: string[];
  sourceClientId?: string;
  category: ConnectedAppCategory;
  publishStatus: ConnectedAppStatus | null;
  /** This Server hasn't confirmed the app's current agent prompt text. */
  promptTextConfirmationRequired?: boolean;
  /** Added login/data permissions awaiting this Server's approval; absent on older servers. */
  permissionApprovalRequired?: boolean;
  /**
   * An App built here that this Server has an active installation of: its
   * name opens the installed-app detail (permissions, Approve update), as
   * another Server's App's does.
   */
  installedHere?: boolean;
  /** The App's bot on this Server; absent when it ships none. */
  bot?: AppBotOffer;
  /** An owner or admin has something to handle on it: the row's attention dot. */
  needsAdminReview?: boolean;
};

export type ServerRegisteredApp = OAuthClientRecord & {
  status: ConnectedAppStatus;
  logoUrl: string | null;
  defaultLogoSeed: string;
};
