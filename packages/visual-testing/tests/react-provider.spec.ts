import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const { test, expect } = require("@playwright/test");

type VisualInteraction = {
  type: "click" | "contextmenu" | "wait" | "fill";
  target?: string;
  value?: string;
  ms?: number;
  x?: number;
  y?: number;
};

type VisualCase = {
  id: string;
  baselineStatus?: string;
  skip?: boolean | { enabled?: boolean };
  viewport?: { width: number; height: number; density: number };
  capture?: {
    selector?: string;
    crop?: string;
    contract?: string;
    interactions?: VisualInteraction[];
  };
  variants?: Array<{
    id: string;
    props?: Record<string, unknown>;
    interactions?: VisualInteraction[];
  }>;
};

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDir, "..");
const reactRepoRoot = process.env.SLOCK_REACT_REPO_DIR
  ? resolve(process.env.SLOCK_REACT_REPO_DIR)
  : resolve(testDir, "../../..");
const androidRepoRoot = process.env.SLOCK_ANDROID_REPO_ROOT
  ? resolve(process.env.SLOCK_ANDROID_REPO_ROOT)
  : resolve(reactRepoRoot, "../..");
const resultRoot = resolve(
  process.env.SLOCK_VISUAL_RESULT_ROOT
    || (process.env.SLOCK_ANDROID_REPO_ROOT
      ? resolve(androidRepoRoot, "visual-testing-results")
      : resolve(reactRepoRoot, "visual-testing-results")),
);
const packageManifestPath = resolve(packageRoot, "shared/sharedCases.json");
const fixtureData = JSON.parse(readFileSync(resolve(packageRoot, "shared/fixtureData.json"), "utf8"));
const savedMessagesFixture = JSON.parse(readFileSync(resolve(packageRoot, "shared/savedMessagesFixture.json"), "utf8"));
const searchResultsFixture = JSON.parse(readFileSync(resolve(packageRoot, "shared/searchResultsFixture.json"), "utf8"));
const activityResultsFixture = JSON.parse(readFileSync(resolve(packageRoot, "shared/activityResultsFixture.json"), "utf8"));
const tasksFixture = JSON.parse(readFileSync(resolve(packageRoot, "shared/tasksFixture.json"), "utf8"));
const fxOwner = fixtureData.humans.owner;
const fxDesigner = fixtureData.humans.designer;
const fxCindy = fixtureData.agents.cindy;
const fxProductUx = fixtureData.agents.productUx;
const fxAndroidDev = fixtureData.agents.androidDev4;
const fxMachine = fixtureData.machines.primary;
const fxStudioMachine = fixtureData.machines.studio;
const fxLongNameMachine = fixtureData.machines.longName;
const fxDaemonOnlyMachine = fixtureData.machines.daemonOnly;
/* task #535 / #537: every fixture agent an agent-detail case can open. The app
   refetches /api/agents after mount and replaces the primed store, so an agent
   missing from THIS list renders AgentUnavailablePanel no matter what the case
   file seeded (run 33774349200 captured exactly that for the four new cases). */
const fxAgentDetailAgents = [
  fixtureData.agents.productUx,
  fixtureData.agents.computerOffline,
  fixtureData.agents.computerMissing,
  fixtureData.agents.noComputer,
  fixtureData.agents.longMachine,
  fixtureData.agents.daemonOnly,
  fixtureData.agents.noMembership,
];
const fxAgentDetailIds = new Set(fxAgentDetailAgents.map((agent) => agent.id));
/** Same rule as VisualTestingCases.machineIdForFixtureAgent: "missing" is a
    deliberately dangling id, null is no machine, anything else must resolve. */
function fixtureAgentMachineId(agent: { machineKey: string | null }): string | null {
  if (agent.machineKey === null) return null;
  if (agent.machineKey === "missing") return "computer-missing";
  const machine = (fixtureData.machines as Record<string, { id: string } | undefined>)[agent.machineKey];
  if (!machine) throw new Error(`fixture agent machineKey "${agent.machineKey}" is not a machines key`);
  return machine.id;
}
/** True for /api/.../agents/<id>/<suffix> when <id> is one of the agent-detail fixture agents. */
function isAgentDetailSubRoute(pathname: string, suffix: string): boolean {
  const match = pathname.match(/\/agents\/([^/]+)\/(.+)$/);
  return match !== null && fxAgentDetailIds.has(match[1]) && match[2] === suffix;
}
const fxServer = fixtureData.server;
const fxChannels = fixtureData.channels;
const fxTimes = fixtureData.times;
const fxFiles = fixtureData.files;
const manifestPath = process.env.SLOCK_VISUAL_CASE_MANIFEST
  ? resolve(process.env.SLOCK_VISUAL_CASE_MANIFEST)
  : packageManifestPath;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { cases: VisualCase[] };
const requestedIds = (process.env.SLOCK_VISUAL_CASE_IDS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

// Mirrors isSkippedCase in src/cli.mjs so a raw playwright run and
// `slock-visual capture --providers react` select the same cases.
function isSkippedCase(visualCase: VisualCase): boolean {
  const value = visualCase.skip;
  if (value === true) return true;
  return Boolean(value && typeof value === "object" && value.enabled !== false);
}

const envFlag = (name: string) => ["1", "true"].includes(String(process.env[name] || "").toLowerCase());
const includePending = envFlag("SLOCK_VISUAL_INCLUDE_PENDING");
const includeSkipped = envFlag("SLOCK_VISUAL_INCLUDE_SKIPPED");
const selectedCases = requestedIds.length > 0
  ? manifest.cases.filter((item) => requestedIds.includes(item.id))
  : manifest.cases.filter((item) => includePending || item.baselineStatus !== "pending");
const cases = selectedCases.filter((item) => includeSkipped || !isSkippedCase(item));
{
  const excluded = manifest.cases.length - cases.length;
  if (excluded > 0) {
    console.log(
      `react visual provider: running ${cases.length}/${manifest.cases.length} manifest cases; `
        + `${excluded} pending/skipped/unselected cases excluded (SLOCK_VISUAL_INCLUDE_PENDING=1, `
        + `SLOCK_VISUAL_INCLUDE_SKIPPED=1, or SLOCK_VISUAL_CASE_IDS control selection).`,
    );
  }
}

function caseUrl(visualCase: VisualCase): string {
  const params = new URLSearchParams({ case: visualCase.id });
  const props = visualCase.variants?.[0]?.props || {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      params.set(key, String(value));
    }
  }
  return `/visual-testing.html?${params.toString()}`;
}

