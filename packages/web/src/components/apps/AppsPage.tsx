import { IntegrationsSection } from "../../features/apps/IntegrationsSection";

/**
 * /s/<slug>/apps — the server's Apps, out of Settings into a page of their own
 * (#proj-apps task #22). On desktop it follows the rail with no sidebar, like
 * Tasks; on a phone the server tab's popover pushes it, with Back.
 */
export default function AppsPage() {
  return <IntegrationsSection variant="page" />;
}
