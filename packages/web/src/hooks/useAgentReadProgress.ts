import { useEffect, useMemo } from "react";
import { useIntl } from "react-intl";
import type { Channel } from "../store/channelStore";
import { useChannelStore } from "../store/channelStore";
import { selectIsDmSurface } from "../store/channelDmSurface";
import { useThreadStore } from "../store/threadStore";
import { useAgentStore } from "../store/agentStore";
import type { Agent } from "../store/agentStore";
import { useAgentTyping } from "../store/agentTypingStore";
import { useAuthStore } from "../store/authStore";
import { useReadReceiptStore } from "../store/readReceiptStore";
import { acquireAgentReadProgressWatch, isAgentReadProgressWatched } from "../store/agentReadProgressWatch";
import {
  AGENT_READ_MAX_FACES,
  AGENT_READ_MAX_FACES_NARROW,
  agentReadPositions,
  agentsMutedChannel,
  agentsStoppedFollowing,
  ownLatestMessageId,
  placeAgentReads,
  projectAgentReadStatus,
  relevantReadAgentIds,
} from "../store/agentReadProgressDomain";
import type { AgentReadMessageSlice } from "../store/agentReadProgressDomain";
import {
  AGENT_READ_PROGRESS_FEATURE_FLAG_KEY,
  useServerFeatureFlag,
} from "../store/serverFeatureFlags";
import type { AgentReadFace, AgentReadProgressModel } from "../components/message/agentReadProgressContext";
import { isReadReceiptScopeEligible } from "./useReadReceiptHydrate";
import { useMediaQuery } from "./effectPrimitives";
import { trackAgentReadProgressShown } from "../analytics/gatedFeatures";

const NARROW_QUERY = "(max-width: 767px)";

export interface AgentReadProgressInput {
  /** The conversation the timeline shows (its read-receipt scope), or null. */
  scope: Pick<Channel, "id" | "name" | "type"> | null;
  /** A thread's parent conversation: a thread under a DM is a DM surface. */
  parentChannelId?: string | null;
  messages: readonly AgentReadMessageSlice[];
  /** The window is not at the live edge (a context window). */
  hasNewer: boolean;
  /** System messages folded into a group -> the group's row. */
  foldedMessageIds?: ReadonlyMap<string, string>;
  /** Where this conversation's agent typing is keyed (agentTypingStore). */
  typingChannelId: string | null;
  typingParentMessageId: string | null;
  /**
   * The conversation's agents by id, for names and avatars the server's own
   * agent list lacks: a joint channel shows the other server's agents too.
   */
  agentById?: ReadonlyMap<string, Pick<Agent, "name" | "displayName" | "avatarUrl">>;
}

export interface AgentReadProgress {
  /** Null while the feature is off here: render rows exactly as before. */
  model: AgentReadProgressModel | null;
  /** The message that may carry the B line (your latest, at the live edge). */
  statusMessageId: string | null;
}

/**
 * Agent read progress for one open conversation (agent_read_progress_v0; the
 * read receipts hydrate gives the starting positions). While the flag is on and
 * the conversation can carry it (not a DM or #all; a joint channel can), it
 * watches the conversation's `read_progress:updated` and projects the agents'
 * positions onto the loaded messages (agentReadProgressDomain.ts). The model
 * exists only once the detail hydrated per-agent positions with at least one
 * agent: a summary scope (too many agents) or a scope without agents shows
 * nothing and reserves no column.
 */
