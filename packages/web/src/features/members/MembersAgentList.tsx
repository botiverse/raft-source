import { ListRow, ListRowBody, ListRowGroup, ListRowMeta, ListRowSubtitle, ListRowTitle, Skeleton } from "@botiverse/raft-ui";
import { memo, useCallback, useId } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import StatusDot from "../../components/ui/StatusDot";
import { SkeletonTextBar } from "../../components/ui/Skeleton";
import { useAgentDisplayState } from "../../store/agentStore";
import type { MessageId } from "../../i18n/messages/en";
import type { Machine } from "../../store/machineStore";
import { formatActivityText, formatAgentDisplayStateText } from "../../utils/activity";
import { MemberEntryAppTag, MemberEntryAvatar, MemberEntryRoleWord } from "./MemberEntryParts";
import { agentRuntimeFacts } from "./memberEntryFacts";
import { useRuntimeDeprecatedHere } from "../../hooks/useServerRuntimeCatalog";
import { MemberMenuTrigger } from "./MemberMenuTrigger";
import { MEMBER_ROW_MIN_H } from "./memberRowHeights";
import { CELL, HEADING_LABEL } from "./membersAgentColumns";
import type { MemberEntry } from "./membersPageModel";

// The columns' tracks, shared by the heading row and every row so they line
// up. Status is as wide as its longest short presence word in this locale
// (StatusColumn), so none is ever cut; Model
// has the most room, for names like "DeepSeek V4 Pro · DeepSeek". A value cut
// short shows whole in its title. Below 760px of list width the runtime,
// model and computer fold into one mono line under the description; Status
// stays a column.
const COL_RUNTIME = "hidden w-[104px] shrink-0 @[760px]/members-list:flex";
const COL_MODEL = "hidden w-[176px] shrink-0 @[760px]/members-list:flex";
const COL_COMPUTER = "hidden w-[136px] shrink-0 @[760px]/members-list:flex";
// The usage view (MembersAgentUsage) has more columns: its Model needs 1040px
// of list, below which it folds under the name with the runtime.
const COL_USAGE_MODEL = "hidden w-[176px] shrink-0 @[1040px]/members-list:flex";

// The name line: the name, then the role word and the app tag on its baseline.
const NAME_LINE = "flex min-w-0 items-baseline gap-2";

// The short presence words a Status cell can say (the column's sizer): an
// agent's activity, "Likely online" before its state arrives, a paused assistant.
const STATUS_WORD_IDS: readonly MessageId[] = [
  "activity.status.online",
  "activity.status.likelyOnline",
  "activity.status.thinkingEllipsis",
  "activity.status.workingEllipsis",
  "activity.status.error",
  "activity.status.offline",
  "assistant.paused.chip",
];

/**
 * A Status cell, or its heading: as wide as the light, its gap and the
 * longest status word in this locale, the same in every row, so the column
 * lines up and "Thinking…" (「思考中…」) is never cut. Every word sits
 * invisible in one grid cell under the visible content (a CSS sizer; no
 * measuring). A block ("Computer access revoked…") is a sentence, not a word:
 * it alone may truncate, whole in its title. The visible content comes first:
 * a grid takes its baseline from its first item, so the heading's "Status"
 * lines up with Runtime, Model and Computer on the heading row's baseline,
 * not with the sizer's larger type.
 */
function StatusColumn({ children, id, testId, role }: { children: ReactNode; id?: string; testId?: string; role?: "columnheader" }) {
  const { formatMessage } = useIntl();
  return (
    <span id={id} role={role} className="grid shrink-0" data-testid={testId}>
      <span className="col-start-1 row-start-1 flex min-w-0 items-center">{children}</span>
      <span aria-hidden className="invisible col-start-1 row-start-1 flex gap-2 text-caption" data-status-sizer="">
        <span className="w-2.5 shrink-0" />
        <span className="grid">
          {STATUS_WORD_IDS.map((wordId) => (
            <span key={wordId} className="col-start-1 row-start-1 whitespace-nowrap">{formatMessage({ id: wordId })}</span>
          ))}
        </span>
      </span>
    </span>
  );
}

function Fact({ id, value, className, testId }: { id: string; value: string | null; className: string; testId?: string }) {
  return (
    <span id={id} className={`${className} ${CELL}`} data-testid={testId}>
      {value ? <ListRowMeta title={value}>{value}</ListRowMeta> : <ListRowMeta>—</ListRowMeta>}
    </span>
  );
}

/** A row's usage figures, in the usage view: its cells, and a line under the name when its Computer sends no usage. */
export interface AgentRowUsage {
  cells: ReactNode;
  note: ReactNode;
}

