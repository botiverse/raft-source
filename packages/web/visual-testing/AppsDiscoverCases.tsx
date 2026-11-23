import { useMemo } from "react";
import type { MarketplaceListing, MarketplaceListingId, McpAppListItem } from "@botiverse/raft-shared";
import api from "../src/api/client";
import { IntegrationsSection } from "../src/features/apps/IntegrationsSection";
import { MARKETPLACE_LISTINGS_PATH } from "../src/features/apps/discoverListings";
import type { MarketplaceOAuthClientRecord } from "../src/features/apps/connected-apps/oauthClientRecords";
import { forgetMarketplaceRecords } from "../src/lib/marketplaceRecords";
import { useServerStore } from "../src/store/serverStore";
import fixtureData from "../../visual-testing/shared/fixtureData.json";

// The Apps page's Discover scope (features/apps/IntegrationsSection.tsx,
// variant "page") over fixture answers to its reads, with no app shell
// around it. The page opens on Discover from its address (`?tab=discover`,
// set before the router mounts: VisualTestingCases' route priming).
// `admin`: an owner; "Recommended for {server}" (Stamp) on top, then "All
// apps": the same card as Yours in its Discover variant, Add on what this
// Server hasn't added, Added on what it has. `member-no-discover`: a member
// following the same link: members have no Discover (R15), so the page
// shows Yours alone, read-only, with no scope switch.
// `detail`: the owner opened Retro Board, a Raft App not added (A2): its
// details with Add at the head's top right. `service-detail`: the owner
// opened Linear, a connected service not added (R40): description, who makes
// it and Information, no Tools. `install-confirm`: the owner pressed Retro
// Board's Add on its card: its install confirmation (MarketplaceInstallConfirm),
// not its details. The cases' interactions in sharedCases.json press the
// card or its Add, as a person would.
// `.narrow`: a 360px window, one column. `.dark`: the dark theme.

export const APPS_DISCOVER_CASE_IDS: readonly string[] = [
  "screens.apps.discover.admin",
  "screens.apps.discover.admin.dark",
  "screens.apps.discover.admin.narrow",
  "screens.apps.discover.member-no-discover",
  "screens.apps.discover.member-no-discover.narrow",
  "screens.apps.discover.detail",
  "screens.apps.discover.detail.narrow",
  "screens.apps.discover.service-detail",
  "screens.apps.discover.service-detail.dark",
  "screens.apps.discover.service-detail.narrow",
  "screens.apps.discover.install-confirm",
  "screens.apps.discover.install-confirm.narrow",
];

/** Where these cases open: the Apps page, on Discover. */
export const APPS_DISCOVER_CASE_PATH = `/s/${fixtureData.server.slug}/apps`;

const AT = "2026-10-01T00:00:00.000Z";

/** A Raft App on the Marketplace (GET /integrations/marketplace), added here or not. */
function raftApp(id: string, name: string, description: string, publisher: string, fields: Partial<MarketplaceOAuthClientRecord> = {}): MarketplaceOAuthClientRecord {
  return {
    id,
    serverId: "visual-publisher-server",
    clientId: id,
    appType: "third_party_global",
    publishStatus: "published",
    category: "Productivity & Collaboration",
    dataAccessSummary: null,
    publishRejectionReason: null,
    name,
    description,
    whenToUse: null,
    homepageUrl: `https://${id}.example.com`,
    returnUrl: `https://${id}.example.com/callback`,
    agentManifestUrl: null,
    allowedScopes: ["openid", "profile"],
    logoUrl: null,
    humanMarketplaceVisible: true,
    enableBot: false,
    createdByUserId: "visual-publisher",
    createdAt: AT,
    updatedAt: AT,
    official: false,
    purpose: "",
    installationId: null,
    installStatus: null,
    botGrant: null,
    installedAt: null,
    marketplaceInstallBadge: { kind: "none" },
    publisherName: null,
    publisherServerName: publisher,
    privateShared: false,
    appNotificationGroups: [],
    appNotificationEvents: [],
    appNotificationReviewPending: false,
    appNotificationPendingRevisionId: null,
    appNotificationPendingGroups: [],
    appNotificationPendingEvents: [],
    ...fields,
  };
}

type Listing = MarketplaceListing<MarketplaceOAuthClientRecord>;

function appListing(record: MarketplaceOAuthClientRecord, bucket: Listing["installBucket"]): Listing {
  return {
    id: `app:${record.id}` as MarketplaceListingId,
    kind: "app",
    name: record.name,
    description: record.description,
    logoUrl: record.logoUrl,
    category: record.category,
    installBucket: bucket,
    publishedAt: AT,
    installed: !!record.installedAt,
    publisherName: record.publisherServerName,
    app: record,
  };
}

