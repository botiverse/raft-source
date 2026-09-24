import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { FEATURE_FLAG_REGISTRY } from "../src/analytics/flagRegistry";
import {
  isWorkspaceGridDemoEnabledForServer,
  isWorkspaceGridViewport,
  WORKSPACE_GRID_DEMO_FLAG_KEY,
  WORKSPACE_GRID_DEMO_INITIAL_MODEL,
  WORKSPACE_GRID_DEMO_MOBILE_POLICY,
  WORKSPACE_GRID_DEMO_ROUTE,
  WORKSPACE_GRID_MIN_WIDTH_PX,
  WORKSPACE_GRID_VIEWPORT_QUERY,
  workspaceGridPanelTab,
} from "../src/components/workspace/workspaceGridDemoConfig";
import {
  clearWorkspaceGridDragPanel,
  emitWorkspaceGridDragPanel,
  isWorkspaceGridDemoPath,
  readWorkspaceGridDragPanel,
} from "../src/components/workspace/workspaceGridOpenEvents";
import type { WorkspaceGridNavigationState } from "../src/components/workspace/workspaceGridNavigationStore";
import {
  createWorkspaceGridSidebarSelection,
  selectWorkspaceGridActive,
  selectWorkspaceGridActiveAncestorRefKey,
  selectWorkspaceGridActiveRefKey,
} from "../src/components/workspace/workspaceGridSidebarSelection";
import { adjacentWorkspaceTabsetId, nextWorkspaceMruTabId, nextWorkspaceTabIndex } from "../src/components/workspace/workspaceGridKeyboard";
import {
  decodeWorkspaceGridUrlState,
  encodeWorkspaceGridUrlState,
  getWorkspaceGridUrlSearch,
  serializeWorkspaceGridLayoutIntent,
  WORKSPACE_GRID_URL_PARAM,
} from "../src/components/workspace/workspaceGridUrlState";

const webRoot = resolve(import.meta.dirname, "..");
const srcRoot = resolve(webRoot, "src");
const strykerBackupSrc = () => {
  const tmp = resolve(webRoot, ".stryker-tmp");
  if (!existsSync(tmp)) return null;
  const backup = readdirSync(tmp).find((entry) => entry.startsWith("backup-"));
  return backup ? resolve(tmp, backup, "src") : null;
};

