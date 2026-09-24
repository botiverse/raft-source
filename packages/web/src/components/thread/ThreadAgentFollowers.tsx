import { THREAD_AGENT_FOLLOWER_MANAGEMENT_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { AlertCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { Popover, PopoverContent, PopoverTrigger, toast } from "raft-ui";
import { getSocket } from "../../api/socket";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import {
  requestThreadAgentFollowers,
  useThreadAgentFollowerStore,
} from "../../store/threadAgentFollowerStore";
import { useProfileStore } from "../../store/profileStore";
import { useServerStore } from "../../store/serverStore";
import { JointPeerBadge } from "../agent/ChannelMembers";
import { setCachedAgentProfile } from "../profile/profileFallbackCache";
import { AgentAvatar } from "../agent/PixelAvatar";

export default function ThreadAgentFollowers({
  threadChannelId,
  variant,
}: {
  threadChannelId: string;
  variant: "card" | "header";
}) {
  const { formatMessage } = useIntl();
  const enabled = useServerFeatureFlag(
    THREAD_AGENT_FOLLOWER_MANAGEMENT_FEATURE_FLAG_KEY,
    { prefetch: false },
  ).enabled;
  const roster = useThreadAgentFollowerStore((state) => state.rosters[threadChannelId]);
  const load = useThreadAgentFollowerStore((state) => state.load);
  const remove = useThreadAgentFollowerStore((state) => state.remove);
  const restore = useThreadAgentFollowerStore((state) => state.restore);
  const openProfile = useProfileStore((state) => state.openProfile);
  const currentServerId = useServerStore((state) => state.current?.id);
  const [open, setOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    if (enabled) requestThreadAgentFollowers(threadChannelId);
  }, [enabled, threadChannelId]);

  useEffect(() => {
    if (!enabled) return;
    const socket = getSocket();
    const handleMessageNew = (message: { channelId?: string } | null | undefined) => {
      if (message?.channelId !== threadChannelId) return;
      requestThreadAgentFollowers(threadChannelId, true);
    };
    socket.on("message:new", handleMessageNew);
    return () => {
      socket.off("message:new", handleMessageNew);
    };
  }, [enabled, threadChannelId]);

  if (!enabled) return null;
  const agents = roster?.agents ?? [];
  const label = roster?.error
    ? formatMessage({ id: "thread.followers.loadFailed" })
    : formatMessage({ id: "thread.followers.label" }, { count: agents.length });

  const handleRemove = async (agentId: string, agentLabel: string) => {
    setRemovingId(agentId);
    try {
      const undoToken = await remove(threadChannelId, agentId);
      if (!undoToken) return;
      toast.success(
        formatMessage({ id: "thread.followers.removed" }, { agent: agentLabel }),
        {
          timeout: 5_000,
          dismissible: false,
          contentClassName: "thread-follower-removal-toast",
          action: {
            label: formatMessage({ id: "thread.followers.undo" }),
            onClick: () => {
              void restore(threadChannelId, agentId, undoToken).then((restored) => {
                if (restored) toast.success(formatMessage({ id: "thread.followers.restored" }, { agent: agentLabel }));
              });
            },
          },
        },
      );
    } catch {
      toast.error(formatMessage({ id: "thread.followers.removeFailed" }));
    } finally {
      setRemovingId(null);
    }
  };

  // Do not show a zero-count affordance. While the count is unknown there is
  // nothing actionable yet; a failed load still exposes Retry via an error-only
  // trigger rather than presenting the failure as "0 followers".
  if (!roster || roster.loading && !roster.loaded) return null;
  if (roster.loaded && agents.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={(
          <button
            type="button"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            className={variant === "header"
              ? "btn-brutal-sm flex h-7 items-center gap-1 bg-white px-1.5 text-xs font-bold"
              : "inline-flex h-5 items-center gap-1 rounded border border-black/25 bg-white px-1.5 text-[10px] font-bold text-black/60 hover:border-black"}
            aria-label={label}
            title={label}
            data-testid={`thread-followers-${variant}-trigger`}
          >
            <span className="flex -space-x-1" aria-hidden="true">
              {roster.error ? (
                <AlertCircle size={variant === "header" ? 14 : 12} />
              ) : agents.slice(0, 3).map((agent) => (
                <AgentAvatar key={agent.id} avatarUrl={agent.avatarUrl} size={variant === "header" ? 18 : 14} className="border border-white" />
              ))}
            </span>
            {roster.error ? null : <span>{agents.length}</span>}
          </button>
        )}
      />
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        // The trigger lives in a thread header that reflows when a profile
        // panel opens or the pane is resized. raft-ui disables anchor
        // tracking by default, which would leave this popover stranded at
        // the trigger's old coordinates.
        disableAnchorTracking={false}
        className="w-72 p-0"
        data-testid="thread-followers-popover"
      >
        <div className="border-b-2 border-black bg-brutal-cream px-3 py-2 text-sm font-bold">
          {formatMessage({ id: "thread.followers.title" })}
        </div>
        <div className="max-h-72 overflow-y-auto p-2">
          {roster?.loading && !roster.loaded ? (
            <div className="px-2 py-4 text-center text-xs font-bold text-black/45" data-testid="thread-followers-loading">
              {formatMessage({ id: "thread.followers.loading" })}
            </div>
          ) : roster?.error ? (
            <div className="flex flex-col items-center gap-2 px-2 py-4 text-center text-xs font-bold text-black/60" data-testid="thread-followers-error">
              <AlertCircle size={18} />
              {formatMessage({ id: "thread.followers.loadFailed" })}
              <button type="button" className="btn-brutal-sm bg-white px-2 py-1" onClick={() => void load([threadChannelId], true)}>
                {formatMessage({ id: "thread.followers.retry" })}
              </button>
            </div>
          ) : agents.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs font-bold text-black/45" data-testid="thread-followers-empty">
              {formatMessage({ id: "thread.followers.empty" })}
            </div>
          ) : agents.map((agent) => {
            const agentLabel = agent.displayName || agent.name;
            const canRemoveAgent = roster?.canManage && agent.canRemove !== false;
            const serverLabel = agent.serverName || agent.serverSlug;
            const removeLabel = canRemoveAgent
              ? formatMessage({ id: "thread.followers.remove" }, { agent: agentLabel })
              : formatMessage({ id: "thread.followers.peerRemoveUnavailable" }, {
                agent: agentLabel,
                server: serverLabel || formatMessage({ id: "thread.followers.peerServer" }),
              });
            const openAgentProfile = () => {
              setCachedAgentProfile(currentServerId, {
                ...agent,
                // The follower endpoint exposes transport/display statuses
                // (for example, "online"), while Agent profiles use the
                // shared AgentStatus union. Normalize before seeding the
                // fallback cache so peer rows can open a complete profile.
                status: agent.status === "active" || agent.status === "online"
                  ? "active"
                  : agent.status === "stopped" ? "stopped" : "inactive",
                description: null,
                model: "",
                runtime: "",
                serverRole: null,
                reasoningEffort: null,
                executionMode: "cloud",
                envVars: null,
                machineId: null,
                creatorType: null,
                creatorId: null,
                creator: null,
                createdAgents: [],
                deletedAt: null,
                createdAt: "",
              });
              openProfile("agent", agent.id);
            };
            return (
              <div key={agent.id} className="flex items-center gap-2 px-1 py-1.5" data-testid="thread-follower-row">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-black/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-black"
                  onClick={openAgentProfile}
                  aria-label={agentLabel}
                  title={agentLabel}
                  data-testid="thread-follower-profile-row"
                >
                  <AgentAvatar avatarUrl={agent.avatarUrl} size={28} />
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="truncate text-sm font-bold" title={agentLabel}>
                      {agentLabel}
                    </span>
                    {agent.isCurrentServer === false && serverLabel ? (
                      <span className="min-w-0" title={serverLabel}>
                        <JointPeerBadge label={serverLabel} />
                      </span>
                    ) : null}
                  </span>
                </button>
                {roster?.canManage ? (
                  <button
                    type="button"
                    className={`btn-brutal-sm flex size-7 items-center justify-center bg-white ${canRemoveAgent ? "" : "cursor-not-allowed opacity-45"}`}
                    disabled={!canRemoveAgent || removingId === agent.id}
                    onClick={() => {
                      if (!canRemoveAgent) return;
                      void handleRemove(agent.id, agentLabel);
                    }}
                    aria-label={removeLabel}
                    title={removeLabel}
                    data-testid="thread-follower-remove"
                  >
                    <X size={14} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
