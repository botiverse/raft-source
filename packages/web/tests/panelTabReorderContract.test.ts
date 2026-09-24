import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const srcRoot = resolve(repoRoot, "src");
const strykerBackupSrc = () => {
  const tmp = resolve(repoRoot, ".stryker-tmp");
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

test("top panel tabs use the shared reorderable tab bar", () => {
  const chatPanel = readSource("src/components/message/ChatPanel.tsx");
  const agentPanel = readSource("src/components/agent/AgentDetailPanel.tsx");
  const sidebar = readSource("src/components/layout/Sidebar.tsx");

  assert.match(chatPanel, /import \{ SortableTabsList, SortableTabsTab, Tabs, TabsLabel, useOrderedTabs \} from "raft-ui";/);
  assert.match(
    agentPanel,
    /import \{[^}]*\bSortableTabsList\b[^}]*\bSortableTabsTab\b[^}]*\bTabs\b[^}]*\bTabsLabel\b[^}]*\buseOrderedTabs\b[^}]*\} from "raft-ui";/,
  );
  assert.doesNotMatch(chatPanel, /ReorderablePanelTabs/);
  assert.doesNotMatch(agentPanel, /ReorderablePanelTabs/);
  assert.match(sidebar, /verticalListSortingStrategy/);
  assert.match(sidebar, /useSortable\(\{ id, data \}\)/);
  assert.match(sidebar, /function SidebarDndContainer/);
  assert.match(sidebar, /<DragOverlay dropAnimation=\{null\}>/);
  assert.match(sidebar, /moveSidebarDndItem\(/);
  assert.match(sidebar, /export function getSidebarSortableItemTransform\([\s\S]*?return getSidebarDragItemTransform\(transform, allowHorizontalDrag\);/);
  assert.match(sidebar, /export function getSidebarDragItemTransform\(/);
  assert.match(sidebar, /if \(!transform \|\| allowHorizontalDrag\) return transform;/);
  assert.match(sidebar, /return \{ \.\.\.transform, x: 0 \};/);
  assert.match(sidebar, /transform: CSS\.Transform\.toString\(getSidebarDragItemTransform\(transform, true\)\)/);
  assert.match(sidebar, /<SortableSidebarItem key=\{itemId\} id=\{itemId\} containerId=\{containerId\}>/);

  assert.match(chatPanel, /useOrderedTabs\(chatPanelTabs, channelPanelTabOrder\)/);
  assert.match(chatPanel, /sidebarOrder\.channelPanelTabOrder/);
  assert.match(chatPanel, /updateSidebarOrder\(\{ channelPanelTabOrder: nextOrder \}\)/);
  assert.match(chatPanel, /<Tabs<ChatPanelTab>[\s\S]*?className="overflow-hidden border-b-2 border-black bg-white"/);
  assert.match(chatPanel, /<SortableTabsList<ChatPanelTab>/);
  assert.match(chatPanel, /<SortableTabsTab[\s\S]*?data-testid=\{`panel-tab-\$\{tab\.id\}`\}[\s\S]*?className="!cursor-default"[\s\S]*?>/);

  assert.match(agentPanel, /useOrderedTabs\(visibleAgentTabItems, normalizedAgentPanelTabOrder\)/);
  assert.match(agentPanel, /sidebarOrder\.agentPanelTabOrder/);
  assert.match(agentPanel, /tab === "channels" \|\| tab === "dms" \? "chat" : tab/);
  assert.match(agentPanel, /updateSidebarOrder\(\{ agentPanelTabOrder: nextOrder \}\)/);
  assert.match(agentPanel, /<SortableTabsList<AgentTab>/);
  assert.match(agentPanel, /<div\s+ref=\{agentTabsRef\}[\s\S]*?className=\{`min-w-0 max-w-full overflow-hidden/);
  assert.match(agentPanel, /className="max-w-full border-y-0 border-l-0 border-r-2 border-black bg-white"/);
  assert.doesNotMatch(agentPanel, /className="max-w-none border-y-0 border-l-0 border-r-2 border-black bg-white"/);
  assert.match(agentPanel, /<SortableTabsTab[\s\S]*?data-testid=\{`panel-tab-\$\{tab\.id\}`\}[\s\S]*?className="!cursor-default"[\s\S]*?>/);
  assert.doesNotMatch(agentPanel, /showMoreMenu/);
});

test("chat tabs default to ordered first; agent tabs default to stable profile", () => {
  const chatPanel = readSource("src/components/message/ChatPanel.tsx");
  const agentPanel = readSource("src/components/agent/AgentDetailPanel.tsx");

  assert.match(chatPanel, /const visibleTabs = useMemo\(/);
  assert.match(chatPanel, /const defaultTab = visibleTabs\[0\]\?\.id \?\? "chat";/);
  assert.match(chatPanel, /: defaultTab\s*\)\s*as ChatPanelTab/);
  assert.match(chatPanel, /if \(tab === defaultTab\) next\.delete\(CHAT_TAB_QUERY_PARAM\)/);

  assert.match(agentPanel, /const defaultAgentTab: AgentTab = visibleAgentTabs\.includes\("profile"\)\s*\?\s*"profile"\s*:\s*visibleAgentTabs\[0\] \?\? "profile";/);
  assert.match(agentPanel, /: defaultAgentTab;/);
  assert.match(agentPanel, /if \(tab === defaultAgentTab\) next\.delete\("agentTab"\)/);
});

test("agent detail tab reorder does not redefine the no-param active tab", () => {
  const agentPanel = readSource("src/components/agent/AgentDetailPanel.tsx");

  assert.match(agentPanel, /const orderedAgentTabs = useOrderedTabs\(visibleAgentTabItems, normalizedAgentPanelTabOrder\);/);
  assert.match(agentPanel, /const defaultAgentTab: AgentTab = visibleAgentTabs\.includes\("profile"\)/);
  assert.doesNotMatch(agentPanel, /const defaultAgentTab = orderedAgentTabs\[0\]/);
});

test("agent detail default tabs place Activity second after Profile", () => {
  const agentPanel = readSource("src/components/agent/AgentDetailPanel.tsx");

  assert.match(
    agentPanel,
    /const AGENT_TABS = \["profile", "activity", "chat", "reminders", "workspace", "integrations", "mcp"\] as const;/,
  );
  assert.match(
    agentPanel,
    /\{ id: "profile", icon: Bot, labelId: "agent\.detail\.tab\.profile" \},\n\s+\{ id: "activity", icon: Activity, labelId: "agent\.detail\.tab\.activity" \},/,
  );
  assert.match(agentPanel, /\{ id: "mcp", icon: Blocks, labelId: "agent\.detail\.tab\.mcp" \},/);
  assert.match(agentPanel, /if \(tab === "mcp"\) return canManageAgent;/);
  assert.match(agentPanel, /<AgentMcpTab agentId=\{agent\.id\} canManageServer=\{canManageServer\} \/>/);
});

test("agent detail active tab scroll reruns after agent and tab order settle", () => {
  const agentPanel = readSource("src/components/agent/AgentDetailPanel.tsx");

  assert.match(agentPanel, /const orderedAgentTabKey = orderedAgentTabIds\.join\("\|"\);/);
  assert.match(agentPanel, /useLayoutEffect\(\(\) => \{/);
  assert.match(agentPanel, /querySelector<HTMLElement>\('\[data-slot="tabs-list"\]'\)/);
  assert.match(agentPanel, /querySelector<HTMLElement>\(`\[data-testid="panel-tab-\$\{activeTab\}"\]`\)/);
  assert.match(agentPanel, /tabsList\.scrollLeft\s*=\s*Math\.max\(0, Math\.min\(targetScrollLeft, maxScrollLeft\)\)/);
  assert.match(agentPanel, /\}, \[activeTab, agent\.id, orderedAgentTabKey\]\);/);
  assert.doesNotMatch(agentPanel, /activeTabButton\?\.scrollIntoView/);
});
