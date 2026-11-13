import { memo, useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { CircleHelp, Image as ImageIcon, ScrollText, User } from "lucide-react";
import {
  Badge,
  MessageItem,
  MessageItemAvatarSlot,
  MessageItemGutter,
  MessageItemHeader,
  MessageItemSender,
  MessageItemSenderGroup,
} from "@botiverse/raft-ui";
import type { AgentContextViewMessage, AgentContextViewPart, AgentContextViewTrigger, RaftDelivery } from "@botiverse/raft-shared";

import type { MessageId } from "../../i18n/messages/en";
import { formatFileSizeBytes } from "../../utils/fileSizePresentation";
import AvatarSlot from "../ui/AvatarSlot";
import { AgentContextViewRaftDelivery } from "./AgentContextViewRaftNotice";
import { CodeCard, FoldedText, Hint } from "./AgentContextViewText";
import type { PartSearch } from "./AgentContextViewText";
import { ToolCall, ToolResult } from "./AgentContextViewToolCall";
import { AgentContextViewSendStep, AgentContextViewToolStep } from "./AgentContextViewToolStep";
import { agentContextViewDelivery, agentContextViewNoticeKey, agentContextViewPartKey } from "./agentContextViewMessageFilter";
import type {
  AgentContextViewMatch,
  AgentContextViewPairs,
  AgentContextViewRow,
  AgentContextViewTurn,
  AgentContextViewTurnKind,
} from "./agentContextViewMessageFilter";

type ToolUsePart = Extract<AgentContextViewPart, { kind: "tool_use" }>;
type ToolResultPart = Extract<AgentContextViewPart, { kind: "tool_result" }>;

/** Which of the list's folds: a step or result opened, a long text's first lines, a Raft notice opened. */
export type FoldKind = "result" | "text" | "notice";
export type ToggleFold = (kind: FoldKind, key: string) => void;
/** The list's folds that are open, by key (agentContextViewPartKey; a notice's adds its segment): kept by the list, not the rows, which unmount as they scroll out. */
export type Folds = { result: ReadonlySet<string>; text: ReadonlySet<string>; notice: ReadonlySet<string> };

const Part = memo(function Part({ part, call, partKey, resultOpen, textOpen, onToggle, pattern, hit }: {
  part: AgentContextViewPart;
  /** A result's call, when the context has it. */
  call: ToolUsePart | null;
  partKey: string;
  resultOpen: boolean;
  textOpen: boolean;
  onToggle: ToggleFold;
  pattern: RegExp | null;
  /** The current match, when it is in this part. */
  hit: number | null;
}) {
  const { formatMessage } = useIntl();
  const toggleText = useCallback(() => onToggle("text", partKey), [onToggle, partKey]);
  const toggleResult = useCallback(() => onToggle("result", partKey), [onToggle, partKey]);
  const search = useMemo(() => (pattern ? { pattern, hit } : null), [hit, pattern]);
  switch (part.kind) {
    case "text":
      return <FoldedText text={part.text} markdown open={textOpen} onToggle={toggleText} search={search} testId="agent-context-view-text" />;
    case "thinking":
      return part.text === null
        ? (
          <span className="flex">
            <Badge appearance="soft" variant="muted" data-testid="agent-context-view-thinking-hidden">
              {formatMessage({ id: "agentContextView.part.thinkingHiddenBadge" })}
            </Badge>
          </span>
        )
        : <CodeCard title={formatMessage({ id: "agentContextView.part.thinking" })} text={part.text} open={textOpen} onToggle={toggleText} search={search} />;
    case "tool_use":
      return <ToolCall part={part} open={textOpen} onToggle={toggleText} search={search} />;
    case "tool_result":
      return <ToolResult part={part} call={call} expanded={resultOpen} onExpand={toggleResult} textOpen={textOpen} onToggleText={toggleText} search={search} />;
    case "image":
      return (
        <Hint icon={<ImageIcon />}>
          {formatMessage(
            { id: "agentContextView.part.image" },
            {
              type: part.mediaType ?? formatMessage({ id: "agentContextView.unknown" }),
              size: part.sizeBytes === null ? formatMessage({ id: "agentContextView.unknown" }) : formatFileSizeBytes(part.sizeBytes, formatMessage),
            },
          )}
        </Hint>
      );
    case "compaction":
      return (
        <div className="grid min-w-0 grid-cols-1 gap-2">
          <p className="flex items-center gap-3 text-callout text-foreground-muted before:h-px before:flex-1 before:bg-line-hairline after:h-px after:flex-1 after:bg-line-hairline">
            {formatMessage({ id: "agentContextView.part.compacted" })}
          </p>
          {part.text === null
            ? <Hint>{formatMessage({ id: "agentContextView.part.compactionEncrypted" })}</Hint>
            : <CodeCard title={formatMessage({ id: "agentContextView.part.summary" })} text={part.text} open={textOpen} onToggle={toggleText} search={search} />}
        </div>
      );
    default:
      return <Hint icon={<CircleHelp />} testId="agent-context-view-unknown-part">{formatMessage({ id: "agentContextView.part.unknown" }, { kind: part.originalKind })}</Hint>;
  }
});

/** Who a row is from, as its header shows it: the agent, or the system, the user or a tool. */
type Speaker = "agent" | "system" | "user" | "tool";

const SPEAKER_NAME: Record<Exclude<Speaker, "agent">, MessageId> = {
  system: "agentContextView.role.system",
  user: "agentContextView.role.user",
  tool: "agentContextView.role.tool",
};

/** A user message holding only tool results (as Claude's format sends them) is the tools speaking. */
function speakerOf(message: AgentContextViewMessage, parts: readonly number[]): Speaker {
  if (message.role === "assistant") return "agent";
  if (message.role === "user" && parts.length > 0 && parts.every((index) => message.parts[index]?.kind === "tool_result")) return "tool";
  return message.role;
}

const TURN_NAME: Record<Exclude<AgentContextViewTurnKind, "agent">, MessageId> = {
  system: "agentContextView.role.system",
  user: "agentContextView.role.user",
};

/** A turn's mark on the rail: the agent's avatar, or the user's or the system's icon in a circle. */
function TurnMark({ kind, agentAvatarUrl }: { kind: AgentContextViewTurnKind; agentAvatarUrl: string | null }) {
  if (kind === "agent") return <AvatarSlot context="message-row" type="agent" agentAvatarUrl={agentAvatarUrl} />;
  return (
    <span className="flex size-7 items-center justify-center rounded-full bg-layer-canvas text-foreground-muted ring-1 ring-line-hairline [&_svg]:size-4">
      {kind === "user" ? <User aria-hidden /> : <ScrollText aria-hidden />}
    </span>
  );
}

/** What a part shows in a row: a step, the send step, Raft's notices, or the part as it is. */
/** A step joins its neighbours into one card: `top` / `bottom`, the step just above / below is one too. */
type Join = { top: boolean; bottom: boolean };
type RowItem = { key: string; step: boolean; node: (join: Join) => ReactNode };

/**
 * One message on the timeline: a turn's first row carries its mark on the
 * rail (the agent's avatar, the user's or the system's icon) and its header
 * (who, "from Raft", the agent's steps, the turn's message range); every row
 * draws the rail, so the rows of a turn read as one though each is its own
 * virtual row. A call and its result are one step; the send call is the
 * send step; Raft's notices are a card.
 */
export const AgentContextViewMessageRow = memo(function AgentContextViewMessageRow({
  message, index, row, messages, turn, turnKind, first, last, joinTop, joinBottom, agentName, agentAvatarUrl, trigger, stepOf, pairs, calls, sent, folds, onToggle, pattern, activeMatch,
}: {
  message: AgentContextViewMessage;
  index: number;
  row: AgentContextViewRow;
  messages: readonly AgentContextViewMessage[];
  /** The turn, when this row is its first in the list. */
  turn: AgentContextViewTurn | null;
  turnKind: AgentContextViewTurnKind;
  /** The list's first and last rows: the rail starts at the first mark and stops at the last row. */
  first: boolean;
  last: boolean;
  /** The row above ends with a step of this turn and this one starts with one (or this ends with one and the row below starts with one): one card across the rows. */
  joinTop: boolean;
  joinBottom: boolean;
  agentName: string;
  agentAvatarUrl: string | null;
  /** The send call, when it is in this row. */
  trigger: AgentContextViewTrigger | null;
  stepOf: ReadonlyMap<string, number>;
  pairs: AgentContextViewPairs;
  /** The context's calls by id, for an unpaired result's title. */
  calls: ReadonlyMap<string, ToolUsePart>;
  sent: { content: string; createdAt: string } | null;
  folds: Folds;
  onToggle: ToggleFold;
  pattern: RegExp | null;
  /** The current match, when it is in this row. */
  activeMatch: AgentContextViewMatch | null;
}) {
  const { formatMessage } = useIntl();
  const speaker = speakerOf(message, row.parts);
  const name = speaker === "agent" ? agentName : formatMessage({ id: SPEAKER_NAME[speaker] });
  const indexLabel = formatMessage({ id: "agentContextView.messageIndex" }, { index });
  const hitIn = (messageIndex: number, partIndex: number) => (activeMatch && activeMatch.messageIndex === messageIndex && activeMatch.partIndex === partIndex ? activeMatch.hit : null);

  const items: RowItem[] = [];
  const paired = new Set<string>();
  for (const partIndex of row.parts) {
    const content = message.parts[partIndex]!;
    const key = agentContextViewPartKey(index, partIndex);
    if (content.kind === "tool_use" && trigger && trigger.messageIndex === index && trigger.partIndex === partIndex) {
      items.push({
        key,
        step: false,
        node: () => (
          <SendItem
            call={content}
            partKey={key}
            step={stepOf.get(key) ?? null}
            index={index}
            sent={sent}
            agentName={agentName}
            agentAvatarUrl={agentAvatarUrl}
            folds={folds}
            onToggle={onToggle}
            pattern={pattern}
            hit={hitIn(index, partIndex)}
          />
        ),
      });
      continue;
    }
    if (content.kind === "tool_use") {
      const place = pairs.resultOf.get(key);
      const inRow = place !== undefined && row.members.some((member) => member.messageIndex === place.messageIndex && member.parts.includes(place.partIndex));
      if (inRow) paired.add(agentContextViewPartKey(place.messageIndex, place.partIndex));
      items.push({
        key,
        step: true,
        node: (join) => (
          <StepItem
            join={join}
            call={content}
            partKey={key}
            step={stepOf.get(key) ?? null}
            result={inRow ? messages[place.messageIndex]!.parts[place.partIndex] as ToolResultPart : null}
            resultMessage={inRow ? place.messageIndex : null}
            resultPart={inRow ? place.partIndex : null}
            folds={folds}
            onToggle={onToggle}
            pattern={pattern}
            callHit={hitIn(index, partIndex)}
            resultHit={inRow ? hitIn(place.messageIndex, place.partIndex) : null}
          />
        ),
      });
      continue;
    }
    const delivery = agentContextViewDelivery(message, content);
    if (delivery && content.kind === "text") {
      items.push({
        key,
        step: false,
        node: () => <DeliveryItem text={content.text} delivery={delivery} messageIndex={index} partIndex={partIndex} folds={folds} onToggle={onToggle} pattern={pattern} hit={hitIn(index, partIndex)} />,
      });
      continue;
    }
    items.push({ key, step: false, node: () => <RowPart message={message} messageIndex={index} partIndex={partIndex} calls={calls} folds={folds} onToggle={onToggle} pattern={pattern} hit={hitIn(index, partIndex)} /> });
  }
  // A folded-in result whose call isn't shown here (never, as rows are built; kept so nothing is lost).
  for (const member of row.members) {
    for (const partIndex of member.parts) {
      const key = agentContextViewPartKey(member.messageIndex, partIndex);
      if (paired.has(key)) continue;
      items.push({ key, step: false, node: () => <RowPart message={messages[member.messageIndex]!} messageIndex={member.messageIndex} partIndex={partIndex} calls={calls} folds={folds} onToggle={onToggle} pattern={pattern} hit={hitIn(member.messageIndex, partIndex)} /> });
    }
  }

  const range = turn
    ? (turn.first === turn.last ? formatMessage({ id: "agentContextView.messageIndex" }, { index: turn.first }) : formatMessage({ id: "agentContextView.turn.range" }, { first: turn.first, last: turn.last }))
    : null;
  const turnMeta = turn
    ? (turn.kind === "agent" && turn.steps > 0
      ? formatMessage({ id: "agentContextView.turn.steps" }, { count: turn.steps })
      : turn.kind === "user" && turn.fromRaft ? formatMessage({ id: "agentContextView.turn.fromRaft" }) : null)
    : null;
  return (
    <MessageItem
      // No transparent top border, no padding outside the gutter: the rail runs the row's whole height, unbroken between rows.
      className="border-t-0 px-(--column-margin) py-0"
      aria-label={formatMessage({ id: "agentContextView.rowLabel" }, { name, index: indexLabel })}
      data-testid="agent-context-view-message-row"
      data-message-index={index}
      data-speaker={speaker}
      data-trigger={trigger ? "true" : undefined}
      data-turn-start={turn ? "true" : undefined}
    >
      <MessageItemGutter>
        <span aria-hidden className={`absolute start-1/2 w-px -translate-x-1/2 bg-line-hairline ${first ? "top-5" : "top-0"} ${last ? "h-5" : "bottom-0"}`} data-testid="agent-context-view-rail" />
        {turn ? (
          <MessageItemAvatarSlot className="mt-2">
            <TurnMark kind={turnKind} agentAvatarUrl={agentAvatarUrl} />
          </MessageItemAvatarSlot>
        ) : null}
      </MessageItemGutter>
      <div className={`flex min-w-0 flex-1 flex-col ${joinTop ? "pt-0" : "pt-2"} ${joinBottom ? "pb-0" : "pb-2"}`}>
        {turn ? (
          <MessageItemHeader className="items-center" data-testid="agent-context-view-row-header">
            <MessageItemSenderGroup className="items-center">
              <MessageItemSender>{turn.kind === "agent" ? agentName : formatMessage({ id: TURN_NAME[turn.kind] })}</MessageItemSender>
              {turnMeta ? <span className="text-caption text-foreground-muted before:me-1.5 before:content-['·']" data-testid="agent-context-view-turn-meta">{turnMeta}</span> : null}
            </MessageItemSenderGroup>
            <span className="ms-auto shrink-0 font-mono text-mono-meta tabular-nums text-foreground-hint" data-testid="agent-context-view-row-index">{range}</span>
          </MessageItemHeader>
        ) : null}
        {items.map((item, at) => {
          const above = at === 0 ? joinTop : item.step && items[at - 1]!.step;
          const below = at === items.length - 1 ? joinBottom : item.step && items[at + 1]!.step;
          // Spacing is inside the row (never a margin between rows); joined steps have none.
          const spaced = at === 0 ? turn !== null : !above;
          return (
            <div key={item.key} className={`grid min-w-0 grid-cols-1 ${spaced ? "mt-2" : ""}`}>
              {item.node({ top: item.step && above, bottom: item.step && below })}
            </div>
          );
        })}
      </div>
    </MessageItem>
  );
});

function usePartSearch(pattern: RegExp | null, hit: number | null): PartSearch | null {
  return useMemo(() => (pattern ? { pattern, hit } : null), [hit, pattern]);
}

/** The send call as the send step; Show Command is its `result` fold, the command's lines its `text` fold. */
function SendItem({ call, partKey, step, index, sent, agentName, agentAvatarUrl, folds, onToggle, pattern, hit }: {
  call: ToolUsePart;
  partKey: string;
  step: number | null;
  index: number;
  sent: { content: string; createdAt: string } | null;
  agentName: string;
  agentAvatarUrl: string | null;
  folds: Folds;
  onToggle: ToggleFold;
  pattern: RegExp | null;
  hit: number | null;
}) {
  const toggle = useCallback(() => onToggle("result", partKey), [onToggle, partKey]);
  const toggleInput = useCallback(() => onToggle("text", partKey), [onToggle, partKey]);
  const search = usePartSearch(pattern, hit);
  return (
    <AgentContextViewSendStep
      call={call}
      step={step}
      index={index}
      sent={sent}
      agentName={agentName}
      agentAvatarUrl={agentAvatarUrl}
      open={folds.result.has(partKey)}
      onToggle={toggle}
      inputOpen={folds.text.has(partKey)}
      onToggleInput={toggleInput}
      search={search}
    />
  );
}

/** A call and its result as a step: open is the call's `result` fold; the input's and the output's lines are their parts' `text` folds. */
function StepItem({ join, call, partKey, step, result, resultMessage, resultPart, folds, onToggle, pattern, callHit, resultHit }: {
  join: Join;
  call: ToolUsePart;
  partKey: string;
  step: number | null;
  result: ToolResultPart | null;
  resultMessage: number | null;
  resultPart: number | null;
  folds: Folds;
  onToggle: ToggleFold;
  pattern: RegExp | null;
  callHit: number | null;
  resultHit: number | null;
}) {
  const resultKey = resultMessage !== null && resultPart !== null ? agentContextViewPartKey(resultMessage, resultPart) : null;
  const toggle = useCallback(() => onToggle("result", partKey), [onToggle, partKey]);
  const toggleInput = useCallback(() => onToggle("text", partKey), [onToggle, partKey]);
  const toggleOutput = useCallback(() => {
    if (resultKey) onToggle("text", resultKey);
  }, [onToggle, resultKey]);
  const shownResult = useMemo(() => (result && resultMessage !== null ? { part: result, messageIndex: resultMessage } : null), [result, resultMessage]);
  const callSearch = usePartSearch(pattern, callHit);
  const resultSearch = usePartSearch(result ? pattern : null, resultHit);
  return (
    <AgentContextViewToolStep
      joinTop={join.top}
      joinBottom={join.bottom}
      call={call}
      step={step}
      result={shownResult}
      open={folds.result.has(partKey)}
      onToggle={toggle}
      inputOpen={folds.text.has(partKey)}
      onToggleInput={toggleInput}
      outputOpen={resultKey !== null && folds.text.has(resultKey)}
      onToggleOutput={toggleOutput}
      callSearch={callSearch}
      resultSearch={resultSearch}
    />
  );
}

/** Raft's notices as a card; each notice's open state is a `notice` fold. */
function DeliveryItem({ text, delivery, messageIndex, partIndex, folds, onToggle, pattern, hit }: {
  text: string;
  delivery: RaftDelivery;
  messageIndex: number;
  partIndex: number;
  folds: Folds;
  onToggle: ToggleFold;
  pattern: RegExp | null;
  hit: number | null;
}) {
  const isOpen = useCallback((segment: number) => folds.notice.has(agentContextViewNoticeKey(messageIndex, partIndex, segment)), [folds.notice, messageIndex, partIndex]);
  const toggle = useCallback((segment: number) => onToggle("notice", agentContextViewNoticeKey(messageIndex, partIndex, segment)), [messageIndex, onToggle, partIndex]);
  const search = usePartSearch(pattern, hit);
  return <AgentContextViewRaftDelivery text={text} delivery={delivery} isOpen={isOpen} onToggle={toggle} search={search} />;
}

/** A part shown as it is (text, thinking, an unpaired result, an image, a compaction). */
function RowPart({ message, messageIndex, partIndex, calls, folds, onToggle, pattern, hit }: {
  message: AgentContextViewMessage;
  messageIndex: number;
  partIndex: number;
  calls: ReadonlyMap<string, ToolUsePart>;
  folds: Folds;
  onToggle: ToggleFold;
  pattern: RegExp | null;
  hit: number | null;
}) {
  const content = message.parts[partIndex]!;
  const key = agentContextViewPartKey(messageIndex, partIndex);
  return (
    <Part
      part={content}
      call={content.kind === "tool_result" && content.toolUseId ? calls.get(content.toolUseId) ?? null : null}
      partKey={key}
      resultOpen={folds.result.has(key)}
      textOpen={folds.text.has(key)}
      onToggle={onToggle}
      pattern={pattern}
      hit={hit}
    />
  );
}