const AgentRow = memo(function AgentRow({ entry, machine, showComputer, selected, usage, onOpen }: {
  entry: Extract<MemberEntry, { kind: "agent" }>;
  /** Open in the side panel: ListRow's own selected state (info-soft, no hover). */
  selected: boolean;
  /** The agent's computer, from the page's one lookup. */
  machine: Machine | undefined;
  showComputer: boolean;
  /** The usage view's cells in place of Runtime, Model and Computer. */
  usage?: AgentRowUsage;
  onOpen: (entry: MemberEntry) => void;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const deprecatedHere = useRuntimeDeprecatedHere();
  const { agent } = entry;
  const handleClick = useCallback(() => onOpen(entry), [entry, onOpen]);
  const id = useId();
  // One read of the agent's state for both its avatar light and its Status column.
  const state = useAgentDisplayState(agent.id, agent);
  // The column says the short presence word; the full state (an external
  // agent's "Last active this minute", a block, a pause) is its title.
  const statusText = formatAgentDisplayStateText(intl, state, { withDetail: false });
  const statusWord = state.blocked || state.paused || state.likelyOnline
    ? statusText
    : formatActivityText(formatMessage, state.activity, "");
  const external = Boolean(state.isExternal && !state.isOnline);
  const { runtime, model } = agentRuntimeFacts(agent, formatMessage, deprecatedHere);
  const folded = usage
    ? [model, runtime].filter(Boolean).join(" · ")
    : [runtime, model, showComputer ? machine?.name : null].filter(Boolean).join(" · ");
  const describedBy = (usage
    ? [`${id}-meta`, agent.description ? `${id}-desc` : null, `${id}-status`, `${id}-model`, `${id}-usage`]
    : [
      `${id}-meta`,
      agent.description ? `${id}-desc` : null,
      `${id}-status`,
      `${id}-runtime`,
      `${id}-model`,
      showComputer ? `${id}-computer` : null,
    ]).filter(Boolean).join(" ");
  return (
    <MemberMenuTrigger
      entry={entry}
      render={<ListRow selected={selected} />}
      aria-current={selected ? "true" : undefined}
      onClick={handleClick}
      aria-label={formatMessage({ id: "members.page.openProfile" }, { name: entry.name })}
      aria-describedby={describedBy}
      data-testid={`members-agent-row-${agent.id}`}
      data-member-entry-id={agent.id}
      // Every row the height of one with a description (12 + 22 + 2 + 18 + 12 with a mouse),
      // the name centred on its cells when there is none, as every cell is.
      className={MEMBER_ROW_MIN_H}
    >
      <MemberEntryAvatar
        entry={entry}
        context="list-row"
        badge={<StatusDot activity={state.activity} external={external} size="sm" />}
      />
      <ListRowBody>
        <span className={NAME_LINE}>
          <ListRowTitle className="min-w-[3ch] flex-none" data-testid="member-entry-name">{entry.name}</ListRowTitle>
          <span id={`${id}-meta`} className="contents">
            <MemberEntryRoleWord entry={entry} className="shrink-0 text-caption font-medium text-foreground-hint" />
            <MemberEntryAppTag entry={entry} className="self-center" />
          </span>
        </span>
        {agent.description ? (
          <ListRowSubtitle id={`${id}-desc`} title={agent.description} data-testid="member-entry-description">
            {agent.description}
          </ListRowSubtitle>
        ) : null}
        {folded ? (
          <ListRowMeta className={usage ? "@[1040px]/members-list:hidden" : "@[760px]/members-list:hidden"} aria-hidden>
            {folded}
          </ListRowMeta>
        ) : null}
        {usage?.note}
      </ListRowBody>
      {/* The presence word with its light (Identity and presence), as the agent's profile says it. */}
      <StatusColumn id={`${id}-status`} testId={`members-agent-status-${agent.id}`}>
        <span className={`flex ${CELL} text-caption text-foreground-muted`}>
          <StatusDot activity={state.activity} external={external} className="shrink-0" />
          <span className="truncate" title={statusText} data-testid="members-agent-status-word">{statusWord}</span>
        </span>
      </StatusColumn>
      {usage ? (
        <>
          <Fact id={`${id}-model`} value={model} className={COL_USAGE_MODEL} />
          <span id={`${id}-usage`} className="contents">{usage.cells}</span>
        </>
      ) : null}
      {usage ? null : <Fact id={`${id}-runtime`} value={runtime} className={COL_RUNTIME} />}
      {usage ? null : <Fact id={`${id}-model`} value={model} className={COL_MODEL} />}
      {showComputer && !usage ? (
        // The computer's name with its own light; a dash for an agent on no computer.
        <span id={`${id}-computer`} className={`${COL_COMPUTER} ${CELL}`} data-testid={`members-agent-computer-${agent.id}`}>
          {machine ? (
            <>
              <StatusDot presence={machine.status === "online" ? "online" : "offline"} className="shrink-0" data-testid="members-agent-computer-light" />
              <ListRowMeta title={machine.name}>{machine.name}</ListRowMeta>
            </>
          ) : <ListRowMeta>—</ListRowMeta>}
        </span>
      ) : null}
    </MemberMenuTrigger>
  );
});

/**
 * An agent's row while the Agents tab loads: AgentRow's own ListRow at the
 * member row's height (MEMBER_ROW_MIN_H, 66px with a mouse), the list-row
 * avatar's 35px box, and bars in its name line and description line, so the
 * rows land where these were (#proj-raft-ui:#231).
 */
export function AgentRowSkeleton() {
  return (
    <ListRow interactive={false} render={<div />} className={MEMBER_ROW_MIN_H} aria-hidden="true" data-skeleton="">
      <Skeleton className="size-[35px] shrink-0" />
      <ListRowBody>
        <span className={NAME_LINE}>
          <ListRowTitle className="min-w-[3ch] flex-none"><SkeletonTextBar className="w-28" /></ListRowTitle>
        </span>
        <ListRowSubtitle><SkeletonTextBar className="w-64 max-w-full" /></ListRowSubtitle>
      </ListRowBody>
    </ListRow>
  );
}

/**
 * One group of the Agents tab (raft-design Members › Agents as a list): a
 * raft-ui ListRowGroup, one ListRow per agent, with Status, Runtime, Model and
 * Computer columns, or in the usage view Status, Model and the usage columns.
 * The column cells and their heading are hand-rolled: the DS has no column
 * part for ListRow yet (an upstream raft-ui candidate), and the Computers list
 * draws its own the same way (mono meta in hint).
 */
export function MembersAgentGroup({ heading, entries, machinesById, showComputer, showColumnHeadings, openKey, usage, onOpen }: {
  heading: ReactNode;
  /** `agent:<id>` of the profile open in the side panel. */
  openKey: string | null;
  entries: MemberEntry[];
  machinesById: ReadonlyMap<string, Machine>;
  showComputer: boolean;
  showColumnHeadings: boolean;
  /** The usage view: each agent's cells (its headings are MembersAgentUsageHeadings, above the groups). */
  usage?: { row: (agentId: string) => AgentRowUsage };
  onOpen: (entry: MemberEntry) => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <section className="@container/members-list flex min-w-0 flex-col" data-testid="members-agent-group">
      {heading || showColumnHeadings ? (
        // The column headings ride on the group's heading line, on the rows'
        // tracks: the same margin, edge and padding as the group and its rows.
        <div className="mx-5 flex min-w-0 items-baseline gap-3 border-x border-transparent pt-4 pr-4">
          <div className="min-w-0 flex-1">{heading}</div>
          {showColumnHeadings ? (
            <>
              <StatusColumn><span className={HEADING_LABEL}>{formatMessage({ id: "members.page.column.status" })}</span></StatusColumn>
              <span className={`${COL_RUNTIME} ${HEADING_LABEL}`}>{formatMessage({ id: "members.page.column.runtime" })}</span>
              <span className={`${COL_MODEL} ${HEADING_LABEL}`}>{formatMessage({ id: "members.page.column.model" })}</span>
              {showComputer ? <span className={`${COL_COMPUTER} ${HEADING_LABEL}`}>{formatMessage({ id: "members.page.column.computer" })}</span> : null}
            </>
          ) : null}
        </div>
      ) : null}
      <ListRowGroup className="mx-5 mt-2">
        {entries.map((entry) => entry.kind === "agent" ? (
          <AgentRow
            key={entry.id}
            entry={entry}
            machine={entry.agent.machineId ? machinesById.get(entry.agent.machineId) : undefined}
            showComputer={showComputer}
            selected={openKey === `agent:${entry.id}`}
            usage={usage?.row(entry.id)}
            onOpen={onOpen}
          />
        ) : null)}
      </ListRowGroup>
    </section>
  );
}

/**
 * The usage view's column headings, one line above its groups (so the name
 * sorts in a grouped list too), on the rows' tracks. A header row of its own
 * table: the rows are buttons (ListRow) that can't be table rows, so each of
 * their cells also names its column for a screen reader (MembersAgentUsage).
 */
export function MembersAgentUsageHeadings({ label, name, headings }: {
  /** The table's accessible name. */
  label: string;
  /** The Agent heading, at the name's track. */
  name: ReactNode;
  /** The usage columns' headings, each a columnheader. */
  headings: ReactNode;
}) {
  const { formatMessage } = useIntl();
  return (
    <div role="table" aria-label={label} className="@container/members-list min-w-0" data-testid="members-usage-headings">
      {/* Centred, not on the baseline: a heading that sorts is a button, which centres its label. */}
      <div role="row" className="mx-5 flex min-w-0 items-center gap-3 border-x border-transparent pt-4 pr-4">
        <div className="min-w-0 flex-1">{name}</div>
        <StatusColumn role="columnheader"><span className={HEADING_LABEL}>{formatMessage({ id: "members.page.column.status" })}</span></StatusColumn>
        <span role="columnheader" className={`${COL_USAGE_MODEL} ${HEADING_LABEL}`}>{formatMessage({ id: "members.page.column.model" })}</span>
        {headings}
      </div>
    </div>
  );
}
