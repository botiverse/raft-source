/** Browser OAuth callbacks must be navigable web URLs. Local HTTP callbacks
 * remain available for development and installed-client loopback listeners. */
export function isSafeOAuthReturnUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return (url.protocol === "https:" || (url.protocol === "http:" && loopback))
      && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export function appendOAuthAuthorizationParams(returnTo: string, code: string, state?: string | null): string {
  if (!isSafeOAuthReturnUrl(returnTo)) throw new Error("Invalid OAuth returnUrl");
  const url = new URL(returnTo);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

/**
 * An authorization error sent back to the app's registered callback (RFC 6749
 * §4.1.2.1): `error`, optional `error_description`, and the app's `state`.
 * Only for a callback the server already matched to the registered one.
 */
export function appendOAuthErrorParams(
  returnTo: string,
  error: string,
  options: { description?: string | null; state?: string | null } = {},
): string {
  if (!isSafeOAuthReturnUrl(returnTo)) throw new Error("Invalid OAuth returnUrl");
  const url = new URL(returnTo);
  url.searchParams.delete("code");
  url.searchParams.set("error", error);
  if (options.description) url.searchParams.set("error_description", options.description);
  if (options.state) url.searchParams.set("state", options.state);
  return url.toString();
}