function readSource(path: string): string {
  const backupSrc = strykerBackupSrc();
  const srcPath = path.replace(/^src\//, "");
  const backupPath = backupSrc ? resolve(backupSrc, srcPath) : null;
  return readFileSync(backupPath && existsSync(backupPath) ? backupPath : resolve(srcRoot, srcPath), "utf8");
}

const workspaceGridCss = readSource("src/components/workspace/WorkspaceGridDemo.css");
const indexCss = readSource("src/index.css");
const workspaceGridDemoSource = readSource("src/components/workspace/WorkspaceGridDemo.tsx");
const workspaceRailPanelFrameSource = readSource("src/components/workspace/WorkspaceRailPanelFrame.tsx");
const workspaceGridOpenEventsSource = readSource("src/components/workspace/workspaceGridOpenEvents.ts");
const mainLayoutSource = readSource("src/components/layout/MainLayout.tsx");
const leftRailSource = readSource("src/components/layout/LeftRail.tsx");
const sidebarSource = readSource("src/components/layout/Sidebar.tsx");
const workspaceAvailabilitySource = readSource("src/components/workspace/workspaceGridAvailability.ts");
const serverFeatureFlagsSource = readSource("src/store/serverFeatureFlags.ts");
const workspaceRealPanelSource = readSource("src/components/workspace/WorkspaceGridRealPanel.tsx");
const agentDetailPanelSource = readSource("src/components/agent/AgentDetailPanel.tsx");
const machineDetailPanelSource = readSource("src/components/machine/MachineDetailPanel.tsx");
const settingsPanelSource = readSource("src/components/settings/SettingsPanel.tsx");
const workspaceSettingsModalSource = readSource("src/components/settings/WorkspaceSettingsModal.tsx");
const settingsNavListSource = readSource("src/components/settings/SettingsNavList.tsx");
const settingsNavigationSource = readSource("src/components/settings/settingsNavigation.ts");
const panelHeaderSource = readSource("src/components/ui/PanelHeader.tsx");
const searchPanelSource = readSource("src/components/search/MessageSearchPage.tsx");
const tasksPanelSource = readSource("src/components/task/TasksPanel.tsx");
const threadsInboxSource = readSource("src/components/thread/ThreadsInbox.tsx");

test("workspace grid demo is gated by the server-authoritative feature flag", () => {
  assert.equal(WORKSPACE_GRID_DEMO_FLAG_KEY, "chat_grid_layout_v0");
  assert.equal(WORKSPACE_GRID_DEMO_ROUTE, "workspace");
  assert.equal(WORKSPACE_GRID_DEMO_MOBILE_POLICY, "desktop-only-min-1024");
  assert.deepEqual(FEATURE_FLAG_REGISTRY.find((flag) => flag.key === WORKSPACE_GRID_DEMO_FLAG_KEY), {
    key: "chat_grid_layout_v0",
    label: "Chat grid layout",
    variants: ["disabled", "enabled"],
    default: "disabled",
  });

  assert.equal(isWorkspaceGridDemoEnabledForServer({ slug: "botiverse", name: "Botiverse" }, "enabled"), true);
  assert.equal(isWorkspaceGridDemoEnabledForServer({ slug: "botiverse", name: "Botiverse" }, "disabled"), false);
  assert.equal(isWorkspaceGridDemoEnabledForServer({ slug: "other", name: "Other" }, "enabled"), true);
  assert.equal(isWorkspaceGridDemoEnabledForServer({ slug: "other", name: "Other" }, "disabled"), false);
  assert.equal(isWorkspaceGridDemoEnabledForServer(null, "enabled"), false);
  assert.match(workspaceAvailabilitySource, /useServerFeatureFlag\(WORKSPACE_GRID_DEMO_FLAG_KEY, \{/);
  assert.match(serverFeatureFlagsSource, /chatGridLayout: CHAT_GRID_LAYOUT_FEATURE_FLAG_KEY/);
  assert.match(serverFeatureFlagsSource, /keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS/);
  assert.match(serverFeatureFlagsSource, /\.catch\(\(\) => Object\.freeze\(\{/);
  assert.doesNotMatch(workspaceAvailabilitySource, /getFlagOverride/);
  assert.equal(isWorkspaceGridDemoPath("/s/dev/workspace"), true);
  assert.equal(isWorkspaceGridDemoPath("/s/dev/workspace/"), true);
  assert.equal(isWorkspaceGridDemoPath("/s/dev/workspace-grid-demo"), false);
  assert.equal(isWorkspaceGridDemoPath("/s/dev/channels/general"), false);
});

test("workspace grid stays unavailable below the 1024px desktop boundary", () => {
  assert.equal(WORKSPACE_GRID_MIN_WIDTH_PX, 1024);
  assert.equal(WORKSPACE_GRID_VIEWPORT_QUERY, "(min-width: 1024px)");
  assert.equal(isWorkspaceGridViewport(390), false);
  assert.equal(isWorkspaceGridViewport(768), false);
  assert.equal(isWorkspaceGridViewport(834), false);
  assert.equal(isWorkspaceGridViewport(1023), false);
  assert.equal(isWorkspaceGridViewport(1024), true);
  assert.equal(isWorkspaceGridViewport(1440), true);
  assert.match(mainLayoutSource, /const workspaceEnabled = isLg\s*&& workspaceAvailability\.enabled/s);
  assert.match(mainLayoutSource, /workspaceModeAvailable=\{isLg && workspaceAvailability\.resolved && workspaceAvailability\.enabled\}/);
});

test("workspace rails use compact density without changing the classic rail width", () => {
  assert.match(leftRailSource, /workspaceEnabled \? "w-12" : "w-\[64px\] \[@media\(max-height:600px\)\]:w-\[50px\]"/);
  assert.match(leftRailSource, /compact \? "size-8" : "size-10/);
  assert.match(leftRailSource, /workspaceEnabled \? "h-12 border-b border-black\/25" : "h-panel-header border-b-2 border-black"/);
  assert.match(leftRailSource, /workspaceEnabled \? "size-9 text-sm shadow-brutal-active hover:shadow-brutal-sm" : "size-10 text-base shadow-brutal-sm hover:shadow-brutal/);
  assert.match(leftRailSource, /icon=\{<SquareSplitHorizontal size=\{18\} \/>\}[\s\S]*?label=\{workspaceEnabled \? formatMessage\(\{ id: "layout\.leftRail\.exitWorkspace" \}\) : formatMessage\(\{ id: "layout\.leftRail\.enterWorkspace" \}\)\}[\s\S]*?active=\{workspaceEnabled\}[\s\S]*?activeVariant="depressed"/);
  assert.match(leftRailSource, /activeVariant === "depressed"[\s\S]*?border-black bg-workspace-mode-active shadow-workspace-mode-active/);
  assert.match(leftRailSource, /activeVariant = "default"[\s\S]*?: "border-black bg-white shadow-brutal-sm"/);
  assert.match(indexCss, /--color-workspace-mode-active: #E3B100;/);
  assert.match(indexCss, /--shadow-workspace-mode-active: inset 3px 3px 0px rgb\(20 17 17 \/ 35%\);/);
  assert.doesNotMatch(leftRailSource, /PanelsTopLeft/);
  assert.doesNotMatch(leftRailSource, /Columns3/);
  assert.match(sidebarSource, /workspaceEnabled \? "h-12 border-b border-black\/25 px-4" : "h-panel-header border-b-2 border-black px-5"/);
});

test("workspace sidebar rows forward repeat clicks to the toggle-capable host", () => {
  assert.match(sidebarSource, /onClick=\{\(event\) => onSelect\(machine\.id, event\.detail\)\}/);
  assert.match(sidebarSource, /onClick=\{\(event\) => onSelect\(channel, event\.detail\)\}/);
  assert.match(sidebarSource, /onClick=\{\(event\) => onSelect\(dm\.id, event\.detail\)\}/);
  assert.match(sidebarSource, /onClick=\{\(event\) => onSelect\(agent, dmId, event\.detail\)\}/);
  assert.match(sidebarSource, /handleSelectAgent\(agent\.id, event\.detail\)/);
  assert.match(sidebarSource, /handleSelectHuman\(human\.userId, event\.detail\)/);
  assert.doesNotMatch(sidebarSource, /shouldIgnoreWorkspaceSidebarRepeatClick/);
  assert.doesNotMatch(workspaceGridDemoSource, /activeRefKey === refKey/);
  assert.doesNotMatch(workspaceGridDemoSource, /lastSidebarOpenRef/);
  assert.match(workspaceGridDemoSource, /const openSidebarPanelRef[\s\S]*?isWorkspaceGridActiveTabForRef\(model, ref\)[\s\S]*?closeWorkspaceTab\(activeTab\)/);
  assert.match(workspaceGridDemoSource, /const openSidebarPanelRef[\s\S]*?if \(!openWorkspaceGridPanelTab\(model, makeRefTab\(ref, source, formatMessage\)\)\) return;[\s\S]*?setActiveRefKey\(refKey\)/);
});

test("workspace collapsed rail and stable composers preserve the editor surface", () => {
  assert.doesNotMatch(mainLayoutSource, /workspace-sidebar-reopen/);
  assert.doesNotMatch(leftRailSource, /left-rail-tab-humans/);
  assert.match(leftRailSource, /workspaceSidebar\.activeItem === mode && !workspaceSidebar\.collapsed/);
  assert.match(leftRailSource, /workspaceItems\.map\(\(item\) => \(/);
  assert.doesNotMatch(leftRailSource, /draggable=|onDragStart=|dataTransfer\.setData/);
  assert.match(leftRailSource, /workspace-rail-drag-overlay/);
  assert.match(leftRailSource, /workspace-rail-drop-placeholder/);
  assert.match(leftRailSource, /workspace-rail-drop-indicator/);
  assert.match(leftRailSource, /workspaceRailDrag \? "pointer-events-auto" : "pointer-events-none"/);
  assert.match(leftRailSource, /opacity-90[\s\S]*?workspace-rail-drag-overlay/);
  assert.match(leftRailSource, /transition-transform duration-100[\s\S]*?workspace-rail-drop-indicator/);
  assert.doesNotMatch(leftRailSource, /const previewRailLayout/);
  assert.match(leftRailSource, /const rawWorkspaceItems = workspaceRailLayout\[side\]/);
  assert.match(leftRailSource, /const workspaceItems = rawWorkspaceItems\.filter\(\(item\) => \([\s\S]*?item !== "wiki" \|\| wikiEnabled[\s\S]*?!isGuest \|\| \(item !== "members" && item !== "humans" && item !== "computers"\)[\s\S]*?\)\);/);
  assert.match(leftRailSource, /workspaceItems\.length === 0 && workspaceRailDrag\?\.targetSide !== "right"/);
  assert.match(leftRailSource, /--workspace-rail-drag-x/);
  assert.match(leftRailSource, /--workspace-rail-drag-y/);
  assert.match(leftRailSource, /current\?\.targetSide === \(target\?\.side \?\? null\)[\s\S]*?current\.targetIndex === \(target\?\.index \?\? null\)\) return;/);
  assert.match(mainLayoutSource, /!workspaceSidebars\.right\.collapsed && workspaceSidebars\.right\.activeItem !== null/);
  assert.match(mainLayoutSource, /workspaceSidebars\.left\.collapsed \|\| workspaceSidebars\.left\.activeItem === null/);
  assert.match(mainLayoutSource, /workspaceEnabled && !isWikiRoute \? <LeftRail side="right" hidden=\{mobileShowSidebarInline\} \/> : null/);
  assert.match(mainLayoutSource, /workspaceEnabled && !isWikiRoute \? \([\s\S]*?<WorkspaceGridDemo initialPanel=\{workspaceInitialPanel\} \/>/);
  assert.match(mainLayoutSource, /workspaceEnabled && !isWikiRoute && !workspaceSidebars\.right\.collapsed/);
  assert.match(mainLayoutSource, /workspace-left-sidebar-resize-handle/);
  assert.match(mainLayoutSource, /workspace-right-sidebar-resize-handle/);
  assert.match(mainLayoutSource, /workspace-settings-modal/);
  assert.match(mainLayoutSource, /querySelector<HTMLButtonElement>\('\[data-testid="workspace-settings-trigger"\]'\)/);
  assert.match(sidebarSource, /\{workspaceEnabled \|\| railMode !== "humans" \? \(/);
  assert.match(sidebarSource, /\{!hideHumansFromMembers && \(/);
  assert.equal((workspaceRealPanelSource.match(/\n\s+workspaceComposer\n/g) ?? []).length, 2);
  assert.equal((workspaceRealPanelSource.match(/composerAutoFocus=\{active\}/g) ?? []).length, 2);
  assert.doesNotMatch(workspaceRealPanelSource, /showComposer=\{active\}/);
  assert.doesNotMatch(workspaceRealPanelSource, /\boverlayComposer\b/);
});

test("workspace tab keyboard helpers keep roving, MRU, and adjacent-group behavior deterministic", () => {
  assert.equal(nextWorkspaceTabIndex(4, 0, "ArrowLeft"), 3);
  assert.equal(nextWorkspaceTabIndex(4, 3, "ArrowRight"), 0);
  assert.equal(nextWorkspaceTabIndex(4, 2, "Home"), 0);
  assert.equal(nextWorkspaceTabIndex(4, 1, "End"), 3);
  assert.equal(nextWorkspaceMruTabId(["current", "recent", "stale"], "current", (id) => id !== "stale"), "recent");
  const tabsets = [
    { id: "left", left: 0, right: 300, top: 0, bottom: 500 },
    { id: "center", left: 301, right: 700, top: 0, bottom: 500 },
    { id: "right", left: 701, right: 1000, top: 0, bottom: 500 },
    { id: "below", left: 0, right: 300, top: 501, bottom: 800 },
  ];
  assert.equal(adjacentWorkspaceTabsetId(tabsets, "center", "left"), "left");
  assert.equal(adjacentWorkspaceTabsetId(tabsets, "center", "right"), "right");
  assert.equal(adjacentWorkspaceTabsetId(tabsets, "left", "left"), null);
});

test("workspace tab chrome exposes pane ownership, keyboard navigation, and the five context actions", () => {
  assert.match(workspaceGridDemoSource, /onPointerDownCapture=\{handleWorkspacePointerDownCapture\}/);
  assert.match(workspaceGridDemoSource, /onFocusCapture=\{handleWorkspaceFocusCapture\}/);
  assert.match(workspaceGridDemoSource, /Actions\.setActiveTabset\(tabset\.getId\(\)\)/);
  assert.match(workspaceGridDemoSource, /event\.ctrlKey[\s\S]*?event\.key === "Tab"/);
  assert.match(workspaceGridDemoSource, /event\.key\.toLowerCase\(\) === "w"/);
  assert.match(workspaceGridDemoSource, /"ArrowLeft", "ArrowRight", "Home", "End"/);
  assert.match(workspaceGridDemoSource, /formatMessage\(\{ id: "common\.close" \}\)[\s\S]*?<kbd[^>]*>⌘W<\/kbd>/);
  assert.match(workspaceGridDemoSource, /workspace\.grid\.demo\.closeOthers/);
  assert.match(workspaceGridDemoSource, /workspace\.grid\.demo\.closeAll/);
  assert.match(workspaceGridDemoSource, /const closeAllContextTabs = \(\) => \{[\s\S]*?!\(candidate\.getConfig\(\) as WorkspacePanelConfig \| undefined\)\?\.pinned[\s\S]*?candidate\.isEnableClose\(\)[\s\S]*?rememberClosedTabs\(candidates\)[\s\S]*?Actions\.deleteTab\(candidate\.getId\(\)\)/);
  assert.match(workspaceGridDemoSource, /const togglePinnedTab = \(\) => \{[\s\S]*?pinned: nextPinned[\s\S]*?enableClose: !nextPinned[\s\S]*?enableDrag: !nextPinned/);
  assert.match(workspaceGridDemoSource, /workspace\.grid\.demo\.unpin[\s\S]*?workspace\.grid\.demo\.pin/);
  assert.match(workspaceGridDemoSource, /workspace\.grid\.demo\.moveToOtherPane/);
  assert.doesNotMatch(workspaceGridDemoSource, /Move to Left Group|Move to Right Group|Close to the right|Keep open|Reopen closed tab|Saved Contexts/);
  assert.match(workspaceGridDemoSource, /DropdownMenuContent/);
  assert.doesNotMatch(workspaceGridDemoSource, /onShowOverflowMenu=/);
  assert.match(workspaceGridDemoSource, /data-testid="workspace-tab-search-trigger"/);
  assert.match(workspaceGridDemoSource, /<ChevronDown size=\{18\} aria-hidden="true" \/>/);
  assert.match(workspaceGridDemoSource, /data-testid="workspace-tab-overflow-menu"/);
  assert.match(workspaceGridDemoSource, /WORKSPACE_RECENTLY_CLOSED_LIMIT = 10/);
  assert.match(workspaceGridDemoSource, /event\.key\.toLocaleLowerCase\(\) !== "t"[\s\S]*?reopenRecentlyClosedTab\(latest\)/);
  assert.match(workspaceGridDemoSource, /workspace\.grid\.demo\.openSection/);
  assert.match(workspaceGridDemoSource, /workspace\.grid\.demo\.recentlyClosed/);
  assert.match(workspaceGridDemoSource, /workspacePaneLabel\(overviewTabsets, tabset\)/);
  assert.match(workspaceGridDemoSource, /workspacePanelParent\(config\)/);
  assert.match(workspaceGridDemoSource, /workspace-grid-pinned-tab-label sr-only/);
  assert.match(workspaceGridDemoSource, /config\?\.pinned \|\| !tab\.isEnableClose\(\)/);
  assert.doesNotMatch(workspaceGridDemoSource, /just now|\b\d+m\b|Open ·|OPEN ·/);
  assert.match(workspaceGridCss, /flexlayout__tab_button:has\(\.workspace-grid-pinned-tab-label\)[\s\S]*?width:\s*48px;[\s\S]*?min-width:\s*48px;[\s\S]*?max-width:\s*48px;/);
  assert.match(workspaceGridCss, /flexlayout__tab_button:has\(\.workspace-grid-pinned-tab-label\) \.flexlayout__tab_button_trailing[\s\S]*?display:\s*none;/);
  assert.match(workspaceGridCss, /flexlayout__tab_button:focus-visible[\s\S]*?outline:\s*1px solid var\(--workspace-grid-ink\)/);
  assert.match(workspaceGridCss, /flexlayout__tabset-selected:has\(\.flexlayout__tab_button:focus-visible\)/);
});

test("workspace mode keeps a feature-gated fallback switch in Account Settings", () => {
  assert.match(settingsPanelSource, /function WorkspaceModeSettingsCard\(\)/);
  assert.match(settingsPanelSource, /if \(!availability\.resolved \|\| !availability\.enabled\) return null;/);
  assert.match(settingsPanelSource, /onChange=\{\(event\) => setEnabled\(event\.currentTarget\.checked, userId\)\}/);
  assert.match(settingsPanelSource, /settingsTab === "account" && <WorkspaceModeSettingsCard \/>/);
});

test("workspace Settings modal keeps the full settings navigation inside the modal", () => {
  assert.match(mainLayoutSource, /const WorkspaceSettingsModal = lazy\(\(\) => import\("\.\.\/settings\/WorkspaceSettingsModal"\)\)/);
  assert.match(mainLayoutSource, /<WorkspaceSettingsModal \/>/);
  // The nav is composed via the extracted pure `SettingsNavList` (so its label
  // localization is DOM-testable without SettingsPanel's import.meta graph); the
  // modal still mounts it, so the full nav stays inside the modal.
  assert.match(workspaceSettingsModalSource, /<SettingsNavList\b/);
  assert.match(workspaceSettingsModalSource, /if \(!canOpenSettingsTab\("billing", capabilities\)\) hidden\.add\("billing"\)/);
  assert.match(workspaceSettingsModalSource, /hidden\.add\("administration"\)/);
  // Anchored on the catalog id (migrated in sub-batch H1), not display copy.
  assert.match(settingsNavListSource, /aria-label=\{formatMessage\(\{ id: "settings\.tabs\.navAriaLabel" \}\)\}/);
  // The nav map wiring now lives in the extracted SettingsNavList.
  assert.match(settingsNavListSource, /import \{ SETTINGS_GROUPS, SETTINGS_TAB_NAV_LABEL_ID \} from "\.\/settingsNavigation"/);
  assert.match(settingsNavListSource, /import type \{ SettingsTabId \} from "\.\/settingsNavigation"/);
  assert.match(settingsPanelSource, /normalizeSettingsTab\(tabProp\)/);
  // Group headers migrated in sub-batch H1: they now carry a catalog `labelId`
  // plus a stable non-display `key`, so the contract anchors on the ids. The
  // grouping itself (Personal / Workspace) is what this contract is about, not
  // the English words.
  assert.match(settingsNavigationSource, /key: "personal", labelId: "settings\.tabs\.groupPersonal"/);
  assert.match(settingsNavigationSource, /key: "workspace", labelId: "settings\.tabs\.groupWorkspace"/);
  assert.match(settingsNavigationSource, /id: "account"/);
  assert.match(settingsNavigationSource, /id: "language-region"/);
  assert.match(settingsNavigationSource, /id: "appearance"/);
  assert.match(settingsNavigationSource, /id: "notifications"/);
  assert.match(settingsNavigationSource, /id: "server"/);
  assert.match(settingsNavigationSource, /id: "billing"/);
  assert.match(settingsNavigationSource, /id: "administration"/);
  assert.match(settingsNavigationSource, /id: "integrations"/);
  assert.match(settingsNavigationSource, /id: "about"/);
  assert.match(workspaceSettingsModalSource, /resolveWorkspaceSettingsActiveTab\(activeTab, slackBridgeEnabled\)/);
  assert.match(workspaceSettingsModalSource, /<SettingsPanel tab=\{effectiveActiveTab\} \/>/);
  assert.doesNotMatch(workspaceSettingsModalSource, /navigate\(|useNavigate|location\.pathname/);
});

test("workspace grid demo starts as a usable real channel workspace", () => {
  assert.equal(WORKSPACE_GRID_DEMO_INITIAL_MODEL.layout.type, "row");
  assert.equal(WORKSPACE_GRID_DEMO_INITIAL_MODEL.layout.id, "workspace-root");
  assert.equal(WORKSPACE_GRID_DEMO_INITIAL_MODEL.global?.enableEdgeDock, true);
  assert.equal(WORKSPACE_GRID_DEMO_INITIAL_MODEL.global?.tabSetEnableClose, true);
  assert.equal(WORKSPACE_GRID_DEMO_INITIAL_MODEL.global?.tabSetEnableCloseButton, false);

  const primary = WORKSPACE_GRID_DEMO_INITIAL_MODEL.layout.children?.[0];
  assert.equal(primary?.type, "tabset");
  assert.equal(primary?.id, "workspace-primary");

  const primaryChildren = primary?.children ?? [];
  assert.equal(primaryChildren.length, 1);
  assert.equal(primaryChildren[0]?.component, "workspace-panel");
  assert.equal(primaryChildren[0]?.config?.ref, undefined);
  assert.deepEqual(primaryChildren[0]?.config?.demoSource, { kind: "first-channel" });
  assert.equal(primaryChildren[0]?.config?.title, "Chat");
  assert.equal(primaryChildren[0]?.enableClose, true);
  assert.equal(WORKSPACE_GRID_DEMO_INITIAL_MODEL.layout.children?.length, 1);
});

test("workspace external drag accepts only complete typed panel identities", () => {
  const dataTransfer = (payload: unknown) => ({
    getData: () => typeof payload === "string" ? payload : JSON.stringify(payload),
  }) as DataTransfer;

  assert.deepEqual(readWorkspaceGridDragPanel(dataTransfer({
    ref: { kind: "thread", channelId: "channel-1", threadRootId: "message-1" },
    title: "Thread message-1",
  })), {
    ref: { kind: "thread", channelId: "channel-1", threadRootId: "message-1" },
    title: "Thread message-1",
  });
  assert.equal(readWorkspaceGridDragPanel(dataTransfer({ ref: { kind: "channel" } })), null);
  assert.equal(readWorkspaceGridDragPanel(dataTransfer({ ref: { kind: "tasks", scope: "channel" } })), null);
  assert.equal(readWorkspaceGridDragPanel(dataTransfer("not json")), null);
});

test("workspace external drag survives browsers withholding payload bytes during dragover", () => {
  const payload = {
    ref: { kind: "channel", id: "channel-1" } as const,
    title: "#general",
  };
  const dragEvent = {
    dataTransfer: {
      effectAllowed: "none",
      setData: () => undefined,
    },
  } as unknown as DragEvent;

  emitWorkspaceGridDragPanel(dragEvent, payload.ref, { title: payload.title });
  const dragoverTransfer = {
    getData: () => "",
    types: ["application/x-raft-workspace-panel"],
  } as unknown as DataTransfer;
  assert.deepEqual(readWorkspaceGridDragPanel(dragoverTransfer), payload);

  clearWorkspaceGridDragPanel();
  assert.equal(readWorkspaceGridDragPanel(dragoverTransfer), null);
});

test("workspace selected entities get a distinct external-drag instance and 24 percent edge split", () => {
  assert.match(workspaceGridDemoSource, /model\.getNodeById\(baseTabId\)[\s\S]*id: `\$\{baseTabId\}-drag-\$\{\+\+externalDragSequenceRef\.current\}`/);
  assert.match(workspaceGridDemoSource, /droppedTabset\.setWeight\(24\)/);
  assert.match(workspaceGridDemoSource, /\* 76/);
  assert.match(workspaceGridDemoSource, /rootRect\.width \* 0\.24/);
  assert.match(workspaceGridDemoSource, /rootRect\.height \* 0\.24/);
  assert.match(workspaceGridDemoSource, /outline\.dataset\.workspaceDropKind = "edge"/);
  assert.match(workspaceGridCss, /data-workspace-drop-kind="insertion"[^}]*background:\s*var\(--workspace-grid-drop-fill-active\);[^}]*border:\s*1px solid var\(--workspace-grid-drop-line\);[^}]*border-radius:\s*4px;/s);
});

test("workspace native drag keeps typed panel payloads and supports in-sidebar reorder", () => {
  assert.match(sidebarSource, /return workspaceEnabled \? staticContent : sortable/);
  assert.match(sidebarSource, /kind="pinned"\s+manual=\{pinnedManualSort\}/);
  assert.match(sidebarSource, /kind="jointChannels"\s+manual=\{jointChannelManualSort\}/);
  assert.match(sidebarSource, /kind="channels"\s+manual=\{channelManualSort\}/);
  assert.match(sidebarSource, /kind="dms"\s+manual=\{dmManualSort\}/);
  assert.equal((sidebarSource.match(/staticContent=/g) ?? []).length, 5);
  assert.doesNotMatch(sidebarSource, /DraggableSidebarItem/);
  assert.equal((sidebarSource.match(/draggable=\{!!onDragStart\}/g) ?? []).length, 4);
  assert.match(sidebarSource, /getSidebarDragItemTransform\(transform, true\)/);
  assert.match(sidebarSource, /return \{ \.\.\.transform, x: 0 \};/);
  assert.match(sidebarSource, /emitWorkspaceGridDragPanel\(event\.nativeEvent, ref, source\)/);
  assert.match(sidebarSource, /workspaceSidebarNativeDragIdRef\.current = sidebarDragId \?\? null/);
  assert.match(sidebarSource, /handleWorkspaceSidebarDragOver/);
  assert.match(sidebarSource, /handleWorkspaceSidebarDrop/);
  assert.match(sidebarSource, /reorderSidebarSubset\(channelOrderIds, sortableIds/);
  assert.match(sidebarSource, /reorderSidebarSubset\(dmOrderIds, sortableDmIds/);
  assert.match(workspaceGridOpenEventsSource, /document\.body\.classList\.add\(WORKSPACE_GRID_EXTERNAL_DRAG_CLASS\)/);
  assert.match(workspaceGridOpenEventsSource, /document\.body\.classList\.remove\(WORKSPACE_GRID_EXTERNAL_DRAG_CLASS\)/);
  assert.match(workspaceGridCss, /\.workspace-grid-external-drag-active \[data-testid\$="-sidebar-resize-handle"\]\s*\{[^}]*pointer-events:\s*none;/s);
});

test("workspace grid drag indicators stay lightweight and layout-neutral", () => {
  assert.match(workspaceGridCss, /--workspace-grid-drop-fill:\s*rgb\(0 220 255 \/ 8%\);/);
  assert.match(workspaceGridCss, /--workspace-grid-drop-fill-active:\s*rgb\(0 220 255 \/ 16%\);/);
  assert.match(workspaceGridCss, /--workspace-grid-drop-line:\s*rgb\(0 150 190 \/ 50%\);/);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__outline_rect,[^}]*\.flexlayout__outline_rect_edge\s*\{[^}]*background:\s*var\(--workspace-grid-drop-fill-active\);[^}]*border:\s*1px solid var\(--workspace-grid-drop-line\);[^}]*border-radius:\s*4px;[^}]*box-shadow:\s*none;/s);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__edge_rect\s*\{[^}]*background:\s*var\(--workspace-grid-drop-fill\);[^}]*border:\s*1px solid rgb\(0 150 190 \/ 45%\);[^}]*border-radius:\s*4px !important;[^}]*box-shadow:\s*none;[^}]*opacity:\s*1;/s);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__edge_rect svg\s*\{[^}]*display:\s*block;[^}]*color:\s*currentColor;/s);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__drag_rect\s*\{[^}]*background:\s*var\(--workspace-grid-drop-fill\);[^}]*border:\s*1px solid var\(--workspace-grid-drop-line\);[^}]*border-radius:\s*4px;[^}]*box-shadow:\s*none;/s);
  assert.match(workspaceGridCss, /--color-edge-marker:\s*var\(--workspace-grid-drop-fill\);/);
  assert.match(workspaceGridCss, /--color-edge-icon:\s*rgb\(0 120 150 \/ 70%\);/);
  assert.match(workspaceGridCss, /\.workspace-grid-drag-theme \.flexlayout__layout\.flexlayout__drag_rect\s*\{[^}]*background:\s*rgb\(0 220 255 \/ 8%\);[^}]*border:\s*1px solid rgb\(0 150 190 \/ 50%\);[^}]*border-radius:\s*4px;[^}]*box-shadow:\s*none;/s);
  assert.doesNotMatch(workspaceGridCss, /\.flexlayout__(?:outline_rect|outline_rect_edge|edge_rect|drag_rect)[^}]*255 212 64/s);
});