function visualBillingInfo(caseId: string) {
  const isNoPermission = caseId === "components.settings.billing.no-permission";
  const isFounder = caseId === "components.settings.billing.founder";
  const isDowngrade = caseId === "components.settings.billing.downgrade";
  const isPro = caseId === "components.settings.billing.page";
  const plan = isFounder ? "founder" : isPro ? "pro" : "free";
  const now = "2026-06-19T12:00:00.000Z";
  return {
    plan,
    displayName: isFounder ? "Founder" : isPro ? "Pro" : "Free",
    serverPlan: isDowngrade ? "free" : plan,
    source: isPro ? "subscription" : "server",
    capacity: {
      maxHumans: isPro ? 4 : 1,
      maxAgents: isPro ? 16 : 2,
      maxUniversalSeats: isPro ? 4 : -1,
    },
    usage: {
      humans: 2,
      agents: isDowngrade ? 8 : 2,
      universalSeats: isPro ? 2.5 : 0,
    },
    provisioned: {
      humans: isPro ? 4 : 1,
      agents: isPro ? 16 : 2,
      proPackQuantity: isPro ? 4 : 0,
      trialFreePackQuantity: 0,
      firstPackTrialEndsAt: null,
    },
    fileUploadQuota: {
      month: "2026-06",
      plan,
      limited: plan === "free",
      enforced: false,
      limitBytes: 524_288_000,
      usedBytes: 188_743_680,
      reservedBytes: 0,
      remainingBytes: 335_544_320,
    },
    price: isPro
      ? {
          billingInterval: "monthly",
          monthlyUsd: 80,
          annualUsd: 768,
          discountPercent: 20,
          baseMonthlyUsd: 80,
          overageMonthlyUsd: 0,
          seatQuantity: 4,
          packQuantity: 4,
          humanSeatQuantity: 4,
          agentSeatQuantity: 16,
          agentSeatBlockQuantity: 4,
        }
      : null,
    subscription: isPro
      ? {
          status: "active",
          billingInterval: "monthly",
          currentPeriodStart: now,
          currentPeriodEnd: "2026-07-19T12:00:00.000Z",
          cancelAtPeriodEnd: false,
        }
      : null,
    stripeConfigured: true,
    permissions: {
      canReadBillingSummary: !isNoPermission,
      canManageBilling: !isNoPermission,
    },
  };
}

