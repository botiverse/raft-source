import { GitBranch, Hash, Lock, LogIn, UserPlus } from "lucide-react";
import { useIntl } from "react-intl";
import { Checkbox } from "raft-ui";
import type { Channel } from "../../store/channelStore";
import AvatarSlot from "../ui/AvatarSlot";
import Button from "../ui/Button";
import Spinner from "../ui/Spinner";
import {
  MAX_FORWARD_DESTINATIONS,
  localSelectionKey,
  searchSelectionKey,
  targetIcon,
  targetLabel,
  targetPickerLabel,
} from "./forwardComposerModel";
import type { ForwardSearchTarget, SelectedDestination } from "./forwardComposerModel";

type Props = {
  currentServerId: string;
  isSearchMode: boolean;
  lowerQuery: string;
  searchResults: ForwardSearchTarget[];
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
};

export default function ForwardComposerTargetList({
  currentServerId,
  isSearchMode,
  lowerQuery,
  searchResults,
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
}: Props) {
  const { formatMessage } = useIntl();
  const showCheckbox = !isMobile || mobileMultiSelect;

  const renderSearchTarget = (target: ForwardSearchTarget) => {
    const key = searchSelectionKey(currentServerId, target);
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
        aria-label={formatMessage({ id: showCheckbox ? "message.forwardComposer.selectTargetAria" : "message.forwardComposer.forwardToAria" }, { target: target.title })}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== " " && event.key !== "Enter") return;
          event.preventDefault();
          toggle();
        }}
        className={`flex w-full min-w-0 items-center gap-2 border-2 border-black px-2 py-2 text-left text-sm font-bold transition-colors ${
          unavailable ? "cursor-not-allowed bg-black/5 opacity-50" : selected ? "bg-soft-signal" : "bg-white hover:bg-brutal-cyan/15"
        }`}
        data-testid={`forward-search-target-${target.type}-${target.id}`}
      >
        {showCheckbox && <Checkbox checked={selected} disabled={disabled} tabIndex={-1} aria-hidden className="pointer-events-none" />}
        <span className="shrink-0">
          {target.type === "channel" && target.channelType === "joint" && <GitBranch size={14} />}
          {target.type === "channel" && target.channelType === "private" && <Lock size={14} />}
          {target.type === "channel" && target.channelType !== "joint" && target.channelType !== "private" && <Hash size={14} />}
          {target.type === "dm" && (
            <AvatarSlot
              context="compact-list"
              type={target.subtitle === "agent" ? "agent" : "human"}
              agentAvatarUrl={target.subtitle === "agent" ? target.avatarUrl : null}
              humanAvatarUrl={target.subtitle !== "agent" ? target.avatarUrl : null}
              humanPlaceholder={target.subtitle !== "agent" && !target.avatarUrl}
            />
          )}
          {target.type === "agent" && <AvatarSlot context="compact-list" type="agent" agentAvatarUrl={target.avatarUrl} />}
          {target.type === "human" && <AvatarSlot context="compact-list" type="human" humanAvatarUrl={target.avatarUrl} humanPlaceholder={!target.avatarUrl} />}
        </span>
        <span className="min-w-0 flex-1 truncate">{target.title}</span>
        {target.requiredAction === "join_channel" && !resolvedChannelId && (
          <span className="flex shrink-0 items-center gap-1 text-[10px] font-bold uppercase text-black/45">
            <LogIn size={10} />
            {formatMessage({ id: "message.forwardComposer.notJoined" })}
          </span>
        )}
        {target.requiredAction === "create_dm" && !resolvedChannelId && (
          <span className="flex shrink-0 items-center gap-1 text-[10px] font-bold uppercase text-black/45">
            <UserPlus size={10} />
            {formatMessage({ id: "message.forwardComposer.newDm" })}
          </span>
        )}
      </div>
    );
  };

  const renderTarget = (target: Channel) => {
    const key = localSelectionKey(currentServerId, target.id);
    const selected = selectedDestinations.has(key);
    const disabled = joinInFlight || (!selected && selectedDestinations.size >= MAX_FORWARD_DESTINATIONS);
    const toggle = () => chooseDestination({ key, label: targetLabel(target), localTarget: target }, disabled);
    return (
      <div
        key={key}
        role={showCheckbox ? "checkbox" : "button"}
        tabIndex={disabled ? -1 : 0}
        aria-checked={showCheckbox ? selected : undefined}
        aria-disabled={disabled}
        aria-label={formatMessage({ id: showCheckbox ? "message.forwardComposer.selectTargetAria" : "message.forwardComposer.forwardToAria" }, { target: targetLabel(target) })}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== " " && event.key !== "Enter") return;
          event.preventDefault();
          toggle();
        }}
        className={`flex w-full min-w-0 items-center gap-2 border-2 border-black px-2 py-2 text-left text-sm font-bold transition-colors ${selected ? "bg-soft-signal" : "bg-white hover:bg-brutal-cyan/15"}`}
        data-testid={`forward-target-${target.id}`}
      >
        {showCheckbox && <Checkbox checked={selected} disabled={disabled} tabIndex={-1} aria-hidden className="pointer-events-none" />}
        <span className="shrink-0">{targetIcon(target)}</span>
        <span className="min-w-0 flex-1 truncate">{targetPickerLabel(target)}</span>
      </div>
    );
  };

  if (!isSearchMode) return <>{filteredTargets.map(renderTarget)}</>;
  if (searchLoading) return <div className="flex items-center justify-center py-4"><Spinner size="sm" /></div>;
  if (searchFailed) {
    return (
      <div className="flex flex-col items-center gap-2 py-4 text-center">
        <p className="text-xs font-bold text-black/55">{formatMessage({ id: "message.forwardComposer.searchFailed" })}</p>
        <Button type="button" size="xs" tone="white" onClick={() => retrySearch(lowerQuery)}>{formatMessage({ id: "message.forwardComposer.tryAgain" })}</Button>
      </div>
    );
  }
  if (searchResults.length === 0) {
    return <p className="py-4 text-center text-xs font-bold text-black/35">{formatMessage({ id: "message.forwardComposer.noMatchingDestinations" })}</p>;
  }
  return <>{searchResults.map(renderSearchTarget)}</>;
}
