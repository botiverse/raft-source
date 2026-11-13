/**
 * Agent Lounge v0 (zh 会客厅, #proj-chat:30a58e4d): the one public
 * conversation per agent where the server's members talk with that agent.
 * On the wire it is a public channel named `<agent>-lounge` that carries
 * `loungeAgentId`; the web keeps it in its own store slice (channelDomain)
 * and always names it after its agent: "{Name}'s Lounge", never the raw
 * channel name.
 *
 * Everything here is gated by the server's `agent_lounge_v0` flag, and a
 * Guest never gets it (the server answers 403 for them anyway).
 */
import { Users } from "lucide-react";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useAgentStore } from "../../store/agentStore";
import { useChannelStore } from "../../store/channelStore";
import { findLoungeAgentId } from "../../store/storedChannel";
import type { AgentLoungeSummary, Channel } from "../../store/channelStore";
import { useProfileStore } from "../../store/profileStore";
import { AGENT_LOUNGE_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useServerStore } from "../../store/serverStore";
import { useThreadStore } from "../../store/threadStore";
import { resolveAgentDmProfileSource } from "../layout/agentDmProfileSource";
import { showToast } from "../toastBridge";

/** The Lounge's glyph (its sidebar row, the DM header's Lounge button). */
export const AgentLoungeIcon = Users;

/** The server has Lounges on and this person is not a Guest. Loading or unknown: off. */
export function useAgentLoungeEnabled(): boolean {
  const enabled = useServerFeatureFlag(AGENT_LOUNGE_FLAG_KEY).enabled;
  const isGuest = useServerStore((s) => s.current?.role === "guest");
  return enabled && !isGuest;
}

/**
 * Whether an agent offers a Lounge: not a deleted agent, and not someone's
 * personal assistant (it works for one person; a room for the whole server
 * makes no sense for it).
 */
export function agentOffersLounge(agent: { deletedAt?: string | null; assistantOwnerUserId?: string | null }): boolean {
  return !agent.deletedAt && !agent.assistantOwnerUserId;
}

/** The agent's name from a Lounge's own row when the agent directory does not have it. */
function agentNameFromLoungeChannel(channelName: string): string {
  return channelName.replace(/-lounge$/, "");
}

/** The name a Lounge is shown under, outside React: its agent's display name, else from the channel name. */
export function loungeAgentDisplayName(
  agent: Parameters<typeof resolveAgentDmProfileSource>[0] | undefined,
  channelName: string,
): string {
  return agent ? resolveAgentDmProfileSource(agent).displayName : agentNameFromLoungeChannel(channelName);
}

/**
 * "{Name}'s Lounge" for a conversation read from the stores at call time
 * (an event handler's label), or null when it is not a Lounge.
 */
export function loungeTitleNow(
  formatMessage: IntlShape["formatMessage"],
  channelId: string | null | undefined,
  channelName: string,
): string | null {
  const agentId = findLoungeAgentId(useChannelStore.getState(), channelId);
  if (!agentId) return null;
  const agent = useAgentStore.getState().agents.find((candidate) => candidate.id === agentId);
  return formatMessage({ id: "agent.lounge.title" }, { name: loungeAgentDisplayName(agent, channelName) });
}

/** The name a Lounge is shown under: its agent's display name. */
export function useLoungeAgentName(channel: Pick<Channel, "loungeAgentId" | "name"> | null | undefined): string {
  const agent = useAgentStore((s) => (
    channel?.loungeAgentId ? s.agents.find((candidate) => candidate.id === channel.loungeAgentId) : undefined
  ));
  if (agent) return resolveAgentDmProfileSource(agent).displayName;
  return channel ? agentNameFromLoungeChannel(channel.name) : "";
}

/**
 * "{Name}'s Lounge" for the Lounge of `agentId` (null: not a Lounge). For a
 * place that knows a Lounge only by its agent (an Activity row, a search
 * scope): the agent's name from the directory, else from the Lounge's own
 * channel name (`<agent>-lounge`).
 */
export function useLoungeTitle(agentId: string | null | undefined, channelName: string | null | undefined): string | null {
  const { formatMessage } = useIntl();
  const name = useLoungeAgentName(agentId ? { loungeAgentId: agentId, name: channelName ?? "" } : null);
  return agentId ? formatMessage({ id: "agent.lounge.title" }, { name }) : null;
}

/**
 * Whether an agent's Lounge has a sidebar row: only once you joined it, or
 * someone mentioned you there (not one row for every agent). `slice` is the
 * Lounge row the store holds (fresher, e.g. right after your first post);
 * `summary` is what the agent's DM row carried.
 */
export function agentLoungeSidebarEntry(
  summary: AgentLoungeSummary | undefined,
  slice: Channel | undefined,
): { channelId: string; unreadCount: number; mentioned: boolean } | null {
  const channelId = slice?.id ?? summary?.channelId;
  if (!channelId) return null;
  const joined = slice?.joined === true || summary?.joined === true;
  const mentionCount = summary?.channelId === channelId ? summary.mentionCount ?? 0 : 0;
  if (!joined && mentionCount <= 0) return null;
  return {
    channelId,
    unreadCount: summary?.channelId === channelId ? summary.unreadCount : 0,
    mentioned: mentionCount > 0,
  };
}

/**
 * Open an agent's Lounge (POST /agents/:id/lounge makes it the first time)
 * and go to it. A failure says so in a toast and stays where it is.
 */
export function useOpenAgentLounge(): (agentId: string) => Promise<void> {
  const openLounge = useChannelStore((s) => s.openLounge);
  const nav = useAppNavigate();
  const { formatMessage } = useIntl();
  return useCallback(async (agentId: string) => {
    let channelId: string;
    try {
      channelId = (await openLounge(agentId)).channel.id;
    } catch {
      showToast({ title: formatMessage({ id: "agent.lounge.openFailed" }), type: "error" });
      return;
    }
    useProfileStore.getState().closeProfile();
    useThreadStore.getState().closeThread();
    nav.toChannel(channelId);
  }, [formatMessage, nav, openLounge]);
}
