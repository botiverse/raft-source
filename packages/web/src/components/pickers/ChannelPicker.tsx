// ChannelPicker — controlled picker over channels (and DMs, when the caller
// passes them), rendered as DS picker list rows.
//
// `multiple` shows a check per row and toggles. A single picker either
// chooses on press (`single="choose"`: plain button rows, the press is the
// action, as forwarding on a phone) or holds one value in a form
// (`single="radio"`: a radio group, with a None row when it may be empty).
// Candidates are passed in, already filtered and ordered;
// `useChannelPickerCandidates` derives them from the channel store.

import { useCallback, useMemo } from "react";
import { Checkbox, IconTile, RadioGroup, RadioGroupItem } from "@botiverse/raft-ui";
import type { Channel } from "../../store/channelStore";
import { useChannelStore } from "../../store/channelStore";
import { useAppBotAgent } from "../../store/agentStore";
import AppBadge from "../agent/AppBadge";
import { DmPeerAvatarSlot } from "../layout/DmPeerAvatarSlot";
import { ChannelIcon } from "../channel/channelKindIcon";
import { isPickerOptionBlocked, togglePickerValue } from "./pickerSelection";

export function channelLabel(channel: Channel) {
  if (channel.type === "dm") return `@${channel.peerDisplayName || channel.peerName || channel.name}`;
  return `#${channel.name}`;
}

export function channelPickerLabel(channel: Channel) {
  return channel.type === "dm" ? channelLabel(channel) : channel.name;
}

export function channelIcon(channel: Channel) {
  // A DM's face is read live, so a changed avatar shows here at once.
  if (channel.type === "dm") {
    return (
      <DmPeerAvatarSlot
        context="compact-row"
        peerType={channel.peerType}
        peerId={channel.peerId}
        peerAvatarUrl={channel.peerAvatarUrl}
      />
    );
  }
  return <ChannelIcon channel={channel} size={14} />;
}

export type ChannelPickerScope = "joined" | "visible";

/** Channels the client already holds: every visible, active, non-thread,
 *  non-DM channel ("visible"), or only those the viewer has joined. */
export function useChannelPickerCandidates(scope: ChannelPickerScope): Channel[] {
  const channels = useChannelStore((s) => s.channels);
  return useMemo(() => channels.filter((channel) => (
    !channel.archivedAt
    && channel.type !== "thread"
    && channel.type !== "dm"
    && (scope === "visible" || channel.joined === true)
  )), [channels, scope]);
}

// DS ListRow in a picker: no frame, the row presses like any list row; the
// chosen value is the check (and a bolder name), never a colour wash.
export const CHANNEL_PICKER_ROW_CLASS = "flex min-h-11 w-full min-w-0 items-center gap-3 rounded-control px-2 py-1.5 text-left text-subhead text-foreground outline-none transition-colors focus-visible:shadow-focus";

type ChannelPickerCommon = {
  channels: readonly Channel[];
  value: readonly string[];
  disabled?: boolean;
  optionTestIdPrefix?: string;
};
/** Rows a press toggles or chooses; `toggled` is the channel whose row was pressed. */
type ChannelButtonPickerProps = ChannelPickerCommon & {
  onChange: (next: string[], toggled: Channel) => void;
  /** Accessible name per row; defaults to the channel label. */
  optionAriaLabel?: (channel: Channel) => string;
} & (
  /** `maxItems` caps the value length; unselected rows are blocked at the cap. */
  | { multiple: true; maxItems?: number; single?: never }
  /** A single picker has no cap to set. */
  | { multiple: false; maxItems?: never; single: "choose" }
);
/** One value held in a form: a radio group, each row named by its label. */
type ChannelRadioPickerProps = ChannelPickerCommon & {
  multiple: false;
  single: "radio";
  onChange: (next: string[]) => void;
  /** A leading row that clears the value, for an optional field. */
  noneLabel?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
};
type ChannelPickerProps = ChannelButtonPickerProps | ChannelRadioPickerProps;

