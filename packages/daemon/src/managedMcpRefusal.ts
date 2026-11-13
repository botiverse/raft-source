/**
 * What the model is told when the Server refuses a managed MCP call.
 *
 * Shared by both call surfaces (the Pi custom tools and the native MCP proxy) because the model
 * sees whichever one its runtime uses, and a refusal that differs between them would make the same
 * situation look like two different problems.
 *
 * The code used to be dropped on the floor at both surfaces: the model saw an HTTP status or a bare
 * sentence, and could not tell "a human must approve this" from "retry later" from "this tool is
 * not yours". Each line below says what happens next, because the model's alternative is to retry
 * the same call.
 */
export function managedMcpRefusalGuidance(input: {
  message: string;
  code: string | null;
  /**
   * The Server's own statement that a connection card exists for this refusal. Only `true` lets the
   * model be told to wait: a call with no valid origin raises no card, and "a request is waiting,
   * do not retry" would then leave the model and the human both waiting on nothing (@Huarong).
   */
  connectionRequested?: boolean;
  /**
   * The Server already worded this refusal for the agent (it sends the same text as
   * `suggestedNextAction`; managedMcpAgentErrors on the Server). Its sentence already ends in what
   * to do next, so adding ours would repeat or contradict it: pass it through unchanged.
   */
  agentWorded?: boolean;
}): string {
  if (input.agentWorded) return input.message;
  switch (input.code) {
    case "managed_mcp_login_required":
      if (input.connectionRequested !== true) {
        return `${input.message}. No connection request could be raised from here, so nobody has been asked yet. `
          + "Tell a human in your conversation that this Agent needs this MCP connection authorized; "
          + "calling the tool again while replying to their message raises the request there.";
      }
      return `${input.message}. A connection request has been raised in this conversation for a human to authorize; `
        + "do not retry this tool until someone confirms they authorized it.";
    case "managed_mcp_app_off":
      return `${input.message}. This MCP App is not granted to this Agent (a human revoked it, or it was never `
        + "granted); do not retry, and do not ask for a connection: connecting will not grant it.";
    case "managed_mcp_tool_not_allowed":
      return `${input.message}. This is a tool restriction, not a missing connection — authorizing a `
        + "connection will not widen it. Ask a human to change this Agent's allowed tools.";
    case "managed_mcp_server_disabled":
      return `${input.message}. An operator disabled this MCP server; nothing the Agent does will re-enable it.`;
    case "managed_mcp_auth_invalid":
      return `${input.message}. The MCP server's own authorization needs attention from a human.`;
    case "managed_mcp_credential_invalid":
      return `${input.message}. The stored credential cannot be used; this needs an operator, not a retry.`;
    case "managed_mcp_unreachable":
      return `${input.message}. The MCP server could not be reached; this may be transient, so one later retry is reasonable.`;
    case "managed_mcp_config_stale":
      // The runtimes recover from this themselves (refresh the snapshot, retry once). If it still
      // reaches the model, the recovery did not settle it.
      return `${input.message}. The tool catalogue changed and refreshing it did not settle the call.`;
    default:
      return input.code ? `${input.message} (${input.code})` : input.message;
  }
}
