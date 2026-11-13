import { memo, useMemo } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { selectTypingAgentIds, useAgentTyping, useAgentTypingStore } from "../../store/agentTypingStore";
import { useAgentStore } from "../../store/agentStore";
import { useAppearanceStore } from "../../store/appearanceStore";
import { WORKING_ID_SEPARATOR } from "../../features/channel/chatPanelHelpers";
import { useLiveAgentActivityStore } from "../../store/liveAgentActivityStore";
import type { LiveAgentActivityItem } from "../../utils/liveAgentActivity";
import { WorkingFaces, WorkingNowPopover } from "../layout/WorkingNowSummary";
import { useChannelWorkingAgents } from "./useChannelWorkingAgents";

/**
 * Agent typing line (raft-design 0042, stdrc #proj-chat:ce40cff2): who is
 * about to post here. Up to three still 19px faces and one muted sentence.
 * Nothing moves — no dots, no shimmer, no entrance.
 */

const SENTENCE_IDS = {
  typing: {
    one: "message.agentTyping.typing.one",
    two: "message.agentTyping.typing.two",
    three: "message.agentTyping.typing.three",
    many: "message.agentTyping.typing.many",
  },
  replying: {
    one: "message.agentTyping.replying.one",
    two: "message.agentTyping.replying.two",
    three: "message.agentTyping.replying.three",
    many: "message.agentTyping.replying.many",
  },
} as const;

/** "Niko is typing…", "Niko and Kirby are typing…", "Niko, Kirby and Tenny are
 *  typing…", "Niko, Kirby and 3 other agents are typing…" (`replying`: the
 *  thread hint under a parent message). Empty for nobody. */
export function formatAgentTypingSentence(
  formatMessage: IntlShape["formatMessage"],
  kind: keyof typeof SENTENCE_IDS,
  names: readonly string[],
): string {
  const ids = SENTENCE_IDS[kind];
  const [first, second, third] = names;
  if (names.length === 0) return "";
  if (names.length === 1) return formatMessage({ id: ids.one }, { first });
  if (names.length === 2) return formatMessage({ id: ids.two }, { first, second });
  if (names.length === 3) return formatMessage({ id: ids.three }, { first, second, third });
  return formatMessage({ id: ids.many }, { first, second, others: names.length - 2, count: names.length });
}

interface TypingAgent {
  agentId: string;
  agentName: string;
  agentAvatarUrl: string | null;
}

/** The typing agents of one conversation, named from the agent store, or
 *  nothing while the Live agent activity setting is off. */
function useTypingAgents(channelId: string | null | undefined, parentMessageId: string | null): TypingAgent[] {
  const { formatMessage } = useIntl();
  const visible = useAppearanceStore((state) => state.showLiveAgentActivityBar);
  const agentIds = useAgentTyping(visible ? channelId : null, parentMessageId);
  const agents = useAgentStore((state) => state.agents);
  return useMemo(() => {
    if (agentIds.length === 0) return [];
    const fallback = formatMessage({ id: "activity.live.agentFallback" });
    return agentIds.map((agentId) => {
      const agent = agents.find((item) => item.id === agentId);
      return {
        agentId,
        agentName: agent?.displayName || agent?.name || fallback,
        agentAvatarUrl: agent?.avatarUrl ?? null,
      };
    });
  }, [agentIds, agents, formatMessage]);
}

/** Whether anyone is about to post into this conversation (false while the
 *  Live agent activity setting is off). Re-renders only when that flips. */
function useAgentTypingShown(channelId: string | null | undefined, parentMessageId: string | null): boolean {
  const visible = useAppearanceStore((state) => state.showLiveAgentActivityBar);
  return useAgentTypingStore((state) => (
    visible && selectTypingAgentIds(state, channelId, parentMessageId).length > 0
  ));
}

/**
 * For the list's bottom MessageListJumpControls (Back to bottom, the
 * unread-thread pill), which come after AgentTypingLine in the same
 * container: while the line shows, `--message-list-bottom-inset` is its
 * 24px row, so they sit 12px above it instead of 12px above the list's edge
 * and the two never overlap (raft-ui message-list.md, "Jump controls"). CSS
 * only (a sibling selector), so the panel does not re-render when typing
 * starts and stops. While select mode floats its toolbar over the list's
 * bottom, the list's container sets `--select-mode-reserve` (the toolbar's
 * room, SELECT_MODE_LIST_RESERVE_CLASS) and both sit that much higher.
 */