async function quietApi(page: any, caseId: string) {
  await page.route("**/*", (route: any) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith("/api/")) {
      route.continue();
      return;
    }
    // screens.home.loading pins the post-sign-in transition: MainLayout's
    // mount-time list fetches must stay in flight so the primed loading:true
    // stores keep the home skeleton rows on screen (same delayed-fulfill
    // pattern as components.settings.billing.loading, task #372).
    // /api/channels/saved is delayed too so the Saved row's count badge stays
    // hidden — in the real transition that count has not loaded yet either.
    // screens.members.agent-detail.profile.loading-state (task #535 batch 2):
    // the machines list must still be in flight so the Computer row's
    // "not loaded yet" frame is what gets captured.
    if (caseId === "screens.members.agent-detail.profile.loading-state" && pathname.endsWith("/servers/visual-server/machines")) {
      setTimeout(() => { void route.fulfill({ status: 200, contentType: "application/json", body: "[]" }); }, 60_000);
      return;
    }
    if (
      caseId === "screens.home.loading"
      && (pathname === "/api/channels"
        || pathname === "/api/channels/dm"
        || pathname === "/api/agents"
        || pathname === "/api/channels/saved"
        || pathname.endsWith("/servers/visual-server/machines"))
    ) {
      setTimeout(() => {
        void route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(pathname === "/api/channels/saved" ? savedMessagesFixture : []),
        });
      }, 10_000);
      return;
    }
    // components.members.create-agent.claude-custom-provider-dialog drives
    // provider-mode -> Custom, but that control only exists once a runtime is
    // selected — and the runtime select is populated from this endpoint, not from
    // the case fixture. Without a catalog the select renders empty, nothing is
    // selectable, provider-mode never mounts, and the setup's first click times
    // out. That is the whole of this case's long-standing failure.
    //
    // Scoped to this one case on purpose: serving a catalog to every case would
    // auto-select a runtime everywhere and change unrelated visual baselines.
    if (
      caseId === "components.members.create-agent.claude-custom-provider-dialog"
      && pathname.endsWith("/runtime-options")
    ) {
      const machineId = pathname.split("/machines/")[1]?.split("/")[0] ?? null;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          context: "new_agent",
          machineId,
          options: [
            {
              runtimeId: "claude",
              capabilityStatus: "available",
              admissionStatus: "available_for_new",
              admissionReason: null,
              current: false,
              availableForNew: true,
              manageableForCurrentAgent: false,
              canSelectInThisContext: true,
            },
          ],
        }),
      });
      return;
    }
    if (pathname.endsWith("/auth/providers")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          providers: [
            { id: "google", label: "Google", enabled: true },
            { id: "github", label: "GitHub", enabled: true },
          ],
        }),
      });
      return;
    }
    if (pathname.endsWith("/auth/identities")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          identities: [
            { provider: "google", providerEmail: fxOwner.email },
          ],
        }),
      });
      return;
    }
    // components.thread.comment-anchor (task #566 regression pair): one
    // anchored comment so the list row's anchor chip renders, viewer allowed
    // to comment so the composer + pending-anchor chip show.
    if (pathname.endsWith("/attachments/att-anchor-1/comments")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          comments: [
            {
              id: "comment-anchor-1",
              channelId: "channel-anchor-1",
              senderType: "user",
              senderId: "user-anchor-2",
              senderName: "Artea",
              content: "Please keep the tag inset consistent with the field below.",
              createdAt: "2026-06-25T10:32:00.000Z",
              reactions: [],
              anchor: {
                type: "md-section",
                data: {
                  headingId: "agent-tabs-full-page-review",
                  headingTitle: "agent-tabs-full-page-review.mp4",
                },
              },
              senderAvatarUrl: null,
              senderGravatarHash: null,
            },
          ],
          threadChannelId: "channel-anchor-1",
          viewer: { canComment: true },
        }),
      });
      return;
    }
    if (pathname.endsWith("/attachments/upload")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          attachments: [{ id: `visual-upload-${Date.now()}` }],
        }),
      });
      return;
    }
    if (pathname.endsWith("/auth/me")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: fxOwner.id,
          email: fxOwner.email,
          gravatarHash: "",
          name: fxOwner.name,
          displayName: fxOwner.displayName,
          description: null,
          avatarUrl: null,
          emailVerified: fxOwner.emailVerified,
          preferredLanguage: null,
          preferredTimezone: fxOwner.timezone,
          autoTranslationEnabled: false,
          preferredTranslationDisplay: "translated",
          preferredTimeFormat: fxOwner.timeFormat,
          preferredMessageBodyFontSize: null,
        }),
      });
      return;
    }
    if (pathname === "/api/servers") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: fxServer.id,
            name: fxServer.name,
            slug: fxServer.slug,
            ownerId: fxOwner.id,
            onboardingAgentId: null,
            hideHumansFromMembers: false,
            plan: fxServer.plan,
            planDowngradedAt: null,
            role: "owner",
            createdAt: fxTimes.entityCreatedAtIso,
          },
        ]),
      });
      return;
    }
    // Connected Apps (IntegrationsSection) load() does a Promise.all of four
    // GETs that must each return an array or the render throws
    // (integrationOverview.filter is not a function). Mirror the canonical KMP
    // settingsVisualConnectedAppsSnapshot() so react pairs with the Android
    // seeded store: 3 marketplace (2 listings + the built-in GitHub) / 1
    // installed (GitHub Issues) / 1 my-app (Slack Bridge). Installed is derived
    // from marketplace records with installedAt set; my-apps = /integrations/clients.
    if (pathname.endsWith("/integrations/marketplace")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "market_slack", serverId: fxServer.id, clientId: "client_slack_bridge",
            appType: "third_party_global", publishStatus: "published", category: "Productivity & Collaboration",
            dataAccessSummary: "Messages and channel metadata", publishRejectionReason: null,
            name: "Slack Bridge", description: "Mirror Slock activity into Slack channels.",
            homepageUrl: "https://example.com/slack", returnUrl: null, agentManifestUrl: null,
            allowedScopes: [], logoUrl: null, humanMarketplaceVisible: true,
            createdByUserId: fxOwner.id, createdAt: fxTimes.entityCreatedAtIso, updatedAt: fxTimes.entityCreatedAtIso,
            installedAt: null, publisherName: "Raft Labs", privateShared: false,
          },
          {
            id: "market_github", serverId: fxServer.id, clientId: "client_github_issues",
            appType: "third_party_global", publishStatus: "published", category: "Development",
            dataAccessSummary: "Tasks and feedback", publishRejectionReason: null,
            name: "GitHub Issues", description: "Create issues from tasks and feedback.",
            homepageUrl: "https://example.com/github", returnUrl: null, agentManifestUrl: null,
            allowedScopes: [], logoUrl: null, humanMarketplaceVisible: true,
            createdByUserId: fxOwner.id, createdAt: fxTimes.entityCreatedAtIso, updatedAt: fxTimes.entityCreatedAtIso,
            installedAt: fxTimes.entityCreatedAtIso, publisherName: "Raft Labs", privateShared: false,
          },
        ]),
      });
      return;
    }
    if (pathname.endsWith("/integrations/built-in")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "builtin_github", clientId: "github", appType: "slock_builtin",
            name: "GitHub", description: "Built-in source control integration.",
            homepageUrl: "https://github.com", agentManifestUrl: null, allowedScopes: [],
            humanMarketplaceVisible: true, createdAt: fxTimes.entityCreatedAtIso, updatedAt: fxTimes.entityCreatedAtIso,
          },
        ]),
      });
      return;
    }
    if (pathname.endsWith("/integrations/clients")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "client_1", serverId: fxServer.id, clientId: "client_slack_bridge",
            appType: "server_local", publishStatus: "private", category: "Productivity & Collaboration",
            dataAccessSummary: "Messages and channel metadata", publishRejectionReason: null,
            name: "Slack Bridge", description: "Server-local OAuth client.",
            homepageUrl: "https://example.com", returnUrl: "https://example.com/oauth/callback",
            agentManifestUrl: "https://example.com/manifest.json", allowedScopes: [], logoUrl: null,
            humanMarketplaceVisible: false, createdByUserId: fxOwner.id,
            createdAt: fxTimes.entityCreatedAtIso, updatedAt: fxTimes.entityCreatedAtIso,
          },
        ]),
      });
      return;
    }
    if (pathname.endsWith("/integrations/overview")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
      return;
    }
    if (pathname.endsWith("/servers/visual-server/sidebar-order")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          channelOrder: [],
          agentOrder: ["agent-product-ux"],
          dmOrder: [],
          channelSortMode: "manual",
          jointChannelSortMode: "manual",
          dmSortMode: "recent",
          pinnedSortMode: "manual",
          pinnedChannelIds: [],
          pinnedAgentIds: ["agent-product-ux"],
          pinnedOrder: ["agent-product-ux"],
          hiddenDmIds: [],
          channelPanelTabOrder: [],
          agentPanelTabOrder: ["profile", "permissions", "dms", "reminders", "workspace", "integrations", "activity"],
        }),
      });
      return;
    }
    if (pathname.endsWith("/servers/visual-server/usage")) {
      if (caseId === "components.settings.billing.loading") {
        setTimeout(() => {
          void route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ agents: 2, machines: 1, channels: 4 }),
          });
        }, 10_000);
        return;
      }
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ agents: 2, machines: 1, channels: 4 }),
      });
      return;
    }
    if (pathname.endsWith("/servers/visual-server/members/visual-human-1/profile")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          userId: fxOwner.memberId,
          serverId: fxServer.id,
          email: fxOwner.email,
          gravatarHash: "",
          name: fxOwner.name,
          displayName: fxOwner.displayName,
          description: fxOwner.description,
          avatarUrl: null,
          role: fxOwner.role,
          joinedAt: fxTimes.memberJoinedAtIso,
          membershipStatus: "active",
          createdAgents: [],
        }),
      });
      return;
    }
    if (pathname.endsWith("/servers/visual-server/members")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            userId: fxOwner.memberId,
            serverId: fxServer.id,
            email: fxOwner.email,
            gravatarHash: "",
            name: fxOwner.name,
            displayName: fxOwner.displayName,
            description: fxOwner.description,
            avatarUrl: null,
            role: fxOwner.role,
            joinedAt: fxTimes.memberJoinedAtIso,
            membershipStatus: "active",
          },
          {
            userId: fxDesigner.id,
            serverId: fxServer.id,
            email: fxDesigner.email,
            gravatarHash: "",
            name: fxDesigner.name,
            displayName: fxDesigner.displayName,
            description: fxDesigner.description,
            avatarUrl: null,
            role: fxDesigner.role,
            joinedAt: fxTimes.memberJoinedAtIso,
            membershipStatus: "active",
          },
          {
            userId: fixtureData.humans.jiacheng.id,
            serverId: fxServer.id,
            email: fixtureData.humans.jiacheng.email,
            gravatarHash: "",
            name: fixtureData.humans.jiacheng.name,
            displayName: fixtureData.humans.jiacheng.displayName,
            description: fixtureData.humans.jiacheng.description,
            avatarUrl: null,
            role: fixtureData.humans.jiacheng.role,
            joinedAt: fxTimes.memberJoinedAtIso,
            membershipStatus: "active",
          },
        ]),
      });
      return;
    }
    if (pathname.endsWith("/servers/visual-server/machines")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: fxMachine.id,
            name: fxMachine.name,
            status: fxMachine.status,
            statusVersion: fxMachine.statusVersion,
            apiKeyPrefix: fxMachine.apiKeyPrefix,
            runtimes: fxMachine.runtimes,
            hostname: fxMachine.hostname,
            os: fxMachine.os,
            daemonVersion: fxMachine.daemonVersion,
            isComputer: fxMachine.isComputer,
            computerVersion: fxMachine.computerVersion,
            lastHeartbeat: fxMachine.lastHeartbeatIso,
            createdAt: fxMachine.createdAtIso,
          },
          // Offline studio machine — mirrors the render host's primed
          // visualMachines so Sidebar's mount refetch keeps the
          // machine-offline notification alive for
          // components.home.titlebar.states (task #334).
          {
            id: fxStudioMachine.id,
            name: fxStudioMachine.name,
            status: fxStudioMachine.status,
            statusVersion: fxStudioMachine.statusVersion,
            apiKeyPrefix: fxStudioMachine.apiKeyPrefix,
            runtimes: fxStudioMachine.runtimes,
            hostname: fxStudioMachine.hostname,
            os: fxStudioMachine.os,
            daemonVersion: fxStudioMachine.daemonVersion,
            isComputer: fxStudioMachine.isComputer,
            computerVersion: fxStudioMachine.computerVersion,
            lastHeartbeat: fxStudioMachine.lastHeartbeatIso,
            createdAt: fxStudioMachine.createdAtIso,
          },
          {
            id: fxDaemonOnlyMachine.id,
            name: fxDaemonOnlyMachine.name,
            status: fxDaemonOnlyMachine.status,
            statusVersion: fxDaemonOnlyMachine.statusVersion,
            apiKeyPrefix: fxDaemonOnlyMachine.apiKeyPrefix,
            runtimes: fxDaemonOnlyMachine.runtimes,
            hostname: fxDaemonOnlyMachine.hostname,
            os: fxDaemonOnlyMachine.os,
            daemonVersion: fxDaemonOnlyMachine.daemonVersion,
            isComputer: fxDaemonOnlyMachine.isComputer,
            computerVersion: fxDaemonOnlyMachine.computerVersion,
            lastHeartbeat: fxDaemonOnlyMachine.lastHeartbeatIso,
            createdAt: fxDaemonOnlyMachine.createdAtIso,
          },
          {
            id: fxLongNameMachine.id,
            name: fxLongNameMachine.name,
            status: fxLongNameMachine.status,
            statusVersion: fxLongNameMachine.statusVersion,
            apiKeyPrefix: fxLongNameMachine.apiKeyPrefix,
            runtimes: fxLongNameMachine.runtimes,
            hostname: fxLongNameMachine.hostname,
            os: fxLongNameMachine.os,
            daemonVersion: fxLongNameMachine.daemonVersion,
            isComputer: fxLongNameMachine.isComputer,
            computerVersion: fxLongNameMachine.computerVersion,
            lastHeartbeat: fxLongNameMachine.lastHeartbeatIso,
            createdAt: fxLongNameMachine.createdAtIso,
          },
        ]),
      });
      return;
    }
    if (pathname.endsWith("/channels/visual-thread-composer/files")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          files: [
            {
              id: "visual-file-image",
              messageId: "msg-files-image",
              channelId: fxChannels.composerHost.id,
              filename: fxFiles.image.filename,
              mimeType: fxFiles.image.mimeType,
              sizeBytes: fxFiles.image.sizeBytes,
              width: 128,
              height: 128,
              thumbnailUrl:
                "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20128%20128%22%3E%3Crect%20width%3D%22128%22%20height%3D%22128%22%20fill%3D%22%23FDE047%22%2F%3E%3Ccircle%20cx%3D%2288%22%20cy%3D%2240%22%20r%3D%2220%22%20fill%3D%22%23F472B6%22%2F%3E%3Cpath%20d%3D%22M16%20104L48%2068l22%2024%2018-16%2024%2028H16z%22%20fill%3D%22%23000000%22%2F%3E%3C%2Fsvg%3E",
              createdAt: fxTimes.fileImageAtIso,
              uploader: { type: "user", id: fxOwner.id, name: fxOwner.name, displayName: fxOwner.displayName },
              source: { type: "channel", channelId: fxChannels.composerHost.id, parentMessageId: null, parentMessageShortId: null },
            },
            {
              id: "visual-file-pdf",
              messageId: "msg-files-pdf",
              channelId: fxChannels.composerHost.id,
              filename: fxFiles.pdf.filename,
              mimeType: fxFiles.pdf.mimeType,
              sizeBytes: fxFiles.pdf.sizeBytes,
              createdAt: fxTimes.filePdfAtIso,
              uploader: { type: "agent", id: fxCindy.id, name: fxCindy.name, displayName: fxCindy.displayName },
              source: { type: "thread", channelId: fxChannels.composerHost.id, parentMessageId: "parent-files", parentMessageShortId: "f8e569cb" },
            },
            {
              id: "visual-file-zip",
              messageId: "msg-files-zip",
              channelId: fxChannels.composerHost.id,
              filename: fxFiles.zip.filename,
              mimeType: fxFiles.zip.mimeType,
              sizeBytes: fxFiles.zip.sizeBytes,
              createdAt: fxTimes.fileZipAtIso,
              uploader: { type: "agent", id: fxAndroidDev.id, name: fxAndroidDev.name, displayName: fxAndroidDev.displayName },
              source: { type: "channel", channelId: fxChannels.composerHost.id, parentMessageId: null, parentMessageShortId: null },
            },
          ],
          nextCursor: "next-files-page",
        }),
      });
      return;
    }
    if (pathname === "/api/agents") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(fxAgentDetailAgents.map((agent) => ({
          id: agent.id,
          serverId: fxServer.id,
          name: agent.name,
          displayName: agent.displayName,
          avatarUrl: agent.avatar,
          description: agent.description,
          status: agent.status,
          // noMembership has none on purpose: the wire omits serverRole for an agent
          // without a membership row, and JSON.stringify drops the undefined key.
          serverRole: (agent as { serverRole?: string }).serverRole,
          model: agent.model,
          runtime: agent.runtime,
          reasoningEffort: agent.reasoningEffort,
          executionMode: agent.executionMode,
          envVars: { RAFT_PROFILE: "product-ux", SLOCK_VISUAL_PROVIDER: "react" },
          machineId: fixtureAgentMachineId(agent),
          sessionId: agent.sessionId,
          runtimeProfile: null,
          creatorType: "user",
          creatorId: fxOwner.id,
          creator: {
            type: "human",
            id: fxOwner.id,
            name: fxOwner.name,
            displayName: fxOwner.displayName,
            avatarUrl: null,
            gravatarHash: "",
          },
          createdAgents: agent.createdAgents.map((created: any) => ({
            id: created.id,
            name: created.name,
            displayName: created.displayName,
            avatarUrl: null,
            runtime: created.runtime,
            status: created.status,
          })),
          deletedAt: null,
          createdAt: fxTimes.entityCreatedAtIso,
          activity: agent.activity,
          activityDetail: agent.activityDetail,
        }))),
      });
      return;
    }
    if (isAgentDetailSubRoute(pathname, "activity-log")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            timestamp: 1781872080000,
            entry: {
              kind: "status",
              activity: "working",
              detail: "Capturing deterministic Activity tab state",
            },
          },
          {
            timestamp: 1781872140000,
            entry: {
              kind: "thinking",
              text: "Comparing React and Android Members Activity screenshots before publishing.",
            },
          },
          {
            timestamp: 1781872200000,
            entry: {
              kind: "tool_start",
              toolName: "shell",
              toolInput: "pnpm --filter @botiverse/raft-visual-testing exec slock-visual diff --case screens.members.agent-detail.activity",
            },
          },
          {
            timestamp: 1781872260000,
            entry: {
              kind: "slock_action",
              title: "Posted status update",
              text: "Reported capture progress in #product:d4870bc3 and kept #225 in review.",
            },
          },
        ]),
      });
      return;
    }
    if (pathname === "/api/channels") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
      return;
    }
    if (pathname === "/api/channels/dm") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "dm-agent-product-ux-artin",
            serverId: fxServer.id,
            name: fxProductUx.displayName,
            description: fixtureData.messages.dmLastPreview,
            type: "dm",
            peerId: fxProductUx.id,
            peerName: fxProductUx.displayName,
            createdAt: fxTimes.recentActivityAtIso,
            joined: true,
          },
        ]),
      });
      return;
    }
    if (pathname === "/api/channels/unread") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
      return;
    }
    if (pathname === "/api/channels/inbox") {
      // Must mirror the render host's primed useInboxStore rows (shared
      // activityResultsFixture.json) so ThreadsInbox's mount-time loadInbox()
      // cannot swap in rows the Android fixture never shows. Scoped to the
      // activity case: other cases keep an empty inbox (task #351).
      if (caseId === "components.home.activity.results") {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(activityResultsFixture),
        });
        return;
      }
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], hasMore: false }),
      });
      return;
    }
    if (pathname === "/api/servers/unread-summary") {
      // Marks the OTHER primed server (visual-alt-server) unread so the
      // titlebar badge shows its pink server-unread dot
      // (components.home.titlebar.states, task #334).
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { serverId: "visual-alt-server", unreadCount: 3, serverPushMuted: false },
        ]),
      });
      return;
    }
    if (pathname === "/api/channels/saved") {
      // Must mirror the render host's primed useSavedStore state (shared
      // savedMessagesFixture.json) — an empty payload here wiped the saved
      // list the moment SavedPanel's mount effect reconciled (task #334).
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(savedMessagesFixture),
      });
      return;
    }
    if (pathname === "/api/tasks/server") {
      // Must mirror the render host's primed useTaskStore.serverTasks (shared
      // tasksFixture.json) — TasksPanel's mount-time loadServerTasks() would
      // otherwise replace the primed cards (task #353).
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tasks: tasksFixture.tasks }),
      });
      return;
    }
    if (pathname === "/api/channels/threads/followed") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
      return;
    }
    if (pathname === "/api/announcements/active") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ announcements: [] }),
      });
      return;
    }
    if (pathname.endsWith("/servers/visual-server/onboarding-settings")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          // Administration cases mirror Android's canonical
          // settingsRouteVisualState onboarding snapshot: Cindy selected +
          // greeting enabled (task #388). Gated so other cases (home/setup
          // reminder logic reads this payload too) keep the null default.
          onboardingAgentId: caseId.includes("administration") ? fxCindy.id : null,
          agentAllChannelGreetingEnabled: true,
          setupModalReminderOptOut: true,
          onboardingReminderOptOut: true,
          dismissedAddComputerStepAt: "2026-06-18T00:00:00.000Z",
          dismissedCreateAgentStepAt: "2026-06-18T00:00:00.000Z",
          dismissedInviteStepAt: "2026-06-18T00:00:00.000Z",
          dismissedCommunityStepAt: "2026-06-18T00:00:00.000Z",
          dismissedNotificationStepAt: "2026-06-18T00:00:00.000Z",
          onboardingWizardCurrentStep: null,
          onboardingDmSentAt: null,
          onboardingDmSentByAgentId: null,
        }),
      });
      return;
    }
    if (pathname.endsWith("/billing/subscription")) {
      if (caseId === "components.settings.billing.loading") {
        setTimeout(() => {
          void route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(visualBillingInfo(caseId)),
          });
        }, 10_000);
        return;
      }
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(visualBillingInfo(caseId)),
      });
      return;
    }
    if (pathname.endsWith("/servers/visual-server/notification-settings")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ serverPushMuted: false }),
      });
      return;
    }
    if (pathname.endsWith("/servers/visual-server/translation-settings")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        // Field names mirror the real GET /servers/:id/translation-settings
        // response (servers.ts) — translationStore.loadSettings reads
        // `translationAvailable`/`canManageTranslation`; the previous
        // `providerAvailable`/`canManageServerTranslation` keys were ignored,
        // leaving the Translation checkbox disabled with no Save button
        // (task #388, Android canonical shows the control manageable).
        body: JSON.stringify({
          translationEnabled: true,
          translationAvailable: true,
          canManageTranslation: true,
        }),
      });
      return;
    }
    // Administration fixtures below mirror Android's canonical
    // settingsRouteVisualState (mobile SettingsHomePage.kt
    // settingsVisualServerSnapshot) so the task #388 full-height pixel diff
    // compares identical data. Field names follow the real server responses
    // (inviteService.listPendingInvites / listJoinLinks) — the previous stubs
    // used `email`/`code`, which InvitesSection/JoinLinksSection never read,
    // so both sections rendered blank rows.
    if (pathname.endsWith("/servers/visual-server/invites")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "invite-visual-designer",
            invitedEmail: fxDesigner.email,
            invitedByUserId: fxOwner.id,
            status: "pending",
            expiresAt: "2026-07-18T00:00:00.000Z",
            createdAt: fxTimes.entityCreatedAtIso,
          },
          {
            id: "invite-visual-qa",
            invitedEmail: "qa@slock.ai",
            invitedByUserId: fxCindy.id,
            status: "pending",
            expiresAt: "2026-07-19T12:24:00.000Z",
            createdAt: fxTimes.recentActivityAtIso,
          },
        ]),
      });
      return;
    }
    if (pathname.endsWith("/servers/visual-server/join-links")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "join-link-visual",
            // Android's canonical link is https://app.raft.build/join/design;
            // react builds the URL as `${window.location.origin}/join/${token}`
            // so only the /join/design path can be mirrored from data — the
            // origin renders as the harness host.
            token: "design",
            createdAt: fxTimes.entityCreatedAtIso,
            expiresAt: fxTimes.recentActivityAtIso,
            maxUses: 25,
            useCount: 8,
            revokedAt: null,
          },
        ]),
      });
      return;
    }
    if (pathname.endsWith("/servers/visual-server/agreement")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          enabled: true,
          agreement: {
            title: "Raft Design workspace agreement",
            bodyMarkdown: "Please keep feedback actionable and avoid sharing credentials in public channels.",
          },
        }),
      });
      return;
    }
    if (pathname.endsWith("/integrations/clients")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "oauth-visual-ci",
            clientId: "visual-ci",
            name: "Visual CI",
            description: "Publishes screenshot reports.",
            homepageUrl: "https://ci.example.com",
            returnUrl: "https://ci.example.com/callback",
            agentManifestUrl: null,
            category: "Developer Tools",
            dataAccessSummary: "Profile and identity",
            publishStatus: "private",
            logoUrl: null,
          },
        ]),
      });
      return;
    }
    if (pathname.endsWith("/integrations/built-in")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "builtin-docs",
            clientId: "docs",
            name: "Docs",
            description: "Create documents from agent work.",
            homepageUrl: "https://docs.example.com",
            agentManifestUrl: null,
          },
        ]),
      });
      return;
    }
    if (pathname.endsWith("/integrations/marketplace")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "marketplace-storage",
            clientId: "storage",
            name: "Storage Sync",
            publisherName: "Slock Labs",
            description: "Sync files for review.",
            homepageUrl: "https://storage.example.com",
            returnUrl: "https://storage.example.com/callback",
            logoUrl: null,
            category: "Infrastructure",
            dataAccessSummary: "Profile and identity",
            installedAt: "2026-06-18T00:00:00.000Z",
          },
        ]),
      });
      return;
    }
    if (pathname.endsWith("/skills")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          global: [
            {
              name: "visual-testing",
              displayName: "visual-testing",
              description: "Cross-platform fixture ownership",
              sourcePath: "notes/product",
              userInvocable: false,
            },
          ],
          workspace: [
            {
              name: "feature-map",
              displayName: "feature-map",
              description: "React/KMP parity maps",
              sourcePath: "notes/product",
              userInvocable: false,
            },
          ],
        }),
      });
      return;
    }
    if (pathname.endsWith("/agent-dms")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "dm-agent-product-ux-artin",
            peerId: fxOwner.id,
            peerName: fxOwner.name,
            lastMessageAt: fxTimes.recentActivityAtIso,
            lastMessagePreview: fixtureData.messages.dmLastPreview,
          },
        ]),
      });
      return;
    }
    if (pathname.endsWith("/channels/channel-design/members") || pathname.endsWith("/channels/visual-thread-composer/members")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          agents: [
            {
              id: fxCindy.id,
              serverId: fxServer.id,
              name: fxCindy.name,
              displayName: fxCindy.displayName,
              avatarUrl: fxCindy.avatar,
              description: fxCindy.description,
              status: fxCindy.status,
              model: fxCindy.model,
              runtime: fxCindy.runtime,
              reasoningEffort: fxCindy.reasoningEffort,
              executionMode: fxCindy.executionMode,
              envVars: {},
              machineId: fxMachine.id,
              sessionId: fxCindy.sessionId,
              runtimeProfile: null,
              creatorType: "user",
              creatorId: fxOwner.id,
              creator: null,
              createdAgents: [],
              deletedAt: null,
              createdAt: fxTimes.entityCreatedAtIso,
              activity: fxCindy.activity,
              activityDetail: fxCindy.activityDetail,
            },
          ],
          humans: [
            {
              id: fxOwner.memberId,
              userId: fxOwner.memberId,
              serverId: fxServer.id,
              name: fxOwner.name,
              displayName: fxOwner.displayName,
              description: fxOwner.description,
              avatarUrl: null,
              gravatarHash: "",
              email: fxOwner.email,
              role: fxOwner.role,
              joinedAt: fxTimes.memberJoinedAtIso,
            },
          ],
        }),
      });
      return;
    }
    if (pathname.endsWith("/messages/search")) {
      // Rows live in shared searchResultsFixture.json (fixtureData-derived
      // channel/sender/times) so the Android provider can render the same
      // list for components.home.search.results (task #351).
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(searchResultsFixture),
      });
      return;
    }
    if (pathname.endsWith("/external-status")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          setupState: "connected",
          credentialLastUsedAt: "2026-06-19T12:20:00.000Z",
          lastActivityAt: "2026-06-19T12:28:00.000Z",
        }),
      });
      return;
    }
    if (isAgentDetailSubRoute(pathname, "scopes")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          agentId: pathname.match(/\/agents\/([^/]+)\//)?.[1] ?? fxProductUx.id,
          granted: [
            "inbox:read",
            "inbox:write",
            "channels:read",
            "messages:write",
          ],
          revision: 7,
          updatedAt: "2026-06-19T12:28:00.000Z",
          mode: "custom",
        }),
      });
      return;
    }
    if (isAgentDetailSubRoute(pathname, "workspace-files/read")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          path: "MEMORY.md",
          content: "# Product UX Designer\n\n- Owns visual fixture review.\n- Tracks cross-platform parity gaps.\n",
          binary: false,
          size: 86,
          mimeType: "text/markdown",
          modifiedAt: "2026-06-19T12:28:00.000Z",
        }),
      });
      return;
    }
    if (isAgentDetailSubRoute(pathname, "workspace-files")) {
      const dirPath = new URL(route.request().url()).searchParams.get("dirPath");
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          files: dirPath
            ? [
                {
                  name: "visual-parity.md",
                  path: "notes/visual-parity.md",
                  isDirectory: false,
                  size: 1240,
                  modifiedAt: "2026-06-19T12:28:00.000Z",
                },
              ]
            : [
                {
                  name: "MEMORY.md",
                  path: "MEMORY.md",
                  isDirectory: false,
                  size: 86,
                  modifiedAt: "2026-06-19T12:28:00.000Z",
                },
                {
                  name: "notes",
                  path: "notes",
                  isDirectory: true,
                  modifiedAt: "2026-06-19T12:28:00.000Z",
                },
              ],
        }),
      });
      return;
    }
    if (pathname === "/api/reminders") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          reminders: [
            {
              reminderId: "reminder-product-ux-memory",
              ownerAgentId: "agent-product-ux",
              title: "Roll 1-6; if 3, tidy Product-UX memory/files",
              fireAt: "2026-06-19T18:30:00.000Z",
              status: "scheduled",
              recurrenceDescription: "daily",
            },
          ],
        }),
      });
      return;
    }
    if (pathname.startsWith("/api/integrations/agents/")) {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
      return;
    }
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ agents: [], humans: [], results: [] }),
    });
  });
}

