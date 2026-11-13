// The Login with Raft setup page's shared classes (pages/HumanLoginSetupPage
// and the account-mode AccountLoginPanel draw the same fields).

// The app's details sit in a raft-ui Card; a card that opens the app's
// homepage is the same Card drawn on a link.
export const APP_DETAILS_CARD_CLASS = "mt-1.5 px-3 py-2.5 text-callout";
export const APP_DETAILS_LINK_CARD_CLASS = `${APP_DETAILS_CARD_CLASS} no-underline outline-none hover:overlay-subtle active:overlay-medium focus-visible:shadow-focus`;

// A field label above a value (DS TextField label: 13/18 600, ink-2).
export const FIELD_LABEL_CLASS = "text-footnote font-semibold text-foreground-muted";
// Help text under a field (DS: 12/16, ink-3).
export const FIELD_HELP_CLASS = "mt-1.5 text-caption text-foreground-hint";
// The status line under the commit button (a failure the server worded): a
// <pre> rendered as a raft-ui ScrollArea, which scrolls a long line sideways.
export const LOGIN_STATUS_CLASS = "mt-4 min-h-16 rounded-container border border-line-hairline bg-layer-code p-3 font-mono text-mono-code text-foreground";
// The card's title (h1): focusable from script (tabIndex -1) for focus that
// has nowhere nearer to go, ringed only for the keyboard, as Settings ›
// Account's sign-out heading is (AccountSignOutSection).
export const TITLE_CLASS = "mb-3 rounded-control outline-none focus-visible:shadow-focus";
