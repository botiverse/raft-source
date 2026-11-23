import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import {
  SidebarRoot,
  SidebarSectionControls,
  SidebarSectionCount,
  SidebarSectionEndChevron,
  SidebarSectionTitle,
  SidebarSectionTrailing,
} from "@botiverse/raft-ui";
import fixtureData from "../../../visual-testing/shared/fixtureData.json";
import AttentionDot from "../../src/components/ui/AttentionDot";
import { ChannelRow } from "../../src/features/sidebar/rows/ChannelRow";
import { DmRow } from "../../src/features/sidebar/rows/DmRow";
import { AgentDmRow } from "../../src/features/sidebar/rows/AgentDmRow";
import { AgentLoungeRow } from "../../src/components/layout/AgentLoungeRow";
import type { SidebarBrowserInUse } from "../../src/features/sidebar/rows/SidebarBrowserInUseMark";
import { SIDEBAR_SECTION_ROWS_CLASS, sidebarItemClass } from "../../src/features/sidebar/rows/sidebarRowClasses";
import { SidebarSectionHeader } from "../../src/features/sidebar/sections/SidebarSectionHeader";
import { SidebarSectionToggle } from "../../src/features/sidebar/sections/SidebarSectionToggle";
import { SidebarSectionChevronIcon } from "../../src/features/sidebar/sections/SidebarSectionChevronIcon";
import type { SidebarLongPress } from "../../src/features/sidebar/sidebarContextMenu";
import { preloadInitialLocaleMessages } from "../../src/i18n/preloadLocaleMessages";
import { useAgentStore } from "../../src/store/agentStore";
import type { Agent } from "../../src/store/agentStore";
import type { Channel } from "../../src/store/channelStore";
import { useMarkedUnreadStore } from "../../src/store/markedUnreadStore";
import { useMessageStore } from "../../src/store/messageStore";
import { VisualTestingRoot } from "../VisualTestingRoot";
import "../../src/index.css";

// The sidebar's browser in-use mark (SidebarBrowserInUseMark) on the real rows
// and section heads, for local screenshots (sidebar-browser-in-use.shot.mjs):
// ?mode=light|dark&phone=0|1. phone=1: the phone's inline sidebar, full width
// (Sidebar `mobileInline`); else the desktop's 260px sidebar column. The rows
// are ChannelRow / DmRow / AgentDmRow / AgentLoungeRow as the Sidebar renders them, with their
// stores primed here; only `browserInUse` is new. The selected row never has
// one (that conversation is on screen).
const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") === "dark" ? "dark" : "light";
const phone = params.get("phone") === "1";

const SOUND: SidebarBrowserInUse = { media: [], audible: true, muted: false };
const MUTED: SidebarBrowserInUse = { media: [], audible: false, muted: true };
const MIC: SidebarBrowserInUse = { media: ["microphone"], audible: false, muted: false };
// A device and sound: the device's mark alone.
const MIC_CAMERA: SidebarBrowserInUse = { media: ["microphone", "camera"], audible: true, muted: false };

const createdAt = fixtureData.times.entityCreatedAtIso;
const serverId = fixtureData.server.id;
const channel = (id: string, name: string): Channel => ({ id, serverId, name, description: null, type: "channel", createdAt, joined: true });
const channels = {
  design: channel("ch-design", "design"),
  standup: channel("ch-standup", "standup"),
  launch: channel("ch-launch", "launch"),
  general: channel("ch-general", "general"),
  product: channel("ch-product", "product"),
  random: channel("ch-random", "random"),
  release: channel("ch-release", "release-notes"),
};
const designer = fixtureData.humans.designer;
const cindy = fixtureData.agents.cindy;
const dmDesigner: Channel = {
  id: "dm-designer", serverId, name: designer.displayName, description: null, type: "dm", createdAt, joined: true,
  peerType: "user", peerId: designer.id, peerAvatarUrl: null,
} as Channel;
const agent = {
  id: cindy.id, serverId, name: cindy.name, displayName: cindy.displayName, avatarUrl: cindy.avatar,
  description: cindy.description, status: "active", serverRole: "member", model: cindy.model, runtime: cindy.runtime,
  reasoningEffort: "medium", executionMode: "byoc", envVars: {}, machineId: null, sessionId: cindy.sessionId,
  runtimeProfile: null, creatorType: "user", creatorId: "visual-owner", creator: null, createdAgents: [],
  deletedAt: null, createdAt,
} as unknown as Agent;

useAgentStore.setState({ agents: [agent], loading: false } as never);
useMessageStore.setState({
  currentChannelId: channels.product.id,
  unreadCounts: { [channels.launch.id]: 3 },
  mentionFlags: { [channels.launch.id]: true },
  newFlags: {},
  drafts: { [dmDesigner.id]: "Sending the mocks after this call" },
} as never);
useMarkedUnreadStore.setState({ marked: { [channels.general.id]: true } });