function ChannelRowContent({ channel }: { channel: Channel }) {
  // A DM with an App bot shows the App badge after the name.
  const appBot = useAppBotAgent(channel.type === "dm" && channel.peerType === "agent" ? channel.peerId : null);
  return (
    <>
      {channel.type === "dm" ? (
        <span className="shrink-0">{channelIcon(channel)}</span>
      ) : (
        <IconTile size="sm">{channelIcon(channel)}</IconTile>
      )}
      {appBot ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 truncate">{channelPickerLabel(channel)}</span>
          <AppBadge className="shrink-0" appName={appBot.managedByApp?.name} botName={channel.peerDisplayName || channel.peerName || channel.name} />
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{channelPickerLabel(channel)}</span>
      )}
    </>
  );
}

export default function ChannelPicker(props: ChannelPickerProps) {
  return props.single === "radio" ? <ChannelRadioPicker {...props} /> : <ChannelButtonPicker {...props} />;
}

// The radio ends 16px inside the frame (Card p-1 + pr-3), where a member row's radio and checkbox end.
const RADIO_ROW_CLASS = `${CHANNEL_PICKER_ROW_CLASS.replace("px-2", "pl-2 pr-3")} hover:bg-fill-subtle`;
/** The None row's value: no channel id is empty. */
const NONE = "";

function ChannelRadioPicker({
  channels,
  value,
  onChange,
  noneLabel,
  disabled = false,
  optionTestIdPrefix = "channel-picker-option-",
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
}: ChannelRadioPickerProps) {
  const choose = useCallback((id: string) => {
    if (!disabled) onChange(id === NONE ? [] : [id]);
  }, [disabled, onChange]);
  // DS RadioGroup: the whole row is the radio's <label>, which names it; the
  // chosen row is the ink dot, at the row's end as the checkboxes are.
  return (
    <RadioGroup value={value[0] ?? NONE} onValueChange={choose} disabled={disabled} aria-labelledby={labelledBy} aria-describedby={describedBy}>
      {noneLabel !== undefined ? (
        <label className={RADIO_ROW_CLASS} data-testid={`${optionTestIdPrefix}none`}>
          <span className="min-w-0 flex-1 truncate">{noneLabel}</span>
          <RadioGroupItem value={NONE} />
        </label>
      ) : null}
      {channels.map((channel) => (
        <label key={channel.id} className={RADIO_ROW_CLASS} data-testid={`${optionTestIdPrefix}${channel.id}`}>
          <ChannelRowContent channel={channel} />
          <RadioGroupItem value={channel.id} />
        </label>
      ))}
    </RadioGroup>
  );
}

function ChannelButtonPicker({
  channels,
  value,
  onChange,
  multiple,
  maxItems,
  disabled: pickerDisabled = false,
  optionAriaLabel = channelLabel,
  optionTestIdPrefix = "channel-picker-option-",
}: ChannelButtonPickerProps) {
  const renderOption = (channel: Channel) => {
    const selected = value.includes(channel.id);
    const disabled = pickerDisabled || isPickerOptionBlocked(value, channel.id, maxItems);
    const toggle = () => {
      if (disabled) return;
      onChange(togglePickerValue(value, channel.id, multiple), channel);
    };
    return (
      <div
        key={channel.id}
        role={multiple ? "checkbox" : "button"}
        tabIndex={disabled ? -1 : 0}
        aria-checked={multiple ? selected : undefined}
        aria-disabled={disabled}
        aria-label={optionAriaLabel(channel)}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== " " && event.key !== "Enter") return;
          event.preventDefault();
          toggle();
        }}
        className={`${CHANNEL_PICKER_ROW_CLASS} hover:bg-fill-subtle ${selected ? "font-bold" : "font-medium"}`}
        data-testid={`${optionTestIdPrefix}${channel.id}`}
      >
        {multiple && <Checkbox checked={selected} disabled={disabled} tabIndex={-1} aria-hidden className="pointer-events-none" />}
        <ChannelRowContent channel={channel} />
      </div>
    );
  };

  return <>{channels.map(renderOption)}</>;
}
