import { Badge, ScrollArea, Separator, IconTile, ListRow, ListRowBody, ListRowDescription, ListRowGroup, ListRowTitle, ListRowTop } from "@botiverse/raft-ui";
import { MessageIcon, DirectMessageIcon } from "@botiverse/ricons";
import Tooltip from "../../components/ui/Tooltip";
import { useState, useEffect, useRef, useCallback } from "react";
import type { MouseEvent } from "react";
import { useIntl } from "react-intl";
import { BellOff, Hash } from "lucide-react";
import { ChannelIcon } from "../../components/channel/channelKindIcon";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import SectionHeader from "../../components/ui/SectionHeader";
import ShowMoreToggle from "../../components/ui/ShowMoreToggle";
import api from "../../api/client";
import { AgentDMConversationList } from "../../components/agent/AgentDMConversationList";
import type { AgentDMConversation } from "../../components/agent/AgentDMConversationList";
import Banner from "../../components/ui/Banner";
import EmptyState from "../../components/ui/EmptyState";
import { AgentChatInlineEmpty } from "./AgentChatInlineEmpty";

interface AgentChannelMembership {
  id: string;
  name: string;
  description: string | null;
  type: "channel" | "private" | "joint";
  createdAt: string;
  archivedAt: string | null;
  activityMuted: boolean;
  muteFromSeq: string | number | null;
}

interface AgentChatDataState<T> {
  items: T[];
  loading: boolean;
  error: string;
}

const EMPTY_AGENT_DMS_STATE: AgentChatDataState<AgentDMConversation> = {
  items: [],
  loading: false,
  error: "",
};

const EMPTY_AGENT_CHANNELS_STATE: AgentChatDataState<AgentChannelMembership> = {
  items: [],
  loading: false,
  error: "",
};
const AGENT_CHAT_CHANNEL_PREVIEW_LIMIT = 5;

function visibleAgentChatChannels(items: AgentChannelMembership[]): AgentChannelMembership[] {
  return items.filter((item) => !item.archivedAt);
}

