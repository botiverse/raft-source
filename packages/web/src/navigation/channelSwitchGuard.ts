/**
 * Navigation interception for the channel sheet's unsaved-settings draft.
 *
 * task #156: ChatPanel (and therefore the open channel sheet) is reused
 * across channels, and the sheet's settings form is keyed by channel id —
 * a channel switch remounts the form and silently drops a dirty draft.
 * The sheet cannot observe that in time: by the time its `channelId` prop
 * changes the route has already committed. The interception therefore
 * lives at the navigation call site: every conversation navigation in the
 * app funnels through useAppNavigate, which routes each `navigate()` call
 * through `requestChannelNavigation` first.
 *
 * The mounted ChannelOverflowMenu registers one interceptor. Returning
 * true means "I have taken over" — the interceptor opens the sheet's
 * existing keep/discard/save prompt with the real navigation parked as the
 * post-close action (the same deferred-action mechanism the search overlay
 * guard uses). Returning false lets the navigation proceed immediately.
 *
 * Scope note: this covers every nav.* call (sidebar rows, DM/agent/human/
 * computer entries, message permalinks, #channel mention links, search
 * results). Paths that bypass useAppNavigate — a pasted deep link, browser
 * back/forward, initial-load redirects in MainLayout — are not intercepted;
 * BrowserRouter offers no blocking hook without a data-router migration.
 */
export type ChannelSwitchInterceptor = (
  /** The router path the caller is about to navigate to. */
  targetPath: string,
  /** Runs the real navigation. Called by the interceptor's UI only after
   *  the user chose discard or save. */
  proceed: () => void,
) => boolean;

let active: ChannelSwitchInterceptor | null = null;

export function setChannelSwitchInterceptor(
  interceptor: ChannelSwitchInterceptor | null,
): void {
  active = interceptor;
}

/** Unregister without stealing the slot: an unmount that runs AFTER a
 *  second sheet registered itself must not null the newer interceptor. */
export function clearChannelSwitchInterceptor(
  interceptor: ChannelSwitchInterceptor,
): void {
  if (active === interceptor) active = null;
}

/** Guarded navigation: `proceed` runs now when no surface is holding a
 *  dirty draft, or is deferred to the prompt's Discard/Save choice. */
export function requestChannelNavigation(
  targetPath: string,
  proceed: () => void,
): void {
  if (active?.(targetPath, proceed)) return;
  proceed();
}
