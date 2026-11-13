import { DEPLOYMENT_USER_LIMIT_REACHED_CODE, RAFT_LICENSE_CONTACT_EMAIL } from "@botiverse/raft-shared";

/** The address the user limit's copy links to (`<mail>` in the deploymentUserLimit.* messages). */
export const RAFT_LICENSE_CONTACT_MAILTO = `mailto:${RAFT_LICENSE_CONTACT_EMAIL}`;

/**
 * A request refused because the source-available deployment already has as
 * many people as the Raft License allows (the server's
 * deployment_user_limit_reached): someone joining, becoming a member, or
 * creating a server. Its copy is DeploymentUserLimitText.
 */
export function isDeploymentUserLimitRefusal(err: unknown): boolean {
  const data = (err as { response?: { data?: { code?: unknown; errorCode?: unknown } } } | null)?.response?.data;
  return data?.code === DEPLOYMENT_USER_LIMIT_REACHED_CODE || data?.errorCode === DEPLOYMENT_USER_LIMIT_REACHED_CODE;
}
