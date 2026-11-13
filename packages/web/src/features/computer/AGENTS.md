# features/computer

A Computer (machine) and its runtimes: the Computer page (detail panel), the
Computers rack (overview list / cards), and the runtime sign-in, sign-out and
model-provider dialogs. One component per file, named exports.

- Entries:
  - `MachineDetailPanel.tsx`: the Computer page. Loaded through
    `machineDetailChunk.ts` (`loadMachineDetailPanel`, `preloadComputerPanel`)
    by the side panel (`ProfilePanel`), `MainLayout` and the rack's hover.
  - `ComputersRackOverview.tsx` (desktop) and `ComputersRackList.tsx` (also the
    phone's `MobileComputersPanel`): loaded together through
    `computersRackChunk.ts` (`loadComputersRack`), one promise for every caller.
  - `RuntimeSignInDialog.tsx`, `RuntimeSignOutDialog.tsx`,
    `RuntimeProviderConnectDialog.tsx`: opened from
    `components/machine/RuntimeAccountUsageChip.tsx` and `RuntimeSignInNotice.tsx`
    (contract: `docs/contracts/runtime-auth.md`).
  - `RuntimeLimitResetDialog.tsx` (outcome copy and helpers in
    `limitResetOutcome.ts`): Use a reset on the usage card, confirming whose
    reset it spends; the card (`useRuntimeUsageCard`) owns the attempt's
    idempotency key (contract: `docs/contracts/runtime-account-usage.md`).
    The card's drawing is `components/machine/RuntimeUsageSurface.tsx`.
  - `useClaudeLimitResets.tsx`, `ClaudeLimitResetsDialog.tsx` (copy in
    `claudeLimitResetCopy.ts`): Claude limit resets by kind behind
    `claude_limit_reset`: View available resets (consent first at the 5-hour
    limit), Use per kind, Use 5-hour reset at the wall (same contract).
  - `DeleteComputerDialog.tsx`: Delete Computer, from `MachineDetailPanel` and
    the rack row's `RackRowMenu`. Which path is the server's revoke gate:
    the viewer's own computer is a Computer whose machine row is theirs
    (`machine.userId`, sent with every machine row), not whoever attached it
    (`computerAttachedByCurrentUser`). Someone else's computer, a raw daemon,
    or a legacy machine an admin adopted (attached by one person, the row
    another's): the plain DELETE, refused while any agent is on it. The
    viewer's own computer: only their own agents hold it up; it revokes the Computer key first
    (`revoke-computer-key`), whose 409 `others_agents_on_computer` opens
    `OthersAgentsOnComputerDialog.tsx` (each agent with its owner and Notify
    Owner to Move It), then Force Unbind and Delete, then the DELETE
    (#triage:#198).
  - Other people's agents on the person's computers (#triage:d10ace06), shared
    with Settings › Account › Delete Account: `othersAgentsApi.ts` (wire
    shapes, both notify-agent-owners routes, the revoke),
    `useAgentOwnerNotify.ts` (what the screen's notify calls learned, the
    once-a-day limit) and `AgentOwnerNotifyActions.tsx` (Notify Owner to Move
    It, Remind Again, when they can remind again, who else can act).
    `ForceUnbindAgentsDialog.tsx`: the confirmation for force-unbinding them
    (each with its owner, or No owner, and computer; the caller sends exactly
    that list). Copy: `machine.othersAgents.*`, `machine.forceUnbind.*`.
  - Computer owner v1 (#wg-rbac:#32): who Raft records as a Computer's owner
    (`machine.ownerUserId` / `owner`, null = Public), display and transfer
    only, no rights. `ComputerOwnerField.tsx` (the Computer page's Owner row:
    Transfer owner for the owner and owners/admins, Make it mine for whoever
    connected a Public Computer), `TransferComputerOwnerDialog.tsx` (the
    picker and the credentials warning), `ComputerOwnerLabel.tsx` (the rack's
    owner line); `machineStore.setMachineOwner` (PUT
    `/servers/:id/machines/:machineId/owner`). Server rules:
    `packages/server/src/services/computerOwnerService.ts`. Copy:
    `machine.owner.*`.
- Shared here: `machineDetailClassNames.ts`, `machineDetailTypes.ts`,
  `computersRackLayout.ts` (the rack's column widths), `computersRackTypes.ts`,
  `useAgentsByMachine.ts`, `useOrderedMachines.ts`, `useComputerName.ts`,
  `accountText.ts`, `computersRackSort.ts` (the overview's sort: Name, each
  runtime's remaining quota (`rackRemaining`), Disk, Memory; the choice is
  `store/computersRackSortPreference.ts`, shared by the toolbar's Sort and the
  list's headings, raft-ui's `TableSortButton` in `RackListHeader.tsx`). No
  choice (the default, the Sort's "Mine first") is no sort: the
  `useOrderedMachines` order (this device, the viewer's own by
  `isMyComputer` in `components/layout/sidebarMachineOrder.ts`, the rest), no
  heading marked, and grouped, the groups holding the viewer's own first.
- The overview's toolbar (Raft DS › Raft Chat › Computers,
  `design/products/raft-chat/computers.md` in raft-design):
  `ComputersRackToolbar.tsx` (search, then Status / Runtime / Group / Sort as
  PickerTriggerButton Selects, Clear all; the phone's two lines),
  `computersRackToolbarModel.ts` (its labels and options),
  `computersRackFilter.ts` (filtering and grouping, pure),
  `store/computersRackFilterPreference.ts` (search and filters for the page,
  the grouping kept in this browser). `ComputersRackList.tsx` applies them and
  folds offline computers into one Offline section at the end.
  `RackGroupTitle.tsx` draws a group's header. Tests:
  ~~`tests/computersRackToolbar.behavior.test.tsx`~~ (removed in the [web DOM test prune](../../../../../docs/development/README.md#web-dom-test-prune-2026-11)),
  `tests/computersRackFilter.behavior.test.ts`.
- Loading (skeleton-vs-loaded audit): while the computers load, the page draws
  what it drew last time on this server (`computersRackRemembered.ts`,
  localStorage, counts only): `components/machine/rack/RackRowSkeleton.tsx`
  cards or list rows at the remembered count (desktop, inside
  `ComputersRackList`; the phone has its own `RackSkeleton` in
  `MobileComputersPanel`), and the attention summary's lines
  (`ComputersAttentionSummary`); the Runtime filter stays, disabled, until the
  runtimes are known. A usage cell being read is `pending` (bars, a loading
  label; never "—", which is a failed or empty read), as tall as its last
  answer (`rack/rackUsageLines.ts`, localStorage). Cards remember each one's shape too (usage lines, Other runtimes, offline: `cards` in `computersRackRemembered.ts`). Tests:
  ~~`tests/computersRackOverview.behavior.test.tsx`~~ (removed),
  ~~`tests/computersRackRuntimeUsage.behavior.test.tsx`~~ (removed).
- Product events of the Computers page (docs/analytics/product-events.md,
  "Computers page"; registry `COMPUTERS_LIST_*`): `analytics/computersList.ts`
  holds the three senders. `useComputersListViewed.ts` sends the snapshot once
  per server per mount of the page, from `ComputersRackToolbar` (on screen as
  long as the page is, desktop and phone; not from `MobileComputersPanel`,
  which is in the first download and must not import the rack's filter and sort stores). A
  control says its change from its own handler, with its surface: the
  toolbar's (`ReportChange` in `ComputersRackToolbar.tsx`), and the list's
  headings, folds, empty-state Clear all and opened rows
  (`ComputersRackList.tsx`, which reads the list at the click from
  `eventInputs`, a ref, so the handlers given to the memoized rows keep one
  identity). A new control, or a new way to change one, adds its call there;
  the stores send nothing. Tests:
  ~~`tests/computersListEvents.behavior.test.tsx`~~ (removed).
- Most of the Computer code still lives in `components/machine/` (rows, chips,
  upgrade/restart hooks, `localComputer/`, `rack/` parts) and moves here by
  feature later. State: `store/machineStore.ts`.
- `MachineDetailPanel.tsx` owns the Computer page's state and layout; its
  sections are siblings: `MachineInfoSection.tsx`, `ComputerRecoveryCard.tsx`
  (offline), `ComputerServiceActionsCard.tsx` and `ComputerRecoveryGuideCard.tsx`
  (Actions), with the Name / Description editors in
  `useMachineDetailEditors.ts` and command helpers in `machineDetailCommands.ts`.
- Tests that exercise only this feature live in `tests/` here
  (`src/features/computer/tests/`); tests that cross features stay in
  `packages/web/tests/` (`computer*`, `machine*`, `computersRack*`). Run named
  files with `pnpm --filter @botiverse/raft-web test:dom <files>`.
