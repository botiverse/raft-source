# features/settings

Settings panels, one folder per tab. `components/settings/SettingsPanel.tsx`
is only the shell: the `SettingsPanel` component (named export), the tab switch and the layout (header,
mobile back, embed mode). It renders each tab from its folder here; nothing
here imports `SettingsPanel`. Tabs whose code is still all in
`components/settings/` (Theme, Server notifications, Providers, IM bridges,
Feedback) render from there.

- `shared/`: helpers more than one panel uses. `selectOptions.ts`
  (`SelectOption`, `getSelectMenuOptions`), `renderSelectItems.tsx` (the
  raft-ui Select rows for those options), `inviteRecords.ts` (`PendingInvite`,
  `JoinLinkRecord`, the invite API rows) and `DangerActionRow.tsx` (a danger
  zone row, a ListRow in its own ListRowGroup: title, consequence, a red or
  warning button; Server's Delete Server and Leave Server, Account's Delete
  Account).
  Account and Administration draw their settings as raft-design Forms › A
  setting's row: per section one ListRowGroup of `plain` ListRows (a short
  control at the row's end, under the text below 32rem of the group's width;
  a select of names or phrases under the text). A row may hold a small form
  saved together with one button (create an invite link, add an owner or
  admin, the change-password form in the row under Change password); a card
  of its own is for a multi-field form with its own Save (the profile, the
  pre-join agreement, SSO). What comes and goes beside a switch (a warning)
  and a section's own failure go under its group, so the row and its switch
  don't move. A setting that applies at once says nothing when it is stored;
  only a failure shows, on its SaveStatus line under the description (or the
  title when the row has none), growing the row until the next change
  (`ImmediateSaveStatus`, `ImmediateSwitchRow`, `ImmediateRowSwitch` in
  `components/settings/ImmediateSetting.tsx`; raft-ui 0.84). A row that
  belongs to the setting above it (quiet hours' times, a server's customized
  channels, the font size's preview) is `ListRow attached`, with `role="group"`
  and `aria-labelledby` that setting's title; a section may hold more than one
  group, by topic, in a `stack-y-3` column (Appearance), and says where its
  settings are stored once, not per row.
  `useScrollToSettingsSection.ts` (SettingsPanel calls it: `/settings/<tab>#<id>`
  opens the tab scrolled to the element with that id, waiting up to 5s for a
  section that renders after its data loads, and marks it located with
  `utils/locateElement.ts`; a jump from the keyboard also moves focus to it).
  Give a section a stable `id` to make it linkable.
- `search/`: Search settings, the field on top of the settings list (raft-design
  settings.md#searching-settings). `SettingsSearch.tsx` (deferred: rendered by
  `features/sidebar/Sidebar.tsx` through `DeferredSettingsSearch.tsx`, which
  draws `SettingsSidebarList` itself, outside the Suspense, so the rows stay the
  same elements when the chunk arrives; desktop sidebar and the phone's
  Settings page; results, No match with Search everywhere, and
  ⌘F / Ctrl+F, listed in `keyboard-shortcuts/keyboardShortcutList.ts`);
  `settingsSearchMatch.ts` (pure: NFKC matching and result order);
  `settingsSearchCopy.ts` (the shared index,
  `@botiverse/raft-shared/src/settingsSearch.v1.json`, and the web's catalog ids
  for each setting's name, description and section); `useSettingsSearchSettings.ts`
  (the settings this person can see: the list's pages, less what a page hides for
  them; SSO by the section's own read, `sso/useServerSsoShown.ts`); `settingsSearchStore.ts` (the query: kept inside Settings on one
  server, so a phone's Back returns to the results; leaving Settings or
  switching server clears it, `useSettingsSearchLifetime`, also called by
  SettingsPanel). Every setting the index lists for the web has
  `id="<its id>"` on its row, once on its page (`tests/settingsSearchAnchors.test.ts`
  lists the file of each). ⌘F / Ctrl+F works on `/settings` pages only.
- `administration/`: Settings › Administration. Entry
  `AdministrationTabContent.tsx`; one file per section (`AdminsSection`,
  `SystemChannelsSection`, `InvitesSection`, `JoinLinksSection`,
  `PreJoinAgreementSection`, `OnboardingAgentSection`,
  `ServerTranslationSection`, `MemberPermissionsSection`,
  `ContextViewGrantsSection`: owners and admins, behind
  `agent_context_view_v0`, list and revoke which agents may read other
  agents' context, and grant it in `GrantContextViewDialog`, calls in
  `contextViewGrantsApi.ts`), plus
  `administrationVisualSections.ts` (`ADMINISTRATION_VISUAL_SECTIONS`, the
  sections in tab order, for visual cases and tests), `showUndoToast.ts`,
  `buildJoinLinkUrl.ts` and `renderPrincipalAvatar.tsx`. The rows
  `AdminPrincipalRow`, `PendingInviteRow` and `JoinLinkRow` and
  `WorkspaceProductAnalyticsSection` (`UsageDataSettings`) are still in
  `components/settings/`.
  - Stores: `serverStore` (current server, members and roles, settings),
    `agentStore` (agents, the onboarding agent), `channelStore` (`#all`
    visibility), `translationStore` (server translation).
  - APIs: `/servers/:id/invites`, `/servers/:id/join-links`,
    `/servers/:id/agreement`, `/servers/:id/setup-projection`,
    `/servers/:id/onboarding-settings`, `/servers/:id/setup-transition`,
    `/servers/:id/agent-context-view-grants`; role,
    profile and translation changes go through the stores.
- `server/`: Settings › Server. Entry `ServerTabContent.tsx`; `ProfileSection`,
  `PublicVisibilitySection` (with `PublicChannelList` and
  `publicVisibilityUiReducer.ts`), `DangerZoneSection` (with
  `shared/DangerActionRow`). The archived channel, joint channel and agent sections
  and `DeleteServerConfirmDialog` are still in `components/settings/`.
  - Stores: `serverStore` (profile, avatar, leave, server list refresh) and the
    `public_server_v0` feature flag.
  - APIs: `/servers/:id/public-visibility`, `/servers/:id/public-search`.
- `account/`: Settings › Account. Entry `AccountSection.tsx` (profile card,
  password, connected accounts, then passkeys, two-step verification, apps,
  Share usage data (`components/settings/UsageDataSettings`), sign-out and
  Delete Account, last); `AccountSignOutSection.tsx`;
  `AppLoginsSection.tsx` (Apps signed in to with the Raft account, RFC 079
  phase 3a: one `AppLoginRow.tsx` each with Revoke → confirm; renders only
  while `GET /me/app-logins` lists one; calls in `appLoginsApi.ts`);
  `SocialProviderIcon.tsx` (the provider marks `ProviderAccountRow` shows);
  `DeleteAccountSection.tsx` opening Account's
  level-2 page Delete Account, `/s/<slug>/settings/account/delete`
  (SettingsPanel reads the route's rest: on desktop the title is the
  breadcrumb "Account › Delete Account", `components/settings/SettingsSubPageTitle.tsx`,
  the tab muted and linking back; on a phone the plain title and Back to Account;
  the App's in-app WebView opens it with `embed=raft-settings-v1&shell=host`):
  `DeleteAccountPage.tsx` holds the flow; `AccountDeletionChecklist.tsx` the
  v7 list (one Card, a row per thing, "now → after": `AccountDeletionChecklistRow.tsx`):
  Needs action, what holds the deletion up: `SoleOwnerTransferRow.tsx` per
  server to hand over, then `OthersAgentsOnComputers.tsx`, other members'
  agents on the person's computers (#triage:d10ace06: the request revokes the
  computers' keys at once, so they have to leave first). Only their owner can
  move one; the row's one action is Notify Owner to Move It (Raft sends the
  owner a system message, at most once a day per agent: GET's and the 409's
  `ownerNextNotifyAt` says when the next may go; Notify All for more than one), and its line says who else can act: the server's owner or an
  admin can delete an ordinary agent, or on Pro move it; another member's
  personal assistant (`personalAssistant`) only its owner can move, or an admin
  delete once that owner has left (`owner: null`: nobody to notify, the button
  stays off). The notify controls, their state and the wire shapes are shared
  with Delete Computer (`features/computer/AgentOwnerNotifyActions.tsx`,
  `useAgentOwnerNotify.ts`, `othersAgentsApi.ts`).
  A row goes once GET stops listing its agent; the page reads the list again
  after each action and on focus. The other way on is Force Unbind and
  Request Deletion: `features/computer/ForceUnbindAgentsDialog.tsx` confirms
  the list, and the request (each step of it, the proof's too) carries it as
  `forceAgentIds`; a 409 `others_agents_on_computers` then means more agents
  arrived, nothing was unbound, and a line asks to confirm again. The rest happens by
  itself: servers that close, the person's agents (`accountDeletionAgentGroups.ts`
  groups them per computer of theirs, then per server; `AccountDeletionAgentRow.tsx`
  says who gets them and offers the optional Move to Another Computer, Pro only,
  with the existing `AgentMigrationDialog` on the current server or Delete Account
  on the agent's server with `?move=<agentId>`, and Archive), billing that stops;
  then Learn more, the red button with the reason it's off, and how to cancel.
  The person's own agents and computers don't block (#12468) and the page has
  no Disconnect. The server checks both again at submit time (409
  `sole_owner_servers`, then `others_agents_on_computers`, whose `agents` stand
  for that group until the read it starts lands).
  `DeleteAccountVerifyDialog.tsx` is the proof
  the server's `methods` ask for (`VerifyItsYouDialog`, the password or an
  emailed code), a small centred dialog;
  the confirmation whose OK signs out is `pages/AccountDeletionRequestedPage.tsx`,
  which, like the pending page, stands in for the whole shell
  (`pages/AccountDeletionGate.tsx`, frame and heading `pages/AccountDeletionFrame.tsx`).
  The email's cancel link, `/?cancel_account_deletion=<token>`, lands on
  `pages/AccountDeletionCancelLinkPage.tsx` (App.tsx, before the shell; acts on a
  click only; the proposed server contract is in `accountDeletionApi.ts`).
  `deleteAccountFlow.ts` (outcome, failure copy, sign-out) and
  `DeleteAccountSignInAgainBanner.tsx` are shared by the page and the dialog;
  `accountDeletionApi.ts` holds the calls (`/me/account/deletion`, and for a
  transfer `GET /servers/:id/members` and `PATCH /servers/:id/members/:userId`,
  for an agent's optional archive `DELETE /agents/:id`, each with that server's
  `X-Server-Id`; `POST /me/account/deletion/notify-agent-owners`, proposed
  with Archer's server PR; the cancel link's proposed `POST /auth/account-deletion/cancel`). The pending-deletion page is
  `pages/AccountDeletionPendingPage.tsx` (Cancel Deletion then loads Settings ›
  Account, `pages/accountDeletionReturn.ts`: the address's server, else the last
  location saved by `hooks/useLastLocationResume.ts`, which never saves the
  Delete Account page; an App's sign-in, `/login/app?request=<uuid>`, goes back
  to that confirmation instead), which App shows through
  `pages/AccountDeletionGate.tsx` from `store/accountDeletionPending.ts`; the
  API client sets that on any 403 `account_deletion_pending`. Its copy is the
  `accountDeletion.*` block of each catalog. The answer state and failure copy
  the second-step dialogs share (`useAnswer`, `useFailureCopy`) are
  `components/settings/secondFactorAnswer.ts`. `ProviderAccountRow`,
  `PasskeysSection`, `TwoStepVerificationSection`, `SettingsProfileCard` and
  `secondFactorStepUp` are still in `components/settings/`.
  The profile card's avatar is the way to change it
  (`components/member/HumanAvatarEditMenu.tsx`, also on your own profile and
  at account setup): Upload a photo, Build an avatar
  (`HumanAvatarBuilderDialog.tsx`, docs/contracts/human-pixel-avatar.md; only
  while `human_avatar_builder_v0` is on for the current server). No Remove:
  an avatar is changed by uploading or building another (product decision).
  - Stores: `authStore` (user, `updateProfile`, `uploadAvatar`, `logout`),
    `useAuthProviders`; Raft Desktop links through `utils/desktopOAuth`.
  - APIs: `GET /auth/identities`, `POST /auth/:provider/link/start`,
    `DELETE /auth/identities/:provider`, `POST /auth/forgot-password`;
    `/me/account/deletion` (GET, POST, DELETE, POST `/email-code`), and
    another server's `GET /servers/:id/members` and
    `PATCH /servers/:id/members/:userId` for Delete Account's transfers,
    `DELETE /agents/:id` for its optional Archive, `POST
    /me/account/deletion/notify-agent-owners` for its Notify Owner (the POST
    request's optional `forceAgentIds` for Force Unbind); signed out, the cancel link's
    `POST /auth/account-deletion/cancel` (proposed); `GET /me/app-logins` and
    `DELETE /me/app-logins/:clientId` (always 204).
- `notifications/`: Settings › Notifications. Entry
  `NotificationsTabContent.tsx` (`PwaInstallSettingsCard`, then
  `components/settings/notifications/NotificationSettingsSection`, then
  `ServerNotificationsLink.tsx`, the way to this server's own level).
  - Stores: `serverStore`, `notificationSettingsStore`.
- `language-region/`: Settings › Language & Region. Entry
  `LanguageRegionSection.tsx`; `publicTranslationSettingsContext.ts` (the
  public server page's context, a SettingsPanel prop).
  - Stores: `translationStore` (settings and each preference), `serverStore`;
    the display language through `i18n/LocaleProvider` and
    `persistDisplayLanguage`.
- `labs/`: Settings › Labs. Entry `LabsTabContent.tsx` (behind the
  server-labs UI flag); `LabsSection.tsx`.
  `ServerLabRow` is still in `components/settings/`.
  - Stores: `serverLabsSettingsStore`, `serverFeatureFlags`, `serverStore`.
  - APIs: `GET /servers/:id/labs` (through `serverLabsSettingsStore`),
    `PATCH /servers/:id/labs/access`, `PUT /servers/:id/labs/:key`.
- `billing/`: Settings › Plan & Billing. Entry `BillingTabContent.tsx`
  (`viewBilling` gate); `PlanSection.tsx`, `PlanBillingLoadingSection.tsx`,
  `DowngradeWarningCard.tsx` and the `usePlanBillingDraft.ts` hook. The page
  itself, `PlanSectionContent`, is still in `components/settings/`.
  - Stores: `serverStore` (usage, billing); `analytics/billingEntry`.
- `appearance/`: Settings › Appearance. Entry `AppearanceSection.tsx` (with
  its preview message fixtures); `ServerThemeLink.tsx` (the way to the
  server's Theme tab, `components/settings/ServerThemeSection`);
  `ComposerSendKeySetting.tsx` (Message box: Enter or ⌘/Ctrl+Enter sends,
  saved on the account; logic in `features/composer/composerSendKey.ts`).
  - Stores: `appearanceStore`, `serverStore`.
- `about/`: Settings › About. Entry `AboutSection.tsx` (version and source
  link, desktop and mobile downloads, workspace). The Feedback tab is
  `components/settings/LazyAboutFeedbackDialog.tsx`.
- Settings › Shared links (`shared-links/`) was removed with Share to X on
  2026-11-09; `/settings/shared-links` falls back to Account like any unknown
  tab. Existing public share links: docs/contracts/share-artifacts.md.
- A panel's own logic belongs to its feature: Settings › Applications renders
  `features/apps/IntegrationsSection.tsx`, and the App parts live in
  `features/apps/connected-apps/`.
- `shared/` keeps no state and calls no API.
- Tests live in `packages/web/tests/` (`settings*`, plus each panel's own:
  `serverAdmin.i18n`, `settingsAdministration.contract`,
  `settingsImmediateApply`, `serverSetupSettingsReopen`, `settingsSubBatchG`,
  `settingsAdministrationRows` (the sections' rows),
  `publicVisibilitySettings`, `serverManagementConfirmDialog`,
  `archivedChannelsSettings`; Account: `accountIdentity*`, `passkeysSettings`,
  `twoStepVerification*`, `secondFactorSensitiveStepUp`, `accountDeletion`,
  `wellKnownChangePassword`; Billing: `billingEntry`, `billingSummary`,
  `desktopBillingReturnUrl`; Appearance: `publicSettingsAppearance`,
  `composerSendKeySetting` (in `features/settings/tests/`),
  `sidebarSectionContextMenu`; Search: `settingsSearch`, `settingsSearchMatch`,
  `settingsSearchAnchors`, `settingsSectionLink` (in `features/settings/tests/`);
  About: `desktopDownload`,
  `mobileAppSettingsSection`; Labs: `serverLabsSettings`; Language & Region:
  `settingsLanguage.i18n`, `displayLanguageLoop`, `timeFormatting`). Run named
  files with `pnpm --filter @botiverse/raft-web test:dom <files>`.