async function seedVisualCase(page: Page, visualCase: VisualCase) {
  const props = visualCase.variants?.[0]?.props || {};
  if (visualCase.id === "components.auth.register.inputs") {
    await page.locator("input[type='email']").fill(String(props.registerEmail || fixtureData.registerForm.email));
    await page.locator("input[type='password']").fill(String(props.registerPassword || fixtureData.registerForm.password));
    return;
  }
  if (visualCase.id === "screens.auth.profile-setup") {
    await page.locator("input[name='username']").fill(String(props.profileSetupHandle || "new_designer"));
    await page.locator("input[name='name']").fill(String(props.profileSetupDisplayName || "New Designer"));
    return;
  }

  if (visualCase.id === "components.thread.composer.image-preview") {
    // Opaque 128x128 PNG rasterized from the same SVG art the visual file
    // fixtures use (yellow ground, pink sun, black mountain), so the React
    // composer preview shows the same picture as the Android fixture image.
    await page.getByTestId("composer-media-input").setInputFiles({
      name: "composer-preview.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAACXBIWXMAAAsTAAALEwEAmpwYAAAGw0lEQVR4nO2cb2iVVRzHn01zRtPMGtFeKPoiNRP/gIUpKK06SyFLfREEuehFBK4iZmBbKyXLIVGbzgSxWUtxOhPaEpyYL9WoF9nKwNgO1csiit17t7t7+MV56Eped+e993nO8zvnPt8XXxhMec79/T7395zf93fOPCUFQSK2MfC4FwAJAAAIBCoAIBB4BQACgT0AIBDYBAICgS4AEAi0gYBAwAcABAJGECAQcAIBgYAVDAgEZgGAQGAYBAgEpoGAQGAcDAgEzgMAAoEDIYBA4EQQIBA4EsYGwVA9jV9soLHeFkp1dlDy3c8pseM0jTT1+dI/J3d3+7/T/2b80lZSw3Ych8OZQFl68DKDW2j02C5KtJ6kkdfPFKVE6wkaPbqTMoObAYBzib/6NKU+aaORpv6iE3+Tmvop1dVGmasbUQFcUPrsK5R484vgic+tCM2nKD3QGPnnwStAFhisofWUOrw39MTnSlcW/SwAYJOubaBk+wHjyc8q2XHAfyYqgCXf/GSEyb8OwUcHSQ09iVcANwCpCMp+3tdBVxsA4Ex++uyrbMnPKn3O7MYQm0CZv9VLNIe/2y9WuuMw2SICAJmn9Os+nzn5WY0e2QMAoiz9mcHN4Zg8YampnzI/bEEFiAqA0WO7+JOeWwWO7gQAkQAwLHyfnjvhudLzBj10wh7AMADjFxvYk51P45e3AgDTAIz1trAnOp/GTrUAANMAJDv3sSc6n1IH2gGAcQB2d7MnOp+S73UDANMAJAyMesOSNqawCTQMwIhN/X+utvcBAAAgQo0BrGCJV4Dxb5VLSmITGHMAOtEGxlpjNhtBvc2hf17sAeSNAdGXNrgTnU/jl58HANEMg3rYk52rxNs9Rm4ToQLIm4OiR6/cCc+VHlGbAB4ASAcOhGzvo8zgJgAQ5WYw1WXRkbBP3zf2OVEB5MSByfy80Y5Doc2ncCiUS+mBRnYA0ue2Gf2MqADS3tPBJk8DA4BCgzRUT8n90buDyY5OXA2z6nJoR4SXQ/d14nKofZVgfSSdgV/2I7gUildAiQFLn2s00h34fyDC8IYPAIR4b3D0yB7foAmc/O19fp+v206OyoYuQAYAYXCTbxuXMjvQ/0fbu6YcPgAQZSCHhX9pQ5/b10e39eld/3CptpOb+v2fk7s/83+nR7r+VA9/Jo6PekjgFQAIBPYACtUAm0AVcwjQBUj+JAAACwKhYipUAMmfBABgQSBUTOV0BdjbvIDadtzPvg7lsJwF4Pj+pVRZWUEVFR4dalvMvh7lqJwE4OuelVQ1rZI8z/M1ZUoFnfx4Gfu6lINyDoArA6vprjtvu578rKZXVdKFEw+xr085JqcA+PXSWppTO/2m5Gc1s3oqffvVKvZ1KofkDAB/DdbR0kUz8iY/q5rZ0+jqhTXs61WOyAkAUtcep7o1d98y+VnNn3M7/f7NOvZ1KwdkPQCZYUHPPVNbcPKzWrJwBv3x/aPs61eWy3oAXntxbtHJz2rViln0z0+PsYH7xsvzqP2dRewxdBYAbfSUmvysNtTV0NgvT0T+ynr2qfv852uv4vSh5eyxdA6ArNETFAAt/QrR38go1v3nlTpa+/DsG55ffccU+u7MI+wxdQaAXKMnDG1rmGN83b9dXkfLHpi4U6m9t4rkxbXssbUegHxGTxgyOTe4MrB6Uo9Ca/nimfT3jzx7EicAuJXRE1Sm5gbnj6+kWTOnFrSG+nX3RL4ncQKAQo2eoAp7btB7cJlvQxezhsYX5rLH2yoAijV6giqsucGHrQtL3qja0h56rho9QRVkbpD5r8cP8nxb2kPPZaMnqGpKmBv8v8cPKhvaQ891oyeo5hcxN5ioxw8q7vbQKwejJ6iWFDA3mKzHDyrO9tArF6MnqFZNMjcopMcPKq720Csno8fE3OB8ET1+UHG0h145GT1hzw16S+jxgyrq9jAyAPQG6sEF1ewJLkRNL82jD94qvccPalR9eXhFeQEQtdHjuqojbA+9cjV6XFdtRO2hV85Gj+taHkF76JW70eO66g23h14cjB7X1WiwPfTiYvS4rnZD7aEXJ6PHZVUamh56cTN6XFa1gfbQc+1ET9xVG3J7GAoAMHo8Z9vDwADA6PGcbg8DAwCjx3O6PWQ/EgYJ1hgAABlvCAGA5E8CALAgECqmQgWQ/EkAABYEQsVUqACSPwkAwIJAqJgKFUDyJwEAWBAIFVOhAkj+JAAACwKhYipUAMmfBABgQSBUTIUKIPmTAAAsCISKqVABJH8SAIAFgVAxFSqA5E8CALAgECqmQgWQ/EkAABYEQsVUqACSPwkAwIJAqJjqX0exlowR0ml5AAAAAElFTkSuQmCC",
        "base64"
      ),
    });
    await page.waitForSelector("[data-message-affordance='attachment-preview-loading'], [data-message-affordance='file-preview']", { timeout: 5_000 }).catch(() => undefined);
    await page
      .waitForFunction(() => {
        const img = document.querySelector<HTMLImageElement>("img[alt='composer-preview.png']");
        return !!img && img.complete && img.naturalWidth > 0;
      }, undefined, { timeout: 5_000 })
      .catch(() => undefined);
    await page.waitForTimeout(240);
    return;
  }

  if (visualCase.id === "components.thread.composer.file-previews") {
    await page.setInputFiles("input[type='file']:not([accept])", [
      {
        name: "release-notes.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4 visual fixture\n"),
      },
      {
        name: "android-smoke-log.zip",
        mimeType: "application/zip",
        buffer: Buffer.from("visual zip fixture"),
      },
    ]);
    await page.waitForSelector("[data-message-affordance='file-preview'], [data-message-affordance='file-download']", { timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(240);
  }
}

