// The ONE allowlist of URL schemes a link may hand off outside the app.
//
// Used by the web's markdown sanitizer (which hrefs survive in rendered
// markdown, packages/web markdownSanitizeSchema.ts) and by Raft Desktop's main
// process (which off-app window.open / navigation targets it gives to
// shell.openExternal, apps/desktop src/main/externalLinks.ts). Adding a scheme
// here is a security review: it widens both at once.

/** Ordinary links, opened without a confirmation (window.open or a navigation). */
export const STANDARD_EXTERNAL_LINK_SCHEMES: readonly string[] = ["http", "https", "mailto"];

/**
 * Schemes the web renders only behind its confirm dialog (CustomProtocolLink,
 * task #734), which then calls window.open — so the desktop honours them on the
 * window.open path only, never on a bare navigation.
 */
export const CONFIRMED_EXTERNAL_LINK_SCHEMES: readonly string[] = ["irc", "ircs", "xmpp", "obsidian"];

/** Every scheme a link may carry out of the app. */
export const EXTERNAL_LINK_SCHEMES: readonly string[] = [...STANDARD_EXTERNAL_LINK_SCHEMES, ...CONFIRMED_EXTERNAL_LINK_SCHEMES];
