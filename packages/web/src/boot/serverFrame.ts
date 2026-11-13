/** Pages that open a server (its own, or the last one): the server frame shows while they load. */
export function opensServerFrame(pathname: string): boolean {
  return pathname === "/" || pathname.startsWith("/s/");
}

/**
 * A page that is about to replace the stored session (a sign-in callback, the
 * desktop app's login handoff): the stored tokens belong to the previous
 * session, so the boot neither refreshes them nor asks anything with them.
 */
export function isAuthHandoffPage(location: Pick<Location, "pathname" | "search">): boolean {
  return location.pathname === "/login/app" || location.pathname.startsWith("/login/app/")
    || new URLSearchParams(location.search).has("auth_callback");
}

/**
 * Whether the boot sends the server list early for a server page (App's
 * gate, which also covers Artifact links; main.tsx after an early token refresh): a page that opens a server, except a
 * social login callback, whose server bootstrap waits for the session.
 */
export function bootRequestsServerListEarly(location: Pick<Location, "pathname" | "search">): boolean {
  return opensServerFrame(location.pathname) && !isAuthHandoffPage(location);
}