async function applyInteractions(page: Page, visualCase: VisualCase) {
  const interactions = [
    ...(visualCase.capture?.interactions || []),
    ...(visualCase.variants?.[0]?.interactions || []),
  ];
  for (const interaction of interactions) {
    if (interaction.type === "wait") {
      await page.waitForTimeout(interaction.ms || 0);
    } else if (interaction.type === "click" && interaction.target) {
      await page.locator(interaction.target).first().click();
    } else if (interaction.type === "contextmenu" && interaction.target) {
      const target = page.locator(interaction.target).first();
      const box = await target.boundingBox();
      if (!box) throw new Error(`contextmenu target has no bounding box: ${interaction.target}`);
      const clientX = Math.round(box.x + (interaction.x ?? box.width / 2));
      const clientY = Math.round(box.y + (interaction.y ?? box.height / 2));
      await target.evaluate((element, position) => {
        element.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          buttons: 2,
          clientX: position.clientX,
          clientY: position.clientY,
        }));
      }, { clientX, clientY });
      await page.getByRole("menu", { name: "Message context menu" }).first().waitFor({ state: "visible" });
    } else if (interaction.type === "fill" && interaction.target) {
      await page.locator(interaction.target).first().fill(interaction.value || "");
    }
  }
}

async function applyCaseFixtureState(page: Page, visualCase: VisualCase) {
  if (visualCase.id === "components.settings.account.password-expanded") {
    await page.getByRole("button", { name: "Change Password" }).first().click();
    const submit = page.locator("form button[type='submit']").last();
    await submit.waitFor({ state: "visible" });
    await submit.scrollIntoViewIfNeeded();
    return;
  }
  if (visualCase.id !== "components.members.create-agent.claude-custom-provider-dialog") return;
  await page.getByTestId("runtime-provider-mode-select").click();
  await page.getByRole("option", { name: "Custom", exact: true }).click();
  await page.getByPlaceholder("https://gateway.example.com").fill("https://gateway.example.com");
  await page.getByPlaceholder("sk-ant-...").fill("visual-test-key");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.getByPlaceholder("claude").fill("claude");
  await page.locator(".fixed.inset-0").evaluate((element) => {
    element.scrollTop = 0;
  });
}

