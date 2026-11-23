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
    `components/machine/RuntimeAccountUsageChip.tsx` and `RuntimeSignInNotice.tsx`,
    and the sign-in one also from setup's handoff (`useFirstAgentStartFailure.tsx`)
    and from `RuntimeSignInAction.tsx`: Sign in beside an agent's "Sign-in
    needed" status (member list, a DM's header; #triage:#494). That check is
    `runtimeSignInNeededOf` (`utils/activity.ts`); who gets Sign in is
    `components/machine/runtimeSignInGate.ts`, shared with the notice
    (contract: `docs/contracts/runtime-auth.md`).
  - `RuntimeLimitResetDialog.tsx` (outcome copy and helpers in
    `limitResetOutcome.ts`): Use a reset on the usage card, confirming whose
    reset it spends; the card (`useRuntimeUsageCard`) owns the attempt's
    idempotency key (contract: `docs/contracts/runtime-account-usage.md`).
    The card's drawing is `components/machine/RuntimeUsageSurface.tsx`.
    Its layout (#oar-raft:3a3f8fc1): no action row on a healthy card; resets
    left and credits always shown under the account; the reset offered only
    from 80% used (`components/machine/limitResetOffer.ts`) and as the main
    action, with why, once limited; Sign out in the account's ⋯ menu; Refresh
    beside "Updated …"; signed out, one full-width "Sign in to …". Fixture
    screenshots: `visual-testing/runtime-usage-card/`.
  - `useClaudeLimitResets.tsx`, `ClaudeLimitResetsDialog.tsx` (copy in
    `claudeLimitResetCopy.ts`): Claude limit resets by kind behind
    `claude_limit_reset_v2`, as Claude Code's own `/limit-reset`: one entry,
    "Use a limit reset" (no step asks first; at the 5-hour limit the read
    carries consent), then `claudeLimitResetReadStep`: one usable kind straight
    to its confirm, several under "Which reset do you want to use?", else a
    line on the card (Claude's older program: the read itself used the 5-hour
    reset, or nothing). What a viewer is offered is `claudeLimitResetOffer.ts`:
    a person who cannot use them (did not connect the Computer) gets "View
    available resets", the list read-only, below the 5-hour limit, and no entry
    at all at it (the read needs consent); never a control beside a note saying
    why it cannot be used. Tests: `tests/claudeLimitResetsDialog.behavior.test.tsx`.
    Fixture screenshots: `visual-testing/claude-limit-reset/`.
  - `useRuntimeUpgrade.ts`, `RuntimeUpgradeButton.tsx`, `RuntimeUpgradeOutcome.tsx`
    (copy in `runtimeUpgradeOutcomeCopy.ts`), `runtimeUpgradeTarget.ts`: Upgrade a
    runtime's CLI behind `runtime_upgrade_button`, offered per runtime by the
    runtime-auth read (`runtimeUpgradeOffered`: `runtimeUpgrade` and the
    Computer's `upgradableRuntimes`). On the card (`RuntimeVersionLine.tsx` in
    `components/machine`: a text link in the version line, replaced by the
    outcome once it has one; state in `useRuntimeUsageCard`) where the Computer's read-only update check
    (`runtimeUpdateOf`: the view's `runtimeUpdates`) found a newer version,
    or reported none (an older Computer or server); its line in place of the
    bare version ("1.5.10 → 1.5.11 available", "1.5.11 · Latest", "Updates
    are managed outside Raft", "Couldn't check for updates"; a check over a
    day old counts as none) and when the button shows are
    `runtimeUpdateCheckCopy` / `runtimeUpgradeButtonShown`; on the agent
    form's `runtime_outdated` source line
    (`components/agent/RuntimeFormV2OutdatedUpgrade.tsx`, target from
    `RuntimeConfigFields`' `upgradeTarget`); on `RuntimeSignInNotice.tsx` for
    `version_unsupported` (those two ignore the check: the CLI is known too
    old). Only on a press; never automatic (contract:
    `docs/contracts/runtime-auth.md` §6d).
  - `useRuntimeInstall.ts`, `RuntimeInstallDialog.tsx`, `RuntimeInstallOutcome.tsx`
    (state and copy in `runtimeInstallCopy.ts`): Install a runtime the Computer
    does not have behind `runtime_install_button`, offered per runtime by the
    runtime-auth read (`runtimeInstallOffered`: `runtimeInstall` and the
    Computer's `installableRuntimes`; the same people as Upgrade). On the
    "not installed" chip's card in `components/machine/MachineRuntimeChips.tsx`
    (under Show all supported). A press reads the plan and shows its exact
    commands and the vendor's page; only the confirm runs it; OAR's manual
    steps are shown with no Install where it will not run them. The web sends
    the runtime id only (contract: `docs/contracts/runtime-auth.md` §6e).
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
  - `raft proc` jobs (contract: `docs/contracts/proc-jobs.md`):
    `useMachineProcJobs.ts` (GET …/proc-jobs while the Computer is online,
    every 30 s and on focus, paused while hidden; `unknown` is not "no jobs"),
    `MachineAgentProcJobs.tsx` (the Jobs line under an agent with jobs in
    `MachineAgentList`: a display-only raft-ui ListRow attached to the agent's
    row; Stop for `canControlComputer` viewers after a size-sm Dialog), copy
    in `procJobsCopy.ts` (`machine.procJobs.*`). Test:
    `tests/machineAgentProcJobs.behavior.test.tsx`.
- Add Computer's "The terminal shows a code? Enter it here." (a setup run
  over SSH shows a device code): `useAddComputerCode.ts` (held by
  `components/machine/AddMachineDialog.tsx`), `AddComputerCodeEntry.tsx` (the
  closed-by-default field under the command, then the approved/denied line),
  `AddComputerCodeReview.tsx` (the confirm screen and step-up in the
  command's place), `addComputerCode.ts` (which codes this window approves:
  `computer_attach` / `computer_migrate` whose servers include the window's
  server; anything else gets the device login page, the code never in its
  address). The calls, errors and confirm facts are the device login page's
  (`components/auth/useDeviceLoginApproval.ts`, `deviceLoginApproval.ts`,
  `DeviceLoginRequestDetails.tsx`, shared with `pages/DeviceLoginPage.tsx`).
  Copy: `machine.add.code.*`. Tests: `tests/computerAddByCode.behavior.test.tsx`.
- Add Computer's pairing (no code at all; contract
  `docs/contracts/computer-pairing.md`): `useComputerPairing.ts`, held by
  `AddMachineDialog` while the command is on screen. Creates a pairing for the
  window's server, renews it every 5 minutes, cancels it on close / a server
  change / leaving the command; the id only in this hook's memory and in the
  one-paste mac/Linux command (`… | sh -s -- --setup /slug --pair <id>`, via
  `utils/computerSetupCommand.ts` `pairingId`), never the plain `setup` form
  (an older installed raft-computer refuses it) nor Windows (no one-paste
  form). Learns of a linked request from `computer_pairing:requested` /
  `:voided` on the person's socket (matched by `pairingRef`), else a 10 s
  visible-only status read (`utils/visiblePoll.ts`); shows it with
  `useDeviceLoginApproval.show` on part A's confirm screen
  (`AddComputerCodeReview`, no Enter a different code), approved through
  `/computer-pairings/approve` (the request's `pairingId`). A conflict (the
  command ran more than once) drops any approve on screen, says so
  (`machine.add.pairing.conflict`) and shows a new command; expired or voided
  is replaced quietly; a failed create is today's command without `--pair`.
  Tests: `tests/computerAddPairing.behavior.test.tsx`.
- Shared here: `machineDetailClassNames.ts`, `machineDetailTypes.ts`,
  `computersRackLayout.ts` (the rack's column widths), `computersRackTypes.ts`,
  `useAgentsByMachine.ts`, `useOrderedMachines.ts`, `useComputerName.ts`,
  `accountText.ts`, `computersRackSort.ts` (the overview's sort: Name, each
  runtime's remaining quota (`rackRemaining`), Disk, Memory; the choice is
  `store/computersRackSortPreference.ts`, shared by the toolbar's Sort and the
  list's headings, raft-ui's `TableSortButton` in `RackListHeader.tsx`). No
  choice (the default, the Sort's "Needs attention first") is no sort: the
  `useOrderedMachines` order (this device, the viewer's own by
  `isMyComputer` in `components/layout/sidebarMachineOrder.ts`, the rest)
  with the computers needing attention moved first, stable within each part
  (`attentionFirst`, by `machineNeedsAttention` in
  `utils/computerUpgradeIndicator.ts`, the rule of the left rail's count;
  #triage:#527; this page only, the shared order is unchanged; this device
  stays pinned on top, `attentionFirst`'s `pinnedId`; the server's verdict
  wins over the web's own version check, so a row whose dot shows an update
  the server doesn't count keeps its place, as in the rail's count), no heading marked, and grouped, the groups holding
  the viewer's own first, attention first within each. A chosen sort wins.
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