export const ABOVE_AGENT_TYPING_LINE_CLASS = [
  "[--message-list-bottom-inset:var(--select-mode-reserve,0px)]",
  "peer-data-[agent-typing=shown]/agent-typing:[--message-list-bottom-inset:calc(var(--select-mode-reserve,0px)+--spacing(6))]",
].join(" ");

/**
 * For the list's end fade (raft-ui MessageListEndFade, rendered after
 * AgentTypingLine in the same container): while the line shows, the fade
 * grows by the line's 24px row and that row is solid panel colour, so the
 * line gets its own ground and the same fade runs above it. A message
 * scrolled under the line no longer shows through it. CSS only, like the
 * jump controls above; no motion, like the line itself.
 */
export const END_FADE_UNDER_AGENT_TYPING_LINE_CLASS = [
  "peer-data-[agent-typing=shown]/agent-typing:h-[calc(var(--spacing-timeline-section)-(--spacing(2))+(--spacing(6)))]",
  "peer-data-[agent-typing=shown]/agent-typing:[--tw-gradient-from-position:--spacing(6)]",
].join(" ");

/**
 * The agent typing line (task #120): floats over the bottom of a
 * conversation's message list, directly above the composer, on the
 * composer's 20px edge. No reserved slot: nothing above the composer while
 * nobody types, and the composer never moves when the line comes and goes.
 * It has no fade of its own: the list's end fade (MessageListEndFade,
 * rendered just after it) grows under it while it shows, one step below it
 * (END_FADE_UNDER_AGENT_TYPING_LINE_CLASS).
 *
 * Render it inside the list's positioned container, next to the timeline.
 * In select mode it sits above the floating toolbar (`--select-mode-reserve`).
 * It stays mounted (the strip is `hidden` while nobody types): WebKit
 * restyles the whole timeline subtree when its parent's child list changes,
 * and the live region must already be in the page to be heard.
 *
 * In a channel (`workingAgentIdKey`, the channel's agents; not a DM, a
 * lounge or a thread) the line says who is working here, typing included
 * (stdrc: typing is one kind of working): the working agents' faces in the
 * order they started, then any typer not among them; "3 agents working here",
 * or the typing sentence and " · 2 others working". It is a button that opens
 * Working now for them, upward from the line. Only typing is announced.
 */
