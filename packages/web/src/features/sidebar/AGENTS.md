# features/sidebar

The app's left sidebar: the Chat tab's sections (Pinned, joint channels,
Channels, Direct Messages, custom sections), the Computers rail, the
settings sub-nav, their context menus and drag and
drop. One component per file, named exports, no index files.

- Entry: `Sidebar.tsx`, the named export `Sidebar` (`memo`'d), rendered by
  `components/layout/MainLayout.tsx` (the shell's sidebar column, inline on a
  phone) and by `visual-testing/VisualTestingCases`. It only composes: it
  calls the hooks below in a fixed order, each taking the results of the
  earlier ones (`data`, `view`, `sync`, ...), and renders the parts with them.
  Keep that order: together the hooks are one component's hook sequence.
- `hooks/`: `useSidebarData` (store reads, flags, dialog / menu / drag state),
  `useSidebarViewState` (section menus, collapsed state, permissions, rail
  mode, sort modes), `useSidebarSync` (effects: inbox reset, order ids, unread
  summary, route auto-expand, Escape), `useSidebarRowHandlers` (select / open /
  context-menu handlers, menu placement), `useSidebarRoute` (selection by
  route, settings sub-nav), `useSidebarCreateActions`, `useSidebarItems` (what
  each section lists), `useSidebarProjection` (reveal on navigation, unread
  flags, DM list, drag projection, row counts), `useSidebarDnd` (pin / section
  / drag mutations and handlers), `useSidebarHomeEntries`,
  `useSidebarMenuActions` (context-menu targets and actions, dialog handlers).
- Parts: `SidebarTopBar.tsx`, `SidebarDialogs.tsx`,
  `sections/SidebarChatSections.tsx` (the Chat sections in their drag
  context), `rows/SidebarHomeEntries.tsx`,
  `computers/SidebarComputersRail.tsx`, and `menus/` (the row, section and
  surface context menus). They hold no hooks of their own.
- `rows/`: the per-row leaves, each `memo`'d or subscribing to only its own
  slice so a message or status push re-renders one row, not the Sidebar
  (`ChannelRow`, `DmRow`, `AgentDmRow`, `SidebarPeerRowBody`,
  `ChannelUnreadSegments`, `SidebarActivityMutedMark`, `SidebarAgentMeta`,
  `SidebarAgentActivityBadge`, `SavedNavCount`, `DraftsNavCount`);
  `SidebarCellList` and `SidebarRowsSkeleton` (raft-ui SidebarItems with an
  avatar or a glyph-box lead; also the boot frame's); `sidebarRowClasses.ts`
  (`sidebarItemClass`, `SIDEBAR_ROW_TRAILING_CLASS`, and
  `SIDEBAR_SECTION_ROWS_CLASS`, a section's column of rows).
- `computers/`: the Computers rail (`ComputersRailList`, `ComputerRow`,
  `ComputerRowBody`); each row subscribes to its own machine.
  `ComputerRowSkeleton` is a row while the list loads, from the row's parts
  (`computerRowClasses.ts`), as many as last time (`useSidebarData`'s
  `rememberedComputerRows`); the head has no count until the list is read.
- `sections/`: the section heads (`SidebarSectionHeader`,
  `SidebarSectionToggle`, `SidebarSectionChevronIcon`,
  `SidebarSectionDescription`; the empty lines `SidebarPinnedEmptyHint` and
  `SidebarJointEmptyLine`, whose `reserved` box a loading section keeps), `SortableSidebarSection` and the drag-handle
  context it provides to the toggle (`sidebarSectionDragHandleContext.ts`),
  and `sidebarSortSections.ts` (sort modes and their labels, the system
  section order, `sidebarSectionOrderKey`; also `SidebarSortMenu` and
  `SectionSortModeMenuItem`'s). The heads are raft-ui's parts:
  `tests/sidebarSectionControls.contract.test.ts` fails on a wrapper of our own.
  `SidebarPinnedEmptyHint` (Pinned's empty hint, or its invisible box while
  the pins are read) and `PendingSidebarSkeleton` (the sidebar of the boot
  frame, `components/layout/PendingServerLayout`: the loaded sidebar's Saved
  row, section heads and columns with remembered row counts; a section the
  person folded is its folded head alone, from the same per-person setting
  the loaded sidebar reads, `sidebarCollapsedSections`).
- `dnd/`: `SortableSidebarItem`, `SidebarDndContainer`,
  `SidebarDndProjectionMeasurements`, the drag ids and collision/drop-edge
  helpers (`sidebarDragIds.ts`) and the drag transforms
  (`sidebarDragTransform.ts`). The live projection during a drag is a store
  per Sidebar (`sidebarDndProjectionStore.ts`,
  `data.sidebarDndProjectionStore`), not Sidebar state: each section reads
  its own container through `SidebarDndProjectedCount` (visibility, count)
  and `SidebarDndProjectedItems` (rows), so a move renders only the sections
  it changes, never the Sidebar (~~`tests/sidebarDragRenders.behavior.test.tsx`~~ (removed in the [web DOM test prune](../../../../../docs/development/README.md#web-dom-test-prune-2026-11))).
  The drag model itself (containers, projection, reserved height) is
  `components/layout/sidebarDnd.ts`.
- Here too: `sidebarContextMenu.ts` (menu target types, `SidebarCtxKind`,
  `SidebarLongPress`), `sidebarDisplayItems.ts`, `sidebarOrderIds.ts`,
  `expandSidebarSections.ts`.
- Still in `components/layout/` and moving here later: the sort
  (`sidebarSort.ts`, `SidebarSortMenu`), drag model (`sidebarDnd.ts`),
  visibility, focus, collapsed-state and row-count helpers
  (`sidebarChannelVisibility`, `sidebarChannelFocus`,
  `sidebarCollapsedSections`, `sidebarSectionRowCounts`,
  `sidebarEmptySectionVisibility`, `sidebarContextMenuPosition`,
  `sidebarDmContext`, `sidebarMachineOrder`, `agentDmProfileSource`), the
  custom-section dialogs (`SidebarSectionDialog`,
  `SidebarSectionAddConversationsDialog`, `SidebarSectionEmojiPicker`), the
  menu items (`MoveToSectionMenuItem`, `SectionSortModeMenuItem`,
  `SidebarReadToggleMenuItem`), `AgentLoungeRow`, `QuietUnreadDot`, `StaleCountsNotice`,
  `WorkingNowSummary`, `TabRootBar`, `NotificationTrigger`. None of them
  imports this directory's `Sidebar.tsx`.
- State: `channelStore`, `messageStore` (unread, drafts), `agentStore`,
  `machineStore`, `serverStore`, `uiStore`, `inboxStore`, `markedUnreadStore`,
  `store/sidebarSections` (custom sections and placement) and
  `utils/sidebarPinnedRefs`; the saved order loads with the server
  (`serverStore`, `GET /servers/:id/sidebar-order`).
- Agent Lounge v0 (`agent_lounge_v0`, never for a Guest): a Lounge is its own
  row (`components/layout/AgentLoungeRow`, "{Name}'s Lounge" with the
  LoungeAvatar), not a sub-row of its agent's DM row. `useSidebarItems`
  builds `loungeEntryById` from `channelStore.loungeChannels` and the agent
  DM rows' `lounge` summaries; `useSidebarProjection` lists the `listed` ones
  (joined, or you were mentioned there) in Direct Messages, sorted with the
  DMs by the section's mode (in manual order after the DMs: the row is not
  draggable and has no place in `dmOrder`), whether or not the DM row is
  shown. Pinned is `channel:<lounge id>` (Pinned shows it instead, no
  duplicate; the server must accept Lounge ids in pins); no custom sections.
  Its menu is the `lounge` type: Mark read / unread, Pin, Mute (joined),
  Close. Close is a closed DM's (`useSidebarSync` `closeDm`): the Lounge's
  channel id goes in `sidebarOrder.hiddenDmIds` (the server accepts Lounge
  ids there). Like a closed DM it shows again while it has unread or a
  mention for you (display only), and opening it (its channel route) or
  posting there yourself (`reopenDmAfterOwnReply`) takes it off the list.
- Tests live in `packages/web/tests/` (`sidebar*`, plus `agentLoungeSidebar`,
  `agentPinnedDmProfileSource`, `appBotBadgeLists`, `savedNavCount*`,
  `drafts`, `computerUpgrade*`, `computerVersionNotice`, `pendingServerLayout`,
  `threadUnreadSidebar`, `layoutNamespace.i18n`, `phoneTab*`,
  `searchSidebarChannelFocus`, `jointChannelCreateEntry`); the unread display
  rules are `packages/shared/contract-cases/unread`. Run named files with
  `pnpm --filter @botiverse/raft-web test:dom <files>`.