export function useAgentReadProgress({
  scope,
  parentChannelId = null,
  messages,
  hasNewer,
  foldedMessageIds,
  typingChannelId,
  typingParentMessageId,
  agentById,
}: AgentReadProgressInput): AgentReadProgress {
  const { formatMessage } = useIntl();
  const progressEnabled = useServerFeatureFlag(AGENT_READ_PROGRESS_FEATURE_FLAG_KEY).enabled;
  const scopeId = scope?.id ?? null;
  // One-to-one DMs keep their "Read" line and get no faces; so does a thread
  // under a DM. The store is the authority on DM-ness (see MessageItem).
  const dmSurface = useChannelStore((state) => (
    selectIsDmSurface(state, scopeId) || selectIsDmSurface(state, parentChannelId)
  ));
  const watchScopeId = progressEnabled
    && scope?.type !== "dm"
    && !dmSurface
    && isReadReceiptScopeEligible(scope)
    ? scopeId
    : null;

  useEffect(() => {
    if (!watchScopeId) return;
    const release = acquireAgentReadProgressWatch(watchScopeId);
    return () => {
      release();
      // Unwatched, its moves are missed from here on: the next open loads the
      // detail again instead of trusting the kept positions.
      if (!isAgentReadProgressWatched(watchScopeId)) {
        useReadReceiptStore.getState().forgetScopeFreshness(watchScopeId);
      }
    };
  }, [watchScopeId]);

  const receiptScope = useReadReceiptStore((state) => (watchScopeId ? state.scopes[watchScopeId] : undefined));
  const positions = useMemo(() => agentReadPositions(receiptScope), [receiptScope]);
  const stoppedFollowing = useMemo(() => agentsStoppedFollowing(receiptScope), [receiptScope]);
  const mutedChannel = useMemo(() => agentsMutedChannel(receiptScope), [receiptScope]);
  const working = useAgentTyping(positions ? typingChannelId : null, typingParentMessageId);
  const agents = useAgentStore((state) => state.agents);
  const viewerUserId = useAuthStore((state) => state.user?.id ?? null);
  const narrow = useMediaQuery(NARROW_QUERY);

  // A context window (`hasNewer`: a jump to a search hit or a link) shows
  // history, not the conversation's end: no faces and no line there (who
  // spoke recently and where agents stopped are about the end). The column
  // stays, so returning to the end does not reflow the rows.
  const relevant = useMemo(
    () => (positions && !hasNewer ? relevantReadAgentIds(messages, positions, working) : []),
    [hasNewer, messages, positions, working],
  );
  const statusMessageId = useMemo(
    () => (positions ? ownLatestMessageId(messages, viewerUserId, hasNewer) : null),
    [hasNewer, messages, positions, viewerUserId],
  );
  // In a channel, your message's thread counts too: an agent that replied in
  // it (the thread summary's participants) or is typing there has your
  // message, so the line does not flag it. A thread's own replies have no
  // thread under them.
  const statusThreadParticipants = useThreadStore((state) => (
    statusMessageId && typingParentMessageId === null ? state.summaries[statusMessageId]?.participantIds : undefined
  ));
  const statusThreadWorking = useAgentTyping(
    statusMessageId && typingParentMessageId === null ? typingChannelId : null,
    statusMessageId,
  );

  const model = useMemo<AgentReadProgressModel | null>(() => {
    if (!watchScopeId || !positions) return null;
    const workingIds = new Set(working);
    const fallbackName = formatMessage({ id: "activity.live.agentFallback" });
    const agentsById = new Map<string, AgentReadFace>();
    for (const agentId of relevant) {
      const agent = agents.find((candidate) => candidate.id === agentId) ?? agentById?.get(agentId);
      agentsById.set(agentId, {
        agentId,
        name: agent?.displayName || agent?.name || fallbackName,
        avatarUrl: agent?.avatarUrl ?? null,
        working: workingIds.has(agentId),
      });
    }
    const facesByMessageId = new Map<string, AgentReadFace[]>();
    for (const [messageId, agentIds] of placeAgentReads(messages, positions, relevant, foldedMessageIds, hasNewer)) {
      facesByMessageId.set(messageId, agentIds.map((agentId) => agentsById.get(agentId)!));
    }
    const entries = projectAgentReadStatus(
      messages,
      statusMessageId,
      positions,
      relevant,
      statusThreadWorking.length > 0 ? [...working, ...statusThreadWorking] : working,
      statusThreadParticipants ?? [],
      stoppedFollowing,
      mutedChannel,
    );
    return {
      scopeId: watchScopeId,
      maxFaces: narrow ? AGENT_READ_MAX_FACES_NARROW : AGENT_READ_MAX_FACES,
      facesByMessageId,
      status: statusMessageId && entries ? { messageId: statusMessageId, entries } : null,
      agentsById,
    };
  }, [agentById, agents, foldedMessageIds, formatMessage, hasNewer, messages, narrow, positions, relevant, statusMessageId, statusThreadParticipants, statusThreadWorking, stoppedFollowing, mutedChannel, watchScopeId, working]);

  // Usage of the gated display (tygg, #proj-o11y:a5f3094f): the faces, and
  // the line under your message, each count once per conversation per page
  // load, when first generated here (placed on loaded rows; the virtualized
  // viewport is not checked). No ids go out (analytics/gatedFeatures.ts).
  const facesShown = model !== null && model.facesByMessageId.size > 0;
  const lineShown = model?.status != null;
  const conversation = scope?.type === "thread" ? "thread" : "channel";
  useEffect(() => {
    trackAgentReadProgressShown(watchScopeId, conversation, { faces: facesShown, notReachingLine: lineShown });
  }, [conversation, facesShown, lineShown, watchScopeId]);

  return { model, statusMessageId: model ? statusMessageId : null };
}
