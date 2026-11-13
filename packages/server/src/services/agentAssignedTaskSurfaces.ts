import * as agentService from "./agentService";
import * as channelService from "./channelService";
import { resolveTaskChannelSurfaces, type TaskSurfaceChannel } from "./taskChannelSurface";

/** Where an agent sees a task of one of its channels: the channel's agent-facing ref and its local surface. */
export type AgentTaskSurface = {
  channelRef: string;
  localChannel: TaskSurfaceChannel;
};

/**
 * The task surfaces an agent can see on its server (`raft task list --mine`,
 * the idle task reminder), keyed by every channel id a task row may carry for
 * them: the authorized local channel and its storage channel. The visible
 * channels and their refs, then every task surface in one batch. These ids
 * are already authorized by the ref resolution, so they are not turned into
 * refs and looked up by name again (that round trip, per channel under
 * Promise.all, borrowed 172 pool connections for one agent on prod). Empty
 * when the agent is not on `serverId`.
 */
export async function resolveAgentTaskSurfaces(serverId: string, agentId: string): Promise<Map<string, AgentTaskSurface>> {
  const taskSurfaces = new Map<string, AgentTaskSurface>();
  const agent = await agentService.getAgent(agentId);
  if (!agent || agent.serverId !== serverId) return taskSurfaces;
  const channelRefs = await channelService.listAgentFacingTaskChannelRefs(serverId, agentId);
  const surfaces = await resolveTaskChannelSurfaces(serverId, [...channelRefs.keys()]);
  for (const [localChannelId, channelRef] of channelRefs) {
    const resolved = surfaces.get(localChannelId);
    if (!resolved) continue;
    const surface = { channelRef, localChannel: resolved.localChannel };
    // Legacy/raw imports may still carry the authorized local joint id,
    // while Task V2 writes the canonical storage id. Both project to the
    // same caller-local surface; neither id is discovered from task rows.
    taskSurfaces.set(localChannelId, surface);
    taskSurfaces.set(resolved.storageChannelId, surface);
  }
  return taskSurfaces;
}
