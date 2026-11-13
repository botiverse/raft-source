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

- `IntegrationsSection.tsx`: the entry. The server's Apps (Installed,
  Marketplace, My Apps) as one component; the Apps page renders it with
  `variant="page"` (`components/apps/AppsPage.tsx`), Settings › Applications
  with the default `variant="settings"`.
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
  whether a private App exists). Both parameters leave the address in one
  replace, the other parameters kept.
  `useMarketplaceBotHint.tsx`: the Marketplace's hint for an installed App's
  undecided (`pending`) bot (#proj-apps:#35 layer 2), on its card and in its
  listing's Posts as row: the same add for owners and admins, who can add it
  for members. Matched by the App's id (`listing.app.id`); the listing's own
  id is opaque.
- The Apps page's "Recommended for you" (`components/apps/AppsRecommendedSection.tsx`):
  the App ids in `components/apps/appsRecommendations.ts` (Stamp only, by
  client ID `stamp` and `official`, never by name), shown at the top of the
  Installed tab (under the page's notices), with no search or filter on,
  while the Marketplace lists one for this Server and it isn't installed, as its Marketplace card (`MarketplaceListingRow`) with its own
  line; the card opens the same install detail. While it shows, the installed
  list under it has its own "Installed" heading (`AppsSectionHeading`, an
  `h3` under the page title's `h2`). A Server that uninstalled Stamp sees it
  recommended again: the record carries no "uninstalled here" signal. Add a
  recommendation there, with its line in the catalogs.
- `connected-apps/`: the parts several App surfaces share. Record and view
  types (`oauthClientRecords.ts`, `connectedAppTypes.ts`), pure helpers
  (`connectedAppStatus.ts`, `connectedAppCatalog.ts`, `connectedAppMapping.ts`,
  `connectedAppsViewMode.ts`, `getDomainFromUrl.ts`), and one presentational
  component per file (badges, the view toggle, editor sections, the scope list
  and picker, the detail dialog).
- Still elsewhere, moving here later: the page and list code in
  `components/apps/`, `components/settings/mcpApps/`, and in
  `components/settings/` the `ConnectedApp*` files, `DeclaredScopeToggle.tsx`,
  `AppNotificationsControls.tsx`, `AppPromptTextPanels.tsx`,
  `AppWhenToUseField.tsx`,
  `connectedAppsErrorSurface.ts`, `InstalledConnectedAppItem.tsx` and
  `RegisteredConnectedAppItem.tsx`.
- Stores and APIs: `IntegrationsSection` reads `serverStore` and
  `profileStore`, loads `GET /integrations/clients`, `/integrations/marketplace`,
  `/integrations/overview` and `/mcp/apps`, and makes the App edits under
  `/integrations/clients/:id` and `/integrations/marketplace/:id/install`.
  `connected-apps/` keeps no state and calls no API: its records mirror those
  responses; the view mode is kept in localStorage
  (`raft:connected-apps:view-mode`).
- Tests live in `packages/web/tests/` (`connectedApps*`, `mcpApp*`, `appsPage`, `appsRecommended`,
  `settingsSubBatch{D,E,F,G}.i18n`, `agentDirectoryPermission`). Run named files
  with `pnpm --filter @botiverse/raft-web test:dom <files>`.