for (const visualCase of cases) {
  test(`react visual provider ${visualCase.id}`, async ({ page }) => {
    page.on("console", (message: any) => {
      if (message.type() === "error") {
        console.log(`browser console error: ${message.text()}`);
      }
    });
    page.on("pageerror", (error: Error) => {
      console.log(`browser pageerror: ${error.message}`);
    });
    await quietApi(page, visualCase.id);
    // Every case renders against the fixture's declared instant, like the Android
    // visual host does (VisualFixtureData.Locale.NOW_EPOCH_MILLIS). Without this,
    // relative labels ("75 days ago" on screens.members.agent-detail.reminders)
    // drift with the CI wall clock and the cell can never be stable (task #536, S1).
    // billing.trial keeps its own instant below: its fixture is built around it.
    const fixtureNowEpochMillis = Number(fixtureData.locale?.nowEpochMillis);
    if (!Number.isFinite(fixtureNowEpochMillis)) {
      throw new Error("visual-testing/shared/fixtureData.json must declare locale.nowEpochMillis");
    }
    if (visualCase.id !== "components.settings.billing.trial") {
      await page.clock.setFixedTime(new Date(fixtureNowEpochMillis));
    }
    if (visualCase.id === "components.settings.billing.trial") {
      await page.clock.setFixedTime(new Date("2026-05-15T12:00:00.000Z"));
      await page.addInitScript(() => {
        const fixed = new Date("2026-05-15T12:00:00.000Z").getTime();
        const RealDate = Date;
        class FixedDate extends RealDate {
          constructor(...args: ConstructorParameters<DateConstructor>) {
            super(...(args.length ? args : [fixed]));
          }
          static now() {
            return fixed;
          }
        }
        FixedDate.UTC = RealDate.UTC;
        FixedDate.parse = RealDate.parse;
        FixedDate.prototype = RealDate.prototype;
        window.Date = FixedDate as DateConstructor;
        globalThis.Date = FixedDate as DateConstructor;
      });
    }
    const viewport = visualCase.viewport || { width: 390, height: 844, density: 1 };
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(caseUrl(visualCase));
    await page.evaluate(() => document.fonts.ready);
    // The render host shows an explicit panel for unregistered case ids.
    // Fail here so body/viewport-selector cases cannot screenshot it as a
    // plausible-looking baseline.
    const unknownCase = page.locator("[data-visual-unknown-case]");
    if ((await unknownCase.count()) > 0) {
      const reported = await unknownCase.first().getAttribute("data-visual-unknown-case");
      throw new Error(
        `render host does not recognize case id '${visualCase.id}' (reported '${reported}'); register it in VisualTestingCases.tsx before capturing`,
      );
    }
    await seedVisualCase(page, visualCase);
    await applyInteractions(page, visualCase);
    await applyCaseFixtureState(page, visualCase);
    await page.waitForTimeout(120);

    const selector = visualCase.capture?.selector || `[data-visual-case='${visualCase.id}']`;
    const target = page.locator(selector).first();
    if ((await target.count()) === 0) {
      const visualCount = await page.locator("[data-visual-case]").count();
      const html = await page.locator("body").evaluate((body) => body.innerHTML.slice(0, 500));
      console.log(`visual provider debug case=${visualCase.id} url=${page.url()} visualCount=${visualCount} body=${html}`);
    }
    await expect(target).toBeVisible();

    const outputDir = resolve(resultRoot, "react");
    mkdirSync(outputDir, { recursive: true });
    const imagePath = resolve(outputDir, `${visualCase.id}.png`);
    const captureContract = visualCase.capture?.contract || "component-bounds";
    const isViewportPortalCapture = captureContract === "viewport-with-portal";
    // full-height is the sanctioned exception to the viewport-clamp parity
    // contract below: it captures the WHOLE scrollable route at content height
    // (390 wide, height follows content) to pair with the Android eager
    // full-height capture (task #388) that renders every item beyond the
    // viewport. Normal captures stay clamped because android cannot render
    // beyond its viewport.
    const isFullHeightCapture = captureContract === "full-height";
    // Parity contract: the diff engine pads and never rescales, so react
    // captures must not exceed the android-capturable window (android cannot
    // render beyond its viewport). Element screenshots capture the full
    // bounding box even when it overflows the viewport, so clamp them to the
    // viewport intersection; element crops within the viewport keep the
    // existing element-screenshot behavior unchanged.
    let clampedRect: { x: number; y: number; width: number; height: number } | null = null;
    if (!isViewportPortalCapture && !isFullHeightCapture) {
      const box = await target.boundingBox();
      const viewportSize = page.viewportSize() || { width: viewport.width, height: viewport.height };
      if (box && (box.x < 0 || box.y < 0 || box.x + box.width > viewportSize.width || box.y + box.height > viewportSize.height)) {
        const x = Math.max(box.x, 0);
        const y = Math.max(box.y, 0);
        const width = Math.min(box.x + box.width, viewportSize.width) - x;
        const height = Math.min(box.y + box.height, viewportSize.height) - y;
        if (width > 0 && height > 0) {
          clampedRect = { x, y, width, height };
        }
      }
    }
    let fullHeightPx: number | null = null;
    if (isFullHeightCapture) {
      // Let the layout settle at full content height before measuring/capturing.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
      fullHeightPx = await page.evaluate(() =>
        Math.ceil(
          Math.max(
            document.documentElement.scrollHeight,
            document.body ? document.body.scrollHeight : 0,
          ),
        ),
      );
    }
    if (isFullHeightCapture) {
      await page.screenshot({ path: imagePath, fullPage: true });
    } else if (isViewportPortalCapture) {
      await page.screenshot({ path: imagePath });
    } else if (clampedRect) {
      await page.screenshot({ path: imagePath, clip: clampedRect });
    } else {
      await target.screenshot({ path: imagePath });
    }
    const rect = isFullHeightCapture
      ? { x: 0, y: 0, width: viewport.width, height: fullHeightPx ?? viewport.height }
      : isViewportPortalCapture
        ? { x: 0, y: 0, width: viewport.width, height: viewport.height }
        : clampedRect || (await target.boundingBox());
    const roundedRect = rect
      ? {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      : null;
    writeFileSync(
      resolve(outputDir, `${visualCase.id}.metadata.json`),
      JSON.stringify(
        {
          provider: "react",
          providerType: "react-playwright",
          caseId: visualCase.id,
          image: `visual-testing-results/react/${visualCase.id}.png`,
          viewport,
          selector,
          crop: {
            mode: visualCase.capture?.crop || "element",
            contract: captureContract,
            rect: roundedRect,
            targetRect: roundedRect,
            outset: null,
          },
          capturedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  });
}
