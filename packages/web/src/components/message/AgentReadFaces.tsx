import { Fragment, memo, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { useIntl } from "react-intl";
import { BellOff, CheckCheck } from "lucide-react";
import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@botiverse/raft-ui";
import { UnfollowThreadIcon } from "@botiverse/ricons";
import { MessageItemTrailing } from "@botiverse/raft-ui/wip";
import { cn } from "@botiverse/raft-ui/cn";
import { AgentAvatar } from "../agent/PixelAvatar";
import Tooltip from "../ui/Tooltip";
import { useAgentDisplayState } from "../../store/agentStore";
import { formatActivityText } from "../../utils/activity";
import { AGENT_READ_STATUS_MESSAGE_IDS, agentReadStatusRuns, formatAgentReadStatus } from "../../store/agentReadProgressDomain";
import type { AgentReadStatusEntry, AgentReadStatusRun } from "../../store/agentReadProgressDomain";
import { AgentReadProgressContext } from "./agentReadProgressContext";
import type { AgentReadFace, AgentReadProgressModel } from "./agentReadProgressContext";
import { MessageReadStatusLine, ReadStatusSeparator } from "./MessageReadStatusLine";

/**
 * Agent read progress on the timeline (agent_read_progress_v0, artin's "A+B"):
 * A, each agent's 19px face on the last message it has read, at the end of
 * that message's last line (raft-ui MessageItemTrailing: no column of its own;
 * the text wraps under the faces only when the last line is full, and under a
 * code block or a table they sit on a line of their own); B, one line under
 * your latest message only when it will not reach an agent: one that stopped
 * following the thread or muted the channel, then what would reach them
 * (who read it is the faces' to say).
 *
 * MessageItem renders <AgentReadFaces> as the last child of its body while the
 * feature is on in the conversation (stdrc, 2026-11-05: the faces kept a
 * 63-77px column beside every row). Off, rows render exactly as before.
 *
 * Nothing animates when the faces change (Artea, 2026-11-08, #proj-raft-ui:
 * the slide from the row a face left read as a strange jump once several
 * agents read at once): a face that moves on leaves one row and is on the
 * other in the same frame, keyed by its agent so a face that stays is the
 * same node (raft-design: Conversation, "Who has read it").
 */

/** A working agent's tooltip also says what it is doing (its runtime status). */
function WorkingFaceTooltip({ agentId, name }: { agentId: string; name: string }) {
  const { formatMessage } = useIntl();
  const display = useAgentDisplayState(agentId);
  const activity = formatActivityText(formatMessage, display.activity, display.activityDetail, display.activityDetailKind, display.activityErrorCode);
  return <>{formatMessage({ id: "message.agentReadFaces.readUpToWorking" }, { name, activity })}</>;
}

function AgentReadFaceAvatar({ face }: { face: AgentReadFace }) {
  const { formatMessage } = useIntl();
  return (
    <Tooltip
      content={face.working
        ? <WorkingFaceTooltip agentId={face.agentId} name={face.name} />
        : formatMessage({ id: "message.agentReadFaces.readUpTo" }, { name: face.name })}
    >
      {/* raft-ui Avatar itself, not AvatarSlot: the tooltip trigger needs
          the sticker's own element, and AvatarGroup overlaps its direct
          children. The face and fill are AvatarSlot's agent branch.
          Working: the still busy light (DS: status never moves). */}
      <Avatar
        size="2xs"
        type="agent"
        data-slot="avatar"
        data-agent-id={face.agentId}
        data-working={face.working ? "true" : undefined}
      >
        <AvatarFallback className="relative overflow-hidden">
          <AgentAvatar avatarUrl={face.avatarUrl} />
        </AvatarFallback>
        {face.working ? <AvatarBadge presence="busy" /> : null}
      </Avatar>
    </Tooltip>
  );
}

/** The read mark and the faces of the agents that stopped on a row. */
function AgentReadFaceGroup({ faces, model }: { faces: readonly AgentReadFace[]; model: AgentReadProgressModel }) {
  const { formatMessage, formatList } = useIntl();
  const shown = faces.slice(0, model.maxFaces);
  const rest = faces.slice(model.maxFaces);
  return (
    <div className="flex items-center gap-1">
      {/* The read mark (artin: a face alone at the row's end didn't say
          "read"): the DM "Read" line's double check, in its hint colour. */}
      <CheckCheck size={12} className="shrink-0 text-foreground-hint" aria-hidden data-testid="agent-read-mark" />
      <AvatarGroup
        role="group"
        aria-label={formatMessage(
          { id: "message.agentReadFaces.groupLabel" },
          { names: formatList(faces.map((face) => face.name), { type: "conjunction" }) },
        )}
        data-testid="agent-read-faces"
      >
        {shown.map((face) => (
          <AgentReadFaceAvatar key={face.agentId} face={face} />
        ))}
        {rest.length > 0 ? (
          <Tooltip
            content={formatMessage(
              { id: "message.agentReadFaces.moreNames" },
              { names: formatList(rest.map((face) => face.name), { type: "conjunction" }) },
            )}
          >
            <AvatarGroupCount size="2xs" data-slot="avatar-group-count" data-testid="agent-read-faces-more">
              {formatMessage({ id: "message.agentReadStatus.more" }, { count: rest.length })}
            </AvatarGroupCount>
          </Tooltip>
        ) : null}
      </AvatarGroup>
    </div>
  );
}

/** The faces of one message: the end of its body's last line, empty when no agent stopped here. */
export const AgentReadFaces = memo(function AgentReadFaces({ messageId }: { messageId: string }) {
  const model = useContext(AgentReadProgressContext);
  if (!model) return null;
  const faces = model.facesByMessageId.get(messageId);
  // Reads arrive in realtime: the slot is there from the first frame, empty,
  // as wide as its smallest content (the read mark and one face: 12 + 4 + 19),
  // so the row doesn't move when the first face arrives (raft-ui
  // MessageItemTrailing, Kirby's review 2026-11-05).
  const empty = !faces || faces.length === 0;
  return (
    <MessageItemTrailing
      className={empty ? "min-w-[35px]" : "gap-1"}
      data-testid="agent-read-column"
      data-message-affordance="agent-read-faces"
    >
      {empty ? null : <AgentReadFaceGroup faces={faces} model={model} />}
    </MessageItemTrailing>
  );
});

/**
 * A system line or a system group's header with the faces of the agents that
 * stopped on it at the row's end. A system line has no body for
 * MessageItemTrailing to end, so the faces sit beside it, level with its one
 * line of text (the line's lead above, its row inset below), in a slot as wide
 * as its smallest content from the first frame, like a message's.
 */
export function AgentReadSystemRow({ messageId, children }: { messageId: string; children: ReactNode }) {
  const model = useContext(AgentReadProgressContext);
  if (!model) return <>{children}</>;
  const faces = model.facesByMessageId.get(messageId);
  return (
    <div className="flex min-w-0 items-start">
      <div className="min-w-0 flex-1">{children}</div>
      <div
        className="me-[var(--message-rail-inset,0px)] flex min-w-[35px] shrink-0 items-center justify-end pt-timeline-lead pb-timeline-row h-[calc(var(--spacing-timeline-lead)+var(--text-mono-meta--line-height)+var(--spacing-timeline-row))]"
        data-testid="agent-read-column"
        data-message-affordance="agent-read-faces"
      >
        {faces && faces.length > 0 ? <AgentReadFaceGroup faces={faces} model={model} /> : null}
      </div>
    </div>
  );
}

const NAMES_SLOT = <Fragment />;

type FormatMessage = ReturnType<typeof useIntl>["formatMessage"];

/** One piece of a segment's own message, around its `{names}` slot. */
interface SegmentPiece {
  text: string;
  /** Right before or after the slot: the row's gap is taken back on that side. */
  beforeSlot: boolean;
  afterSlot: boolean;
}

/**
 * One segment of the B line, ready to draw: its message split around the
 * `{names}` slot (the verb, as the catalog writes it, with its punctuation:
 * "Muted:", "已静音："), the catalog's spacing at the slot's edges ("Muted: "),
 * which goes with whatever fills the slot, and what can fill it: the names
 * and "+N", or the count.
 */
interface StatusSegment {
  run: AgentReadStatusRun;
  /** Text pieces in order; null is the slot. */
  pieces: ReadonlyArray<SegmentPiece | null>;
  lead: string;
  tail: string;
  /** "+2" when names are folded, else null. */
  moreText: string | null;
  /** "4 agents": the slot when not one name fits. */
  countText: string;
}

function statusSegment(run: AgentReadStatusRun, formatMessage: FormatMessage): StatusSegment {
  const parts = formatMessage({ id: AGENT_READ_STATUS_MESSAGE_IDS[run.state] }, { names: NAMES_SLOT });
  const chunks = Array.isArray(parts) ? parts : [parts];
  const isSlot = (index: number) => index >= 0 && index < chunks.length && typeof chunks[index] !== "string";
  let lead = "";
  let tail = "";
  const pieces = chunks.map((part, index): SegmentPiece | null => {
    if (typeof part !== "string") return null;
    const beforeSlot = isSlot(index + 1);
    const afterSlot = isSlot(index - 1);
    let text = part;
    if (beforeSlot) {
      const trimmed = text.trimEnd();
      lead = text.slice(trimmed.length);
      text = trimmed;
    }
    if (afterSlot) {
      const trimmed = text.trimStart();
      tail = text.slice(0, text.length - trimmed.length);
      text = trimmed;
    }
    return { text, beforeSlot, afterSlot };
  });
  return {
    run,
    pieces,
    lead,
    tail,
    moreText: run.more > 0 ? formatMessage({ id: AGENT_READ_STATUS_MESSAGE_IDS.more }, { count: run.more }) : null,
    countText: formatMessage({ id: AGENT_READ_STATUS_MESSAGE_IDS.agentCount }, { count: run.total }),
  };
}

/**
 * One segment of the B line: its verb, whole, then the names and "+N", or,
 * when not one name fits (`countForm`), the count ("Muted: 4 agents"). The
 * verb is the segment's message itself, around its `{names}` slot, so no glue
 * is added here and a locale may put the names first. Every part is an item
 * of the line's row (the wrappers are `display: contents`;
 * MessageReadStatusLine):
 *
 * - The names are `basis-0 grow max-w-max`: they take only the room the
 *   rest leaves, up to their own width, so they never make the line
 *   overflow; with room to spare they are exactly as wide as their text
 *   (the line sizes itself to every part's natural width). With too little,
 *   they take the ellipsis.
 * - The hint (MessageReadStatusLine) is the only part that shrinks: once the
 *   verbs, the counts, the "·" and the hint don't fit, it loses its tail.
 * - The verbs, "+N", the count, the icon and the "·" never shrink.
 *
 * The row's gap-1 spaces the parts. Between a verb and its slot the
 * catalog's spacing is the spacing: the verb takes the gap back on the slot's
 * side, and the catalog's space there ("Muted: ") moves into the slot's text.
 */
function AgentReadStatusSegment({ segment, countForm }: { segment: StatusSegment; countForm: boolean }) {
  const { run, lead, tail } = segment;
  return (
    <span className="contents" data-slot="read-status-segment">
      {segment.pieces.map((piece, index) => {
        if (piece === null) {
          return countForm ? (
            <span key={`count-${index}`} className="shrink-0 whitespace-pre" data-slot="read-status-count">
              {lead}{segment.countText}{tail}
            </span>
          ) : (
            <Fragment key={`names-${index}`}>
              {/* whitespace-pre (not truncate's nowrap): keeps the catalog's space at its edge. */}
              <span
                className="min-w-0 max-w-max grow basis-0 overflow-hidden text-ellipsis whitespace-pre"
                data-slot="read-status-names-text"
              >
                {lead}{run.names}{tail}
              </span>
              {segment.moreText !== null ? (
                <span className="shrink-0" data-slot="read-status-more">{segment.moreText}</span>
              ) : null}
            </Fragment>
          );
        }
        if (piece.text === "") return null;
        return (
          <span
            key={`verb-${index}`}
            className={cn("shrink-0 whitespace-pre", piece.afterSlot && "-ms-1", piece.beforeSlot && "-me-1")}
            data-slot="read-status-verb"
          >
            {piece.text}
          </span>
        );
      })}
    </span>
  );
}

/** The B line's segments, a "·" between them. */
function AgentReadStatusSegments({ segments, countForms }: { segments: readonly StatusSegment[]; countForms: readonly boolean[] }) {
  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={segment.run.state}>
          {index > 0 ? <ReadStatusSeparator /> : null}
          <AgentReadStatusSegment segment={segment} countForm={countForms[index] === true} />
        </Fragment>
      ))}
    </>
  );
}

