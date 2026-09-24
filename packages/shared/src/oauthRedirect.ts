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