export function AgentChatTab({ agentId }: { agentId: string }) {
  const { formatMessage } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const nav = useAppNavigate();
  const openChannel = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const channelId = event.currentTarget.dataset.channelId;
    if (channelId) nav.toChannel(channelId);
  }, [nav]);
  const [dms, setDms] = useState<AgentChatDataState<AgentDMConversation>>(EMPTY_AGENT_DMS_STATE);
  const [channels, setChannels] = useState<AgentChatDataState<AgentChannelMembership>>(EMPTY_AGENT_CHANNELS_STATE);
  const [channelsExpanded, setChannelsExpanded] = useState(false);
  const showCombinedEmptyState = !channels.loading
    && !dms.loading
    && !channels.error
    && !dms.error
    && channels.items.length === 0
    && dms.items.length === 0;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setDms((state) => ({ ...state, loading: true, error: "" }));
      try {
        const { data } = await api.get(`/agents/${agentId}/agent-dms`);
        if (!cancelled) setDms({ items: data, loading: false, error: "" });
      } catch (err: any) {
        if (!cancelled) {
          setDms({ items: [], loading: false, error: err?.response?.data?.error || formatMessageRef.current({ id: "agent.detail.loadAgentDmsFailed" }) });
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setChannels((state) => ({ ...state, loading: true, error: "" }));
      try {
        const { data } = await api.get(`/agents/${agentId}/channels`);
        if (!cancelled) setChannels({ items: visibleAgentChatChannels(data), loading: false, error: "" });
      } catch (err: any) {
        if (!cancelled) {
          setChannels({ items: [], loading: false, error: err?.response?.data?.error || formatMessageRef.current({ id: "agent.detail.loadAgentChannelsFailed" }) });
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const canExpandChannels = channels.items.length > AGENT_CHAT_CHANNEL_PREVIEW_LIMIT;
  const visibleChannels = channelsExpanded
    ? channels.items
    : channels.items.slice(0, AGENT_CHAT_CHANNEL_PREVIEW_LIMIT);
  const toggleChannelsExpanded = useCallback(() => setChannelsExpanded((expanded) => !expanded), []);

  return (
    <ScrollArea className="flex-1 bg-layer-canvas">
      <div className="border-b border-line-hairline bg-layer-canvas px-(--surface-inset) py-3">
        <SectionEyebrow as="div">{formatMessage({ id: "agent.detail.channelsAndDms" })}</SectionEyebrow>
      </div>

      {showCombinedEmptyState ? (
        <EmptyState
          className="px-(--surface-inset) py-14"
          icon={(
            <div className="flex items-center gap-3">
              <Hash size={34} />
              <MessageIcon width={34} height={34} />
            </div>
          )}
          title={formatMessage({ id: "emptyState.noChatsTitle" })}
        />
      ) : (
        <>
          <section>
            <div className="px-(--surface-inset) py-3">
              {/* The heading and the list say it: no line describing the list (HelperText step 1). */}
              <SectionHeader label={formatMessage({ id: "agent.detail.channels" })} />
            </div>
            {channels.loading ? (
              <div className="px-(--surface-inset) pb-4 text-caption text-foreground-hint">
                {formatMessage({ id: "agent.detail.loadingAgentChannels" })}
              </div>
            ) : channels.error ? (
              <div className="px-(--surface-inset) pb-4">
                <Banner intent="warning" density="sm">{channels.error}</Banner>
              </div>
            ) : channels.items.length === 0 ? (
              <AgentChatInlineEmpty
                icon={<Hash size={18} />}
                title={formatMessage({ id: "emptyState.noChannelsTitle" })}
                description={formatMessage({ id: "emptyState.noChannelsDesc" })}
              />
            ) : (
              <div className="stack-y-2 px-4 pb-4">
                {/* DS ListRow › channels in an inset list: raft-ui ListRows
                    with the neutral channel tile (# or lock), the name and its
                    description; a muted channel is the `muted` tone (ink-2
                    name) with its bell-off mark. */}
                <ListRowGroup>
                {visibleChannels.map((item) => (
                  <ListRow
                    key={item.id}
                    tone={item.activityMuted ? "muted" : "default"}
                    data-channel-id={item.id}
                    onClick={openChannel}
                  >
                    <IconTile
                      role="img"
                      aria-label={item.type === "private"
                        ? formatMessage({ id: "agent.detail.privateChannel" })
                        : formatMessage({ id: "agent.detail.channel" })}
                    >
                      <ChannelIcon channelId={item.id} type={item.type} />
                    </IconTile>
                    <ListRowBody>
                      <ListRowTop>
                        <ListRowTitle>{item.name}</ListRowTitle>
                        {item.activityMuted && (
                          <Tooltip content={item.muteFromSeq != null
                              ? formatMessage({ id: "agent.detail.activityMutedFromSeq" }, { seq: item.muteFromSeq })
                              : formatMessage({ id: "agent.detail.activityMuted" })}>
                          <span
                            className="inline-flex shrink-0 items-center text-foreground-hint"
                            aria-label={item.muteFromSeq != null
                              ? formatMessage({ id: "agent.detail.activityMutedFromSeq" }, { seq: item.muteFromSeq })
                              : formatMessage({ id: "agent.detail.activityMuted" })}
                          >
                            <BellOff size={13} aria-hidden="true" />
                          </span>
                          </Tooltip>
                        )}
                      </ListRowTop>
                      {item.description && (
                        <ListRowDescription>{item.description}</ListRowDescription>
                      )}
                    </ListRowBody>
                    {item.type !== "channel" && (
                      <Badge appearance="outline" className="shrink-0">
                        {item.type === "private"
                          ? formatMessage({ id: "agent.detail.private" })
                          : formatMessage({ id: "agent.detail.joint" })}
                      </Badge>
                    )}
                  </ListRow>
                ))}
                </ListRowGroup>
                {canExpandChannels && (
                  <ShowMoreToggle
                    onClick={toggleChannelsExpanded}
                    expanded={channelsExpanded}
                    collapsedLabel={formatMessage({ id: "agent.detail.showAllChannels" }, { count: channels.items.length })}
                    expandedLabel={formatMessage({ id: "agent.detail.showFewer" })}
                    aria-expanded={channelsExpanded}
                    data-testid="agent-channels-show-all"
                  />
                )}
              </div>
            )}
          </section>
          <Separator />

          <section>
            <div className="px-(--surface-inset) py-3">
              <SectionHeader label={formatMessage({ id: "agent.detail.agentDms" })} />
            </div>
            {dms.loading ? (
              <div className="px-(--surface-inset) pb-4 text-caption text-foreground-hint">
                {formatMessage({ id: "agent.detail.loadingAgentDms" })}
              </div>
            ) : dms.error ? (
              <div className="px-(--surface-inset) pb-4">
                <Banner intent="warning" density="sm">{dms.error}</Banner>
              </div>
            ) : dms.items.length === 0 ? (
              <AgentChatInlineEmpty
                icon={<DirectMessageIcon width={18} height={18} />}
                title={formatMessage({ id: "emptyState.noAgentDmsTitle" })}
                description={formatMessage({ id: "emptyState.noAgentDmsDesc" })}
              />
            ) : (
              <AgentDMConversationList items={dms.items} />
            )}
          </section>
        </>
      )}
    </ScrollArea>
  );
}