test("workspace grid tabs and actions fill one 48px top chrome band", () => {
  assert.match(workspaceGridCss, /--splitter-size:\s*1px;/);
  assert.match(workspaceGridCss, /--splitter-active-size:\s*8px;/);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__tabset_tabbar_outer_top\s*\{[^}]*padding:\s*0;/s);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__tabset_tabbar_outer\s*\{[^}]*align-items:\s*stretch;[^}]*box-sizing:\s*border-box;[^}]*height:\s*48px;[^}]*min-height:\s*48px;[^}]*border-top:\s*2px solid transparent;[^}]*border-bottom:\s*1px solid/s);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__tabset_tabbar_inner\s*\{[^}]*height:\s*48px;/s);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__tabset_tabbar_inner_tab_container\s*\{[^}]*align-items:\s*stretch;[^}]*height:\s*48px;[^}]*min-width:\s*100%;[^}]*padding:\s*0;/s);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__tabset_tabbar_inner_tab_container_top\s*\{[^}]*border-top:\s*0;/s);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__tab_button\s*\{[^}]*min-width:\s*88px;[^}]*max-width:\s*220px;[^}]*min-height:\s*48px;[^}]*gap:\s*8px;[^}]*padding:\s*0 10px;[^}]*border-right:\s*1px solid/s);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__tabset_tabbar_outer\.flexlayout__tabset-selected\s*\{[^}]*border-top-color:\s*var\(--workspace-grid-active\);/s);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__tab_button--selected\s*\{[^}]*background:\s*var\(--workspace-grid-paper\);[^}]*border-top:\s*0;[^}]*border-bottom:\s*2px solid var\(--workspace-grid-paper\);/s);
  assert.doesNotMatch(workspaceGridCss, /flexlayout__tabset_tab_divider_selected_(?:before|after)[^{]*\{[^}]*border-top:/s);
  assert.doesNotMatch(workspaceGridCss, /\.flexlayout__tab_button--selected\s*\{[^}]*border-top:\s*[1-9]/s);
  assert.doesNotMatch(workspaceGridCss, /workspace-grid-pane-focus|tabset-selected[^}]*brutal-cyan/s);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__tab_button_trailing\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*opacity:\s*0;[^}]*color:\s*rgb\(20 17 17 \/ 40%\);[^}]*background:\s*transparent;/s);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__tab_button_trailing:hover\s*\{[^}]*background:\s*rgb\(20 17 17 \/ 8%\);/s);
  assert.match(workspaceGridCss, /scrollbar-width:\s*thin;/);
  assert.match(workspaceGridCss, /width:\s*10px;[^}]*height:\s*10px;/s);
  assert.match(workspaceGridCss, /border:\s*2px solid transparent;[^}]*background:\s*rgb\(20 17 17 \/ 18%\);[^}]*background-clip:\s*content-box;/s);
  assert.match(workspaceGridDemoSource, /renderValues\.buttons\.push\([\s\S]*?key="workspace-context-actions"/);
  assert.doesNotMatch(workspaceGridDemoSource, /renderValues\.stickyButtons\.push\([\s\S]*?key="workspace-context-actions"/);
  assert.match(workspaceGridDemoSource, /renderValues\.leading = \([\s\S]*?data-testid="workspace-tab-search-trigger"[\s\S]*?selectedTabId: node\.getSelectedNode\(\)\?\.getId\(\) \?\? null/);
  assert.doesNotMatch(workspaceGridDemoSource, /onShowOverflowMenu=/);
  assert.match(workspaceGridDemoSource, /data-testid="workspace-tab-search-input"/);
  assert.match(workspaceGridDemoSource, /model\.doAction\(Actions\.selectTab\(item\.node\.getId\(\)\)\)/);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__tabset_leading\s*\{[^}]*display:\s*flex;[^}]*flex:\s*0 0 auto;[^}]*align-self:\s*stretch;/s);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.workspace-grid-tab-search-trigger\s*\{[^}]*width:\s*40px;[^}]*height:\s*calc\(100% - 2px\);[^}]*border-right:\s*1px solid/s);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__tab_button_overflow\s*\{[^}]*display:\s*none;/s);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__mini_scrollbar_container\s*\{[^}]*min-width:\s*0;/s);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__tab_toolbar\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*3;[^}]*flex:\s*0 0 auto;[^}]*align-self:\s*stretch;[^}]*height:\s*48px;[^}]*min-height:\s*48px;[^}]*margin-left:\s*auto;/s);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__tab_toolbar:empty\s*\{[^}]*display:\s*none;/s);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.flexlayout__tab_toolbar:has\(> \.flexlayout__tab_button_overflow\):not\(:has\(> :not\(\.flexlayout__tab_button_overflow\):not\(\.workspace-grid-tabset-action-host:empty\)\)\)\s*\{[^}]*display:\s*none;/s);
  assert.match(workspaceGridDemoSource, /className="[^"]*top-12[^"]*"[\s\S]*?data-testid="workspace-grid-empty-state"/);
  assert.doesNotMatch(workspaceGridCss, /\.workspace-grid-tabset-actions \.btn-brutal-sm[^{]*\{[^}]*box-shadow:\s*none;/s);
});