/** How narrow the names may get before not one fits: their first letters and the ellipsis. */
const NAMES_MIN_EM = 2;
const NO_COUNT_FORMS: readonly boolean[] = [];

/** Each text's natural width in the line's own font and language: off-flow spans, added and removed in one go. */
function measureTexts(line: HTMLElement, texts: readonly string[]): number[] {
  const probes = texts.map((text) => {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;pointer-events:none";
    probe.textContent = text;
    line.appendChild(probe);
    return probe;
  });
  const widths = probes.map((probe) => probe.getBoundingClientRect().width);
  for (const probe of probes) probe.remove();
  return widths;
}

/**
 * Which segments show their count instead of names, for the row's width.
 * Names stay while every segment fits at least its first letters
 * (NAMES_MIN_EM, or the whole names if shorter) beside the rest of the line
 * at its natural width, the hint whole. Otherwise segments turn to their
 * count from the last back, until the line fits or all are counts (then the
 * hint gives way, in CSS). Only the row's width and the texts decide, never
 * what is drawn now, so a change of form can't feed back into the next.
 */
function countFormsFor(row: HTMLElement, segments: readonly StatusSegment[], hint: string): boolean[] {
  const forms = segments.map(() => false);
  const line = row.querySelector<HTMLElement>('[data-message-affordance="agent-read-status"]');
  if (!line) return forms;
  const style = getComputedStyle(line);
  const gap = Number.parseFloat(style.columnGap) || 0;
  const em = Number.parseFloat(style.fontSize) || 0;
  const available = row.getBoundingClientRect().width;
  const icon = line.firstElementChild?.getBoundingClientRect().width ?? 0;
  const separator = line.querySelector('[data-slot="read-status-separator"]')?.getBoundingClientRect().width ?? 0;
  const texts = [hint];
  for (const segment of segments) {
    texts.push(
      segment.pieces.map((piece) => piece?.text ?? "").join(""),
      segment.lead + segment.run.names + segment.tail,
      segment.lead + segment.tail,
      segment.moreText ?? "",
      segment.lead + segment.countText + segment.tail,
    );
  }
  const widths = measureTexts(line, texts);
  const hintWidth = widths[0]!;
  let required = icon + gap + (segments.length - 1) * (2 * gap + separator) + 2 * gap + separator + hintWidth;
  const savings = segments.map((segment, index) => {
    const [verb, names, edges, more, count] = widths.slice(1 + index * 5, 6 + index * 5) as [number, number, number, number, number];
    const withNames = verb + Math.min(names, edges + NAMES_MIN_EM * em) + (segment.moreText !== null ? gap + more : 0);
    required += withNames;
    return withNames - (verb + count);
  });
  for (let index = segments.length - 1; index >= 0 && required > available + 0.5; index -= 1) {
    forms[index] = true;
    required -= savings[index]!;
  }
  return forms;
}