function serviceListing(templateKey: string, name: string, description: string, publisherName: string | null, installed: boolean, bucket: Listing["installBucket"]): Listing {
  return {
    id: `mcp:${templateKey}` as MarketplaceListingId,
    kind: "mcp",
    templateKey,
    name,
    description,
    logoUrl: null,
    category: "Productivity & Collaboration",
    homepageUrl: `https://${templateKey}.example.com`,
    publisherName,
    installBucket: bucket,
    publishedAt: AT,
    installed,
  };
}

/** The fixture Server: Tracker and Notion added, the rest not; Stamp (Raft's, not added) is recommended. */
function fixtureAnswers() {
  const stamp = raftApp("visual-stamp", "Stamp", "Connect GitHub: agents push code and open pull requests; you review and merge.", "Raft", {
    // The recommendation is by this client ID, in the official registry.
    clientId: "stamp",
    official: true,
    serverId: "raft-official",
    category: "Developer Tools",
    marketplaceInstallBadge: { kind: "bucket", bucket: "1k_plus" },
  });
  const tracker = raftApp("visual-tracker", "Tracker", "Track bugs and feature requests from chat.", "Acme", {
    installationId: "visual-tracker-install",
    installStatus: "active",
    installedAt: AT,
  });
  const retro = raftApp("visual-retro", "Retro Board", "Runs team retros: collects notes, groups them, and posts a summary card.", "Acme Studio");
  const workbench = raftApp(
    "visual-workbench",
    "Customer Relationship and Revenue Operations Workbench for Enterprise Teams",
    "Find any account, contact or opportunity, read its whole history, draft the follow-up and log the call, without leaving the conversation you are in.",
    "Customer Relationship and Revenue Operations Software Incorporated",
  );
  const listings: Listing[] = [
    appListing(stamp, "1k_plus"),
    appListing(tracker, "10_plus"),
    serviceListing("visual-notion", "Notion", "Search and edit your team's pages.", "Notion", true, "100_plus"),
    serviceListing("visual-linear", "Linear", "Create issues, update their status and organize cycles.", "Linear", false, "100_plus"),
    appListing(retro, "10_plus"),
    serviceListing("visual-postgres", "Postgres", "Run read-only queries on your database.", null, false, null),
    appListing(workbench, null),
  ];
  const notion: McpAppListItem = {
    kind: "mcp",
    id: "visual-notion-app",
    name: "Notion",
    description: "Search and edit your team's pages.",
    logoUrl: null,
    homepageUrl: null,
    category: "Productivity & Collaboration",
    distribution: "server_local",
    source: { kind: "template", templateKey: "visual-notion", maintainedByRaft: true, publisherName: "Notion" },
    status: { health: "reachable", toolCount: 12, connectionCount: 1, actionNeeded: 0, defaultConnectionStatus: null },
  };
  return { marketplace: [stamp, tracker, retro, workbench], listings, services: [notion] };
}

function primeAppsDiscover(caseId: string, primeShell: () => void) {
  primeShell();
  if (caseId.includes(".member")) {
    const { current, servers } = useServerStore.getState();
    if (current) {
      const asMember = { ...current, role: "member" as const };
      useServerStore.setState({ current: asMember, servers: servers.map((server) => (server.id === asMember.id ? asMember : server)) });
    }
  }
  const { marketplace, listings, services } = fixtureAnswers();
  forgetMarketplaceRecords();
  api.get = (async (url: string) => {
    if (url === "/integrations/marketplace") return { data: marketplace };
    if (url === MARKETPLACE_LISTINGS_PATH) return { data: { items: listings, total: listings.length, nextCursor: null } };
    if (url === "/integrations/clients") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    if (url === "/mcp/apps") return { data: { apps: services } };
    if (url === "/integrations/link-preview-consents") return { data: { allowed: [], declined: [] } };
    return { data: [] };
  }) as typeof api.get;
  // The agent-text consent flag reads as off.
  api.post = (async () => ({ data: { enabled: false } })) as typeof api.post;
}

export function AppsDiscoverCase({ caseId, primeShell }: { caseId: string; primeShell: () => void }) {
  useMemo(() => primeAppsDiscover(caseId, primeShell), [caseId, primeShell]);
  // The whole window: the page fills it, as it fills the app shell's main column.
  return (
    <main className="h-dvh bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseId} className="flex h-full w-full flex-col overflow-hidden">
        <IntegrationsSection variant="page" />
      </div>
    </main>
  );
}