test("workspace detail panes remove duplicate primary chrome and demote nested navigation", () => {
  assert.match(workspaceRealPanelSource, /<AgentDetailPanel agent=\{agent\} workspaceEmbedded headerActionsHost=\{headerActionsHost\} \/>/);
  assert.match(workspaceRealPanelSource, /<MachineDetailPanel machine=\{machine\} workspaceEmbedded \/>/);
  assert.match(agentDetailPanelSource, /workspaceEmbedded \? "workspace-grid-agent-secondary-nav" : ""/);
  assert.match(agentDetailPanelSource, /return createPortal\(workspaceActions, headerActionsHost\);/);
  assert.match(agentDetailPanelSource, /data-testid="workspace-grid-agent-actions"/);
  assert.match(workspaceGridDemoSource, /selectedKind !== "channel" && selectedKind !== "dm" && selectedKind !== "thread" && selectedKind !== "agent"/);
  assert.match(machineDetailPanelSource, /!workspaceEmbedded && \(/);
  assert.match(workspaceGridCss, /\.workspace-grid-demo-shell \.workspace-grid-agent-secondary-nav \[data-slot="tabs-tab"\]\s*\{[^}]*min-height:\s*32px;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s);
});

test("workspace rail panels share the dense four-tier chrome contract", () => {
  assert.match(mainLayoutSource, /const WorkspaceRailPanelFrame = lazy\(\(\) => import\("\.\.\/workspace\/WorkspaceRailPanelFrame"\)\);/);
  assert.match(mainLayoutSource, /<WorkspaceRailPanelFrame mode="activity" borderClass=\{borderClass\}>/);
  assert.match(mainLayoutSource, /<WorkspaceRailPanelFrame mode="search" borderClass=\{borderClass\}>/);
  assert.match(mainLayoutSource, /<WorkspaceRailPanelFrame mode="tasks" borderClass=\{borderClass\}>/);
  assert.match(workspaceRailPanelFrameSource, /activity:\s*'\[data-testid="inbox-toolbar"\]'/);
  assert.match(workspaceRailPanelFrameSource, /toolbar\.classList\.add\("workspace-grid-panel-toolbar"\)/);
  assert.match(workspaceRailPanelFrameSource, /toolbar\.scrollLeft \+ toolbar\.clientWidth < toolbar\.scrollWidth - 2/);
  assert.match(workspaceRailPanelFrameSource, /data-testid=\{`workspace-\$\{mode\}-toolbar-overflow-cue`\}/);
  assert.match(workspaceRailPanelFrameSource, /workspace-grid-chrome-\$\{mode\}[^"]*min-w-0 max-w-full[^"]*overflow-x-hidden overflow-y-hidden/);
  assert.match(workspaceRailPanelFrameSource, /workspace-grid-panel-content flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-x-hidden overflow-y-hidden/);
  assert.match(workspaceGridCss, /workspace-grid-chrome-density \.h-panel-header[\s\S]*?height:\s*48px;[\s\S]*?border-bottom-width:\s*1px;/);
  assert.match(workspaceGridCss, /workspace-grid-chrome-density \.h-panel-header \.size-icon-header[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;/);
  assert.match(workspaceGridCss, /workspace-grid-panel-toolbar,[\s\S]*?height:\s*40px;[\s\S]*?overflow-x:\s*auto;[\s\S]*?border-bottom-width:\s*1px;/);
  assert.match(workspaceGridCss, /workspace-grid-toolbar-overflow-cue[\s\S]*?linear-gradient\(to left,/);
  assert.match(workspaceGridCss, /workspace-grid-chrome-tasks \[data-testid="channel-task-board-view"\][\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;[\s\S]*?flex-direction:\s*column;/);
  assert.match(workspaceGridCss, /workspace-grid-chrome-tasks \[data-testid="channel-task-board-view"\] > \*[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/);
  assert.match(workspaceGridCss, /workspace-grid-agent-secondary-nav \[data-slot="tabs-tab"\][\s\S]*?min-height:\s*32px;/);
  assert.match(workspaceGridCss, /flexlayout__tabset_tabbar_outer[\s\S]*?height:\s*48px;/);

  for (const source of [panelHeaderSource, searchPanelSource, tasksPanelSource, threadsInboxSource]) {
    assert.doesNotMatch(source, /workspace-grid-chrome|workspace-panel-toolbar|panel-header-(?:icon|title|subtitle|actions)/);
  }
  assert.doesNotMatch(workspaceGridCss, /segmented-control-item[\s\S]*workspace-grid|workspace-grid[\s\S]{0,240}segmented-control-item/);
});

test("workspace pinned tabs remain fixed, icon-only, non-closable, and serializable", () => {
  const pinned = workspaceGridPanelTab("workspace-channel-pinned", "#pinned", {
    kind: "channel",
    ref: { kind: "channel", id: "channel-pinned" },
    title: "#pinned",
    subtitle: "Channel panel",
    summary: "Pinned workspace tab",
    accent: "yellow",
    pinned: true,
  });
  assert.equal(pinned.enableClose, false);
  assert.equal(pinned.enableDrag, false);
  assert.equal(pinned.config?.pinned, true);

  const model = structuredClone(WORKSPACE_GRID_DEMO_INITIAL_MODEL);
  const primary = model.layout.children?.[0];
  assert.equal(primary?.type, "tabset");
  if (primary?.type === "tabset") primary.children = [pinned];
  const serialized = serializeWorkspaceGridLayoutIntent(model);
  const serializedPrimary = serialized.layout.children?.[0];
  const serializedPinned = serializedPrimary?.type === "tabset" ? serializedPrimary.children?.[0] : undefined;
  assert.equal(serializedPinned?.config?.pinned, true);

  const regular = workspaceGridPanelTab("workspace-channel-regular", "#regular", {
    kind: "channel",
    ref: { kind: "channel", id: "channel-regular" },
    title: "#regular",
    subtitle: "Channel panel",
    summary: "Regular workspace tab",
    accent: "cyan",
  });
  assert.equal(regular.enableClose, true);
  assert.equal(regular.enableDrag, true);
});

test("workspace sidebar selection follows the active tab without changing classic routes", () => {
  const state = {
    active: true,
    activeRefKey: "channel:channel-1",
    activeAncestorRefKey: "channel:channel-parent",
  } as WorkspaceGridNavigationState;
  assert.equal(selectWorkspaceGridActive(state), true);
  assert.equal(selectWorkspaceGridActiveRefKey(state), "channel:channel-1");
  assert.equal(selectWorkspaceGridActiveAncestorRefKey(state), "channel:channel-parent");

  const activeChannel = createWorkspaceGridSidebarSelection({
    kind: "channel",
    workspaceActive: true,
    activeRefKey: "channel:channel-1",
    pathname: "/s/dev/channel/channel-2",
    pathBase: "/s/dev",
  });
  assert.equal(activeChannel("channel-1"), true);
  assert.equal(activeChannel("channel-2"), false);

  const activeDm = createWorkspaceGridSidebarSelection({
    kind: "dm",
    workspaceActive: true,
    activeRefKey: "dm:dm-1",
    pathname: "/s/dev/dm/dm-2",
    pathBase: "/s/dev",
  });
  assert.equal(activeDm("dm-1"), true);
  assert.equal(activeDm("dm-2"), false);

  const classicChannel = createWorkspaceGridSidebarSelection({
    kind: "channel",
    workspaceActive: false,
    activeRefKey: "channel:channel-2",
    pathname: "/s/dev/channel/channel-1",
    pathBase: "/s/dev",
  });
  assert.equal(classicChannel("channel-1"), true);
  assert.equal(classicChannel("channel-2"), false);

  const classicDm = createWorkspaceGridSidebarSelection({
    kind: "dm",
    workspaceActive: false,
    activeRefKey: "dm:dm-2",
    pathname: "/s/dev/dm/dm-1",
    pathBase: "/s/dev",
  });
  assert.equal(classicDm("dm-1"), true);
  assert.equal(classicDm("dm-2"), false);
});

test("workspace grid URL state is namespaced and round-trips the layout model", () => {
  assert.equal(WORKSPACE_GRID_URL_PARAM, "wg");
  const encoded = encodeWorkspaceGridUrlState(WORKSPACE_GRID_DEMO_INITIAL_MODEL);

  assert.match(encoded, /^v1\./);
  assert.deepEqual(decodeWorkspaceGridUrlState(encoded), WORKSPACE_GRID_DEMO_INITIAL_MODEL);
  assert.equal(decodeWorkspaceGridUrlState("v1.not-json"), null);
  assert.equal(decodeWorkspaceGridUrlState(null), null);

  const nextSearch = getWorkspaceGridUrlSearch("?thread=abc:def&tab=chat", WORKSPACE_GRID_DEMO_INITIAL_MODEL);
  const params = new URLSearchParams(nextSearch.slice(1));
  assert.equal(params.has(WORKSPACE_GRID_URL_PARAM), true);
  assert.equal(params.get("thread"), "abc:def");
  assert.equal(params.get("tab"), "chat");
  assert.deepEqual(decodeWorkspaceGridUrlState(params.get(WORKSPACE_GRID_URL_PARAM)), WORKSPACE_GRID_DEMO_INITIAL_MODEL);
});

test("workspace grid URL state stores panel identity and layout, not display snapshots", () => {
  const model = structuredClone(WORKSPACE_GRID_DEMO_INITIAL_MODEL);
  const primary = model.layout.children?.[0];
  assert.equal(primary?.type, "tabset");
  const channelTab = primary?.children?.[0];
  assert.ok(channelTab);
  channelTab.name = "#renamed-channel";
  channelTab.config = {
    ...channelTab.config,
    ref: { kind: "channel", id: "channel-1" },
    demoSource: undefined,
    title: "#renamed-channel",
    summary: "Server-owned channel description must not be copied into the URL.",
  };
  primary.children?.push(
    {
      type: "tab",
      id: "workspace-dm-1",
      name: "@Renamed Person",
      component: "workspace-panel",
      config: {
        kind: "dm",
        ref: { kind: "dm", id: "dm-1" },
        title: "@Renamed Person",
        subtitle: "Private conversation",
        summary: "Live DM display data must not be copied into the URL.",
        accent: "yellow",
      },
    },
    {
      type: "tab",
      id: "workspace-thread-channel-1-message-1",
      name: "Thread title",
      component: "workspace-panel",
      config: {
        kind: "thread",
        ref: {
          kind: "thread",
          channelId: "channel-1",
          threadRootId: "message-1",
          threadChannelId: "thread-channel-1",
        },
        title: "Thread title",
        subtitle: "Live thread metadata",
        summary: "Live thread display data must not be copied into the URL.",
        accent: "cyan",
      },
    },
    {
      type: "tab",
      id: "workspace-machine-1",
      name: "Renamed Machine",
      component: "workspace-panel",
      config: {
        kind: "machine",
        ref: { kind: "machine", id: "machine-1" },
        title: "Renamed Machine",
        subtitle: "Live machine metadata",
        summary: "Live machine display data must not be copied into the URL.",
        accent: "lime",
      },
    },
    {
      type: "tab",
      id: "workspace-settings-account",
      name: "Settings account",
      component: "workspace-panel",
      config: {
        kind: "settings",
        ref: { kind: "settings", tab: "account" },
        title: "Settings account",
        subtitle: "Settings panel",
        summary: "Settings display data must not be copied into the URL.",
        accent: "yellow",
      },
    },
  );

  const serialized = serializeWorkspaceGridLayoutIntent(model);
  const serializedTab = serialized.layout.children?.[0]?.type === "tabset"
    ? serialized.layout.children[0].children?.[0]
    : undefined;
  assert.equal(serializedTab?.name, "Channel");
  assert.deepEqual(serializedTab?.config?.ref, { kind: "channel", id: "channel-1" });
  const serializedChildren = serialized.layout.children?.[0]?.type === "tabset"
    ? serialized.layout.children[0].children ?? []
    : [];
  assert.equal(serializedChildren[1]?.name, "Direct message");
  assert.deepEqual(serializedChildren[1]?.config?.ref, { kind: "dm", id: "dm-1" });
  assert.equal(serializedChildren[2]?.name, "Thread");
  assert.deepEqual(serializedChildren[2]?.config?.ref, {
    kind: "thread",
    channelId: "channel-1",
    threadRootId: "message-1",
    threadChannelId: "thread-channel-1",
  });
  assert.equal(serializedChildren[3]?.name, "Computer");
  assert.deepEqual(serializedChildren[3]?.config?.ref, { kind: "machine", id: "machine-1" });
  assert.equal(serializedChildren[4]?.name, "Settings");
  assert.deepEqual(serializedChildren[4]?.config?.ref, { kind: "settings", tab: "account" });
  assert.equal(JSON.stringify(serialized).includes("#renamed-channel"), false);
  assert.equal(JSON.stringify(serialized).includes("@Renamed Person"), false);
  assert.equal(JSON.stringify(serialized).includes("Thread title"), false);
  assert.equal(JSON.stringify(serialized).includes("Renamed Machine"), false);
  assert.equal(JSON.stringify(serialized).includes("Settings account"), false);
  assert.equal(JSON.stringify(serialized).includes("Server-owned channel description"), false);
});
