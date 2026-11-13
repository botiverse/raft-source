import {
  clearOAuthBrowserBindingCookie,
  oauthBrowserBindingCookie,
  oauthCallbackIsBound,
  type OAuthBrowserBinding,
} from "./oauthBrowserBinding";

// A managed MCP sign-in completes only in the browser that started it; see
// oauthBrowserBinding for the mechanism.

export const MANAGED_MCP_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

const MANAGED_MCP_BINDING: OAuthBrowserBinding = {
  prefix: "raft_mcp_oauth",
  callbackPath: MANAGED_MCP_OAUTH_CALLBACK_PATH,
};

/** Set-Cookie for the start response; lives exactly as long as the attempt. */
export function managedMcpOAuthBindingCookie(state: string, ttlSeconds: number): string {
  return oauthBrowserBindingCookie(MANAGED_MCP_BINDING, state, ttlSeconds);
}

/** Set-Cookie that removes the binding once its callback has been handled. */
export function clearManagedMcpOAuthBindingCookie(state: string): string {
  return clearOAuthBrowserBindingCookie(MANAGED_MCP_BINDING, state);
}

/** Whether this callback request comes from the browser that started the sign-in. */
export function managedMcpOAuthCallbackIsBound(cookieHeader: string | undefined, state: string): boolean {
  return oauthCallbackIsBound(MANAGED_MCP_BINDING, cookieHeader, state);
}
