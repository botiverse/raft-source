import { SidebarSectionControl, SidebarSectionControls, SidebarSectionCount, SidebarSectionEndChevron, SidebarSectionTitle, SidebarSectionTrailing } from "@botiverse/raft-ui";
import Tooltip from "../../../components/ui/Tooltip";
import { Plus } from "lucide-react";
import { DndContext, DragOverlay, MeasuringStrategy } from "@dnd-kit/core";
import { SidebarDndE2EProbe } from "../../../utils/sidebarDndE2eProbe";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Channel } from "../../../store/channelStore";
import { touchDragRegion } from "../../../utils/touchDragRegion";
import AttentionDot from "../../../components/ui/AttentionDot";
import { getSidebarDmContextTarget } from "../../../components/layout/sidebarDmContext";
import { resolveAgentDmProfileSource } from "../../../components/layout/agentDmProfileSource";
import type { SidebarSortMode } from "../../../components/layout/sidebarSort";
import { shouldShowSidebarChannelEmptyState } from "../../../components/layout/sidebarChannelVisibility";
import { SidebarSortMenu } from "../../../components/layout/SidebarSortMenu";
import { AgentLoungeRow } from "../../../components/layout/AgentLoungeRow";
import { isExternalAgentRuntime } from "@botiverse/raft-shared";
import { sidebarCustomContainerId, SIDEBAR_CHANNELS_CONTAINER_ID, SIDEBAR_DMS_CONTAINER_ID, SIDEBAR_JOINT_CHANNELS_CONTAINER_ID, SIDEBAR_PINNED_CONTAINER_ID } from "../../../components/layout/sidebarDnd";
import { sidebarHeldSkeletonRows, sidebarSkeletonRows } from "../../../components/layout/sidebarSectionRowCounts";
import type { SidebarSortSection } from "./sidebarSortSections";
import type { SidebarDndDisplayItem, SidebarLoungeEntry } from "../sidebarDisplayItems";
import { sidebarItemClass } from "../rows/sidebarRowClasses";
import { SidebarRowsSkeleton } from "../rows/SidebarRowsSkeleton";
import { ChannelRow } from "../rows/ChannelRow";
import { DmRow } from "../rows/DmRow";
import { AgentDmRow } from "../rows/AgentDmRow";
import { SidebarSectionDescription } from "./SidebarSectionDescription";
import { SidebarPinnedEmptyHint } from "./SidebarPinnedEmptyHint";
import { SidebarJointEmptyLine } from "./SidebarJointEmptyLine";
import { SortableSidebarItem } from "../dnd/SortableSidebarItem";
import { SidebarDndProjectionMeasurements } from "../dnd/SidebarDndProjectionMeasurements";
import { SidebarDndContainer } from "../dnd/SidebarDndContainer";
import { SidebarDndProjectedCount } from "../dnd/SidebarDndProjectedCount";
import { SidebarDndProjectedItems } from "../dnd/SidebarDndProjectedItems";
import { SortableSidebarSection } from "./SortableSidebarSection";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { SidebarSectionChevronIcon } from "./SidebarSectionChevronIcon";
import { SidebarSectionToggle } from "./SidebarSectionToggle";
import type { SidebarData } from "../hooks/useSidebarData";
import type { SidebarViewState } from "../hooks/useSidebarViewState";
import type { SidebarSync } from "../hooks/useSidebarSync";
import type { SidebarRowHandlers } from "../hooks/useSidebarRowHandlers";
import type { SidebarRoute } from "../hooks/useSidebarRoute";
import type { SidebarCreateActions } from "../hooks/useSidebarCreateActions";
import type { SidebarItems } from "../hooks/useSidebarItems";
import type { SidebarProjection } from "../hooks/useSidebarProjection";
import type { SidebarDnd } from "../hooks/useSidebarDnd";
import { stagedRowIds } from "../hooks/useStagedSidebarRows";

const EMPTY_SIDEBAR_ITEM_IDS: string[] = [];

