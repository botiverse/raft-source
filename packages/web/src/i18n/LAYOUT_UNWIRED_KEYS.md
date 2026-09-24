# layout namespace — unwired-key ledger

Inventory accounting for the `layout` namespace of PR #3874 (`b41c72b4f`).

    146 canonical rows = 101 migrated to `layout.*` + 8 reused from `settings.tabs.*` + 37 dispositioned below

These 37 rows are deliberately NOT added to the catalogs. An id whose call site
no longer exists is unverifiable dead copy: the DOM behaviour teeth in
`tests/layoutNamespace.i18n.behavior.test.tsx` can only bite on copy that some
component actually renders, so adding these would ship translations that nothing
proves correct and nothing keeps correct. The reviewer therefore required each
one to be dispositioned here rather than added.

(No automated gate enforces this. `tests/i18nMessages.test.ts` checks only that
every locale's key set is exactly equal to `en`, and that zh-cn values are
non-empty strings — it never scans call sites, so it can neither detect nor
punish an unread key. The earlier version of this file claimed otherwise; that
claim was wrong.)

## How dispositions were decided

By **semantic surface / key ancestry**, not by byte-matching the #3874 English
against current source. The question for each row is: *does the UI element this
copy served still exist, even if its text changed?* Byte-matching gets this
wrong in both directions — copy that drifted in case, punctuation or wording
reads as "deleted" while its surface is still shipping, and unrelated **comment**
text reads as "still live".