function sameForms(left: readonly boolean[], right: readonly boolean[]): boolean {
  return left.length === right.length && left.every((form, index) => form === right[index]);
}

/**
 * The count forms for the line's row, measured: on mount, when the row's
 * width changes (a ResizeObserver on the row, which is as wide as the
 * message's content whatever the line draws) and when the fonts are in. Only
 * the one message that carries the line mounts this.
 */
function useCountForms(rowRef: RefObject<HTMLDivElement | null>, segments: readonly StatusSegment[], hint: string): readonly boolean[] {
  const [forms, setForms] = useState<readonly boolean[]>(NO_COUNT_FORMS);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const next = countFormsFor(row, segments, hint);
      setForms((current) => (sameForms(current, next) ? current : next));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(row);
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) update();
    });
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [rowRef, segments, hint]);
  return forms;
}

/**
 * B: the line under your latest message, the DM "Read" line's slot and
 * component (MessageReadStatusLine), there only when the message will not
 * reach some agent. Renders nothing unless this is the message the model's
 * status is for.
 */
export function AgentReadStatusLine({ messageId }: { messageId: string }) {
  const model = useContext(AgentReadProgressContext);
  const status = model?.status;
  if (!model || !status || status.messageId !== messageId || status.entries.length === 0) return null;
  return <AgentReadStatusLineBody entries={status.entries} agentsById={model.agentsById} />;
}

