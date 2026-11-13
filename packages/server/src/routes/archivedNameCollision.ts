import type { ArchivedNameCollisionError } from "../services/channelService";
import { canView, type ViewActor } from "../services/visibilityService";

/**
 * The 409 for a channel name an archived channel holds (create and rename).
 *
 * The specific answer names the archived channel (id, name, type) so the
 * caller can restore or open it. Only someone who can see that channel gets it;
 * anyone else gets the plain "already taken" answer, so a private archived
 * channel's existence is not revealed by trying its name (#proj-chat:#19).
 */
export async function archivedNameCollisionBody(
  err: ArchivedNameCollisionError,
  actor: ViewActor,
  /** People are told whether they may restore it; agents restore through their own command. */
  canUnarchive?: () => Promise<boolean>,
): Promise<Record<string, unknown>> {
  const [visible] = await canView(actor, [{ kind: "conversation", channelId: err.archivedChannelId }]);
  if (!visible) return { error: `Channel name "${err.channelName}" is already taken` };
  return {
    error: err.message,
    code: "archived_name_collision",
    archivedChannelId: err.archivedChannelId,
    archivedChannelName: err.channelName,
    archivedChannelType: err.archivedChannelType,
    ...(canUnarchive ? { canUnarchiveArchivedChannel: await canUnarchive() } : {}),
  };
}