// Raft Design System › Sidebar `.rf-section`: the section heads are raft-ui's
// parts — SidebarSectionHeader (16px above, 6px below, on the rows' text edge),
// SidebarSectionDisclosure (a collapsible title with SidebarSectionTitle and,
// right after it, SidebarSectionCount, always shown) and the controls in
// SidebarSectionTrailing > SidebarSectionControls: hint-colored 24px ghost
// buttons that show on section hover, keyboard focus or an open menu, always
// on touch, the last one ending on the rows' content edge with or without a
// classic scrollbar (raft-design sidebar.md). Never a wrapper of our own:
// tests/sidebarSectionControls.contract.test.ts fails on one.
// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
// Empty drag-only sections can mount after activation; remeasure droppables
// deterministically instead of keeping pre-drag rects.
const SIDEBAR_DND_MEASURING = { droppable: { strategy: MeasuringStrategy.Always } };
// Stryker restore all

/**
 * The Chat rail's sections (Pinned, custom sections, Joint Channels, Channels,
 * Direct Messages) in their drag-and-drop context.
 */
export function SidebarChatSections({ data, view, sync, rowHandlers, route, createActions, items, projection, dnd }: {
  data: SidebarData;
  view: SidebarViewState;
  sync: SidebarSync;
  rowHandlers: SidebarRowHandlers;
  route: SidebarRoute;
  createActions: SidebarCreateActions;
  items: SidebarItems;
  projection: SidebarProjection;
  dnd: SidebarDnd;
}) {
  const {
    formatMessage, channelsLoading, agents, serverPublicPageLive, pinnedHeld, channelSectionsHeld, dmsHeld,
    rememberedRows, customSections, sectionOrder, externalChannelsEnabled, ctxMenu, sidebarDndProjectionStore,
    sidebarDndActiveId, sidebarRowLimit,
  } = data;
  const {
    collapsedCustomSections, canCreateChannel, canCreateJointChannel, collapsed, channelSortMode,
    jointChannelSortMode, dmSortMode, pinnedSortMode, openSortMenu, setOpenSortMenu, joinedChannelsOnly,
    updatePinnedSortMode, updateChannelSortMode, updateJointChannelSortMode, updateDmSortMode,
    isEmptySectionHidden, hideEmptySections,
  } = view;
  const { dndSensors, toggleSection, toggleCustomSection } = sync;
  const {
    makeLongPressHandlers, handleSelectChannel, handleSelectDm, handleSelectAgentDm, handleSelectLounge,
    openCtxMenu, openSectionCtxMenu,
  } = rowHandlers;
  const { isChannelSelected, isDmSelected } = route;
  const { openCreateChannelFromSectionButton, openCreateJointChannelFromSectionButton } = createActions;
  const {
    jointSectionLabelId, fallbackRegularChannels, channelManualSort, jointChannelManualSort, dmManualSort,
    pinnedManualSort, agentDmChannelId, agentDmChannelByAgentId, agentById, dmContextPeerIds,
  } = items;
  const {
    unreadFlags, customUnreadSectionIdSet, sidebarDndDisplayItems, sidebarDndBaseProjection,
  } = projection;
  const {
    sidebarCollisionDetection, resetSidebarDnd, handleSidebarDragStart, handleSidebarDragOver,
    handleSidebarDragEnd,
  } = dnd;

  const renderSortMenu = (
    section: SidebarSortSection,
    value: SidebarSortMode,
    onChange: (value: SidebarSortMode) => void,
  ) => (
    <SidebarSortMenu
      section={section}
      value={value}
      onChange={onChange}
      open={openSortMenu === section}
      setOpenSortMenu={setOpenSortMenu}
    />
  );
  // Stryker disable all: rendered DOM and Playwright tests exercise both dedicated add buttons and their dialogs; this block is React event wiring.
  const renderSectionAddButton = (section: "channels" | "jointChannels") => {
    const isJoint = section === "jointChannels";
    if (isJoint ? !canCreateJointChannel : !canCreateChannel) return null;
    const label = isJoint
      ? formatMessage({ id: externalChannelsEnabled ? "layout.sidebar.createExternalChannel" : "layout.sidebar.createJointChannel" })
      : formatMessage({ id: "layout.sidebar.createChannel" });

    return (
      <Tooltip content={label}>
      <SidebarSectionControl
        type="button"
        aria-label={label}
        onClick={isJoint ? openCreateJointChannelFromSectionButton : openCreateChannelFromSectionButton}
      >
        <Plus />
      </SidebarSectionControl>
      </Tooltip>
    );
  };
  // Stryker restore all
  const renderChannelItem = (channel: Channel) => (
    <ChannelRow
      key={channel.id}
      channel={channel}
      selected={isChannelSelected(channel.id)}
      menuOpen={ctxMenu?.type === "channel" && ctxMenu.id === channel.id}
      onSelect={handleSelectChannel}
      onContextMenu={openCtxMenu}
      makeLongPress={makeLongPressHandlers}
      serverPublicPageLive={serverPublicPageLive}
    />
  );

  /**
   * Agent Lounge v0: a Lounge's own row (Direct Messages or Pinned; the
   * entries exist only while the flag is on and never for a Guest).
   */
  const renderLoungeItem = (lounge: SidebarLoungeEntry) => {
    const selected = isChannelSelected(lounge.channelId);
    return (
      <AgentLoungeRow
        key={lounge.channelId}
        channelId={lounge.channelId}
        agentId={lounge.agentId}
        title={lounge.title}
        summaryUnread={lounge.summaryUnread}
        summaryMentioned={lounge.summaryMentioned}
        activityMuted={lounge.channel?.activityMuted === true}
        selected={selected}
        className={sidebarItemClass(selected, ctxMenu?.type === "lounge" && ctxMenu.id === lounge.channelId)}
        onSelect={handleSelectLounge}
        onContextMenu={openCtxMenu}
        makeLongPress={makeLongPressHandlers}
      />
    );
  };

  /** Render agent as a DM conversation item (Chat tab) — navigates to /dm/:dmId */
  const renderAgentDmItem = (agent: typeof agents[0]) => {
    const dmId = agentDmChannelId[agent.id];
    const dm = agentDmChannelByAgentId[agent.id];
    return (
      <AgentDmRow
        key={agent.id}
        agent={agent}
        dmId={dmId}
        activityMuted={dm?.activityMuted === true}
        selected={dmId ? isDmSelected(dmId) : false}
        menuOpen={ctxMenu?.type === "agent" && ctxMenu.id === agent.id}
        onSelect={handleSelectAgentDm}
        onContextMenu={openCtxMenu}
        makeLongPress={makeLongPressHandlers}
      />
    );
  };

  const renderDmItem = (dm: Channel) => {
    const isAgent = dm.peerType === "agent";
    const dmCtxTarget = getSidebarDmContextTarget(dm, dmContextPeerIds);
    const matchingAgent = isAgent && dm.peerId ? agentById.get(dm.peerId) : undefined;
    const agentProfile = matchingAgent ? resolveAgentDmProfileSource(matchingAgent) : null;
    const displayName = agentProfile
      ? agentProfile.displayName
      : dm.peerDisplayName || dm.peerName || dm.name;
    const description = isAgent
      ? agentProfile?.description ?? null
      : dm.peerDescription ?? null;
    return (
      <DmRow
        key={dm.id}
        dm={dm}
        isAgent={isAgent}
        peerId={dm.peerId ?? null}
        displayName={displayName}
        description={description}
        selected={isDmSelected(dm.id)}
        menuOpen={ctxMenu?.type === dmCtxTarget.type && ctxMenu.id === dmCtxTarget.id}
        ctxType={dmCtxTarget.type}
        ctxId={dmCtxTarget.id}
        onSelect={handleSelectDm}
        onContextMenu={openCtxMenu}
        makeLongPress={makeLongPressHandlers}
        agentRuntime={matchingAgent?.runtime ?? null}
        agentExternal={matchingAgent ? matchingAgent.external === true || isExternalAgentRuntime(matchingAgent.runtime) : false}
        appBot={Boolean(matchingAgent?.managedByAppInstallId)}
        appBotAppName={matchingAgent?.managedByApp?.name ?? null}
      />
    );
  };

  // Stryker disable all: pre-existing shared section-toggle glue is outside the workspace mutation corpus.
  const agentsExpanded = !collapsed.agents;
  // Stryker restore all

  // A row looks the same in every section it can be in (its home section,
  // Pinned, a custom section): the section never changes how it is drawn.
  const renderSidebarDndDisplayItem = (item: SidebarDndDisplayItem) => {
    switch (item.type) {
      case "channel":
        return renderChannelItem(item.channel);
      case "dm":
        return renderDmItem(item.dm);
      case "agent":
        return renderAgentDmItem(item.agent);
      case "lounge":
        return renderLoungeItem(item.lounge);
    }
  };

  const renderSidebarDndItem = (itemId: string, containerId: string) => {
    const item = sidebarDndDisplayItems.get(itemId);
    if (!item) return null;
    return (
      <SortableSidebarItem key={itemId} id={itemId} containerId={containerId} dragDisabled={item.type === "lounge"}>
        {renderSidebarDndDisplayItem(item)}
      </SortableSidebarItem>
    );
  };
  // Stryker disable all: sidebar drag/drop render composition is covered by source contracts and browser/manual preview; command-runner DOM mutation tests cannot perform dnd-kit drags.
  const sidebarDragSections = (
    /* Stryker disable all: section-row event wiring and empty-state chrome are covered by rendered DOM plus the real-browser recording. */
    <DndContext
      sensors={dndSensors}
      collisionDetection={sidebarCollisionDetection}
      // Empty drag-only sections can mount after activation; remeasure
      // droppables deterministically instead of keeping pre-drag rects.
      measuring={SIDEBAR_DND_MEASURING}
      onDragStart={handleSidebarDragStart}
      onDragOver={handleSidebarDragOver}
      onDragCancel={resetSidebarDnd}
      onDragEnd={handleSidebarDragEnd}
    >
    <SidebarDndProjectionMeasurements store={sidebarDndProjectionStore} />
    {import.meta.env.VITE_E2E === "true" ? <SidebarDndE2EProbe /> : null}
    <SortableContext items={sectionOrder} strategy={verticalListSortingStrategy}>
    <div ref={touchDragRegion} className="flex flex-col" data-testid="sidebar-section-list">
    {/* Pinned. Each section renders from its own container's projection
        (SidebarDndProjectedCount: its visibility and count; SidebarDndProjectedItems:
        its rows), so a drag's move renders only the sections it changes. */}
    <SidebarDndProjectedCount store={sidebarDndProjectionStore} containerId={SIDEBAR_PINNED_CONTAINER_ID} baseItemIds={sidebarDndBaseProjection[SIDEBAR_PINNED_CONTAINER_ID]}>
    {(pinnedCount) => !isEmptySectionHidden(pinnedCount, pinnedHeld, rememberedRows.pinned, SIDEBAR_PINNED_CONTAINER_ID, true) && (
    <SortableSidebarSection id="system:pinned" testId="sidebar-section-block-pinned" order={sectionOrder.indexOf("system:pinned")}>
        <SidebarSectionHeader section="pinned" onOpenContextMenu={openSectionCtxMenu} sectionKey={"pinned"} open={!collapsed.pinned} onToggleSection={toggleSection}>
          <SidebarSectionToggle
            sectionKey="pinned"
            onToggleSection={toggleSection}
            aria-expanded={!collapsed.pinned}
            aria-controls="sidebar-section-pinned"
            data-testid="sidebar-section-toggle-pinned"
          >
            <SidebarSectionChevronIcon open={!collapsed.pinned} />
            <SidebarSectionTitle>{formatMessage({ id: "layout.sidebar.pinned" })}</SidebarSectionTitle>
            {/* No count while the pins are held: a "0" there would be read, not loading. */}
            {pinnedHeld ? null : (
              <SidebarSectionCount>
                {pinnedCount}
              </SidebarSectionCount>
            )}
            {collapsed.pinned && unreadFlags.pinned && (
              <AttentionDot size="lg" className="ml-1" />
            )}
          </SidebarSectionToggle>
          <SidebarSectionTrailing>
            <SidebarSectionControls>
              {renderSortMenu("pinned", pinnedSortMode, updatePinnedSortMode)}
            <SidebarSectionEndChevron />
          </SidebarSectionControls>
          </SidebarSectionTrailing>
        </SidebarSectionHeader>

        <div id="sidebar-section-pinned" hidden={collapsed.pinned}>
          {!collapsed.pinned && (
            <SidebarDndProjectedItems store={sidebarDndProjectionStore} containerId={SIDEBAR_PINNED_CONTAINER_ID} baseItemIds={sidebarDndBaseProjection[SIDEBAR_PINNED_CONTAINER_ID]}>
            {(pinnedIds) => (
            <SidebarDndContainer
              id={SIDEBAR_PINNED_CONTAINER_ID}
              kind="pinned"
              manual={pinnedManualSort}
              itemIds={pinnedIds}
              empty={pinnedIds.length === 0}
            >
              {pinnedHeld ? (
                  // Neither the empty hint nor some of the pins before
                  // all of them are read. With no rows to draw (none
                  // remembered, none resolved yet) the hint's box is kept
                  // instead, where the shown hint will be, so the sections
                  // below don't move down once the pins are read.
                  sidebarHeldSkeletonRows(rememberedRows.pinned, 0, pinnedIds.length) > 0 ? (
                    <SidebarRowsSkeleton
                      rows={sidebarHeldSkeletonRows(rememberedRows.pinned, 0, pinnedIds.length)}
                    />
                  ) : hideEmptySections ? null : <SidebarPinnedEmptyHint reserved />
                ) : pinnedIds.length > 0 ? (
                  <>{stagedRowIds(pinnedIds, sidebarRowLimit).map((itemId) => renderSidebarDndItem(itemId, SIDEBAR_PINNED_CONTAINER_ID))}</>
                ) : (
                  <SidebarPinnedEmptyHint />
                )
              }
            </SidebarDndContainer>
            )}
            </SidebarDndProjectedItems>
          )}
        </div>
      </SortableSidebarSection>
    )}
    </SidebarDndProjectedCount>

    {customSections
      .slice()
      .sort((a, b) => sectionOrder.indexOf(a.id) - sectionOrder.indexOf(b.id))
      .map((section) => {
        const containerId = sidebarCustomContainerId(section.id);
        const baseItemIds = sidebarDndBaseProjection[containerId] ?? EMPTY_SIDEBAR_ITEM_IDS;
        const collapsedCustom = collapsedCustomSections[section.id] === true;
        return (
          <SidebarDndProjectedCount key={section.id} store={sidebarDndProjectionStore} containerId={containerId} baseItemIds={baseItemIds}>
          {(customCount) => (
          <SortableSidebarSection id={section.id} testId={`sidebar-custom-section-${section.id}`} order={sectionOrder.indexOf(section.id)}>
            <SidebarSectionHeader section={`custom:${section.id}`} onOpenContextMenu={openSectionCtxMenu} sectionKey={section.id} open={!collapsedCustom} onToggleSection={toggleCustomSection}>
              <SidebarSectionToggle
                sectionKey={section.id}
                onToggleSection={toggleCustomSection}
                aria-expanded={!collapsedCustom}
              >
                <SidebarSectionChevronIcon open={!collapsedCustom} />
                {section.emoji && <span aria-hidden>{section.emoji}</span>}
                <SidebarSectionTitle>{section.name}</SidebarSectionTitle>
                <SidebarSectionCount>{customCount}</SidebarSectionCount>
                {collapsedCustom && customUnreadSectionIdSet.has(section.id) && <AttentionDot size="lg" className="ml-1" />}
              </SidebarSectionToggle>
            {/* Only the end chevron, mouse only: no empty trailing room on touch, where it would cut the title short. */}
            <SidebarSectionTrailing className="hidden md:pointer-fine:flex"><SidebarSectionControls><SidebarSectionEndChevron /></SidebarSectionControls></SidebarSectionTrailing>
            </SidebarSectionHeader>
            <div hidden={collapsedCustom}>
              {!collapsedCustom && (
              <SidebarDndProjectedItems store={sidebarDndProjectionStore} containerId={containerId} baseItemIds={baseItemIds}>
              {(projectedItemIds) => (
              <SidebarDndContainer
                id={containerId}
                kind="custom"
                manual={section.sortMode === "manual"}
                itemIds={projectedItemIds}
                empty={projectedItemIds.length === 0}
              >
                {projectedItemIds.length === 0 ? (
                  <SidebarSectionDescription tone="subtle" className="py-1">
                    {formatMessage({ id: "layout.sidebar.noConversations" })}
                  </SidebarSectionDescription>
                ) : (
                  <>{stagedRowIds(projectedItemIds, sidebarRowLimit).map((itemId) => renderSidebarDndItem(itemId, containerId))}</>
                )}
              </SidebarDndContainer>
              )}
              </SidebarDndProjectedItems>
              )}
            </div>
          </SortableSidebarSection>
          )}
          </SidebarDndProjectedCount>
        );
      })}

    {/* Joint Channels */}
    <SidebarDndProjectedCount store={sidebarDndProjectionStore} containerId={SIDEBAR_JOINT_CHANNELS_CONTAINER_ID} baseItemIds={sidebarDndBaseProjection[SIDEBAR_JOINT_CHANNELS_CONTAINER_ID]}>
    {/* With external channels on, an empty External section is not drawn at all, not even to offer
        its +: a server with no external channel has nothing to show there (cindyz, #wg-rbac:db936076).
        Creating one stays in the sidebar's right-click menu (SidebarSurfaceContextMenu). */}
    {/* Through the same check as every section, so it stays while loading and while a drag that
        started in it is under way (moving its last channel out must not unmount the drag's source);
        it is not revealed as a drop target either: a channel dragged in doesn't become external. */}
    {(jointCount) => (externalChannelsEnabled
      ? !isEmptySectionHidden(jointCount, channelSectionsHeld, rememberedRows.jointChannels, SIDEBAR_JOINT_CHANNELS_CONTAINER_ID, false, true)
      : canCreateJointChannel || !isEmptySectionHidden(jointCount, channelSectionsHeld, rememberedRows.jointChannels, SIDEBAR_JOINT_CHANNELS_CONTAINER_ID, true)) && (
    <SortableSidebarSection id="system:joint" testId="sidebar-section-block-joint" order={sectionOrder.indexOf("system:joint")}>
        <SidebarSectionHeader section="jointChannels" onOpenContextMenu={openSectionCtxMenu} sectionKey={"jointChannels"} open={!collapsed.jointChannels} onToggleSection={toggleSection}>
          <SidebarSectionToggle
            sectionKey="jointChannels"
            onToggleSection={toggleSection}
            aria-expanded={!collapsed.jointChannels}
            aria-controls="sidebar-section-joint-channels"
            data-testid="sidebar-section-toggle-joint-channels"
          >
            <SidebarSectionChevronIcon open={!collapsed.jointChannels} />
            <SidebarSectionTitle>{formatMessage({ id: jointSectionLabelId })}</SidebarSectionTitle>
            <SidebarSectionCount>
              {jointCount}
            </SidebarSectionCount>
            {collapsed.jointChannels && unreadFlags.joint && (
              <AttentionDot size="lg" className="ml-1" />
            )}
          </SidebarSectionToggle>
          <SidebarSectionTrailing>
            <SidebarSectionControls>
              {renderSortMenu("jointChannels", jointChannelSortMode, updateJointChannelSortMode)}
              {renderSectionAddButton("jointChannels")}
            <SidebarSectionEndChevron />
          </SidebarSectionControls>
          </SidebarSectionTrailing>
        </SidebarSectionHeader>

        <div id="sidebar-section-joint-channels" hidden={collapsed.jointChannels}>
          {!collapsed.jointChannels && (
            <SidebarDndProjectedItems store={sidebarDndProjectionStore} containerId={SIDEBAR_JOINT_CHANNELS_CONTAINER_ID} baseItemIds={sidebarDndBaseProjection[SIDEBAR_JOINT_CHANNELS_CONTAINER_ID]}>
            {(jointIds) => {
            // Loading: last time's rows, or with none last time the empty
            // line's box, where the line will most likely be.
            const loadingRows = channelSectionsHeld
              ? sidebarHeldSkeletonRows(rememberedRows.jointChannels, 2, jointIds.length)
              : jointIds.length === 0 && channelsLoading ? sidebarSkeletonRows(rememberedRows.jointChannels, 2) : null;
            return (
            <SidebarDndContainer
              id={SIDEBAR_JOINT_CHANNELS_CONTAINER_ID}
              kind="jointChannels"
              manual={jointChannelManualSort}
              itemIds={jointIds}
              empty={jointIds.length === 0}
            >
              {loadingRows !== null ? (
                loadingRows > 0
                  ? <SidebarRowsSkeleton lead="icon" rows={loadingRows} />
                  : <SidebarJointEmptyLine external={externalChannelsEnabled} reserved />
              ) : jointIds.length === 0 ? (
                <SidebarJointEmptyLine external={externalChannelsEnabled} />
              ) : (
                <>{stagedRowIds(jointIds, sidebarRowLimit).map((itemId) => renderSidebarDndItem(itemId, SIDEBAR_JOINT_CHANNELS_CONTAINER_ID))}</>
              )}
            </SidebarDndContainer>
            );
            }}
            </SidebarDndProjectedItems>
          )}
        </div>
    </SortableSidebarSection>
    )}
    </SidebarDndProjectedCount>

    {/* Channels */}
    <SidebarDndProjectedCount store={sidebarDndProjectionStore} containerId={SIDEBAR_CHANNELS_CONTAINER_ID} baseItemIds={sidebarDndBaseProjection[SIDEBAR_CHANNELS_CONTAINER_ID]}>
    {(channelCount) => (
    <SortableSidebarSection id="system:channels" testId="sidebar-section-block-channels" order={sectionOrder.indexOf("system:channels")}>
    <SidebarSectionHeader section="channels" onOpenContextMenu={openSectionCtxMenu} sectionKey={"channels"} open={!collapsed.channels} onToggleSection={toggleSection}>
      <SidebarSectionToggle
        sectionKey="channels"
            onToggleSection={toggleSection}
        aria-expanded={!collapsed.channels}
        aria-controls="sidebar-section-channels"
        data-testid="sidebar-section-toggle-channels"
      >
        <SidebarSectionChevronIcon open={!collapsed.channels} />
        <SidebarSectionTitle>{formatMessage({ id: "layout.sidebar.channels" })}</SidebarSectionTitle>
        <SidebarSectionCount>
          {channelCount}
        </SidebarSectionCount>
        {collapsed.channels && unreadFlags.channels && (
          <AttentionDot size="lg" className="ml-1" data-testid="sidebar-section-unread-dot-channels" />
        )}
      </SidebarSectionToggle>
      <SidebarSectionTrailing>
        <SidebarSectionControls>
          {renderSortMenu("channels", channelSortMode, updateChannelSortMode)}
          {renderSectionAddButton(
            // Stryker disable next-line StringLiteral: the helper's non-joint branch intentionally treats every value other than jointChannels as a regular channel.
            "channels",
          )}
        <SidebarSectionEndChevron />
          </SidebarSectionControls>
      </SidebarSectionTrailing>
    </SidebarSectionHeader>

    <div id="sidebar-section-channels" hidden={collapsed.channels}>
      {!collapsed.channels && (
        <SidebarDndProjectedItems store={sidebarDndProjectionStore} containerId={SIDEBAR_CHANNELS_CONTAINER_ID} baseItemIds={sidebarDndBaseProjection[SIDEBAR_CHANNELS_CONTAINER_ID]}>
        {(channelIds) => (
        <SidebarDndContainer
          id={SIDEBAR_CHANNELS_CONTAINER_ID}
          kind="channels"
          manual={channelManualSort}
          itemIds={channelIds}
          empty={channelIds.length === 0}
        >
          {channelSectionsHeld ? (
            <SidebarRowsSkeleton
              lead="icon"
              rows={sidebarHeldSkeletonRows(rememberedRows.channels, 4, channelIds.length)}
            />
          ) : (
            <>{stagedRowIds(channelIds, sidebarRowLimit).map((itemId) => renderSidebarDndItem(itemId, SIDEBAR_CHANNELS_CONTAINER_ID))}</>
          )}
          {!channelSectionsHeld && shouldShowSidebarChannelEmptyState(fallbackRegularChannels) && (
            channelsLoading ? (
              <SidebarRowsSkeleton lead="icon" rows={sidebarSkeletonRows(rememberedRows.channels, 4)} />
            ) : (
              <SidebarSectionDescription>
                {joinedChannelsOnly ? formatMessage({ id: "layout.sidebar.noJoinedChannels" }) : formatMessage({ id: "layout.sidebar.noChannelsYet" })}
              </SidebarSectionDescription>
            )
          )}
        </SidebarDndContainer>
        )}
        </SidebarDndProjectedItems>
      )}
    </div>
    {/* Stryker restore all */}
    </SortableSidebarSection>
    )}
    </SidebarDndProjectedCount>

    {/* Direct Messages — show open DMs, auto-reopen on unread */}
    {/* Stryker disable all: pre-existing DM ordering and section chrome are outside the workspace mutation corpus. */}
      <SidebarDndProjectedCount store={sidebarDndProjectionStore} containerId={SIDEBAR_DMS_CONTAINER_ID} baseItemIds={sidebarDndBaseProjection[SIDEBAR_DMS_CONTAINER_ID]}>
      {(dmCount) => !isEmptySectionHidden(dmCount, dmsHeld, rememberedRows.dms, SIDEBAR_DMS_CONTAINER_ID) && (
      <SortableSidebarSection id="system:dms" testId="sidebar-section-block-dms" order={sectionOrder.indexOf("system:dms")}>
        <SidebarSectionHeader section="dms" onOpenContextMenu={openSectionCtxMenu} sectionKey={"agents"} open={!collapsed.agents} onToggleSection={toggleSection}>
          <SidebarSectionToggle
            sectionKey="agents"
            onToggleSection={toggleSection}
            aria-expanded={agentsExpanded}
            aria-controls="sidebar-section-direct-messages"
            data-testid="sidebar-section-toggle-dms"
          >
            <SidebarSectionChevronIcon open={!collapsed.agents} />
            <SidebarSectionTitle>{formatMessage({ id: "layout.sidebar.directMessages" })}</SidebarSectionTitle>
            {/* No count while the DM list is held: a "0" there would be read, not loading. */}
            {dmsHeld ? null : (
              <SidebarSectionCount>
                {dmCount}
              </SidebarSectionCount>
            )}
            {collapsed.agents && unreadFlags.dms && (
              <AttentionDot size="lg" className="ml-1" />
            )}
          </SidebarSectionToggle>
          <SidebarSectionTrailing>
            <SidebarSectionControls>
              {renderSortMenu("dms", dmSortMode, updateDmSortMode)}
            <SidebarSectionEndChevron />
          </SidebarSectionControls>
          </SidebarSectionTrailing>
        </SidebarSectionHeader>

        <div id="sidebar-section-direct-messages" hidden={collapsed.agents}>
          {!collapsed.agents && (
            <SidebarDndProjectedItems store={sidebarDndProjectionStore} containerId={SIDEBAR_DMS_CONTAINER_ID} baseItemIds={sidebarDndBaseProjection[SIDEBAR_DMS_CONTAINER_ID]}>
            {(dmIds) => (
            <SidebarDndContainer
              id={SIDEBAR_DMS_CONTAINER_ID}
              kind="dms"
              manual={dmManualSort}
              itemIds={dmIds}
              empty={dmIds.length === 0}
            >
              {dmsHeld ? (
                <SidebarRowsSkeleton
                  rows={sidebarHeldSkeletonRows(rememberedRows.dms, 3, dmIds.length)}
                />
              ) : dmIds.length > 0 ? (
                <>{stagedRowIds(dmIds, sidebarRowLimit).map((itemId) => renderSidebarDndItem(itemId, SIDEBAR_DMS_CONTAINER_ID))}</>
              ) : null}
            </SidebarDndContainer>
            )}
            </SidebarDndProjectedItems>
          )}
        </div>
      </SortableSidebarSection>
      )}
      </SidebarDndProjectedCount>
      {/* Stryker restore all */}
    </div>
    </SortableContext>
    <DragOverlay dropAnimation={null}>
      {sidebarDndActiveId && sidebarDndDisplayItems.get(sidebarDndActiveId) ? (
        <div
          data-testid="sidebar-drag-overlay"
          className="max-w-72 truncate rounded-control bg-layer-popover px-2.5 py-2 font-sans text-subhead font-medium text-foreground shadow-float ring-1 ring-line-seam"
        >
          {sidebarDndDisplayItems.get(sidebarDndActiveId)!.label}
        </div>
      ) : null}
    </DragOverlay>
    </DndContext>
  );
  // Stryker restore all
  return sidebarDragSections;
}
