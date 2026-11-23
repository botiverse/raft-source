import type { McpAppListItem } from "@botiverse/raft-shared";
import { compareAppViews, connectedServiceView, raftAppView } from "./appView";
import type { AppOrigin, AppView, AppViewContext } from "./appView";
import { matchesConnectedAppFilter } from "./connected-apps/connectedAppCatalog";
import type { ConnectedAppStatus, InstalledConnectedApp, ServerRegisteredApp } from "./connected-apps/connectedAppTypes";
import type { MarketplaceOAuthClientRecord, OAuthClientRecord } from "./connected-apps/oauthClientRecords";

/** A connected service as today's rows take it (`mcpAppAsConnectedApp`). */
export type YoursServiceRow = InstalledConnectedApp & { status: ConnectedAppStatus };

/**
 * One App under Yours: the card's view (`view`) and the record today's row
 * and dialogs take (`app`). `kind` says what it opens, never what it is
 * called: `installed` a Raft App this Server has (its installed detail),
 * `service` a connected service (its editor), `built` a Raft App built here
 * that this Server hasn't installed (its editor).
 */
export type YoursApp =
  | { kind: "installed"; key: string; view: AppView; app: InstalledConnectedApp }
  | { kind: "service"; key: string; view: AppView; app: YoursServiceRow }
  | { kind: "built"; key: string; view: AppView; app: ServerRegisteredApp };

export interface YoursAppsSources {
  /** Today's Installed list, in its order. */
  installedApps: readonly InstalledConnectedApp[];
  /** Every App this Server uses or builds as an installed-app entry: the merged review flags of one built here. */
  appEntries: readonly InstalledConnectedApp[];
  /** `GET /mcp/apps`, in its order. */
  serviceItems: readonly McpAppListItem[];
  serviceRow: (item: McpAppListItem) => YoursServiceRow;
  /** Today's Developer list (`GET /integrations/clients`), in its order. */
  registeredApps: readonly ServerRegisteredApp[];
  clients: readonly OAuthClientRecord[];
  marketplaceClients: readonly MarketplaceOAuthClientRecord[];
  context: AppViewContext;
}

/**
 * Who made an App built here, by user id, from the Server's people the page
 * already has (`serverStore.members`): the name they go by. Someone who left
 * isn't in it, and their App's card says "Internal" alone.
 */
export function appMakerNames(members: readonly { userId: string; name: string; displayName: string | null }[]): Map<string, string> {
  return new Map(members.map((member) => [member.userId, member.displayName || member.name]));
}

/** What today's row marks: the server's flag, a permission update, or agent text to confirm (already gated by its flag). */
function entryWaits(entry: InstalledConnectedApp | undefined): boolean {
  return entry?.needsAdminReview === true || entry?.permissionApprovalRequired === true || entry?.promptTextConfirmationRequired === true;
}

/**
 * The mapper reads a clients row's `needsAdminReview` only, and today's list
 * merges the permission and text flags from other reads: hand it the record
 * with the merged answer, so no state is lost (and none is added: the mapper
 * still shows it to App managers only).
 */
function withMergedReview<Record extends OAuthClientRecord>(record: Record, entry: InstalledConnectedApp | undefined): Record {
  return entryWaits(entry) && record.needsAdminReview !== true ? { ...record, needsAdminReview: true } : record;
}

/** An entry whose record is in neither read (not expected): the row is kept, drawn from the entry. */
function entryView(entry: InstalledConnectedApp, context: AppViewContext): AppView {
  const waits = context.canManage && entryWaits(entry);
  return {
    id: entry.id,
    kind: "raftApp",
    appId: entry.id,
    name: entry.name,
    description: entry.description,
    logoUrl: entry.logoUrl,
    logoSeed: entry.defaultLogoSeed,
    official: entry.official,
    origin: entry.editable ? "internal" : entry.privateShared ? "shared" : "marketplace",
    publisherName: entry.editable ? null : entry.developer,
    listedByRaft: false,
    createdByUserId: null,
    reach: null,
    added: true,
    state: waits ? "updateNeedsApproval" : "normal",
    needsAttention: waits,
  };
}

/**
 * Every App this Server has, once each: today's Installed list (Raft Apps
 * installed here, then the connected services), then the Raft Apps built
 * here that are not in it (the rest of today's Developer list). Those that
 * need someone come first; otherwise today's order.
 */
export function buildYoursApps({ installedApps, appEntries, serviceItems, serviceRow, registeredApps, clients, marketplaceClients, context }: YoursAppsSources): YoursApp[] {
  const clientById = new Map(clients.map((client) => [client.id, client]));
  const marketplaceById = new Map(marketplaceClients.map((client) => [client.id, client]));
  const entryById = new Map(appEntries.map((entry) => [entry.id, entry]));
  const installed: YoursApp[] = installedApps.map((app) => {
    // Built here: the clients row (the editor's record). Another Server's: its marketplace row.
    const record = app.editable
      ? clientById.get(app.sourceClientId ?? app.id) ?? marketplaceById.get(app.id)
      : marketplaceById.get(app.id) ?? clientById.get(app.id);
    return {
      kind: "installed",
      key: `${app.origin}-${app.id}`,
      view: record ? raftAppView(withMergedReview(record, app), context) : entryView(app, context),
      app,
    };
  });
  const services: YoursApp[] = serviceItems.map((item) => ({
    kind: "service",
    key: `mcp-${item.id}`,
    view: connectedServiceView(item, context),
    app: serviceRow(item),
  }));
  const installedIds = new Set(installedApps.map((app) => app.id));
  const built: YoursApp[] = registeredApps.filter((app) => !installedIds.has(app.id)).map((app) => ({
    kind: "built",
    key: `built-${app.id}`,
    view: raftAppView(withMergedReview(app, entryById.get(app.id)), context),
    app,
  }));
  // A stable sort: equal ones keep the order above.
  return [...installed, ...services, ...built].sort((a, b) => compareAppViews(a.view, b.view));
}

/** Yours' search (name, description, maker, client id, as today's lists) and its origin filter. */
export function filterYoursApps(apps: readonly YoursApp[], search: string, origin: AppOrigin | "all"): YoursApp[] {
  const normalizedSearch = search.trim().toLowerCase();
  return apps.filter(({ view, app }) => (
    (origin === "all" || view.origin === origin) && matchesConnectedAppFilter(app, normalizedSearch, "all")
  ));
}
