import { renderThirdPartyInertText } from "@botiverse/raft-shared";
import type { ManagedMcpToolCatalogEntry, MarketplaceInstallBucket, MarketplaceListing, McpAppListItem } from "@botiverse/raft-shared";
import type { McpAppView } from "../../components/settings/mcpApps/mcpAppApi";
import type { MarketplaceOAuthClientRecord, OAuthClientRecord } from "./connected-apps/oauthClientRecords";

/**
 * One App as the Apps page shows it: what a card and a detail render from,
 * whichever endpoint the App came from. Pure mapping, no React, no store, no
 * catalog text: the UI turns these parts into words.
 *
 * Not used by any component yet; today's rows still go through
 * `connected-apps/connectedAppMapping.ts`. Where the two differ, this file is
 * the redesign's rule (see `official` and `listedByRaft`).
 */

/**
 * For behaviour only (which detail, which actions). Never a label: the UI
 * does not name App types to people.
 */
export type AppKind = "raftApp" | "connectedService";

/** Where this Server got the App: the Yours filter. */
export type AppOrigin = "internal" | "shared" | "marketplace";

/**
 * - `updateNeedsApproval`: a permission or agent-text update waits for an
 *   owner or admin. Produced for App managers only.
 * - `signInExpired`: the shared sign-in of a connected service expired or
 *   needs signing in (`expired`, `needs_auth`).
 * - `cannotConnect`: the shared account of a connected service fails
 *   (`error`); the detail's banner has the server's reason.
 *
 * The last two are read from the list item's `status.defaultConnectionStatus`
 * only, which no server sends yet: until it does, they are not produced. They
 * are App managers' too: the server sends null to anyone else, and the mapper
 * doesn't rely on that (`connectedServiceState`). A sign-in in progress
 * (`pending`) is normal.
 *
 * Ids only: the UI has the words. There is no "turned off by its maker"
 * state: the server has no such status.
 */
export type AppCardState = "normal" | "updateNeedsApproval" | "signInExpired" | "cannotConnect";

/**
 * Which state a card shows when more than one applies, strongest first. A
 * tie-break only: today an update waits on Raft Apps and the other two come
 * from connected services, so no App has two.
 */
export const APP_CARD_STATE_PRECEDENCE: readonly AppCardState[] = ["cannotConnect", "signInExpired", "updateNeedsApproval", "normal"];

/** The strongest of the states that apply; normal when none does. */
export function strongestAppCardState(states: readonly AppCardState[]): AppCardState {
  return APP_CARD_STATE_PRECEDENCE.find((state) => states.includes(state)) ?? "normal";
}

export interface AppView {
  /** The row's key: the record id, the connected service's id, or the Discover listing's id (opaque). */
  id: string;
  kind: AppKind;
  /**
   * The App's own id on this Server: the Raft App's record id, or the
   * connected service's id. Null for a Discover listing of a service this
   * Server would create by adding it.
   */
  appId: string | null;
  name: string;
  /** The existing description; the UI clamps it. */
  description: string | null;
  logoUrl: string | null;
  /** What the initials fallback is coloured by, as today's rows. */
  logoSeed: string;
  /** Raft's own App. Only a Raft App's `official`; a connected service never is. */
  official: boolean;
  origin: AppOrigin;
  /**
   * "By {publisher}". Raft Apps from elsewhere: the publishing server or
   * person. Connected services: `source.publisherName`, which no server sends
   * yet, so null for now. Null when unknown.
   */
  publisherName: string | null;
  /** "Listed by Raft": a connected service made from one of Raft's listings (Notion, Linear). */
  listedByRaft: boolean;
  /** "made by {name}" for an internal App: the creator's user id, for the UI to resolve. Null when the source has none. */
  createdByUserId: string | null;
  /** How widely it is used: the server's bucket, or null. Never a number. */
  reach: MarketplaceInstallBucket | null;
  /** This Server has it. Always true in Yours; Discover's "Added". */
  added: boolean;
  state: AppCardState;
  /** Sorted first in Yours (`compareAppViews`). */
  needsAttention: boolean;
}

/** The detail's extra facts, only those an endpoint already sends. */
export interface AppDetailView extends AppView {
  homepageUrl: string | null;
  category: string | null;
  /** ISO time. Null for a connected service: its detail has none. */
  updatedAt: string | null;
  /** A Raft App's declared scopes ("what it can see"). Null for a connected service. */
  allowedScopes: string[] | null;
  /** A connected service's server address. Null for a Raft App. */
  endpointUrl: string | null;
  /** A connected service's tools, in the server's order. Null for a Raft App. */
  tools: AppToolView[] | null;
}

