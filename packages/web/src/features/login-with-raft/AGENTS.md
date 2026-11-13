# features/login-with-raft

The parts of the Login with Raft setup page (`pages/HumanLoginSetupPage.tsx`,
`/login-with-raft/setup`) that live outside the page, and its account-mode
view (RFC 079 phase 3a, design §4.1).

- `loginClientSummary.ts`: the lookup's App summary (`LoginClientSummary`,
  `AvailableServerClient`) and `isAccountLoginEntry` (`loginMode: "account"`).
- `loginErrors.ts`: how the page reads refusals: `invalid_scope` back to the
  App, `app_not_available`, 409 `login_mode_changed`, and the account-mode
  `root_issuer_required` / `installation_suspended`.
- `useAccountAuthorization.ts`: POST `/oauth/authorize/account` (never a
  `serverId` or `server`) through the `appAccess` step-up, then on to the App.
- `AccountLoginPanel.tsx`: the account-mode card that replaces the Server
  picker and commit zone; `LoginAppDetailsCard.tsx`,
  `LoginScopeConfigurationAlert.tsx`, `appInitials.ts` and
  `loginSetupClassNames.ts` are shared with the page.
- `LoginLookupLoadingCard.tsx`: the page's card while the App is looked up
  (its mode unknown): `aria-busy`, a skeleton after 1 second (held unseen
  before, so the card is its own height, not the FAQ card's), never the
  Server picker or the account card first.
- `AccountLoginRefusalBanner.tsx`: an account-mode refusal, first in the
  card (the account card, or the install rows when the refusal leaves an
  installable Server); it takes focus when it answers a press
  (`focusOnMount.ts`).
- `useTitleFocusRequest.ts`: the one-shot request (set by a 409) that the
  next card's title take focus; the first title to mount spends it.
- `LoginSetupHeader.tsx`: "Login with [Raft]" (`{raft}` is the lockup, an
  image named Raft) and Back / Log Out.
- `loginClientSummary.ts` also holds the page's Server order
  (`marketplaceServerRank`, `firstServerByRank`) and
  `withAccountInstallationsSuspended`: a 403 `installation_suspended` marks
  the page's one list of lookup answers (`foundEntries`) as a lookup would
  now return them (the Suspended badge), by functional update.
  A fresh lookup (the Servers list refreshing) clears that refusal
  (`clearRefusal`): what it finds is the page's answer, so a restored
  installation brings Login with Raft back.
- `useLoginInstallBotOffer.ts`: Install and Continue's "Also add @handle"
  (the lookup's `bot: { handle }`),
  its per-Server choice and a taken handle's notice.
- `LoginFaqCard.tsx`: the page's side card.
- A lookup without `loginMode` keeps the page's server-mode flow unchanged.
  An account-mode App with nothing ready but install targets uses the page's
  Marketplace rows, then signs in through `useAccountAuthorization`.
- Tests: ~~`tests/humanLoginAccountMode.behavior.test.tsx`~~ (removed in the [web DOM test prune](../../../../../docs/development/README.md#web-dom-test-prune-2026-11)) in this folder (account
  mode and the unchanged server-mode body); in `packages/web/tests/`:
  `humanLoginAppNotAvailable`, `appAccessStepUp`, `connectedAppsIdentity`,
  `appBotInstallOption`.