export const AgentTypingLine = memo(function AgentTypingLine({
  channelId,
  parentMessageId,
  workingAgentIdKey,
}: {
  channelId: string | null | undefined;
  /** The thread's root message in a thread panel; null for the channel itself. */
  parentMessageId: string | null;
  /** A channel's agent ids (WORKING_ID_SEPARATOR): the line also says who works here. Unset in a DM, a lounge, a thread. */
  workingAgentIdKey?: string;
}) {
  const { formatMessage } = useIntl();
  const typing = useTypingAgents(channelId, parentMessageId);
  const working = useChannelWorkingAgents(workingAgentIdKey);
  const typingSentence = formatAgentTypingSentence(formatMessage, "typing", typing.map((agent) => agent.agentName));
  const inChannel = workingAgentIdKey !== undefined;
  const { faces, rows, typingIds } = useMemo(() => {
    const typingIds = new Set(typing.map((agent) => agent.agentId));
    const workingIds = new Set(working.map((item) => item.agentId));
    const extraTypers = typing.filter((agent) => !workingIds.has(agent.agentId));
    return {
      faces: [...working, ...extraTypers],
      rows: [...working, ...extraTypers.map(typerRow)],
      typingIds,
    };
  }, [typing, working]);
  const shownFaces = inChannel ? faces : typing;
  const others = working.filter((item) => !typingIds.has(item.agentId)).length;
  const sentence = !inChannel || (typing.length > 0 && others === 0)
    ? typingSentence
    : typing.length === 0
      ? formatMessage({ id: "message.agentTyping.workingHere" }, { count: faces.length })
      : formatMessage({ id: "message.agentTyping.typingAndOthers" }, { typing: typingSentence, others });
  const shown = shownFaces.length > 0;
  return (
    <div
      data-agent-typing={shown ? "shown" : undefined}
      className="peer/agent-typing pointer-events-none absolute inset-x-0 bottom-[var(--select-mode-reserve,0px)] z-float"
    >
      <span role="status" data-testid="agent-typing-status" className="sr-only">{typingSentence}</span>
      <div data-testid="agent-typing-line" className="relative h-6" hidden={!shown}>
        {shown && inChannel ? (
          <div className="absolute inset-x-5 bottom-0 flex h-6 min-w-0 items-center">
            <WorkingNowPopover
              items={rows}
              typingAgentIds={typingIds}
              label={sentence}
              side="top"
              align="start"
              testId="agent-typing-trigger"
              className="group pointer-events-auto -mx-1 flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-control px-1 text-left text-footnote text-foreground-muted outline-none focus-visible:shadow-focus"
            >
              <WorkingFaces items={faces} still testId="agent-typing-faces" />
              <span className="min-w-0 truncate decoration-[1.5px] underline-offset-[3px] group-hover:underline">{sentence}</span>
            </WorkingNowPopover>
          </div>
        ) : shown ? (
          <div
            aria-hidden="true"
            className="absolute inset-x-5 bottom-0 flex h-6 min-w-0 items-center gap-1.5 text-footnote text-foreground-muted"
          >
            <WorkingFaces items={typing} still testId="agent-typing-faces" />
            <span className="min-w-0 truncate">{sentence}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
});

/** Working now's row for an agent about to post that the live-activity feed
 *  has not reported working (its row reads "Typing…" all the same). */
function typerRow(agent: TypingAgent): LiveAgentActivityItem {
  return {
    id: `typing-${agent.agentId}`, kind: "message", agentId: agent.agentId, agentName: agent.agentName,
    agentAvatarUrl: agent.agentAvatarUrl, text: "", context: null, activity: null,
    createdAt: 0, startedAt: 0, idleSince: null,
  };
}

/**
 * The list's extra end while the typing line shows, on top of the list's
 * own end (a section step above the composer): the last message stays whole
 * above the line, with room between them. Goes in the timeline footer; MessageTimeline keeps a reader who
 * follows the bottom pinned when it appears, and holds the reading position
 * of one scrolled up. Nothing while the line is hidden: in a channel
 * (`workingAgentIdKey`), while nobody types or works here.
 */
export const AgentTypingListEnd = memo(function AgentTypingListEnd({
  channelId,
  parentMessageId,
  workingAgentIdKey,
}: {
  channelId: string | null | undefined;
  parentMessageId: string | null;
  workingAgentIdKey?: string;
}) {
  const typing = useAgentTypingShown(channelId, parentMessageId);
  const working = useAnyChannelAgentWorking(workingAgentIdKey);
  return typing || working ? <div aria-hidden="true" data-testid="agent-typing-list-end" className="h-7.5" /> : null;
});

/** Whether any of a channel's agents is at work (false while the setting is
 *  off). Re-renders only when that flips. */
function useAnyChannelAgentWorking(agentIdKey: string | undefined): boolean {
  const visible = useAppearanceStore((state) => state.showLiveAgentActivityBar);
  const ids = useMemo(() => new Set(agentIdKey ? agentIdKey.split(WORKING_ID_SEPARATOR) : []), [agentIdKey]);
  return useLiveAgentActivityStore((state) => visible && state.items.some((item) => ids.has(item.agentId)));
}

/**
 * Under a parent message in the channel: "Niko is replying" while an agent is
 * about to post into its thread (even one with no replies yet). Takes no space
 * when nobody is.
 */
export const AgentReplyingHint = memo(function AgentReplyingHint({
  channelId,
  parentMessageId,
}: {
  channelId: string;
  parentMessageId: string;
}) {
  const { formatMessage } = useIntl();
  const typing = useTypingAgents(channelId, parentMessageId);
  if (typing.length === 0) return null;
  return (
    <div
      role="status"
      data-testid="agent-replying-hint"
      className="mt-1 flex min-w-0 items-center gap-1.5 text-footnote text-foreground-muted"
    >
      <WorkingFaces items={typing} still testId="agent-replying-faces" />
      <span className="min-w-0 truncate">
        {formatAgentTypingSentence(formatMessage, "replying", typing.map((agent) => agent.agentName))}
      </span>
    </div>
  );
});