/**
 * How the detail groups a tool, from its hints: `readOnly` says it only
 * reads; `changes` says it can change something (not read-only, or
 * destructive; a destructive hint wins over a read-only one); `unlabeled`
 * has no hint either way.
 */
export type AppToolGroup = "readOnly" | "changes" | "unlabeled";

export interface AppToolView {
  name: string;
  title?: string;
  description?: string;
  /** The tool's own hints, as sent. No server sends them yet: absent until one does. */
  annotations?: ManagedMcpToolCatalogEntry["annotations"];
  group: AppToolGroup;
}

export function appToolGroup(annotations: ManagedMcpToolCatalogEntry["annotations"]): AppToolGroup {
  if (!annotations) return "unlabeled";
  if (annotations.destructiveHint === true || annotations.readOnlyHint === false) return "changes";
  if (annotations.readOnlyHint === true) return "readOnly";
  return "unlabeled";
}

export interface AppViewContext {
  /** The Server being viewed; undefined while it isn't known. */
  serverId: string | undefined;
  /** The viewer can manage Apps here (`manageIntegrations`): every state but normal is theirs only. */
  canManage: boolean;
  /** The agent-text consent flag (`app_prompt_text_consent`) is on. Off: text confirmations don't count. */
  promptTextConsent: boolean;
}

type RaftAppRecord = OAuthClientRecord | MarketplaceOAuthClientRecord;

function isMarketplaceRecord(record: RaftAppRecord): record is MarketplaceOAuthClientRecord {
  return "privateShared" in record;
}

/**
 * A Raft App's origin. Built on this Server (its `serverId`, whatever its
 * distribution) is internal; another Server's private share is shared; a
 * server-local App seen without a known Server can only be this Server's;
 * everything else came from the Marketplace.
 */
export function raftAppOrigin(record: RaftAppRecord, serverId: string | undefined): AppOrigin {
  if (serverId !== undefined && record.serverId === serverId) return "internal";
  if (isMarketplaceRecord(record) && record.privateShared) return "shared";
  if (record.appType === "server_local") return "internal";
  return "marketplace";
}

/**
 * A connected service's origin. From one of Raft's listings: marketplace.
 * One connected by its URL: internal.
 */
export function connectedServiceOrigin(source: Pick<McpAppListItem["source"], "kind">): AppOrigin {
  return source.kind === "template" ? "marketplace" : "internal";
}

function reviewWaits(record: RaftAppRecord, context: AppViewContext): boolean {
  if (!context.canManage) return false;
  if (record.needsAdminReview === true) return true;
  if (!isMarketplaceRecord(record)) return false;
  return record.permissionApprovalRequired === true
    || (context.promptTextConsent && record.promptTextConfirmationRequired === true);
}

function stateOf(state: AppCardState): Pick<AppView, "state" | "needsAttention"> {
  return { state, needsAttention: state !== "normal" };
}

/**
 * Absent (today's servers), null (no default account), ready and pending:
 * normal. And normal for a viewer who doesn't manage Apps, whatever the item
 * carries: the shared account's state is not theirs to read or to fix.
 */
function connectedServiceState(status: McpAppListItem["status"], context: Pick<AppViewContext, "canManage">): AppCardState {
  if (!context.canManage) return "normal";
  const connection = status.defaultConnectionStatus;
  return strongestAppCardState([
    connection === "error" ? "cannotConnect" : "normal",
    connection === "expired" || connection === "needs_auth" ? "signInExpired" : "normal",
  ]);
}

/** Another Server's text is shown inert, as the Marketplace rows do today. */
function inert(field: "app_name" | "developer_name" | "description", value: string | null): string | null {
  return value === null ? null : renderThirdPartyInertText({ field, value });
}

/**
 * A Raft App: a `GET /integrations/marketplace` row (another Server's App, or
 * this Server's own while installed here) or a `GET /integrations/clients`
 * row (built here). For an App built here the caller may hand either record;
 * the clients row carries `needsAdminReview` only, the marketplace row also
 * the permission and text flags.
 */