Ancestry for the `onboarding.*` rows was recovered by reading the deleted wizard
itself (`18f736e98^:packages/web/src/components/layout/OwnerOnboardingModal.tsx`,
removed by task #164) and the #3874 catalog's own step-grouping comments
(`b41c72b4f:packages/web/src/i18n/catalog/layout.ts`), then locating each step's
successor in `src/components/onboarding/`.

Dispositions: `retired/deleted` (the element itself has no successor) ·
`renamed/current source` (the element survives; its copy and/or its owning
component changed — evidence cites the current source) ·
`namespace_transfer_member` (copy lives on, owned by the `member` namespace
batch — do NOT migrate under `layout.*`) · `deferred_machine` (blocked on
`machine` namespace language review).

| key | English (b41c72b4f) | disposition | evidence |
|---|---|---|---|
| `onboarding.completeTalkDirectly` | Talk to them directly | `retired/deleted` | complete-step bullet list. Its successor screen (`onboarding/ServerSetupHandoffStep.tsx`) renders no list at all — heading L71, one body paragraph L79-81, one button L96. No successor element anywhere in `components/onboarding/`. |
| `onboarding.completeHandTasks` | Hand them tasks | `retired/deleted` | same deleted bullet list as `completeTalkDirectly`; `ServerSetupHandoffStep.tsx` has no list element. |
| `onboarding.completeCorrect` | Correct them when they miss | `retired/deleted` | same deleted bullet list as `completeTalkDirectly`; `ServerSetupHandoffStep.tsx` has no list element. |
| `onboarding.completeOutro` | Ask for what you need. They'll come back when they need you. | `retired/deleted` | the closing line that followed the bullet list. `ServerSetupHandoffStep.tsx` renders exactly one body paragraph (L79-81, the `completeIntro` successor) and no second paragraph. |
| `onboarding.dontRemind` | Don't remind me again | `retired/deleted` | the wizard-footer opt-out checkbox (`OwnerOnboardingModal.tsx:1152`). The blocking setup surfaces render no opt-out control: `SetupSessionFooter.tsx` offers only "Switch server", `ServerSetupSurveyStep.tsx` is mandatory (submit disabled until both answers). Near miss, deliberately not counted: `NotificationActivationBanner.tsx:244/272` dismisses with `aria-label="Hide notification reminder for this session"` — a session-only hide with its own copy, not a persisted "don't remind me again" preference. |
| `onboarding.failedSavePreference` | Failed to save your preference. | `retired/deleted` | error path of `persistCurrentStepOptOut` (`OwnerOnboardingModal.tsx:517/546`), i.e. the same opt-out mechanism as `dontRemind`. No successor: nothing in `components/onboarding/` persists a per-step preference. |
| `onboarding.failedSaveInviteStep` | Failed to save invite step. | `retired/deleted` | error for persisting the wizard's **invite step** state. The setup projection has no invite surface at all — `serverSetupProjection.ts:5` enumerates `"none" \| "computer_runtime" \| "create_agent" \| "complete" \| "retry"`. The invite *copy* moved to the member dialog (rows below); the step-state element did not survive. |
| `onboarding.skip` | Skip | `retired/deleted` | the wizard footer's Skip button (`OwnerOnboardingModal.tsx:1167`). No skip control exists in the successor flow: `SetupSessionFooter.tsx` renders only "Switch server", the survey step has no skip, and `ServerSetupComputerRuntimeStep.tsx`'s `"skip"` is an internal motion-reducer action (L30/45/57), not a rendered control. **Corrects a false hit:** the previous evidence pointed at `Sidebar.tsx`, which contains "Skip" only in a code comment (L1496, `// Skip if useLongPress already opened the menu`). |
| `sidebar.cindyExistsTitle` | Cindy already exists in this server | `retired/deleted` | the disabled-state title on the sidebar's "Create Cindy" entry. That entry was removed on purpose — see the standing comment at `Sidebar.tsx:147-152` ("Create Cindy no longer lives in this menu… A second entry point here only asked people to make a decision the product does not want them thinking about"). `CreateAgentDialog.tsx` has no already-exists guard or disabled title to inherit it. |
| `onboarding.addComputer` | Add Computer | `renamed/current source` | current source: `onboarding/ServerSetupComputerRuntimeStep.tsx:282` — `"Connect a computer"` (with the returning-user arms "Start your computer" / "Start one of your computers"). The step's primary no longer opens `AddMachineDialog`; the connect guide is rendered inline. |
| `onboarding.createFirstAgent` | Create First Agent | `renamed/current source` | current source: `agent/CreateAgentDialog.tsx:1169` — `"Create Cindy"`, rendered as the setup flow's `create_agent` surface (`onboardingShell="step"`, L1175). The intermediate wizard button is gone; the first-agent primary action is now the dialog's own submit. |
| `onboarding.submit` | Submit | `renamed/current source` | current source: `onboarding/ServerSetupSurveyStep.tsx:151` — `"Continue"`. The referral-source step's successor is the survey step (it still asks "How did you hear about Raft?", L125); its submit was reworded. |
| `onboarding.failedSaveAnswer` | Failed to save your answer. | `renamed/current source` | current source: `onboarding/ServerSetupSurveyStep.tsx:97` — `"Couldn't save your answers. Try again."` Same save-failure banner on the same question, reworded and pluralized. |
| `onboarding.runtimeRequired` | (runtimeList) => `Need an agent runtime installed — ${runtimeList}.` | `renamed/current source` | current source: `onboarding/ServerSetupComputerRuntimeStep.tsx:377-379` — `"No usable runtime yet"` / `"Install one of these on this computer, then hit refresh next to Runtime."` The interpolated `runtimeList` became the rendered `RuntimeRow` list below it (L387-410). |
| `onboarding.enableNotifications` | Enable Notifications | `renamed/current source` | current source: `message/NotificationActivationBanner.tsx:255` and `:266` — `"Enable notifications"`. The enable-notifications step was replaced by this banner (see the task-#164 removal commit `18f736e98`: "Notification permission is already handled by the shipped… flow (tasks #20/#24), not the wizard"). Case-only drift is exactly what byte-matching missed. |
| `onboarding.enablingLabel` | Enabling… | `renamed/current source` | current source: `message/NotificationActivationBanner.tsx:255` and `:266` — same button's busy arm. |
| `onboarding.pushUnsupported` | This browser does not support web push notifications. | `renamed/current source` | current source: `settings/SettingsPanel.tsx:1291`, rendered under `permission === "unsupported"` — and **already migrated** as `settings.notifications.unsupportedHint` ("This browser does not support service worker push notifications."). The banner never renders an unsupported arm (it returns null unless `permission === "default"`), so Settings › Notifications is where this element lives now. Nothing further to do for this row. |
| `onboarding.completeIntro` | One thing: agents here have persistent identity across channels. They remember. Work with them like teammates: | `renamed/current source` | current source: `onboarding/ServerSetupHandoffStep.tsx:79-81` — "Your server is set up. {agentName} is waiting in your channel. She'll show you around Raft and get you working for real." The complete step's body paragraph survives on the handoff screen (rewritten); it is still un-migrated English. |
| `onboarding.joinCommunity` | Join Community | `renamed/current source` | current source: `ui/ServerSwitcherMenu.tsx:266` — `"Join Community"`, verbatim. #3874 filed it under `onboarding.*`, but the live owner is the server switcher. |
| `onboarding.joiningLabel` | Joining… | `renamed/current source` | current source: `server/CommunityAgreementDialog.tsx:84` — the submit button's busy arm (`{submitting ? "Joining…" : "Agree & Continue"}`). |
| `sidebar.addChannel` | Add channel | `renamed/current source` | current source: `layout/Sidebar.tsx:1768` — `const label = isJoint ? "Create joint channel" : "Create channel"`, used as the section `+` button's `aria-label` and `title` (L1773-1774). The add-channel control survives; its accessible name was reworded and the popover it used to open was collapsed into a direct dialog open. **Corrects a false hit:** the previous evidence pointed at `ui/MenuItem.tsx`, which contains "Add channel" only in a doc comment (L9). |
| `sidebar.createCindy` | Create Cindy | `renamed/current source` | current source: `agent/CreateAgentDialog.tsx:1169` — `"Create Cindy"`, verbatim. The sidebar menu entry was removed (`Sidebar.tsx:147-152`); the action moved onto the dialog's own submit button. |
| `onboarding.inviteByEmail` | Invite by Email | `namespace_transfer_member` | live at `member/InviteHumanDialog.tsx:170`; #3874 assigns that dialog to `member` |
| `onboarding.invitePlaceholder` | name@company.com | `namespace_transfer_member` | live at `member/InviteHumanDialog.tsx:181` (email input `placeholder`) |
| `onboarding.inviteOr` | OR | `namespace_transfer_member` | live at `member/InviteHumanDialog.tsx:189` (`<span>OR</span>` divider) |
| `onboarding.inviteLink` | Invite Link | `namespace_transfer_member` | live at `member/InviteHumanDialog.tsx:195` |
| `onboarding.preparingInviteLink` | Preparing invite link… | `namespace_transfer_member` | live at `member/InviteHumanDialog.tsx:199` (loading arm) |
| `onboarding.inviteLinkUnavailable` | Invite link unavailable | `namespace_transfer_member` | live at `member/InviteHumanDialog.tsx:199` (empty-link arm) |
| `onboarding.copyInviteLink` | Copy invite link | `namespace_transfer_member` | live at `member/InviteHumanDialog.tsx:206` (copy button `title`) |
| `onboarding.inviteLinkHelp` | Send this link to your teammates to join the server. | `namespace_transfer_member` | live at `member/InviteHumanDialog.tsx:215` |
| `onboarding.sendInvites` | Send Invites | `namespace_transfer_member` | live at `member/InviteHumanDialog.tsx:233` as `"Send invites"` — case drift only. Previously mis-filed `retired/deleted` by byte-matching. |
| `onboarding.sendingLabel` | Sending… | `namespace_transfer_member` | live at `member/InviteHumanDialog.tsx:233` (same button's busy arm) |
| `onboarding.enterAtLeastOneEmail` | Enter at least one email, or copy the invite link. | `namespace_transfer_member` | live at `member/InviteHumanDialog.tsx:97` as `"Enter at least one email, or copy the invite link above."` — wording drift only. Previously mis-filed `retired/deleted`. |
| `onboarding.failedPrepareJoinLink` | Failed to prepare join link. | `namespace_transfer_member` | live at `member/InviteHumanDialog.tsx:71` as `"Failed to prepare join link"` — punctuation drift only. Previously mis-filed `retired/deleted`. |
| `onboarding.failedSendInvites` | Failed to send invites. | `namespace_transfer_member` | live at `member/InviteHumanDialog.tsx:115` as `"Failed to send invites"` — punctuation drift only. Previously mis-filed `retired/deleted`. |
| `leftRail.computerUpgradeAvailable` | A managed Computer has an upgrade available | `deferred_machine` | live as the Computers rail-tab dot title, `layout/LeftRail.tsx:86` — `` `Computers need attention: ${counts}` ``, where counts come from `utils/computerUpgradeIndicator.ts:61-70` ("N needs/need upgrade" · "N offline"). Blocked: the same helper file emits `Computer offline` / `Computer status` (`:79-80`), which are `machine`-namespace copy with no approved zh. |
| `sidebar.computerUpgradeAria` | (version) => `Computer upgrade available${version ? `: v${version}` : ""}` | `deferred_machine` | live at `utils/computerUpgradeIndicator.ts:77`, rendered as a `title` by `layout/Sidebar.tsx:460` and `machine/MobileComputersPanel.tsx:143`. Blocked: `getComputerAttentionTitle` (`:72-81`) returns this arm alongside `Computer offline` / `Computer status`, which have no approved zh. |

## Totals

- `retired/deleted`: 9
- `renamed/current source`: 13
- `namespace_transfer_member`: 13
- `deferred_machine`: 2

9 + 13 + 13 + 2 = **37**, so `146 = 101 migrated + 8 reused + 37 dispositioned`
still holds. Only the distribution changed when the byte-matched dispositions
were redone by semantic surface.

**Handoff:** the `namespace_transfer_member` rows are claimed by the future
`member` namespace batch — all 13 are live in `InviteHumanDialog.tsx` today, so
that batch must not treat any of them as dead. `deferred_machine` rows unblock
when `machine` zh is language-owner reviewed; `computerUpgradeAria` must be
migrated together with the `Computer offline` / `Computer status` arms of
`getComputerAttentionTitle`, never split. The `renamed/current source` rows are
not owned by this batch either: they point at un-migrated English on surfaces
outside `layout.*` (onboarding setup steps, the notification banner, the create
agent dialog), which whichever namespace claims those files will extract.

## Post-#3874 copy added by this branch (outside the 146)

`layout.sidebar.sectionOptionsAria` — en `{section} options`, zh-cn `{section}选项`.

NEW copy, not a #3874 row: the b41c72b4f catalog has no options-aria key, so this
id is **not** counted inside the 146 and does not change the accounting above.
Language-owner approved 2026-07-22.

It exists because `Sidebar.tsx`'s section context menu built its accessible name
by concatenation — `` `${formatMessage(sectionLabelId)} options` `` — which under
zh-cn produced the mixed-language DOM string `aria-label="频道 options"`. A single
ICU message with a `{section}` argument is the fix: the catalog owns word order
and spacing (the zh arm has no space before 选项), instead of the call site
hard-coding English order. Pinned by
`tests/layoutNamespace.i18n.behavior.test.tsx` — "the Sidebar section context
menu exposes a fully-Chinese accessible name under zh-cn".
