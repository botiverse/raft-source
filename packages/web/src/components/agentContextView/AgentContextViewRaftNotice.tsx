import { Fragment, memo, useId, useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ChevronDown, ChevronUp, Inbox, Info, ListTodo } from "lucide-react";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockBody,
  CodeBlockHeader,
  CodeBlockPre,
  CodeBlockTitle,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
} from "@botiverse/raft-ui";
import { MessageIcon } from "@botiverse/ricons";

import type { MessageId } from "../../i18n/messages/en";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import CopyButton from "../ui/CopyButton";
import CopyIconButton from "../ui/CopyIconButton";
import { HighlightedPieces } from "./AgentContextViewText";
import type { PartSearch } from "./AgentContextViewText";
import { sliceAgentContextViewPieces, splitAgentContextViewHits } from "./agentContextViewMessageFilter";
import type { AgentContextViewTextPiece } from "./agentContextViewMessageFilter";
import type { RaftDelivery, RaftNoticeKind, RaftNoticeSegment } from "@botiverse/raft-shared";

type Notice = Exclude<RaftNoticeSegment, { kind: "text" }>;

const ICON: Record<RaftNoticeKind, ReactNode> = {
  inbox: <Inbox aria-hidden />,
  task: <ListTodo aria-hidden />,
  message: <MessageIcon aria-hidden />,
  generic: <Info aria-hidden />,
};

/** A header's `time=` (`2026-11-06 09:41:00Z`, UTC) as a Date; null when it doesn't read. */
function headerTime(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date;
}

function CopyOriginal({ text }: { text: string }) {
  const { formatMessage } = useIntl();
  return (
    <CopyButton text={text} resetKey={text}>
      {({ copied, disabled, onClick, onMouseDown }) => (
        <CopyIconButton
          onClick={onClick}
          onMouseDown={onMouseDown}
          disabled={disabled}
          copied={copied}
          copiedLabel={formatMessage({ id: "agentContextView.notice.copied" })}
          copyLabel={formatMessage({ id: "agentContextView.notice.copy" })}
          className="rounded-chip"
          data-testid="agent-context-view-notice-copy"
        />
      )}
    </CopyButton>
  );
}

/** A notice's parsed fields, as a description list (one per inbox target or task). */
function Fields({ notice }: { notice: Notice }) {
  const { formatMessage } = useIntl();
  const term = (id: MessageId) => formatMessage({ id });
  let groups: Array<Array<[string, string]>>;
  switch (notice.kind) {
    case "inbox":
      groups = notice.targets.map((target) => [
        [term("agentContextView.notice.field.target"), target.target],
        ...(target.pending === null ? [] : [[term("agentContextView.notice.field.unread"), String(target.pending)] as [string, string]]),
        ...(target.latestSender ? [[term("agentContextView.notice.field.latestSender"), `@${target.latestSender}`] as [string, string]] : []),
        ...(target.preview !== null ? [[term("agentContextView.notice.field.preview"), target.preview] as [string, string]] : []),
        ...(target.mentioned ? [[term("agentContextView.notice.field.mentioned"), term("agentContextView.notice.yes")] as [string, string]] : []),
      ]);
      break;
    case "task":
      groups = notice.tasks.map((task) => [
        [term("agentContextView.notice.field.task"), `${task.ref} ${task.title}`],
        [term("agentContextView.notice.field.status"), task.status],
        ...(task.why ? [[term("agentContextView.notice.field.why"), task.why] as [string, string]] : []),
      ]);
      break;
    case "message":
      groups = [notice.fields.map((field) => [field.key, field.value])];
      break;
    default:
      groups = notice.label ? [[[term("agentContextView.notice.field.kind"), notice.label]]] : [];
  }
  return groups.filter((group) => group.length > 0).map((group, index) => (
    <DescriptionList key={index} direction="horizontal" data-testid="agent-context-view-notice-fields">
      {group.map(([key, value], item) => (
        <DescriptionItem key={item}>
          <DescriptionTerm>{key}</DescriptionTerm>
          <DescriptionDetails className="min-w-0 whitespace-pre-wrap wrap-break-word">{value}</DescriptionDetails>
        </DescriptionItem>
      ))}
    </DescriptionList>
  ));
}

