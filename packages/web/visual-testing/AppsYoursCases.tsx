import { useMemo } from "react";
import type { McpAppListItem } from "@botiverse/raft-shared";
import api from "../src/api/client";
import { IntegrationsSection } from "../src/features/apps/IntegrationsSection";
import type { MarketplaceOAuthClientRecord, OAuthClientRecord } from "../src/features/apps/connected-apps/oauthClientRecords";
import { forgetMarketplaceRecords } from "../src/lib/marketplaceRecords";
import { useServerStore } from "../src/store/serverStore";
import fixtureData from "../../visual-testing/shared/fixtureData.json";

// The Apps page's Yours scope (features/apps/IntegrationsSection.tsx,
// variant "page") over fixture answers to the four reads it makes, with no
// app shell around it: the page's head, its toolbar (Yours / Discover, the
// search, the origin filter, Add app; no view switch) and the cards.
// `admin`: an owner, a mix of Apps, one whose update waits (first, with
// Review). `member`: the same Server read by a member (no Add, no state, no
// button). `no-match`: the owner's list with a search and an origin that
// match nothing; the case's interactions in sharedCases.json type the search
// and pick the origin, as a person would: the page takes no starting filters.
// An App built here names its maker when the Server's people have them
// (Deploy bot: the owner) and says "Internal" alone when they left (Draft tool).
// `.narrow`: a 360px window, one column. `.dark`: the dark theme.

const VIEWS = ["admin", "member", "no-match"] as const;
const SIZES = ["", ".narrow"] as const;
const THEMES = ["", ".dark"] as const;

export const APPS_YOURS_CASE_IDS: readonly string[] = VIEWS.flatMap((view) => SIZES.flatMap((size) => THEMES.map((theme) => `screens.apps.yours.${view}${size}${theme}`)));

const HERE = fixtureData.server.id;
const AT = "2026-10-01T00:00:00.000Z";

function record(id: string, name: string, description: string, fields: Partial<OAuthClientRecord> = {}): OAuthClientRecord {
  return {
    id,
    serverId: "visual-publisher-server",
    clientId: id,
    appType: "third_party_global",
    publishStatus: "published",
    category: "Developer Tools",
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
    ...fields,
  };
}

