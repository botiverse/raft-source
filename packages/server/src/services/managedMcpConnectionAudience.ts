/**
 * Which MCP server a Connection's secret belongs to (`managed_mcp_credentials.authorized_endpoint_url`).
 *
 * Endpoint changes clear secrets in `applyMcpAppServerChange`; this is the second, independent
 * line: a secret recorded for one server is never used against another, even if some write path
 * (an older binary during a deploy, a future route) moves the endpoint without clearing it.
 *
 *   OAuth tokens  bound to the exact endpoint URL: the token audience, the authorization server and
 *                 the refresh grant all come from that server's metadata
 *   API keys      bound to the endpoint's origin, the same trust boundary the endpoint-change rules
 *                 use (a same-origin path change keeps keys, a new origin needs them again)
 *
 * NULL is a row written before the column existed, or by an older binary: trusted as before.
 */
export function connectionAudienceMatches(
  connection: { authorizedEndpointUrl: string | null },
  app: { endpointUrl: string; authMode: string },
): boolean {
  const recorded = connection.authorizedEndpointUrl;
  if (recorded === null) return true;
  if (app.authMode === "oauth") return recorded === app.endpointUrl;
  try {
    return new URL(recorded).origin === new URL(app.endpointUrl).origin;
  } catch {
    return false;
  }
}