/** The one line a notice reads as, and what sits at its right (unread count, task status). */
function useSummary(notice: Notice): { summary: ReactNode; meta: string | null } {
  const { formatMessage } = useIntl();
  const { formatMessageTime } = useTimeFormatter();
  switch (notice.kind) {
    case "inbox": {
      const [only] = notice.targets;
      if (notice.targets.length === 1 && only) {
        return {
          summary: (
            <>
              <span className="font-semibold">{formatMessage({ id: "agentContextView.notice.inbox" }, { target: only.target })}</span>
              {only.latestSender ? <span className="ms-1.5 text-foreground-muted">{formatMessage({ id: "agentContextView.notice.newFrom" }, { sender: only.latestSender })}</span> : null}
            </>
          ),
          meta: only.pending === null ? null : formatMessage({ id: "agentContextView.notice.unread" }, { count: only.pending }),
        };
      }
      return {
        summary: <span className="font-semibold">{formatMessage({ id: "agentContextView.notice.inboxMany" }, { count: notice.targets.length })}</span>,
        meta: notice.pendingTotal === null ? null : formatMessage({ id: "agentContextView.notice.unread" }, { count: notice.pendingTotal }),
      };
    }
    case "task": {
      const [only] = notice.tasks;
      if (notice.tasks.length === 1 && only) {
        return { summary: <span className="font-semibold">{formatMessage({ id: "agentContextView.notice.task" }, { ref: only.ref, title: only.title })}</span>, meta: only.status };
      }
      return { summary: <span className="font-semibold">{formatMessage({ id: "agentContextView.notice.taskMany" }, { count: notice.count ?? notice.tasks.length })}</span>, meta: null };
    }
    case "message": {
      const target = notice.target ?? "";
      const time = headerTime(notice.time);
      return {
        summary: (
          <>
            <span className="font-semibold">
              {notice.sender
                ? formatMessage({ id: "agentContextView.notice.messageFrom" }, { sender: notice.sender, target })
                : formatMessage({ id: "agentContextView.notice.messageIn" }, { target })}
            </span>
            {time ? <span className="ms-1.5 font-mono text-mono-meta text-foreground-hint">{formatMessageTime(time)}</span> : null}
          </>
        ),
        meta: null,
      };
    }
    default:
      return {
        summary: (
          <>
            <span className="font-semibold">{formatMessage({ id: "agentContextView.notice.generic" })}</span>
            {notice.label ? <span className="ms-1.5 text-foreground-muted">{notice.label}</span> : null}
          </>
        ),
        meta: null,
      };
  }
}

/**
 * One notice: its one line (a button that opens it), a message's body always
 * shown under it; opened, its parsed fields and its original text (mono,
 * with a copy button). Search reads the original text: its matches are
 * marked there, and a closed notice says how many it holds.
 */