const ignore = () => {};
const noLongPress = (): SidebarLongPress => ({}) as SidebarLongPress;
const rowProps = { menuOpen: false, onContextMenu: ignore, makeLongPress: noLongPress } as const;
const toggle = ignore;

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  // SortableSidebarItem's box around each row, without the drag wiring.
  return <div className="relative" data-case-row={name}>{children}</div>;
}

function Section({ sectionKey, title, count, collapsed = false, browserInUse = null, attention = false, children }: {
  sectionKey: string;
  title: string;
  count: number;
  collapsed?: boolean;
  browserInUse?: SidebarBrowserInUse | null;
  attention?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div data-case-section={sectionKey}>
      <SidebarSectionHeader sectionKey={sectionKey} open={!collapsed} onToggleSection={toggle}>
        <SidebarSectionToggle sectionKey={sectionKey} onToggleSection={toggle} aria-expanded={!collapsed} browserInUse={collapsed ? browserInUse : null}>
          <SidebarSectionChevronIcon open={!collapsed} />
          <SidebarSectionTitle>{title}</SidebarSectionTitle>
          <SidebarSectionCount>{count}</SidebarSectionCount>
          {collapsed && attention && <AttentionDot size="lg" className="ml-1" data-testid="case-section-attention" />}
        </SidebarSectionToggle>
        <SidebarSectionTrailing className="hidden md:pointer-fine:flex"><SidebarSectionControls><SidebarSectionEndChevron /></SidebarSectionControls></SidebarSectionTrailing>
      </SidebarSectionHeader>
      {collapsed ? null : <div className={SIDEBAR_SECTION_ROWS_CLASS}>{children}</div>}
    </div>
  );
}

function CaseSidebar() {
  const channelRow = (name: keyof typeof channels, browserInUse: SidebarBrowserInUse | null = null) => (
    <Row name={name}>
      <ChannelRow channel={channels[name]} selected={name === "product"} onSelect={ignore} browserInUse={browserInUse} {...rowProps} />
    </Row>
  );
  return (
    <SidebarRoot
      className={`@container/sidebar relative flex h-full w-full flex-col font-sans text-foreground select-none ${phone ? "bg-layer-canvas" : "border-r border-line-seam bg-layer-sidebar"}`}
      data-testid="sidebar-root"
    >
      <div className="min-h-full pb-2">
        <Section sectionKey="channels" title="Channels" count={7}>
          {channelRow("design", SOUND)}
          {channelRow("standup", MIC)}
          {channelRow("launch", MIC_CAMERA)}
          {channelRow("general", MUTED)}
          {channelRow("product")}
          {channelRow("random")}
          {channelRow("release")}
        </Section>
        <Section sectionKey="dms" title="Direct Messages" count={3}>
          <Row name="dm-designer">
            <DmRow dm={dmDesigner} isAgent={false} peerId={designer.id} displayName={designer.displayName} description={designer.description}
              selected={false} ctxType="dm" ctxId={dmDesigner.id} onSelect={ignore} browserInUse={SOUND} {...rowProps} />
          </Row>
          <Row name="dm-agent">
            <AgentDmRow agent={agent} dmId="dm-cindy" selected={false} onSelect={ignore} browserInUse={MIC} {...rowProps} />
          </Row>
          <Row name="dm-lounge">
            {/* An Agent Lounge's own row, with its unread count after the mark. */}
            <AgentLoungeRow channelId="lounge-cindy" agentId={agent.id} title={`${agent.displayName}'s Lounge`} summaryUnread={2} summaryMentioned={false}
              activityMuted={false} selected={false} className={sidebarItemClass(false, false)} onSelect={ignore} onContextMenu={ignore}
              makeLongPress={noLongPress} browserInUse={MUTED} />
          </Row>
        </Section>
        <Section sectionKey="calls" title="Calls" count={3} collapsed browserInUse={MIC} />
        <Section sectionKey="music" title="Listening room" count={2} collapsed attention browserInUse={SOUND} />
      </div>
    </SidebarRoot>
  );
}

const render = () => ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VisualTestingRoot mode={mode}>
      <div className="flex h-screen bg-layer-canvas">
        <div className={phone ? "h-full w-full" : "h-full w-[260px] shrink-0"} data-testid="case-sidebar-column">
          <CaseSidebar />
        </div>
      </div>
    </VisualTestingRoot>
  </StrictMode>,
);
const ready = preloadInitialLocaleMessages();
if (ready) void ready.then(render);
else render();