/** Another Server's App installed here (GET /integrations/marketplace). */
function installed(id: string, name: string, description: string, publisher: string, fields: Partial<MarketplaceOAuthClientRecord> = {}): MarketplaceOAuthClientRecord {
  return {
    ...record(id, name, description),
    official: false,
    purpose: "",
    installationId: `${id}-install`,
    installStatus: "active",
    botGrant: null,
    installedAt: AT,
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

/** An App built on this Server (GET /integrations/clients). */
function builtHere(id: string, name: string, description: string, fields: Partial<OAuthClientRecord> = {}): OAuthClientRecord {
  return record(id, name, description, {
    serverId: HERE,
    appType: "server_local",
    publishStatus: "private",
    humanMarketplaceVisible: false,
    createdByUserId: fixtureData.humans.owner.id,
    ...fields,
  });
}

function service(id: string, name: string, description: string, kind: "url" | "template"): McpAppListItem {
  return {
    kind: "mcp",
    id,
    name,
    description,
    logoUrl: null,
    homepageUrl: null,
    category: "Productivity & Collaboration",
    distribution: "server_local",
    source: { kind, templateKey: kind === "template" ? id : null, maintainedByRaft: kind === "template", publisherName: null },
    // No default account to read: the card's normal state.
    status: { health: "reachable", toolCount: 12, connectionCount: 1, actionNeeded: 0, defaultConnectionStatus: null },
  };
}

/** The fixture Server's Apps. The server marks what waits (`needsAdminReview`) for App managers only. */
function fixtureAnswers(manager: boolean) {
  const marketplace: MarketplaceOAuthClientRecord[] = [
    installed("visual-stamp", "Stamp", "Connect GitHub: agents push code and open pull requests; you review and merge.", "Raft", {
      official: true,
      marketplaceInstallBadge: { kind: "bucket", bucket: "1k_plus" },
    }),
    installed("visual-linear", "Linear", "Plan work, track issues and keep the roadmap in one place.", "Linear", {
      marketplaceInstallBadge: { kind: "bucket", bucket: "100_plus" },
    }),
    installed("visual-figma", "Figma", "Read files and comments, and post design updates.", "Figma", {
      permissionApprovalRequired: true,
      ...(manager ? { needsAdminReview: true } : {}),
    }),
    installed("visual-ledger", "Ledger", "Expense reports for the finance team.", "Acme Finance", {
      publishStatus: "private",
      humanMarketplaceVisible: false,
      privateShared: true,
    }),
    installed(
      "visual-workbench",
      "Customer Relationship and Revenue Operations Workbench for Enterprise Teams",
      "Find any account, contact or opportunity, read its whole history, draft the follow-up and log the call, without leaving the conversation you are in.",
      "Customer Relationship and Revenue Operations Software Incorporated",
      { marketplaceInstallBadge: { kind: "bucket", bucket: "10_plus" } },
    ),
  ];
  const clients: OAuthClientRecord[] = [
    builtHere("visual-deploys", "Deploy bot", "Posts each deploy to #releases.", { installationId: "visual-deploys-install", installStatus: "active" }),
    // Its maker is no longer among the Server's people.
    builtHere("visual-draft", "Draft tool", "A tool this server is still building.", { createdByUserId: "visual-human-left" }),
  ];
  const services = [
    service("visual-notion", "Notion", "Search and edit your team's pages.", "template"),
    service("visual-wiki", "Team wiki", "The team's own wiki, connected by its address.", "url"),
  ];
  return { marketplace, clients, services };
}

function primeAppsYours(caseId: string, primeShell: () => void) {
  primeShell();
  const member = caseId.includes(".member");
  if (member) {
    const { current, servers } = useServerStore.getState();
    if (current) {
      const asMember = { ...current, role: "member" as const };
      useServerStore.setState({ current: asMember, servers: servers.map((server) => (server.id === asMember.id ? asMember : server)) });
    }
  }
  // The Server's people, as the app shell has read them: who made an App built here.
  const owner = fixtureData.humans.owner;
  useServerStore.setState({ members: [{
    userId: owner.id,
    email: owner.email,
    name: owner.name,
    displayName: owner.displayName,
    description: owner.description,
    avatarUrl: null,
    role: "owner",
    joinedAt: AT,
  }] });
  const { marketplace, clients, services } = fixtureAnswers(!member);
  forgetMarketplaceRecords();
  api.get = (async (url: string) => {
    if (url === "/integrations/marketplace") return { data: marketplace };
    if (url === "/integrations/clients") return { data: clients };
    if (url === "/integrations/overview") return { data: [] };
    if (url === "/mcp/apps") return { data: { apps: services } };
    // Discover's count in the scope.
    if (url === "/integrations/marketplace/listings") return { data: { items: [], total: 24, nextCursor: null } };
    if (url === "/integrations/link-preview-consents") return { data: { allowed: [], declined: [] } };
    return { data: [] };
  }) as typeof api.get;
  // The agent-text consent flag reads as off.
  api.post = (async () => ({ data: { enabled: false } })) as typeof api.post;
}

export function AppsYoursCase({ caseId, primeShell }: { caseId: string; primeShell: () => void }) {
  useMemo(() => primeAppsYours(caseId, primeShell), [caseId, primeShell]);
  // The whole window: the page fills it, as it fills the app shell's main column.
  return (
    <main className="h-dvh bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseId} className="flex h-full w-full flex-col overflow-hidden">
        <IntegrationsSection variant="page" />
      </div>
    </main>
  );
}