const NoticeRow = memo(function NoticeRow({ notice, text, pieces, open, segment, onToggle, search }: {
  notice: Notice;
  /** The whole part's text, which `notice` is a range of. */
  text: string;
  /** The text cut at search's matches once for the whole delivery (null without a search). */
  pieces: readonly AgentContextViewTextPiece[] | null;
  open: boolean;
  segment: number;
  onToggle: (segment: number) => void;
  search: PartSearch | null;
}) {
  const { formatMessage } = useIntl();
  const bodyId = useId();
  const { summary, meta } = useSummary(notice);
  const shown = useMemo(() => (pieces ? sliceAgentContextViewPieces(pieces, notice.start, notice.end) : null), [notice.end, notice.start, pieces]);
  const matches = open || !shown ? 0 : shown.filter((piece) => piece.hit !== null).length;
  return (
    <div className="min-w-0" data-testid="agent-context-view-notice" data-kind={notice.kind}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => onToggle(segment)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-callout outline-none hover:bg-fill-muted focus-visible:inset-ring-2 focus-visible:inset-ring-foreground"
        data-testid="agent-context-view-notice-toggle"
      >
        <span className="flex shrink-0 text-foreground-muted [&_svg]:size-4">{ICON[notice.kind]}</span>
        <span className="min-w-0 flex-1 truncate" data-testid="agent-context-view-notice-summary">{summary}</span>
        {matches > 0 ? (
          <span className="shrink-0 text-caption text-foreground" data-testid="agent-context-view-notice-matches">
            {formatMessage({ id: "agentContextView.search.partMatches" }, { count: matches })}
          </span>
        ) : null}
        {meta ? <span className="shrink-0 font-mono text-mono-meta text-foreground-hint" data-testid="agent-context-view-notice-meta">{meta}</span> : null}
        {open ? <ChevronUp aria-hidden className="size-4 shrink-0" /> : <ChevronDown aria-hidden className="size-4 shrink-0" />}
      </button>
      {notice.kind === "message" && notice.body ? (
        <p className="whitespace-pre-wrap wrap-break-word px-3 pb-2 ps-9 text-callout" data-testid="agent-context-view-notice-body">{notice.body}</p>
      ) : null}
      {open ? (
        <div id={bodyId} className="grid min-w-0 grid-cols-1 gap-2 px-3 pb-3 ps-9" data-testid="agent-context-view-notice-details">
          <Fields notice={notice} />
          <CodeBlock className="flex min-w-0 max-w-full flex-col">
            <CodeBlockHeader>
              <CodeBlockTitle>{formatMessage({ id: "agentContextView.notice.original" })}</CodeBlockTitle>
              <CodeBlockActions>
                <CopyOriginal text={text.slice(notice.start, notice.end)} />
              </CodeBlockActions>
            </CodeBlockHeader>
            <CodeBlockBody>
              <CodeBlockPre className="whitespace-pre-wrap wrap-break-word" data-testid="agent-context-view-notice-original">
                {shown ? <HighlightedPieces pieces={shown} search={search} /> : text.slice(notice.start, notice.end)}
              </CodeBlockPre>
            </CodeBlockBody>
          </CodeBlock>
        </div>
      ) : null}
    </div>
  );
});

/**
 * A user's text that Raft wrote (raftDeliveryParse in @botiverse/raft-shared), as a card:
 * several notices under "Raft delivered N notices" with their kinds' icons,
 * one alone without that line; the text between them (the envelope's "New
 * message received:") as muted lines, marked by search like the rest.
 */
export const AgentContextViewRaftDelivery = memo(function AgentContextViewRaftDelivery({ text, delivery, isOpen, onToggle, search }: {
  text: string;
  delivery: RaftDelivery;
  /** Whether the notice at a segment index is open (the list keeps it). */
  isOpen: (segment: number) => boolean;
  onToggle: (segment: number) => void;
  search: PartSearch | null;
}) {
  const { formatMessage } = useIntl();
  const pattern = search?.pattern ?? null;
  // Cut once per delivery and query; each notice and text line slices its range.
  const pieces = useMemo(() => (pattern ? splitAgentContextViewHits(text, pattern) : null), [pattern, text]);
  const kinds = useMemo(() => [...new Set(delivery.segments.flatMap((segment) => (segment.kind === "text" ? [] : [segment.kind])))], [delivery]);
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-line-hairline" data-testid="agent-context-view-delivery">
      {delivery.notices > 1 ? (
        <div className="flex items-center gap-2 border-b border-line-hairline px-3 py-2" data-testid="agent-context-view-delivery-header">
          <span className="min-w-0 flex-1 truncate font-semibold">{formatMessage({ id: "agentContextView.notice.delivered" }, { count: delivery.notices })}</span>
          <span className="flex shrink-0 items-center gap-1.5 text-foreground-muted [&_svg]:size-4">
            {kinds.map((kind) => <Fragment key={kind}>{ICON[kind]}</Fragment>)}
          </span>
        </div>
      ) : null}
      <div className="rule-y rule-line-hairline">
        {delivery.segments.map((segment, index) => (segment.kind === "text"
          ? (
            <p key={index} className="whitespace-pre-wrap wrap-break-word px-3 py-2 text-caption text-foreground-muted" data-testid="agent-context-view-delivery-text">
              {pieces ? <HighlightedPieces pieces={sliceAgentContextViewPieces(pieces, segment.start, segment.end)} search={search} /> : text.slice(segment.start, segment.end)}
            </p>
          )
          : <NoticeRow key={index} notice={segment} text={text} pieces={pieces} open={isOpen(index)} segment={index} onToggle={onToggle} search={search} />))}
      </div>
    </div>
  );
});
