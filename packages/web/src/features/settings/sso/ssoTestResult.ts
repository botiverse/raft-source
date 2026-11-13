/**
 * The owner's test sign-in comes back from the IdP to the app with
 * `?sso_test=ok|failed&server=<serverId>` (routes/sso.ts); App opens that
 * Server's administration settings with the query kept, and the SSO section
 * shows the outcome once.
 */
export type SsoTestResult = { outcome: "ok" | "failed"; serverId: string };

/**
 * Reads the test sign-in's outcome from the address and removes its two
 * parameters (history.replaceState), so a reload doesn't show it again. Null
 * when the address carries none.
 */
export function readSsoTestResult(): SsoTestResult | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const outcome = url.searchParams.get("sso_test");
  const serverId = url.searchParams.get("server");
  if (outcome === null) return null;
  url.searchParams.delete("sso_test");
  url.searchParams.delete("server");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  if ((outcome !== "ok" && outcome !== "failed") || !serverId) return null;
  return { outcome, serverId };
}