export function raftAppView(record: RaftAppRecord, context: AppViewContext): AppView {
  const origin = raftAppOrigin(record, context.serverId);
  const internal = origin === "internal";
  const marketplace = isMarketplaceRecord(record) ? record : null;
  const publisher = marketplace ? marketplace.publisherServerName ?? marketplace.publisherName : null;
  const badge = marketplace?.marketplaceInstallBadge;
  return {
    id: record.id,
    kind: "raftApp",
    appId: record.id,
    name: internal ? record.name : renderThirdPartyInertText({ field: "app_name", value: record.name }),
    description: internal ? record.description : inert("description", record.description),
    logoUrl: record.logoUrl,
    logoSeed: record.clientId,
    official: record.official === true,
    origin,
    // An internal App's source line is "Internal · made by", not "By".
    publisherName: internal ? null : inert("developer_name", publisher),
    listedByRaft: false,
    createdByUserId: internal ? record.createdByUserId : null,
    reach: badge?.kind === "bucket" ? badge.bucket : null,
    added: marketplace ? !!marketplace.installedAt : !!record.installationId,
    ...stateOf(strongestAppCardState([reviewWaits(record, context) ? "updateNeedsApproval" : "normal"])),
  };
}

export function raftAppDetailView(record: RaftAppRecord, context: AppViewContext): AppDetailView {
  return {
    ...raftAppView(record, context),
    homepageUrl: record.homepageUrl,
    category: record.category,
    updatedAt: record.updatedAt,
    allowedScopes: record.allowedScopes,
    endpointUrl: null,
    tools: null,
  };
}

/** A connected service on this Server (`GET /mcp/apps`). Its connection states are App managers' only (`context.canManage`). */
export function connectedServiceView(app: McpAppListItem, context: Pick<AppViewContext, "canManage">): AppView {
  return {
    id: app.id,
    kind: "connectedService",
    appId: app.id,
    name: app.name,
    description: app.description,
    logoUrl: app.logoUrl,
    logoSeed: app.id,
    official: false,
    origin: connectedServiceOrigin(app.source),
    publisherName: app.source.publisherName ?? null,
    listedByRaft: app.source.maintainedByRaft,
    // The list item has no creator.
    createdByUserId: null,
    reach: null,
    added: true,
    ...stateOf(connectedServiceState(app.status, context)),
  };
}

/**
 * A connected service's detail (`GET /mcp/apps/:appId`). `appId` is the id it
 * was asked by: the view's own `id` can be a later version of the App. Its
 * state is always normal: the connection states come from the list item only.
 */
export function connectedServiceDetailView(appId: string, app: McpAppView): AppDetailView {
  return {
    id: appId,
    kind: "connectedService",
    appId,
    name: app.profile.name,
    description: app.profile.description,
    logoUrl: app.profile.logoUrl,
    logoSeed: appId,
    official: false,
    origin: connectedServiceOrigin(app.source),
    publisherName: app.source.publisherName ?? null,
    listedByRaft: app.source.maintainedByRaft,
    createdByUserId: null,
    reach: null,
    added: true,
    ...stateOf("normal"),
    homepageUrl: app.profile.homepageUrl,
    category: app.profile.category,
    updatedAt: null,
    allowedScopes: null,
    endpointUrl: app.server.endpointUrl,
    tools: app.server.tools.map((tool) => ({ ...tool, group: appToolGroup(tool.annotations) })),
  };
}

/**
 * A Discover listing (`GET /integrations/marketplace/listings`). An App
 * listing reads as its record does (so one this Server already has keeps its
 * state), with the listing's own bucket and `installed`. A service listing is
 * one of Raft's by contract (it has a `templateKey`), the same rule the
 * server uses for `source.maintainedByRaft`.
 */
export function listingView(listing: MarketplaceListing<MarketplaceOAuthClientRecord>, context: AppViewContext): AppView {
  if (listing.kind === "app") {
    const app = raftAppView(listing.app, context);
    return {
      ...app,
      id: listing.id,
      publisherName: app.origin === "internal" ? null : app.publisherName ?? inert("developer_name", listing.publisherName),
      reach: listing.installBucket,
      added: listing.installed,
    };
  }
  return {
    id: listing.id,
    kind: "connectedService",
    appId: null,
    name: listing.name,
    description: listing.description,
    logoUrl: listing.logoUrl,
    logoSeed: listing.templateKey,
    official: false,
    origin: "marketplace",
    publisherName: listing.publisherName ?? null,
    listedByRaft: true,
    createdByUserId: null,
    reach: listing.installBucket,
    added: listing.installed,
    // A listing has no connection status.
    ...stateOf("normal"),
  };
}

/** Needs-attention first; equal ones compare 0, so a stable sort keeps the order they came in. */
export function compareAppViews(a: Pick<AppView, "needsAttention">, b: Pick<AppView, "needsAttention">): number {
  return Number(b.needsAttention) - Number(a.needsAttention);
}

/** A sorted copy: needs-attention first, otherwise the given order. */
export function sortAppViews<View extends Pick<AppView, "needsAttention">>(views: readonly View[]): View[] {
  return [...views].sort(compareAppViews);
}
