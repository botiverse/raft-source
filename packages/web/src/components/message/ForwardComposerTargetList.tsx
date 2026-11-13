import { useCallback, useMemo } from "react";
import { UserPlus } from "lucide-react";
import { useIntl } from "react-intl";
import { Checkbox, Button, Spinner, IconTile } from "@botiverse/raft-ui";
import type { Channel } from "../../store/channelStore";
import { useAppBotAgent } from "../../store/agentStore";
import AppBadge from "../agent/AppBadge";
import { DmPeerAvatarSlot } from "../layout/DmPeerAvatarSlot";
import ChannelPicker, { CHANNEL_PICKER_ROW_CLASS, channelLabel } from "../pickers/ChannelPicker";
import SectionEyebrow from "../ui/SectionEyebrow";
import { ThreadMark } from "../thread/ConversationAvatar";
import { ChannelIcon } from "../channel/channelKindIcon";
import { ForwardConversationTargetTitle } from "./ForwardConversationTargetTitle";
import {
  MAX_FORWARD_DESTINATIONS,
  isConversationTarget,
  localSelectionKey,
  searchSelectionKey,
} from "./forwardComposerModel";
import type { ForwardSearchTarget, SelectedDestination } from "./forwardComposerModel";

// A channel is a place, not a face: the neutral DS channel tile (raft-ui
// IconTile at the 27px step, the compact-row avatars' size beside it).
const FORWARD_TARGET_HINT_CLASS = "flex shrink-0 items-center gap-1 text-caption text-foreground-hint";
const FORWARD_GROUP_EYEBROW_CLASS = "flex h-6 items-center px-1 pt-1";

type Props = {
  currentServerId: string;
  isSearchMode: boolean;
  lowerQuery: string;
  searchResults: ForwardSearchTarget[];
  /** Recent threads and task discussions (the current one first): a group above Recent; empty, no group. */
  conversationTargets?: ForwardSearchTarget[];
  searchLoading: boolean;
  searchFailed: boolean;
  filteredTargets: Channel[];
  channelTargets: Channel[];
  dmTargets: Channel[];
  channelLocalMembership: Record<string, boolean | undefined>;
  selectedDestinations: Map<string, SelectedDestination>;
  joinInFlight: boolean;
  isMobile: boolean;
  mobileMultiSelect: boolean;
  chooseDestination: (entry: SelectedDestination, disabled: boolean) => void;
  retrySearch: (query: string) => void;
  /** A search across servers that some servers didn't answer: said under the rows the rest gave. */
  searchPartialFailure?: string | null;
};

/** A search target's name. An App (a DM with one, or a new DM to one) shows the App badge after it. */
function ForwardSearchTargetTitle({ target }: { target: ForwardSearchTarget }) {
  const appBot = useAppBotAgent(target.type === "agent" || (target.type === "dm" && target.subtitle === "agent") ? target.id : null);
  if (!appBot) return <span className="min-w-0 flex-1 truncate">{target.title}</span>;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="min-w-0 truncate">{target.title}</span>
      <AppBadge className="shrink-0" appName={appBot.managedByApp?.name} botName={appBot.displayName || appBot.name} />
    </span>
  );
}

const NO_CONVERSATION_TARGETS: ForwardSearchTarget[] = [];

