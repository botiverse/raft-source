import { Fragment, memo, useCallback } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import {
  Badge,
  ComposerSuggestionAside,
  ComposerSuggestionContent,
  ComposerSuggestionGroup,
  ComposerSuggestionGroupLabel,
  ComposerSuggestionIcon,
  ComposerSuggestionList,
  ComposerSuggestionMeta,
  ComposerSuggestionOption,
  ComposerSuggestionTitle,
  Separator,
} from "@botiverse/raft-ui";

import { useAppBotAgent } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import AgentActivityDot from "../agent/AgentActivityDot";
import AppBadge from "../agent/AppBadge";
import AvatarSlot from "../ui/AvatarSlot";
import Tooltip from "../ui/Tooltip";
import { AvatarOriginCorner } from "../member/MemberLabelParts";
import { originServerNames } from "../../utils/memberOrigin";
import { getMentionCandidateDescription, getMentionCandidateServerLabel } from "../message/mentionCandidates";
import type { MentionCandidate } from "../message/mentionCandidates";
import type { MentionPicker, MentionSuggestionItem } from "./useMentionPicker";

export function MentionCandidateBody({
  candidate,
  appBotAgent,
}: {
  candidate: MentionCandidate;
  appBotAgent?: Agent | null;
}) {
  const { formatMessage } = useIntl();
  const description = getMentionCandidateDescription(candidate);
  // Another server's candidate: its first server, and how many more ("Acme
  // Corp +1"); the whole list is the tooltip. Anyone else keeps the roster's
  // server label, when it has one.
  const externalServers = candidate.origin?.external ? candidate.origin.servers : null;
  const serverLabel = externalServers
    ? externalServers.length > 1
      ? formatMessage({ id: "message.profilePreview.serverAndMore" }, { server: externalServers[0].name, count: externalServers.length - 1 })
      : externalServers[0]?.name ?? null
    : getMentionCandidateServerLabel(candidate);
  const serverNames = candidate.origin?.external ? originServerNames(candidate.origin) : serverLabel;
  // What an App posts as is an App, not an Agent: the App badge takes the kind tag's place.
  const storeAppBot = useAppBotAgent(appBotAgent === undefined && candidate.type === "agent" ? candidate.id : null);
  const appBot = appBotAgent === undefined ? storeAppBot : appBotAgent;
  const actorTypeLabel = candidate.type === "user"
    ? formatMessage({ id: "message.composer.actorType.human" })
    : candidate.type === "agent"
      ? formatMessage({ id: "message.composer.actorType.agent" })
      : candidate.type === "external"
        ? formatMessage({ id: "settings.slackBridge.providerBadge" })
        : null;

  return (
    <>
      <ComposerSuggestionTitle className="max-w-[12rem] min-w-16 flex-[0_1_auto]" data-testid="mention-candidate-name">
        {candidate.displayName || candidate.name}
      </ComposerSuggestionTitle>
      {appBot ? (
        <AppBadge className="shrink-0" appName={appBot.managedByApp?.name} botName={candidate.displayName || candidate.name} />
      ) : actorTypeLabel && (
        <Badge
          data-testid={`mention-actor-type-${candidate.type}`}
          appearance="soft"
          variant="muted"
          className="shrink-0"
        >
          {actorTypeLabel}
        </Badge>
      )}
      {/* Kind, then where from, then Guest, then the description: when the row
          runs out of room the description gives way first (it only takes the
          room left over), then the server name and the name share the cut;
          the name never goes below its minimum, so it always reads. */}
      {serverLabel && (
        <Tooltip content={formatMessage({ id: "message.composer.sourceServer" }, { server: serverNames })}>
          <ComposerSuggestionMeta className="min-w-0 max-w-[8rem] flex-[0_1_auto] truncate" data-testid="mention-candidate-server">
            {serverLabel}
          </ComposerSuggestionMeta>
        </Tooltip>
      )}
      {candidate.guest && (
        <ComposerSuggestionMeta className="flex-none basis-auto" data-testid="mention-candidate-guest">
          {formatMessage({ id: "member.detail.roleGuest" })}
        </ComposerSuggestionMeta>
      )}
      {description && (
        <Tooltip content={description}>
          <ComposerSuggestionMeta className="min-w-0 flex-[1_1_0] truncate" title={description} data-testid="mention-candidate-description">
            {description}
          </ComposerSuggestionMeta>
        </Tooltip>
      )}
      <ComposerSuggestionAside>
        <ComposerSuggestionMeta variant="code" className="max-w-[7rem] truncate">@{candidate.name}</ComposerSuggestionMeta>
      </ComposerSuggestionAside>
    </>
  );
}

export function MentionCandidateAvatar({
  candidate,
  muted,
  appBotAgent,
}: {
  candidate: MentionCandidate;
  muted: boolean;
  appBotAgent?: Agent | null;
}) {
  // An App bot has no presence to show.
  const storeAppBot = useAppBotAgent(appBotAgent === undefined && candidate.type === "agent" ? candidate.id : null);
  const appBot = (appBotAgent === undefined ? storeAppBot : appBotAgent) !== null;
  if (candidate.type === "agent") {
    return (
      <AvatarSlot
        context="compact-list"
        type="agent"
        agentAvatarUrl={candidate.avatarUrl}
        badge={muted || appBot ? undefined : <MentionCandidateActivityBadge agentId={candidate.id} />}
        corner={candidate.origin ? <AvatarOriginCorner origin={candidate.origin} dot /> : undefined}
        className={muted ? "opacity-60" : undefined}
      />
    );
  }

  return (
    <AvatarSlot
      context="compact-list"
      type="human"
      humanAvatarUrl={candidate.avatarUrl}
      corner={candidate.origin ? <AvatarOriginCorner origin={candidate.origin} dot /> : undefined}
      className={muted ? "opacity-60 [&_svg]:opacity-50" : undefined}
    />
  );
}

