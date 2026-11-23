import { memo } from "react";
import type { MouseEvent, ReactNode, RefObject } from "react";
import { useIntl } from "react-intl";
import {
  Badge,
  ComposerSuggestionAside,
  ComposerSuggestionContent,
  ComposerSuggestionGroup,
  ComposerSuggestionIcon,
  ComposerSuggestionList,
  ComposerSuggestionMeta,
  ComposerSuggestionTitle,
} from "@botiverse/raft-ui";
import type { Channel } from "../../store/channelStore";
import { ChannelIcon } from "../channel/channelKindIcon";
import { AutocompleteOptionRow } from "./AutocompleteOptionRow";

const preventOptionMouseDown = (event: MouseEvent<HTMLElement>) => {
  // Keep focus in the textarea so clicking an option inserts at the active caret.
  event.preventDefault();
};

const ChannelAutocompleteRow = memo(function ChannelAutocompleteRow({
  channel,
  flatIndex,
  highlighted,
  archivedLabel,
  onSelect,
}: {
  channel: Channel;
  flatIndex: number;
  highlighted: boolean;
  archivedLabel: string;
  onSelect: (channel: Channel) => void;
}) {
  const isArchived = Boolean(channel.archivedAt);
  return (
    <AutocompleteOptionRow
      value={channel}
      flatIndex={flatIndex}
      highlighted={highlighted}
      onMouseDown={preventOptionMouseDown}
      onSelect={onSelect}
    >
      <ComposerSuggestionIcon variant="framed">
        <ChannelIcon channel={channel} size={12} />
      </ComposerSuggestionIcon>
      <ComposerSuggestionContent>
        <ComposerSuggestionTitle>{channel.name}</ComposerSuggestionTitle>
        {channel.description && (
          <ComposerSuggestionMeta>{channel.description}</ComposerSuggestionMeta>
        )}
        {isArchived && (
          <ComposerSuggestionAside>
            <Badge appearance="soft" variant="muted">
              {archivedLabel}
            </Badge>
          </ComposerSuggestionAside>
        )}
      </ComposerSuggestionContent>
    </AutocompleteOptionRow>
  );
});

export function ChannelAutocompleteList({
  visible,
  channels,
  highlightedIndex,
  popupRef,
  onSelect,
}: {
  visible: boolean;
  channels: readonly Channel[];
  highlightedIndex: number;
  popupRef: RefObject<HTMLDivElement | null>;
  onSelect: (channel: Channel) => void;
}): ReactNode {
  const { formatMessage } = useIntl();
  if (!visible || channels.length === 0) return null;
  const archivedLabel = formatMessage({ id: "message.composer.archivedBadge" });
  return (
    <ComposerSuggestionList
      ref={popupRef}
      data-testid="channel-autocomplete-popover"
    >
      <ComposerSuggestionGroup>
        {channels.map((ch, i) => (
          <ChannelAutocompleteRow
            key={ch.id}
            channel={ch}
            flatIndex={i}
            highlighted={i === highlightedIndex}
            archivedLabel={archivedLabel}
            onSelect={onSelect}
          />
        ))}
      </ComposerSuggestionGroup>
    </ComposerSuggestionList>
  );
}
