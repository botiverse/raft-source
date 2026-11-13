/**
 * Move to Another Computer from Delete Account for an agent on another
 * server: the dialog reads that server's stores, so the row links to Delete
 * Account there, which opens the dialog for `?move=<agentId>`
 * (AccountDeletionAgentRow, DeleteAccountPage).
 */
import { withEmbedParams } from "../../../embed";

/** The query that opens Move to Another Computer for an agent on arrival. */
export const MOVE_AGENT_PARAM = "move";

/** Delete Account on `serverSlug`, opening Move to Another Computer for `agentId`; keeps the App's embed params. */
export function moveAgentElsewhereHref(serverSlug: string, agentId: string): string {
  const query = withEmbedParams(new URLSearchParams({ [MOVE_AGENT_PARAM]: agentId })).toString();
  return `/s/${encodeURIComponent(serverSlug)}/settings/account/delete?${query}`;
}
