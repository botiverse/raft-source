# features/apps

The server's Apps (OAuth Apps and MCP Apps). The Apps page (`/apps`) and
Settings › Applications both show them. Settings imports from here; nothing
here imports `SettingsPanel` or another panel. What this folder still imports
from outside it, until each piece finds its home:

- App parts still in `components/settings/`, moving here later (the list
  below).
- Shared modules that are not App parts and stay where they are:
  `secondFactorStepUp` (any sensitive action's step-up), `LinkPreviewConsents`
  (also Settings › Privacy), `SettingsSegmentedControls` (the
  `ConnectedAppsTab` type) and `features/settings/shared/renderSelectItems`.
  The two feature folders import each other's shared helpers, never each
  other's panels.

- `IntegrationsSection.tsx`: the entry. The server's Apps in two scopes,
  Yours and Discover, as one component; the Apps page renders it with
  `variant="page"` (`components/apps/AppsPage.tsx`), Settings › Applications
  with the default `variant="settings"` (the same lists and cards; Add in the
  section header, no Discover count, no link-preview row). Members have no
  Discover (R15): their page is Yours alone, read-only, with no scope switch,
  and a link's `?tab=discover` shows them Yours. The scope is local
  state; a link may name it with `?tab=` (`appsScope.ts`: `yours`,
  `discover`, and the old `installed`, `myapps`, `marketplace`), and the
  links below and `?permission_updates=1` open Yours. `?tab=` is used once
  (`useAppsScopeLink.ts`): applied, then removed from the address in one
  replace with the other parameters kept, so a later address change (a
  profile opening adds `?profile=`) never puts the page back on the link's
  scope. Beside `?app_bot=` or `?installed_app=` it leaves in
  `useAppBotLink`'s replace, not its own.
- Yours (`yoursApps.ts`, `YoursAppsList.tsx`): every App this Server has,
  once each: today's installed Raft Apps, the connected services, then the
  Raft Apps built here that aren't installed (the old Developer list's
  rest), those that need someone first (`compareAppViews`), otherwise that
  order. `buildYoursApps` maps each to an `AppView` and keeps the record
  today's rows and dialogs take; an App built here gets its review state from
  the merged flags of today's list (the clients row alone doesn't carry the
  permission and text flags). An App built here names its maker on its card
  ("Internal · made by") when `serverStore.members` has them
  (`appMakerNames`; no request of its own), and says "Internal" alone when
  they left. The toolbar has the search and one filter,
  where the App came from (`AppsFilters.origin`); Category is
  Discover's. No scope names an App type (no Type filter) or has a Sort. Apps are cards only, `AppCard` (no grid/list switch, no
  stored view preference; the old rows are gone). A card opens what the row opened: an installed Raft
  App's detail (everyone), a connected service's editor and the editor of an
  App built here and not installed (App managers only; for anyone else the
  card is not a button). A card has no Edit or Uninstall: the installed
  detail has Edit (an App built here), Uninstall (another Server's App) and
  the App's homepage.
  Pictures: the `screens.apps.yours.*` visual cases
  (`visual-testing/AppsYoursCases.tsx`).
- Discover (`DiscoverAppsList.tsx`, `discoverListings.ts`): pages of
  `GET /integrations/marketplace/listings` (Category and search are the
  server's, its own order, Load more by cursor), each listing as `AppCard`
  in `variant="discover"` (`listingView`): Add, or Added; no state. R41
  (`useDiscoverDetail.ts`): a card opens the App's details, for everyone. A
  Raft App opens its Marketplace detail (`MarketplaceListingDetail.tsx`,
  added or not: its publisher's text review and its Danger zone are there),
  with Add at the head's top-right for App managers while it isn't added. A
  connected service this Server has opens its editor for App managers, as
  its Yours card; one not added (or any for someone who can't open its editor)
  opens what Raft's listing says (`DiscoverServiceDetail.tsx`, R40:
  description, who makes it, Information; no Tools, the listing has none
  before a sign-in; no Try asking, the listing has no examples). The card's
  own Add adds without the details: a connected service is made from the
  listing at once (its editor opens on its accounts, where its account is
  picked); a Raft App opens its install confirmation
  (`MarketplaceInstallConfirm.tsx`: the permissions installing approves,
  "Also add @bot to …", its agent text with the consent flag on, then Add),
  the same set and the same install as the details' Add. Whether a Raft
  App's listing is open as its details or as that confirmation is one state
  (`listingDialog`, `{ kind: "detail" | "confirm", listing }`), so a later
  open (a link's `?marketplace_app=`) is always its details. One connected
  service is added at a time: its card's Add (and its details' Add) says
  Adding… and takes no press, and every other Add, Recommended's too, is
  disabled meanwhile. A failure shows where its Add was pressed (raft-design
  Feedback, errors by scope): under the card's text (raft-ui `SaveStatus`,
  until the next Add) or in the details' banner (only that dialog's own
  Add's error, gone when it closes), never in the page's banner.
  The details are today's centred dialog (`ConnectedAppDetailModal`, whose
  `actions` slot holds Add), the same container Yours opens: the side panel
  with Expand (raft-design #1300) is the details PR's. Pictures: the
  `screens.apps.discover.*` visual cases (`visual-testing/AppsDiscoverCases.tsx`).
- `useInstalledAppBot.ts`: adding or removing an installed App's bot (the
  installed detail's banner, bot section and remove confirmation).
  `useAppBotLink.ts`: the bot add link an App sends
  (`/s/<slug>/apps?app_bot=<client_id>`, #proj-apps:#35). It opens that
  installed App's detail on its bot section. For a client_id that isn't
  installed here, known or not, it shows one notice. The same hook handles
  `/s/<slug>/apps?installed_app=<app id>` (an App bot's profile naming its
  App, `features/agent/useManagedAppDetailLink.ts`): the App's row id, which
  the agent profile's `managedByApp.clientId` carries, never the client_id.
  It opens that installed App's plain detail, as its card does; when nothing
  matches, nothing opens and no notice shows (that would tell a crafted link
  whether a private App exists). Both parameters, and a `?tab=` beside them,
  leave the address in one replace, the other parameters kept.
  `useMarketplaceBotHint.tsx`: the Marketplace's hint for an installed App's
  undecided (`pending`) bot (#proj-apps:#35 layer 2), in its listing's
  Posts as row (Discover's cards have no slot for it; the installed detail
  has the bot's banner): the same add for owners and admins, who can add it
  for members. Matched by the App's id (`listing.app.id`); the listing's own
  id is opaque.
- Discover's "Recommended for {server}" (`components/apps/AppsRecommendedSection.tsx`):
  the App ids in `components/apps/appsRecommendations.ts` (Stamp only, by
  client ID `stamp` and `official`, never by name), shown at the top of
  the page's Discover (so never to a member), with no search or filter on,
  while the Marketplace lists one for this Server and it isn't installed, as
  the same `AppCard` as the list, with no line saying why (R26): the card
  opens its details, its Add the install confirmation. While it shows, the
  list under it has its own "All apps" heading (`AppsSectionHeading`, an
  `h3` under the page title's `h2`). A Server where a person uninstalled the
  App is not recommended it again: the record's `uninstalledHereAt` (when a
  person on this Server last uninstalled the App, or null; kept after a
  reinstall, so it is read together with `installedAt`) drops it from the
  section, and the Marketplace still lists it. Add
  a recommendation there.
- `useOwnServerCardButtons.ts`: the App editor's Card buttons section for an
  App made on this Server (RFC 076 §17): reads
  `GET /integrations/clients/:id/action-endpoint` while the editor is open,
  allows the endpoint in force (`PUT .../own-server-actions`, the URL exactly
  as shown; a 409 for a changed one reads it again) and revokes it
  (`DELETE`). `connected-apps/ConnectedAppCardButtonsSection.tsx` draws it.
  The server now has them on by default there, so Allow switches them on and
  Revoke off; the same answer's `card_buttons` is the newer view, which also
  covers allowing an installed App on another Server
  ([app link previews](../../../../../docs/development/app-link-previews.md#card-buttons-of-an-app-raft-did-not-review-rfc-076-17)).
- `AppServerVouchSwitch.tsx`: in the App editor's Distribution section, for a
  server_local App and a viewer with `manageExternalAuth`, the server vouch
  switch ("All agents on this server can use it"), sent at once to
  `PUT /integrations/clients/:id/server-vouch` (turning it on asks the
  approver's second step) and read from the row's `serverVouched`
  ([Raft Apps](../../../../../docs/raft-app/README.md)). Its
  `ServerVouchSwitch` is the same switch for any endpoint: the MCP App
  editor's Distribution section sends it to `PUT /mcp/apps/:id/server-vouch`
  and reads the App view's `serverVouched`
  ([MCP connectors](../../../../../docs/development/managed-mcp-connectors.md)).
- `appView.ts`: the App view model of the Apps redesign: one shape
  (`AppView`, and `AppDetailView` for the detail) for a Raft App, a connected
  service (an MCP App) and a Discover listing, mapped by pure functions from
  the records below. Yours' and Discover's cards use it; the dialogs
  still go through `connected-apps/connectedAppMapping.ts`. Its rules differ from that file on
  purpose: a connected service is never `official` (Raft's listing is
  `listedByRaft`), and no field names an App type to people (`kind` is for
  behaviour only). States are ids (`normal`, `updateNeedsApproval`,
  `signInExpired`, `cannotConnect`); the last two wait for the server's
  `status.defaultConnectionStatus`. Every state but `normal` is produced for
  App managers only (`context.canManage`), whatever the record carries. Tests: `tests/appView.test.ts`.
- `AppCard.tsx`: the redesign's card (`AppCard`, `AppCardSkeleton`), drawn
  from an `AppView`, used by Yours and Discover. The whole card opens the detail
  through a cover button named after the App, and its one button (a state's
  step in `variant="yours"`, Add in `variant="discover"`) sits above the
  cover; a button whose callback the caller leaves out is not drawn (a
  member's view), and without `onOpen` the card is not a button at all. A state says its words in place of the source line, with
  the attention dot on the logo (`AppCardAttentionDot`, the one place its
  look is decided). The card is its own container: under 360px of card the
  button takes its own line. It never names an App type, shows an address,
  or says reviewed. `appCardSource.ts` builds the source line's parts.
  Tests: `tests/appCard.behavior.test.tsx` (DOM); pictures:
  the `components.apps.app-card.*` visual cases
  (`visual-testing/AppCardCases.tsx`).
- `connected-apps/`: the parts several App surfaces share. Record and view
  types (`oauthClientRecords.ts`, `connectedAppTypes.ts`), pure helpers
  (`connectedAppStatus.ts`, `connectedAppCatalog.ts`, `connectedAppMapping.ts`,
  `getDomainFromUrl.ts`), and one presentational
  component per file (badges, editor sections, the scope list and picker,
  the detail dialog).
- Still elsewhere, moving here later: the page and list code in
  `components/apps/`, `components/settings/mcpApps/`, and in
  `components/settings/` the `ConnectedApp*` files, `DeclaredScopeToggle.tsx`,
  `AppNotificationsControls.tsx`, `AppPromptTextPanels.tsx`,
  `AppWhenToUseField.tsx`,
  and `connectedAppsErrorSurface.ts`.
- Stores and APIs: `IntegrationsSection` reads `serverStore` and
  `profileStore`, loads `GET /integrations/clients`, `/integrations/marketplace`,
  `/integrations/overview` and `/mcp/apps`, and makes the App edits under
  `/integrations/clients/:id` and `/integrations/marketplace/:id/install`.
  `connected-apps/` keeps no state and calls no API: its records mirror those
  responses.
- Tests live in `packages/web/tests/` (`appView`, `appCard`, `appsYours` (the scope names, Yours' list and filter; `.behavior` for the page), `appsDiscover.behavior` (Discover's cards, details and Add), `connectedApps*`, `mcpApp*`, `appsRecommended`,
  `settingsSubBatch{D,E,F,G}.i18n`, `agentDirectoryPermission`). Run named files
  with `pnpm --filter @botiverse/raft-web test:dom <files>`.
