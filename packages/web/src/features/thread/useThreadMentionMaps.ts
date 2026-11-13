import { useMemo } from "react";
import type { Agent } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";
import { buildMentionMap } from "../../components/message/MessageItem";
import { useChannelMembers } from "../../hooks/useChannelMembers";
import { rosterHumanAsMember } from "../../utils/rosterHumanAsMember";

/**
 * Who the thread's messages can name: the server's agents and members plus
 * the parent channel's own (a joint channel's people from other servers), as
 * the mention map and the by-id lookups its rows and parent preview read.
 */
export function useThreadMentionMaps({
  parentChannelId,
  threadChannelId,
  agents,
}: {
  parentChannelId: string | null;
  threadChannelId: string | null;
  agents: Agent[];
}) {
  const members = useServerStore((s) => s.members);
  const mentionScopeChannelId = parentChannelId || threadChannelId || "";
  const { channelAgents: mentionChannelAgents, channelHumans: mentionChannelHumans, channelExternalMembers: mentionChannelExternalMembers } = useChannelMembers(mentionScopeChannelId);

  const mentionMap = useMemo(
    () => buildMentionMap(agents, members, mentionChannelAgents, mentionChannelHumans),
    [agents, members, mentionChannelAgents, mentionChannelHumans],
  );
  const agentById = useMemo(() => {
    const map = new Map<string, (typeof agents)[0]>();
    for (const a of agents) map.set(a.id, a);
    for (const a of mentionChannelAgents) map.set(a.id, a);
    return map;
  }, [agents, mentionChannelAgents]);
  const memberById = useMemo(() => {
    const map = new Map<string, (typeof members)[0]>();
    for (const m of members) map.set(m.userId, m);
    for (const human of mentionChannelHumans) map.set(human.id, rosterHumanAsMember(human));
    return map;
  }, [members, mentionChannelHumans]);
  const externalById = useMemo(() => {
    const map = new Map<string, (typeof mentionChannelExternalMembers)[0]>();
    for (const ext of mentionChannelExternalMembers) map.set(ext.id, ext);
    return map;
  }, [mentionChannelExternalMembers]);

  return { mentionMap, agentById, memberById, externalById };
}