function MentionCandidateActivityBadge({ agentId }: { agentId: string }) {
  return (
    <AgentActivityDot agentId={agentId} size="sm" data-mention-avatar-badge-shell="true" />
  );
}

const preventOptionMouseDown = (event: MouseEvent<HTMLElement>) => {
  // Keep focus in the textarea: a pick inserts at its caret.
  event.preventDefault();
};

interface MentionOptionRowProps {
  item: MentionSuggestionItem;
  flatIndex: number;
  highlighted: boolean;
  optionId: string | undefined;
  testId: string | undefined;
  onSelect: (candidate: MentionCandidate) => void;
}

function areMentionOptionRowPropsEqual(prev: MentionOptionRowProps, next: MentionOptionRowProps): boolean {
  return prev.highlighted === next.highlighted
    && prev.flatIndex === next.flatIndex
    && prev.optionId === next.optionId
    && prev.testId === next.testId
    && prev.onSelect === next.onSelect
    && prev.item.candidate === next.item.candidate
    && prev.item.muted === next.item.muted
    && prev.item.className === next.item.className
    && prev.item.auxiliary === next.item.auxiliary;
}

/** A row: owns its select closure and memoizes on item/highlight identity so arrow navigation only re-renders the 2 rows whose highlight flipped. */
const MentionOptionRow = memo(function MentionOptionRow({
  item,
  flatIndex,
  highlighted,
  optionId,
  testId,
  onSelect,
}: MentionOptionRowProps) {
  const { candidate } = item;
  const appBot = useAppBotAgent(candidate.type === "agent" ? candidate.id : null);
  const handleClick = useCallback(() => onSelect(candidate), [onSelect, candidate]);
  return (
    <ComposerSuggestionOption
      render={<button type="button" />}
      data-ac-index={flatIndex}
      data-highlighted={highlighted ? "true" : undefined}
      className={item.className}
      onMouseDown={preventOptionMouseDown}
      onClick={handleClick}
      // Listbox mode only: raft-ui's own defaults stay as they are otherwise.
      {...(optionId ? { id: optionId, role: "option", "aria-selected": highlighted } : {})}
      {...(testId ? { "data-testid": testId } : {})}
    >
      <ComposerSuggestionIcon>
        <MentionCandidateAvatar candidate={candidate} muted={item.muted === true} appBotAgent={appBot} />
      </ComposerSuggestionIcon>
      {item.auxiliary ? <ComposerSuggestionIcon variant="auxiliary">{item.auxiliary}</ComposerSuggestionIcon> : null}
      <ComposerSuggestionContent>
        <MentionCandidateBody candidate={candidate} appBotAgent={appBot} />
      </ComposerSuggestionContent>
    </ComposerSuggestionOption>
  );
}, areMentionOptionRowPropsEqual);

/**
 * The @ picker's list (raft-ui ComposerSuggestion parts): the picker's groups
 * in order, each row a candidate's avatar, name, kind, description, server and
 * handle. Shown while the picker is open and has rows. Place it before the
 * <Composer> card (outside it, per the RUI spec), so the card never clips it.
 */
export function MentionSuggestionList({
  picker,
  onSelect,
  className = "z-float",
  testId,
  optionTestId,
}: {
  picker: MentionPicker;
  onSelect: (candidate: MentionCandidate) => void;
  className?: string;
  testId?: string;
  optionTestId?: (candidate: MentionCandidate) => string;
}): ReactNode {
  if (!picker.visible) return null;
  const { listbox } = picker;
  // Where each group's rows start in the flat list: the highlight index and
  // the option ids count across groups. Worked out before the rows are built.
  const groupStarts: number[] = [];
  let rowCount = 0;
  for (const group of picker.groups) {
    groupStarts.push(rowCount);
    rowCount += group.items.length;
  }
  return (
    <ComposerSuggestionList
      ref={picker.popupRef}
      className={className}
      data-testid={testId}
      {...(listbox ? { id: listbox.listId, role: "listbox", "aria-label": listbox.label } : {})}
    >
      {picker.groups.map((group, groupIndex) => {
        if (group.items.length === 0) return null;
        const start = groupStarts[groupIndex];
        const rows = (
          <ComposerSuggestionGroup
            key={group.separated ? undefined : group.key}
            className={group.separated ? "pt-1" : undefined}
            {...(listbox ? { role: "group", "aria-label": group.ariaLabel } : {})}
          >
            {group.label ? <ComposerSuggestionGroupLabel {...(listbox ? { "aria-hidden": true } : {})}>{group.label}</ComposerSuggestionGroupLabel> : null}
            {group.items.map((item, i) => (
              <MentionOptionRow
                key={`${item.candidate.type}:${item.candidate.id}`}
                item={item}
                flatIndex={start + i}
                highlighted={start + i === picker.index}
                optionId={listbox?.optionId(start + i)}
                testId={optionTestId?.(item.candidate)}
                onSelect={onSelect}
              />
            ))}
          </ComposerSuggestionGroup>
        );
        return group.separated ? (
          <Fragment key={group.key}>
            <Separator className="mt-1" />
            {rows}
          </Fragment>
        ) : rows;
      })}
    </ComposerSuggestionList>
  );
}