function AgentReadStatusLineBody({
  entries,
  agentsById,
}: {
  entries: readonly AgentReadStatusEntry[];
  agentsById: AgentReadProgressModel["agentsById"];
}) {
  const intl = useIntl();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const fallbackName = intl.formatMessage({ id: "activity.live.agentFallback" });
  const format = (maxNames?: number, hint?: string) => formatAgentReadStatus(
    entries,
    (agentId) => agentsById.get(agentId)?.name ?? fallbackName,
    intl.formatMessage,
    (names) => intl.formatList(names, { type: "conjunction" }),
    maxNames,
    hint,
  );
  const segments = useMemo(() => agentReadStatusRuns(
    entries,
    (agentId) => agentsById.get(agentId)?.name ?? fallbackName,
    (names) => intl.formatList(names, { type: "conjunction" }),
  ).map((run) => statusSegment(run, intl.formatMessage)), [agentsById, entries, fallbackName, intl]);
  // Visible: the segments, cut to AGENT_READ_STATUS_MAX_NAMES names, then
  // what would reach them (Jasper, raft-design #1061). On a narrow width the
  // names give way to the ellipsis first; when not one name fits, a segment
  // shows its count instead ("Muted: 4 agents", Kirby: a lone "+1" read as
  // one more agent); each verb, count and "·" stays whole, and the hint
  // loses its tail only when even that is too wide. The tooltip has every
  // name and no hint (it is on the line already); the label reads it all
  // once: every name, then the whole hint (the visible parts are not read on
  // their own).
  const hint = intl.formatMessage({ id: "message.agentReadStatus.stoppedFollowingHint" });
  const countForms = useCountForms(rowRef, segments, hint);
  // The icon the menus use for it, for the line's first segment (entries come
  // sorted): Unfollow for a thread, the channel mute's bell for a muted channel.
  return (
    <MessageReadStatusLine
      rowRef={rowRef}
      testId="agent-read-status"
      affordance="agent-read-status"
      icon={entries[0]!.state === "stoppedFollowing"
        ? <UnfollowThreadIcon width={12} height={12} className="shrink-0" aria-hidden />
        : <BellOff size={12} className="shrink-0" aria-hidden />}
      text={<AgentReadStatusSegments segments={segments} countForms={countForms} />}
      hint={hint}
      label={intl.formatMessage({ id: "message.agentReadStatus.label" }, { status: format(entries.length, hint) })}
      tooltip={format(entries.length)}
      truncate
    />
  );
}