export default function ForwardComposerTargetList({
  currentServerId,
  isSearchMode,
  lowerQuery,
  searchResults,
  conversationTargets = NO_CONVERSATION_TARGETS,
  searchLoading,
  searchFailed,
  filteredTargets,
  channelTargets,
  dmTargets,
  channelLocalMembership,
  selectedDestinations,
  joinInFlight,
  isMobile,
  mobileMultiSelect,
  chooseDestination,
  retrySearch,
  searchPartialFailure = null,
}: Props) {
  const { formatMessage } = useIntl();
  const showCheckbox = !isMobile || mobileMultiSelect;
  const handleRetrySearch = useCallback(() => retrySearch(lowerQuery), [retrySearch, lowerQuery]);

  const renderSearchTarget = (target: ForwardSearchTarget, position = -1) => {
    const key = searchSelectionKey(target.serverId ?? currentServerId, target);
    // A search across servers names each row's server (two #general apart), and says it to a screen reader too.
    const named = target.serverName ? formatMessage({ id: "message.forwardComposer.targetInServer" }, { target: target.title, server: target.serverName }) : target.title;
    const selected = selectedDestinations.has(key);
    const selectedResolvedChannelId = selectedDestinations.get(key)?.resolvedChannelId;
    const joinedChannelId = target.requiredAction === "join_channel"
      ? channelTargets.find((channel) => channel.id === target.channelId)?.id
        ?? (target.channelId && channelLocalMembership[target.channelId] === true ? target.channelId : undefined)
      : undefined;
    const existingDmId = target.requiredAction === "create_dm"
      ? dmTargets.find((channel) => channel.peerId === target.id)?.id
      : undefined;
    const resolvedChannelId = selectedResolvedChannelId ?? joinedChannelId ?? existingDmId;
    const unavailable = !target.canForwardNow && target.requiredAction === null;
    const disabled = joinInFlight || unavailable || (!selected && selectedDestinations.size >= MAX_FORWARD_DESTINATIONS);
    const toggle = () => chooseDestination({ key, label: target.title, searchTarget: target, resolvedChannelId }, disabled);
    return (
      <div
        key={key}
        role={showCheckbox ? "checkbox" : "button"}
        tabIndex={disabled ? -1 : 0}
        aria-checked={showCheckbox ? selected : undefined}
        aria-disabled={disabled}
        aria-label={formatMessage({ id: showCheckbox ? "message.forwardComposer.selectTargetAria" : "message.forwardComposer.forwardToAria" }, { target: named })}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== " " && event.key !== "Enter") return;
          event.preventDefault();
          toggle();
        }}
        className={`${CHANNEL_PICKER_ROW_CLASS} ${
          unavailable ? "cursor-not-allowed text-foreground-disabled" : `hover:bg-fill-subtle ${selected ? "font-bold" : "font-medium"}`
        }`}
        data-testid={`forward-search-target-${target.type}-${target.id}`}
      >
        {showCheckbox && <Checkbox checked={selected} disabled={disabled} tabIndex={-1} aria-hidden className="pointer-events-none" />}
        {isConversationTarget(target) ? (
          <IconTile size="sm"><ThreadMark task={target.type === "task"} /></IconTile>
        ) : target.type === "channel" ? (
          <IconTile size="sm">
            {/* The current server's channel by its id (another server's: by its type). */}
            <ChannelIcon
              channelId={target.serverId ? null : target.channelId ?? target.id}
              type={target.channelType === "private" || target.channelType === "joint" ? target.channelType : "channel"}
            />
          </IconTile>
        ) : (
          <span className="shrink-0">
            {/* A person or agent (or a DM with one) on this server: their face is read live, the search's copy is the fallback. */}
            <DmPeerAvatarSlot
              context="compact-row"
              peerType={target.type === "agent" || (target.type === "dm" && target.subtitle === "agent") ? "agent" : "user"}
              peerId={!target.serverId || target.serverId === currentServerId ? target.id : undefined}
              peerAvatarUrl={target.avatarUrl}
            />
          </span>
        )}
        {isConversationTarget(target) ? (
          // Only the recent group's first row can be the conversation the forward was opened from.
          <ForwardConversationTargetTitle target={target} isMobile={isMobile} current={position === 0 && target.current === true} />
        ) : (
          <ForwardSearchTargetTitle target={target} />
        )}
        {target.serverName ? (
          // The conversation's name comes first: the server's gives way (at most 40% of the row).
          <span className="flex min-w-0 max-w-[40%] items-center text-caption text-foreground-hint" data-testid="forward-search-target-server"><span className="truncate">{target.serverName}</span></span>
        ) : null}
        {target.requiredAction === "join_channel" && !resolvedChannelId && (
          <span className={FORWARD_TARGET_HINT_CLASS}>
            {formatMessage({ id: "message.forwardComposer.notJoined" })}
          </span>
        )}
        {target.requiredAction === "create_dm" && !resolvedChannelId && (
          <span className={FORWARD_TARGET_HINT_CLASS}>
            <UserPlus size={12} />
            {formatMessage({ id: "message.forwardComposer.newDm" })}
          </span>
        )}
      </div>
    );
  };

  // Local destinations go through the shared ChannelPicker. Its value is the
  // listed channels already selected; the cap leaves room for selections made
  // from search (new DMs, unjoined channels), so the overall limit still holds.
  const localSelectedIds = useMemo(
    () => filteredTargets
      .filter((target) => selectedDestinations.has(localSelectionKey(currentServerId, target.id)))
      .map((target) => target.id),
    [filteredTargets, selectedDestinations, currentServerId],
  );
  const localMaxItems = MAX_FORWARD_DESTINATIONS - (selectedDestinations.size - localSelectedIds.length);
  const localOptionAriaLabel = useCallback(
    (target: Channel) => formatMessage(
      { id: showCheckbox ? "message.forwardComposer.selectTargetAria" : "message.forwardComposer.forwardToAria" },
      { target: channelLabel(target) },
    ),
    [formatMessage, showCheckbox],
  );
  const chooseLocalTarget = useCallback((_next: string[], target: Channel) => {
    chooseDestination({ key: localSelectionKey(currentServerId, target.id), label: channelLabel(target), localTarget: target }, false);
  }, [chooseDestination, currentServerId]);

  if (!isSearchMode) {
    const recent = (
      <ChannelPicker
        channels={filteredTargets}
        value={localSelectedIds}
        onChange={chooseLocalTarget}
        // A phone's single pick forwards on press; a cap only means something with several.
        {...(showCheckbox ? { multiple: true as const, maxItems: localMaxItems } : { multiple: false as const, single: "choose" as const })}
        disabled={joinInFlight}
        optionAriaLabel={localOptionAriaLabel}
        optionTestIdPrefix="forward-target-"
      />
    );
    if (conversationTargets.length === 0) return recent;
    // Layout A: recent threads and tasks above Recent, each under its own title.
    return (
      <>
        <div role="group" aria-labelledby="forward-conversation-group-title" data-testid="forward-conversation-group">
          <SectionEyebrow as="div" id="forward-conversation-group-title" className={FORWARD_GROUP_EYEBROW_CLASS}>
            {formatMessage({ id: "message.forwardComposer.conversations" })}
          </SectionEyebrow>
          {conversationTargets.map((target, position) => renderSearchTarget(target, position))}
        </div>
        <div role="group" aria-labelledby="forward-recent-group-title">
          <SectionEyebrow as="div" id="forward-recent-group-title" className={FORWARD_GROUP_EYEBROW_CLASS}>
            {formatMessage({ id: "message.forwardComposer.recent" })}
          </SectionEyebrow>
          {recent}
        </div>
      </>
    );
  }
  if (searchLoading) return <div className="flex items-center justify-center py-4"><Spinner size="md"  aria-label={formatMessage({ id: "common.loadingLabel" })} /></div>;
  if (searchFailed) {
    return (
      <div className="flex flex-col items-center gap-2 py-4 text-center">
        <p className="text-callout text-foreground-muted">{formatMessage({ id: "message.forwardComposer.searchFailed" })}</p>
        <Button type="button" size="md" variant="outline" onClick={handleRetrySearch}>{formatMessage({ id: "message.forwardComposer.tryAgain" })}</Button>
      </div>
    );
  }
  const partial = searchPartialFailure ? (
    <p className="px-1 py-2 text-caption text-foreground-hint" role="status" data-testid="forward-search-partial-failure">{searchPartialFailure}</p>
  ) : null;
  if (searchResults.length === 0) {
    return (
      <>
        <p className="py-4 text-center text-callout text-foreground-hint">{formatMessage({ id: "message.forwardComposer.noMatchingDestinations" })}</p>
        {partial}
      </>
    );
  }
  return <>{searchResults.map((target) => renderSearchTarget(target))}{partial}</>;
}
